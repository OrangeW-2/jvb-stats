"""Portable data ingestion and cross-source deduplication for Just Volleyball.

Reads local Godot userdata (when enabled) and submitted player .zip bundles
created by collect_just_volleyball_data.bat, keeping zero owner-specific
assumptions.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import pathlib
import struct
import zipfile
import zlib
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any

try:
    import zstandard as zstd
except ImportError:
    zstd = None

CPU_KEY = "CPU::[CPU]"
DEFAULT_LOCAL_ROOT = (
    pathlib.Path(os.environ.get("APPDATA", "")) / "Godot" / "app_userdata" / "volleyball"
)


@dataclass
class MatchRecord:
    source: str
    source_id: str
    ts: float
    mode: str
    stage: str
    team_a: list[str]
    team_b: list[str]
    winner: str  # "A" or "B"
    sets_a: int
    sets_b: int
    seed: int | None = None
    raw_names_a: set[str] = field(default_factory=set)
    raw_names_b: set[str] = field(default_factory=set)


class GodotVarReader:
    def __init__(self, buf: bytes, pos: int = 0) -> None:
        self.buf = buf
        self.pos = pos

    def u32(self) -> int:
        (v,) = struct.unpack_from("<I", self.buf, self.pos)
        self.pos += 4
        return v

    def i32(self) -> int:
        (v,) = struct.unpack_from("<i", self.buf, self.pos)
        self.pos += 4
        return v

    def i64(self) -> int:
        (v,) = struct.unpack_from("<q", self.buf, self.pos)
        self.pos += 8
        return v

    def f32(self) -> float:
        (v,) = struct.unpack_from("<f", self.buf, self.pos)
        self.pos += 4
        return v

    def f64(self) -> float:
        (v,) = struct.unpack_from("<d", self.buf, self.pos)
        self.pos += 8
        return v

    def read_var(self) -> Any:
        blen = self.u32()
        end = self.pos + blen
        val = self._read_val()
        self.pos = end
        return val

    def _read_val(self) -> Any:
        hdr = self.u32()
        t = hdr & 0xFFFF
        flags = hdr >> 16
        if t == 0:
            return None
        if t == 1:
            return bool(self.u32())
        if t == 2:
            return self.i64() if (flags & 1) else self.i32()
        if t == 3:
            return self.f64() if (flags & 1) else self.f32()
        if t == 4:
            n = self.u32()
            s = self.buf[self.pos : self.pos + n].decode("utf-8", errors="replace")
            self.pos += (n + 3) & ~3
            return s
        if t == 5:
            return (self.f32(), self.f32())
        if t == 9:
            return (self.f32(), self.f32(), self.f32())
        if t == 20:
            return (self.f32(), self.f32(), self.f32(), self.f32())
        if t == 27:
            n = self.u32() & 0x7FFFFFFF
            return {self._read_val(): self._read_val() for _ in range(n)}
        if t == 28:
            n = self.u32() & 0x7FFFFFFF
            return [self._read_val() for _ in range(n)]
        raise ValueError(f"Unhandled Godot Variant type {t} flags={flags} at {self.pos}")


def read_vbr_meta_slots_events(raw: bytes) -> tuple[dict, list[dict], list[dict]]:
    if raw[:4] != b"GCPF":
        raise ValueError("Bad GCPF magic")
    cmode, bsize, total = struct.unpack_from("<III", raw, 4)
    if cmode != 3:
        raise ValueError(f"Unexpected compression mode {cmode}")
    bc = (total + bsize - 1) // bsize
    csizes = struct.unpack_from(f"<{bc}I", raw, 16)
    pos = 16 + 4 * bc
    out = bytearray()
    target: int | None = None
    for cs in csizes:
        out.extend(zlib.decompress(raw[pos : pos + cs], 16 + zlib.MAX_WBITS))
        pos += cs
        if target is None and len(out) >= 12:
            (m_len,) = struct.unpack_from("<I", out, 8)
            p1 = 12 + m_len
            if len(out) >= p1 + 4:
                (s_len,) = struct.unpack_from("<I", out, p1)
                p2 = p1 + 4 + s_len
                if len(out) >= p2 + 4:
                    (e_len,) = struct.unpack_from("<I", out, p2)
                    target = p2 + 4 + e_len
        if target is not None and len(out) >= target:
            break
    if out[:4] != b"VBRP":
        raise ValueError("Bad VBRP magic")
    r = GodotVarReader(bytes(out), 8)
    meta = r.read_var()
    slots = r.read_var()
    events = r.read_var()
    return meta, slots, events


def strip_cpu_suffix(name: str) -> tuple[str, bool]:
    if name.endswith(" (CPU)"):
        return name[: -len(" (CPU)")], True
    return name, False


def _iter_profile_dicts(blob: dict) -> list[dict]:
    out = []
    for key in ("profiles", "recently_deleted"):
        lst = blob.get(key)
        if isinstance(lst, list):
            out.extend(pr for pr in lst if isinstance(pr, dict))
    return out


def discover_profile_blobs(
    local_root: pathlib.Path | None,
    submissions_dir: pathlib.Path | None,
    include_local: bool = True,
) -> list[tuple[str, dict]]:
    blobs: list[tuple[str, dict]] = []
    if include_local and local_root and (local_root / "data").exists():
        data_dir = local_root / "data"
        cands = [data_dir / fn for fn in ("profiles.json.old", "profiles.json.bak", "profiles.json")]
        flagged = data_dir / "flagged"
        if flagged.exists():
            cands.extend(sorted(flagged.glob("profiles*.json*")))
        for p in cands:
            if p.exists():
                try:
                    blobs.append((f"local:{p.name}", json.loads(p.read_text(encoding="utf-8"))))
                except Exception:
                    continue

    if submissions_dir and submissions_dir.exists():
        for zp in sorted(submissions_dir.glob("*.zip")):
            try:
                with zipfile.ZipFile(zp, "r") as zf:
                    names = sorted(
                        n
                        for n in zf.namelist()
                        if (n.startswith("data/") or n.startswith("save_backups/"))
                        and "profiles" in pathlib.PurePosixPath(n).name
                    )
                    # Process older/backups first so newer profiles.json wins tiebreaks
                    names.sort(key=lambda n: (n.startswith("data/profiles.json"), n == "data/profiles.json", n))
                    for nm in names:
                        try:
                            blobs.append((f"{zp.name}:{nm}", json.loads(zf.read(nm).decode("utf-8"))))
                        except Exception:
                            continue
            except Exception:
                continue
    return blobs


def build_identity_maps(
    profile_blobs: list[tuple[str, dict]],
) -> tuple[dict[str, str], dict[str, set[str]], dict[str, str]]:
    sid_events: dict[str, list[tuple[int, str]]] = defaultdict(list)
    name_to_sids: dict[str, set[str]] = defaultdict(set)

    for _, data in profile_blobs:
        for pr in _iter_profile_dicts(data):
            for hist_key in ("match_history", "favorite_matches"):
                for m in pr.get(hist_key) or []:
                    if not isinstance(m, dict):
                        continue
                    ts = int(m.get("ts", 0))
                    for pl in m.get("players") or []:
                        if not isinstance(pl, dict):
                            continue
                        sid = str(pl.get("sid") or "").strip()
                        if not sid or sid == "0":
                            continue
                        raw_name = str(pl.get("name", "")).strip()
                        base_name, _ = strip_cpu_suffix(raw_name)
                        ready_name = str(pl.get("ready_name", "")).strip()
                        ready_base, _ = strip_cpu_suffix(ready_name)
                        chosen = ready_base or base_name
                        if chosen:
                            sid_events[sid].append((ts, chosen))
                            name_to_sids[chosen].add(sid)
                        if base_name:
                            name_to_sids[base_name].add(sid)

    sid_latest_name: dict[str, str] = {}
    sid_aliases: dict[str, set[str]] = defaultdict(set)
    for sid, evs in sid_events.items():
        evs.sort(key=lambda x: x[0])
        sid_latest_name[sid] = evs[-1][1]
        for _, nm in evs:
            sid_aliases[sid].add(nm)

    unambiguous_name_to_sid = {
        nm: next(iter(sids)) for nm, sids in name_to_sids.items() if len(sids) == 1
    }
    return sid_latest_name, sid_aliases, unambiguous_name_to_sid


def resolve_player_key(
    raw_name: str,
    sid: str | None,
    is_bot: bool,
    sid_latest_name: dict[str, str],
    name_to_sid: dict[str, str],
) -> tuple[str, str]:
    base_name, has_cpu_sfx = strip_cpu_suffix(raw_name.strip())
    if sid and sid != "0":
        disp = sid_latest_name.get(sid, base_name or sid)
        return f"SID::{sid}", disp
    if is_bot or (has_cpu_sfx and not sid):
        return CPU_KEY, "[CPU]"
    if base_name in name_to_sid:
        s = name_to_sid[base_name]
        return f"SID::{s}", sid_latest_name[s]
    return f"NAME::{base_name}", base_name


def _collect_raw_matches_by_token(profile_blobs: list[tuple[str, dict]]) -> dict[str, dict]:
    raw_by_token: dict[str, dict] = {}
    for _, data in profile_blobs:
        for pr in _iter_profile_dicts(data):
            for hist_key in ("match_history", "favorite_matches"):
                for m in pr.get(hist_key) or []:
                    if not isinstance(m, dict):
                        continue
                    tok = str(m.get("match_token") or f"ts_{m.get('ts')}")
                    prev = raw_by_token.get(tok)
                    if prev is None or len(m.get("players", [])) >= len(prev.get("players", [])):
                        raw_by_token[tok] = m
    return raw_by_token


def load_profile_matches(
    profile_blobs: list[tuple[str, dict]],
    sid_latest_name: dict[str, str],
    name_to_sid: dict[str, str],
) -> tuple[list[MatchRecord], dict[str, int]]:
    raw_by_token = _collect_raw_matches_by_token(profile_blobs)
    records: list[MatchRecord] = []
    stats = Counter()

    for tok, m in raw_by_token.items():
        stats["total_unique"] += 1
        if not m.get("online"):
            stats["skipped_offline"] += 1
            continue
        hs = int(m.get("home_sets", 0))
        aws = int(m.get("away_sets", 0))
        ms = int(m.get("my_sets", 0))
        ts_sets = int(m.get("their_sets", 0))
        if hs == aws:
            stats["skipped_tie_sets"] += 1
            continue

        my_name = str(m.get("my_name", "")).strip()
        me_list = [
            pl
            for pl in m.get("players", [])
            if pl.get("name") == my_name or pl.get("ready_name") == my_name
        ]
        if not me_list:
            stats["skipped_no_me"] += 1
            continue
        my_init_side = int(me_list[0]["side"])
        tot = hs + aws
        my_final_side = my_init_side * ((-1) ** (tot - 1))
        pred_ms = hs if my_final_side == 1 else aws
        pred_ts = aws if my_final_side == 1 else hs
        if pred_ms != ms or pred_ts != ts_sets:
            stats["skipped_parity_mismatch"] += 1
            continue

        team_a, team_b = [], []
        names_a, names_b = set(), set()
        for pl in m.get("players", []):
            sid = str(pl.get("sid") or "").strip()
            rname = str(pl.get("name", "")).strip()
            is_bot = (not sid or sid == "0") and rname.endswith(" (CPU)")
            key, _ = resolve_player_key(rname, sid, is_bot, sid_latest_name, name_to_sid)
            base_nm, _ = strip_cpu_suffix(rname)
            if int(pl["side"]) == 1:
                team_a.append(key)
                if key != CPU_KEY:
                    names_a.add(base_nm)
            else:
                team_b.append(key)
                if key != CPU_KEY:
                    names_b.add(base_nm)

        a_final_side = 1 * ((-1) ** (tot - 1))
        sets_a = hs if a_final_side == 1 else aws
        sets_b = aws if a_final_side == 1 else hs
        winner = "A" if sets_a > sets_b else "B"

        records.append(
            MatchRecord(
                source="profiles",
                source_id=tok,
                ts=float(m.get("ts", 0)),
                mode=str(m.get("mode", "")),
                stage=str(m.get("stage", "")),
                team_a=team_a,
                team_b=team_b,
                winner=winner,
                sets_a=sets_a,
                sets_b=sets_b,
                raw_names_a=names_a,
                raw_names_b=names_b,
            )
        )
        stats["kept"] += 1
    return records, dict(stats)


def extract_box_matches(
    profile_blobs: list[tuple[str, dict]],
    sid_latest_name: dict[str, str],
    name_to_sid: dict[str, str],
) -> dict:
    raw_by_token = _collect_raw_matches_by_token(profile_blobs)
    matches = []
    skipped = Counter()
    for tok, m in raw_by_token.items():
        if not m.get("online"):
            skipped["offline"] += 1
            continue
        hs = int(m.get("home_sets", 0))
        aws = int(m.get("away_sets", 0))
        if hs == aws:
            skipped["tie_sets"] += 1
            continue
        my_name = str(m.get("my_name", "")).strip()
        me_list = [
            pl
            for pl in m.get("players", [])
            if pl.get("name") == my_name or pl.get("ready_name") == my_name
        ]
        if not me_list:
            skipped["no_me"] += 1
            continue
        my_init_side = int(me_list[0]["side"])
        tot_sets = hs + aws
        a_final_side = 1 * ((-1) ** (tot_sets - 1))
        sets_a = hs if a_final_side == 1 else aws
        sets_b = aws if a_final_side == 1 else hs
        winner = "A" if sets_a > sets_b else "B"

        raw_set_scores = m.get("set_scores", []) or []
        all_sets_you_opp = [[int(s[0]), int(s[1])] for s in raw_set_scores]
        if len(all_sets_you_opp) < tot_sets:
            all_sets_you_opp.append([int(m.get("my_score", 0)), int(m.get("their_score", 0))])
        you_rallies = sum(s[0] for s in all_sets_you_opp)
        opp_rallies = sum(s[1] for s in all_sets_you_opp)
        total_rallies = you_rallies + opp_rallies
        if total_rallies <= 0:
            skipped["zero_rallies"] += 1
            continue
        you_on_a = my_init_side == 1
        point_diff_a = (you_rallies - opp_rallies) if you_on_a else (opp_rallies - you_rallies)

        players_out = []
        ha = hb = 0
        for pl in m.get("players", []):
            sid = str(pl.get("sid") or "").strip()
            rname = str(pl.get("name", "")).strip()
            is_bot = (not sid or sid == "0") and rname.endswith(" (CPU)")
            key, disp = resolve_player_key(rname, sid, is_bot, sid_latest_name, name_to_sid)
            team = "A" if int(pl["side"]) == 1 else "B"
            if key != CPU_KEY:
                if team == "A":
                    ha += 1
                else:
                    hb += 1
            mvp_score = (
                3 * int(pl.get("pts", 0))
                + 2 * int(pl.get("ace", 0))
                + 2 * int(pl.get("blk", 0))
                + 2 * int(pl.get("ast", 0))
                + 2 * int(pl.get("dig", 0))
                + 1 * int(pl.get("set", 0))
                + 1 * int(pl.get("rcv", 0))
            )
            players_out.append(
                {
                    "key": key,
                    "name": disp,
                    "team": team,
                    "left": bool(pl.get("left", False)),
                    "pts": int(pl.get("pts", 0)),
                    "spk": int(pl.get("spk", 0)),
                    "blk": int(pl.get("blk", 0)),
                    "rcv": int(pl.get("rcv", 0)),
                    "set": int(pl.get("set", 0)),
                    "ast": int(pl.get("ast", 0)),
                    "ace": int(pl.get("ace", 0)),
                    "dig": int(pl.get("dig", 0)),
                    "mvp_score": mvp_score,
                }
            )
        if ha == 0 or hb == 0:
            skipped["all_cpu_side"] += 1
            continue

        matches.append(
            {
                "match_token": tok,
                "ts": int(m.get("ts", 0)),
                "mode": str(m.get("mode", "")),
                "stage": str(m.get("stage", "")),
                "sets_a": sets_a,
                "sets_b": sets_b,
                "winner": winner,
                "total_rallies": total_rallies,
                "point_diff_a": point_diff_a,
                "set_scores_you_opp": all_sets_you_opp,
                "players": players_out,
            }
        )
    matches.sort(key=lambda x: x["ts"])
    return {"matches": matches, "skipped": dict(skipped)}


def match_from_vbr_parsed(
    source_id: str,
    mtime_ts: float,
    meta: dict,
    slots: list[dict],
    events: list[dict],
    sid_latest_name: dict[str, str],
    name_to_sid: dict[str, str],
) -> tuple[MatchRecord | None, str]:
    if not meta.get("online"):
        return None, "skipped_offline"
    hs = int(meta.get("home_sets", 0))
    aws = int(meta.get("away_sets", 0))
    if hs == aws or max(hs, aws) == 0:
        return None, "skipped_incomplete_or_tie"

    pts = [
        e["d"]
        for e in events
        if isinstance(e, dict) and e.get("k") == "point" and isinstance(e.get("d"), dict)
    ]
    set0 = int(pts[0].get("set", 1)) if pts else 1
    tot = hs + aws
    win_final = 1 if hs > aws else -1
    win_tid = win_final * ((-1) ** (tot - 1))
    if pts and "w" in pts[-1] and int(pts[-1]["w"]) != win_tid:
        return None, "skipped_point_mismatch"

    set0_flip = (-1) ** (set0 - 1)
    a_final_side = 1 * ((-1) ** (tot - 1))
    sets_a = hs if a_final_side == 1 else aws
    sets_b = aws if a_final_side == 1 else hs
    winner = "A" if win_tid == 1 else "B"

    rec_at = str(meta.get("recorded_at", ""))
    try:
        ts = dt.datetime.fromisoformat(rec_at.replace("Z", "+00:00")).timestamp() + float(meta.get("duration", 0.0))
    except Exception:
        ts = mtime_ts

    team_a, team_b = [], []
    names_a, names_b = set(), set()
    for s in slots:
        rname = str(s.get("name", "")).strip()
        is_bot = bool(s.get("is_bot", False))
        key, _ = resolve_player_key(rname, None, is_bot, sid_latest_name, name_to_sid)
        base_nm, _ = strip_cpu_suffix(rname)
        tid = int(s["side"]) * set0_flip
        if tid == 1:
            team_a.append(key)
            if key != CPU_KEY:
                names_a.add(base_nm)
        else:
            team_b.append(key)
            if key != CPU_KEY:
                names_b.add(base_nm)

    ts_z = int(meta.get("team_size", 0))
    return (
        MatchRecord(
            source="vbr",
            source_id=source_id,
            ts=ts,
            mode=f"{ts_z}v{ts_z}" if ts_z else "",
            stage=str(meta.get("stage", "")),
            team_a=team_a,
            team_b=team_b,
            winner=winner,
            sets_a=sets_a,
            sets_b=sets_b,
            seed=meta.get("match_seed"),
            raw_names_a=names_a,
            raw_names_b=names_b,
        ),
        "kept",
    )


def load_vbr_matches(
    local_root: pathlib.Path | None,
    submissions_dir: pathlib.Path | None,
    include_local: bool,
    sid_latest_name: dict[str, str],
    name_to_sid: dict[str, str],
) -> tuple[list[MatchRecord], dict[str, int]]:
    records: list[MatchRecord] = []
    stats = Counter()

    if include_local and local_root and (local_root / "replays").exists():
        for p in sorted((local_root / "replays").glob("*.vbr")):
            stats["total_entries"] += 1
            meta, slots, events = read_vbr_meta_slots_events(p.read_bytes())
            rec, st = match_from_vbr_parsed(
                p.name, p.stat().st_mtime, meta, slots, events, sid_latest_name, name_to_sid
            )
            stats[st] += 1
            if rec:
                records.append(rec)

    if submissions_dir and submissions_dir.exists():
        for zp in sorted(submissions_dir.glob("*.zip")):
            try:
                with zipfile.ZipFile(zp, "r") as zf:
                    if "replays/vbr_replays.json" not in zf.namelist():
                        continue
                    entries = json.loads(zf.read("replays/vbr_replays.json").decode("utf-8"))
                    for item in entries:
                        stats["total_entries"] += 1
                        mt = item.get("mtime_utc", "")
                        try:
                            mt_ts = dt.datetime.fromisoformat(mt.replace("Z", "+00:00")).timestamp()
                        except Exception:
                            mt_ts = 0.0
                        src_id = f"{zp.name}:{item.get('file', 'unknown.vbr')}"
                        rec, st = match_from_vbr_parsed(
                            src_id,
                            mt_ts,
                            item.get("meta") or {},
                            item.get("slots") or [],
                            item.get("events") or [],
                            sid_latest_name,
                            name_to_sid,
                        )
                        stats[st] += 1
                        if rec:
                            records.append(rec)
            except Exception:
                continue

    return records, dict(stats)


def _hset(m: MatchRecord) -> frozenset[str]:
    return frozenset(p for p in (m.team_a + m.team_b) if p != CPU_KEY)


def check_pair_agreement(m1: MatchRecord, m2: MatchRecord, label: str) -> None:
    a1 = frozenset(p for p in m1.team_a if p != CPU_KEY)
    b1 = frozenset(p for p in m1.team_b if p != CPU_KEY)
    a2 = frozenset(p for p in m2.team_a if p != CPU_KEY)
    b2 = frozenset(p for p in m2.team_b if p != CPU_KEY)
    w1, l1 = (a1, b1) if m1.winner == "A" else (b1, a1)
    w2, l2 = (a2, b2) if m2.winner == "A" else (b2, a2)
    assert not (w1 & l2) and not (l1 & w2), f"Winner mismatch [{label}] {m1.source_id} vs {m2.source_id}"
    assert (w1 & w2) or (l1 & l2), f"No shared humans [{label}] {m1.source_id} vs {m2.source_id}"


def verify_and_deduplicate(
    prof_recs: list[MatchRecord],
    vbr_recs: list[MatchRecord],
    sess_recs: list[MatchRecord],
) -> tuple[list[MatchRecord], dict[str, int]]:
    overlaps = Counter()

    # Collapse duplicate VBR copies across submissions/local by seed (keeping richest human roster)
    vbr_by_seed: dict[int, MatchRecord] = {}
    dedup_vbr: list[MatchRecord] = []
    for vm in vbr_recs:
        if vm.seed is None:
            dedup_vbr.append(vm)
            continue
        prev = vbr_by_seed.get(vm.seed)
        if prev is None:
            vbr_by_seed[vm.seed] = vm
            dedup_vbr.append(vm)
        else:
            check_pair_agreement(prev, vm, "vbr<->vbr")
            overlaps["vbr_dup_seed"] += 1
            if len(_hset(vm)) > len(_hset(prev)):
                vbr_by_seed[vm.seed] = vm
                dedup_vbr[dedup_vbr.index(prev)] = vm

    sess_by_seed = {m.seed: m for m in sess_recs if m.seed is not None}
    for seed, vm in vbr_by_seed.items():
        if seed in sess_by_seed:
            check_pair_agreement(vm, sess_by_seed[seed], "vbr<->vbtsess")
            overlaps["vbr_vbtsess"] += 1

    matched_vbr_ids: set[str] = set()
    matched_sess_ids: set[str] = set()
    for pm in prof_recs:
        hp = _hset(pm)
        v_cands = [
            (abs(pm.ts - vm.ts), vm)
            for vm in dedup_vbr
            if vm.mode == pm.mode and abs(pm.ts - vm.ts) <= 120 and len(hp & _hset(vm)) >= 1
        ]
        if v_cands:
            v_cands.sort(key=lambda x: x[0])
            _, vm = v_cands[0]
            check_pair_agreement(pm, vm, "profiles<->vbr")
            matched_vbr_ids.add(vm.source_id)
            overlaps["profiles_vbr"] += 1

        s_cands = [
            (abs(pm.ts - sm.ts), sm)
            for sm in sess_recs
            if sm.mode == pm.mode and abs(pm.ts - sm.ts) <= 180 and len(hp & _hset(sm)) >= 2
        ]
        if s_cands:
            s_cands.sort(key=lambda x: x[0])
            _, sm = s_cands[0]
            check_pair_agreement(pm, sm, "profiles<->vbtsess")
            matched_sess_ids.add(sm.source_id)
            overlaps["profiles_vbtsess"] += 1

    merged: list[MatchRecord] = []
    seen_seeds: set[int] = set()
    for vm in dedup_vbr:
        if vm.source_id in matched_vbr_ids and vm.seed is not None:
            seen_seeds.add(vm.seed)
    for sm in sess_recs:
        if sm.source_id in matched_sess_ids and sm.seed is not None:
            seen_seeds.add(sm.seed)

    merged.extend(prof_recs)
    for vm in dedup_vbr:
        if vm.source_id in matched_vbr_ids or (vm.seed is not None and vm.seed in seen_seeds):
            continue
        chosen = vm
        if vm.seed is not None:
            seen_seeds.add(vm.seed)
            if vm.seed in sess_by_seed and sess_by_seed[vm.seed].source_id not in matched_sess_ids:
                sm = sess_by_seed[vm.seed]
                if len(_hset(sm)) > len(_hset(vm)):
                    chosen = sm
        merged.append(chosen)

    for sm in sess_recs:
        if sm.source_id in matched_sess_ids or (sm.seed is not None and sm.seed in seen_seeds):
            continue
        if sm.seed is not None:
            seen_seeds.add(sm.seed)
        merged.append(sm)

    final_matches: list[MatchRecord] = []
    for m in merged:
        if not [k for k in m.team_a if k != CPU_KEY] or not [k for k in m.team_b if k != CPU_KEY]:
            overlaps["excluded_all_cpu_side"] += 1
            continue
        final_matches.append(m)

    final_matches.sort(key=lambda x: x.ts)
    return final_matches, dict(overlaps)



from vbt_ingest import extract_pbp_rallies, load_vbtsess_matches  # noqa: E402,F401
