"""Optional local VBT telemetry (.vbtsess) ingestion for Just Volleyball."""

from __future__ import annotations

import datetime as dt
import json
import pathlib
import struct
from collections import Counter, defaultdict

try:
    import zstandard as zstd
except ImportError:
    zstd = None

import ingest as _ing

def load_vbtsess_matches(
    local_root: pathlib.Path | None,
    include_local: bool,
    sid_latest_name: dict[str, str],
    name_to_sid: dict[str, str],
) -> tuple[list[MatchRecord], dict[str, int]]:
    if not (include_local and local_root and (local_root / "vbt").exists() and zstd is not None):
        return [], {}
    dctx = zstd.ZstdDecompressor()
    records: list[MatchRecord] = []
    stats = Counter()

    for p in sorted((local_root / "vbt").rglob("*.vbtsess")):
        stats["total_files"] += 1
        with open(p, "rb") as f:
            if f.read(4) != b"VBT1":
                stats["skipped_bad_magic"] += 1
                continue
            _, _, hlen = struct.unpack("<HHI", f.read(8))
            hdr = json.loads(f.read(hlen).decode("utf-8"))
            meta = hdr.get("meta", {})
            if not meta.get("online"):
                stats["skipped_offline"] += 1
                continue
            if meta.get("practice"):
                stats["skipped_practice"] += 1
                continue

            wb = hdr["layout"]["blocks"]["world"]
            w_off = wb["offset"]
            fmap = {fld["n"]: fld["o"] for fld in wb["fields"]}
            first_world = None
            rally_ends = []

            while True:
                ch = f.read(56)
                if len(ch) < 56:
                    break
                magic, _, _, _, _, fraw, fcomp, eraw, ecomp = struct.unpack("<4sIqIIIIII", ch[:40])
                if magic != b"CHNK":
                    break
                if first_world is None and fcomp > 0:
                    fpay = f.read(fcomp)
                    if len(fpay) < fcomp:
                        break
                    raw = dctx.decompress(fpay, max_output_size=fraw)
                    first_world = (
                        struct.unpack_from("<i", raw, w_off + fmap["@score_p"])[0],
                        struct.unpack_from("<i", raw, w_off + fmap["@score_n"])[0],
                        struct.unpack_from("<i", raw, w_off + fmap["@sets_p"])[0],
                        struct.unpack_from("<i", raw, w_off + fmap["@sets_n"])[0],
                    )
                else:
                    f.seek(fcomp, 1)
                epay = f.read(ecomp)
                if len(epay) < ecomp:
                    break
                if ecomp > 0:
                    for ev in json.loads(dctx.decompress(epay, max_output_size=eraw)):
                        if ev.get("type") == "rally_end":
                            rally_ends.append(ev)

        if first_world != (0, 0, 0, 0):
            stats["skipped_midmatch_join"] += 1
            continue

        sp = int(meta.get("set_points", 15))
        stw = int(meta.get("sets_to_win", 2))
        pol = 1
        sA = sB = setsA = setsB = 0
        for ev in rally_ends:
            w = int(ev.get("winner", 0))
            if w == 0:
                continue
            if w * pol == 1:
                sA += 1
            else:
                sB += 1
            if (sA >= sp or sB >= sp) and abs(sA - sB) >= 2:
                if sA > sB:
                    setsA += 1
                else:
                    setsB += 1
                sA = sB = 0
                if setsA < stw and setsB < stw:
                    pol *= -1

        if not ((setsA == stw or setsB == stw) and sA == 0 and sB == 0 and setsA <= stw and setsB <= stw):
            stats["skipped_incomplete"] += 1
            continue

        swap_factor = (-1) ** (setsA + setsB - 1)
        team_a, team_b = [], []
        names_a, names_b = set(), set()
        for ent in hdr.get("entities", []):
            init_side = int(ent["side"]) * swap_factor
            rname = str(ent.get("name", "")).strip()
            is_bot = bool(ent.get("is_bot", False))
            key, _ = _ing.resolve_player_key(rname, None, is_bot, sid_latest_name, name_to_sid)
            base_nm, _ = _ing.strip_cpu_suffix(rname)
            if init_side == 1:
                team_a.append(key)
                if key != _ing.CPU_KEY:
                    names_a.add(base_nm)
            else:
                team_b.append(key)
                if key != _ing.CPU_KEY:
                    names_b.add(base_nm)

        stem_parts = p.stem.split("_")
        ts = dt.datetime.strptime(f"{stem_parts[0]}_{stem_parts[1]}", "%Y-%m-%d_%H-%M-%S").timestamp()
        ts = max(ts, p.stat().st_mtime)
        ts_z = int(meta.get("team_size", 0))
        records.append(
            _ing.MatchRecord(
                source="vbtsess",
                source_id=p.name,
                ts=ts,
                mode=f"{ts_z}v{ts_z}" if ts_z else "",
                stage=str(meta.get("stage", "")),
                team_a=team_a,
                team_b=team_b,
                winner="A" if setsA > setsB else "B",
                sets_a=setsA,
                sets_b=setsB,
                seed=meta.get("match_seed"),
                raw_names_a=names_a,
                raw_names_b=names_b,
            )
        )
        stats["kept"] += 1
    return records, dict(stats)



def _read_vbtsess_all_events(path: pathlib.Path) -> tuple[dict, list[dict]] | None:
    dctx = zstd.ZstdDecompressor()
    with open(path, "rb") as f:
        if f.read(4) != b"VBT1":
            return None
        _, _, hlen = struct.unpack("<HHI", f.read(8))
        hdr = json.loads(f.read(hlen).decode("utf-8"))
        meta = hdr.get("meta", {})
        if not meta.get("online") or meta.get("practice"):
            return None
        evs: list[dict] = []
        while True:
            ch = f.read(56)
            if len(ch) < 56:
                break
            magic, _, _, _, _, _, fcomp, eraw, ecomp = struct.unpack("<4sIqIIIIII", ch[:40])
            if magic != b"CHNK":
                break
            f.seek(fcomp, 1)
            epay = f.read(ecomp)
            if len(epay) < ecomp:
                break
            if ecomp > 0:
                evs.extend(json.loads(dctx.decompress(epay, max_output_size=eraw)))
    return hdr, evs


def extract_pbp_rallies(
    local_root: pathlib.Path | None,
    include_local: bool,
    sid_latest: dict[str, str],
    name_to_sid: dict[str, str],
) -> dict:
    if not (include_local and local_root and (local_root / "vbt").exists() and zstd is not None):
        return {"rallies": [], "stats": {}}

    candidates: dict[str, list[tuple[int, pathlib.Path, dict, list[dict]]]] = defaultdict(list)
    stats = Counter()
    for p in sorted((local_root / "vbt").rglob("*.vbtsess")):
        res = _read_vbtsess_all_events(p)
        if res is None:
            stats["skipped_offline_or_practice"] += 1
            continue
        hdr, evs = res
        stats["online_files"] += 1
        seed = hdr.get("meta", {}).get("match_seed")
        dedup_key = f"seed_{seed}" if seed is not None else f"file_{p.name}"
        re_cnt = sum(1 for e in evs if e.get("type") == "rally_end")
        candidates[dedup_key].append((re_cnt, p, hdr, evs))

    selected = []
    for lst in candidates.values():
        lst.sort(key=lambda x: (x[0], x[1].stat().st_size), reverse=True)
        selected.append(lst[0])
        if len(lst) > 1:
            stats["deduped_seed_copies"] += len(lst) - 1

    rallies_out: list[dict] = []
    contact_ok = contact_mismatch = 0
    for _, p, hdr, evs in sorted(selected, key=lambda x: x[1].name):
        meta = hdr.get("meta", {})
        seed = meta.get("match_seed")
        ts_z = int(meta.get("team_size", 0))
        mode = f"{ts_z}v{ts_z}" if ts_z else ""
        session_ts = p.stat().st_mtime
        evs_sorted = sorted(enumerate(evs), key=lambda x: (int(x[1].get("t", 0)), x[0]))

        active_slots: dict[int, dict] = {}
        last_global_switch_t = -10**9
        cur_contacts: list[dict] = []
        rally_idx = side_touch_no = last_touch_side = 0
        rally_has_mismatch = False

        for _, ev in evs_sorted:
            et = ev.get("type")
            t = int(ev.get("t", 0))
            if et == "slot_assign":
                sl = int(ev.get("slot", -1))
                ent = ev.get("entity") or {}
                if sl >= 0 and ent:
                    rname = str(ent.get("name", "")).strip()
                    key, disp = _ing.resolve_player_key(rname, None, bool(ent.get("is_bot", False)), sid_latest, name_to_sid)
                    active_slots[sl] = {"key": key, "name": disp, "side": int(ent.get("side", 0))}
            elif et == "slot_release":
                active_slots.pop(int(ev.get("slot", -1)), None)
            elif et == "side_switch":
                sl = int(ev.get("slot", -1))
                is_global = (sl == -1) or (
                    sl in active_slots and "side" in ev and active_slots[sl]["side"] != 0
                    and int(ev["side"]) == -active_slots[sl]["side"]
                )
                if is_global and t - last_global_switch_t > 60:
                    for info in active_slots.values():
                        info["side"] = -info["side"]
                    last_global_switch_t = t
            elif et == "rally_start":
                cur_contacts, side_touch_no, last_touch_side, rally_has_mismatch = [], 0, 0, False
            elif et == "contact":
                sl = int(ev.get("slot", -1))
                c_side = int(ev.get("side", 0))
                kind = str(ev.get("kind", "other"))
                if sl >= 0 and sl in active_slots:
                    s_info = active_slots[sl]
                    if c_side != 0 and s_info["side"] != 0:
                        if c_side == s_info["side"]:
                            contact_ok += 1
                        else:
                            contact_mismatch += 1
                            rally_has_mismatch = True
                    p_key, p_name = s_info["key"], s_info["name"]
                    p_side = c_side if c_side != 0 else s_info["side"]
                else:
                    p_key, p_name, p_side = None, None, c_side

                if kind == "block":
                    side_touch_no = last_touch_side = 0
                else:
                    side_touch_no = (side_touch_no + 1) if p_side == last_touch_side else 1
                    last_touch_side = p_side

                cur_contacts.append(
                    {
                        "key": p_key,
                        "name": p_name,
                        "side": p_side,
                        "kind": kind,
                        "touch_no": side_touch_no,
                        "power": round(float(ev.get("power", 0.0)), 4),
                        "is_float": bool(ev.get("float", False)),
                    }
                )
            elif et == "rally_end":
                winner = int(ev.get("winner", 0))
                reason = str(ev.get("reason", ""))
                team_pos = [v["key"] for v in active_slots.values() if v["side"] == 1]
                team_neg = [v["key"] for v in active_slots.values() if v["side"] == -1]
                has_pos = any(k != _ing.CPU_KEY for k in team_pos)
                has_neg = any(k != _ing.CPU_KEY for k in team_neg)
                if winner in (1, -1) and not rally_has_mismatch and has_pos and has_neg and cur_contacts:
                    rally_idx += 1
                    rallies_out.append(
                        {
                            "rally_id": f"{p.stem}#{rally_idx}",
                            "session": p.name,
                            "seed": seed,
                            "ts": round(session_ts, 1),
                            "mode": mode,
                            "team_pos": team_pos,
                            "team_neg": team_neg,
                            "winner_side": winner,
                            "reason": reason,
                            "contacts": cur_contacts,
                        }
                    )
                    stats["rallies_kept"] += 1
                else:
                    stats["rallies_skipped"] += 1
                cur_contacts, side_touch_no, last_touch_side, rally_has_mismatch = [], 0, 0, False

    checked = contact_ok + contact_mismatch
    if checked and (contact_mismatch / checked) > 0.05:
        raise AssertionError(f"Contact side mismatch rate too high: {contact_mismatch}/{checked}")
    return {"rallies": rallies_out, "stats": dict(stats)}
