"""Compute Spiker, Setter (S-Eff, S-VPM), and Libero (L-Eff, L-VPM, SR-Eff, Dig-Eff)
role metrics using 5-fold session-grouped out-of-fold DataVolley pass-grade,
set-delivery, and standard non-terminal Markov models.
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from typing import Any

import numpy as np
from sklearn.linear_model import Ridge

CPU_KEY = "CPU::[CPU]"
N_FOLDS = 5

PRIOR_M_KIND = 5.0
PRIOR_M_TOUCH = 20.0
PRIOR_M_STATE = 40.0

GRADE_PRIOR_M = 15.0
CTX_PRIOR_M = 15.0
ROLE_EFF_SHRINK = 40.0
SUBSKILL_SHRINK = 25.0
ROLE_VPM_SHRINK = 150.0

HARD_DIG_INCOMING = {"attack", "tip", "dump", "block"}
ATTACK_KINDS = {"attack", "tip", "dump"}


def _is_human(key: str | None) -> bool:
    return bool(key) and not str(key).startswith("CPU::")


def _short_id(key: str) -> str:
    return "…" + key.split("::", 1)[1][-4:] if key.startswith("SID::") else "unlinked"


def _clean_num(val: float | None, ndigits: int = 3) -> float | None:
    if val is None:
        return None
    f = float(val)
    if not math.isfinite(f):
        raise ValueError(f"Non-finite numeric value detected: {val}")
    return round(f, ndigits)


def _cap_touch(kind: str, touch_no: int) -> int:
    if kind == "block":
        return 0
    if kind == "serve":
        return 1
    return min(max(int(touch_no), 1), 3)


def fit_power_cuts(rallies: list[dict[str, Any]], nonterm_only: bool = True) -> dict[str, tuple[float, float] | None]:
    kind_powers: dict[str, list[float]] = defaultdict(list)
    for r in rallies:
        cs = r["contacts"]
        last_idx = len(cs) - 1
        for i, c in enumerate(cs):
            if nonterm_only and i == last_idx:
                continue
            if c["kind"] == "serve" and c.get("is_float"):
                continue
            kind_powers[c["kind"]].append(float(c.get("power", 0.0)))
    cuts: dict[str, tuple[float, float] | None] = {}
    for k, vals in kind_powers.items():
        if len(vals) < 30:
            cuts[k] = None
            continue
        vals.sort()
        n = len(vals)
        cuts[k] = (vals[n // 3], vals[(2 * n) // 3])
    return cuts


def power_bin(contact: dict[str, Any], cuts: dict[str, tuple[float, float] | None]) -> str:
    kind = contact["kind"]
    if kind == "serve" and contact.get("is_float"):
        return "float"
    q = cuts.get(kind)
    if q is None:
        return "all"
    q33, q67 = q
    p = float(contact.get("power", 0.0))
    if q33 == q67:
        return "base" if p <= q33 else "high"
    if p <= q33:
        return "low"
    if p <= q67:
        return "mid"
    return "high"


def fit_std_markov_oof(rallies: list[dict[str, Any]], sess_fold: dict[str, int]) -> list[list[float]]:
    """5-fold session-grouped OOF standard non-terminal Markov contact EPA."""
    out_epas: list[list[float]] = [[] for _ in rallies]
    for fold in range(N_FOLDS):
        tr = [r for r in rallies if sess_fold[r["session"]] != fold]
        if not tr:
            tr = rallies
        cuts = fit_power_cuts(tr, nonterm_only=True)
        c_kind: dict[str, list[int]] = defaultdict(lambda: [0, 0])
        c_kt: dict[tuple[str, int], list[int]] = defaultdict(lambda: [0, 0])
        c_state: dict[tuple[str, int, str], list[int]] = defaultdict(lambda: [0, 0])
        start_w = sum(1 for r in tr if r["contacts"] and r["contacts"][0]["side"] == r["winner_side"])
        v_start = start_w / max(1, len(tr))
        for r in tr:
            cs = r["contacts"]
            w = r["winner_side"]
            for i in range(len(cs) - 1):
                c = cs[i]
                won = 1 if c["side"] == w else 0
                k = c["kind"]
                t = _cap_touch(k, c["touch_no"])
                pb = power_bin(c, cuts)
                c_kind[k][0] += won; c_kind[k][1] += 1
                c_kt[(k, t)][0] += won; c_kt[(k, t)][1] += 1
                c_state[(k, t, pb)][0] += won; c_state[(k, t, pb)][1] += 1

        def lookup_v(c: dict[str, Any]) -> float:
            k = c["kind"]
            t = _cap_touch(k, c["touch_no"])
            pb = power_bin(c, cuts)
            kw, kn = c_kind.get(k, (0, 0))
            vk = (kw + PRIOR_M_KIND * 0.5) / (kn + PRIOR_M_KIND)
            ktw, ktn = c_kt.get((k, t), (0, 0))
            vkt = (ktw + PRIOR_M_TOUCH * vk) / (ktn + PRIOR_M_TOUCH)
            sw, sn = c_state.get((k, t, pb), (0, 0))
            return (sw + PRIOR_M_STATE * vkt) / (sn + PRIOR_M_STATE)

        for r_idx, r in enumerate(rallies):
            if sess_fold[r["session"]] != fold:
                continue
            cs = r["contacts"]
            w = r["winner_side"]
            last_idx = len(cs) - 1
            v_prev = v_start
            prev_side = cs[0]["side"]
            epas: list[float] = []
            for i, c in enumerate(cs):
                s = c["side"]
                vb = v_prev if s == prev_side else (1.0 - v_prev)
                va = (1.0 if s == w else 0.0) if i == last_idx else lookup_v(c)
                epas.append(va - vb)
                v_prev = va
                prev_side = s
            out_epas[r_idx] = epas
    return out_epas


def pass_grade_dv(cs: list[dict[str, Any]], i: int, winner_side: int) -> str:
    """DataVolley-style 1st-contact pass grade (non-block cross-net)."""
    L = len(cs)
    c = cs[i]
    side = c["side"]
    kind = c["kind"]
    if i == L - 1:
        return "G_overpass_nt" if side == winner_side else "G0_err"
    if kind in ("shank", "carom"):
        return "G1_shank_alive"
    n1 = cs[i + 1]
    if n1["side"] != side:
        return "G_overpass_nt"
    nk = n1["kind"]
    if nk in ("dump", "attack"):
        return "G3_insys_att"
    if nk == "set":
        if i + 2 < L and cs[i + 2]["side"] == side:
            n2k = cs[i + 2]["kind"]
            if n2k in ("attack", "dump"):
                return "G3_insys_att"
            if n2k == "tip":
                return "G2_insys_tip"
            return "G1_oos"
        return "G2_set_neutral"
    if nk == "tip":
        return "G2_insys_tip"
    return "G1_oos"


def setter_grade(cs: list[dict[str, Any]], i: int, winner_side: int) -> str:
    """Setter action outcome grade covering set (touch 1-2) and dump (touch 2)."""
    L = len(cs)
    c = cs[i]
    side = c["side"]
    if c["kind"] == "dump":
        if i == L - 1:
            return "D_win" if side == winner_side else "D_err"
        return "D_alive"
    if i == L - 1:
        return "S_win" if side == winner_side else "S_err"
    n1 = cs[i + 1]
    if n1["side"] != side:
        return "S_overpass"
    nk = n1["kind"]
    if nk in ("attack", "dump"):
        return "S_att"
    if nk == "tip":
        return "S_tip"
    if nk == "set":
        return "S_reset"
    return "S_oos"


def is_libero_contact(cs: list[dict[str, Any]], i: int) -> bool:
    return i > 0 and cs[i - 1]["side"] != cs[i]["side"] and cs[i]["kind"] != "block"


def is_setter_contact(c: dict[str, Any]) -> bool:
    return (c["kind"] == "set" and c["touch_no"] in (1, 2)) or (
        c["kind"] == "dump" and c["touch_no"] == 2
    )


def fit_role_fold(
    tr: list[dict[str, Any]], fold: int, check_invariants: bool
) -> tuple[dict[str, tuple[float, float] | None], dict[str, float], dict[str, float], Any, Any]:
    cuts = fit_power_cuts(tr, nonterm_only=False)

    pg_cnt: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    set_nt_w = 0
    set_nt_n = 0
    sg_cnt: dict[str, list[int]] = defaultdict(lambda: [0, 0])

    for r in tr:
        cs = r["contacts"]
        w = r["winner_side"]
        L = len(cs)
        for i, c in enumerate(cs):
            won = 1 if c["side"] == w else 0
            if is_libero_contact(cs, i):
                g = pass_grade_dv(cs, i, w)
                if not (g == "G_overpass_nt" and i == L - 1):
                    pg_cnt[g][0] += won
                    pg_cnt[g][1] += 1
                if i + 1 < L and cs[i + 1]["side"] == c["side"] and cs[i + 1]["kind"] == "set" and i + 2 < L:
                    set_nt_w += won
                    set_nt_n += 1
            if is_setter_contact(c):
                sg = setter_grade(cs, i, w)
                sg_cnt[sg][0] += won
                sg_cnt[sg][1] += 1

    v_set_nt = set_nt_w / max(1, set_nt_n)
    v_pg_map: dict[str, float] = {"G0_err": 0.0, "G2_set_neutral": v_set_nt}
    for g in ("G3_insys_att", "G2_insys_tip", "G1_oos", "G1_shank_alive", "G_overpass_nt"):
        ww, nn = pg_cnt.get(g, (0, 0))
        v_pg_map[g] = (ww + GRADE_PRIOR_M * 0.5) / (nn + GRADE_PRIOR_M)

    v_sg_map: dict[str, float] = {"S_err": 0.0, "D_err": 0.0, "S_win": 1.0, "D_win": 1.0}
    for sg in ("S_att", "S_tip", "S_reset", "S_oos", "S_overpass", "D_alive"):
        ww, nn = sg_cnt.get(sg, (0, 0))
        v_sg_map[sg] = (ww + GRADE_PRIOR_M * 0.5) / (nn + GRADE_PRIOR_M)

    if check_invariants:
        assert (
            v_pg_map["G3_insys_att"]
            > v_pg_map["G2_insys_tip"]
            > v_pg_map["G1_oos"]
            > v_pg_map["G0_err"]
            == 0.0
        ) and (
            v_pg_map["G3_insys_att"] > v_pg_map["G_overpass_nt"] > v_pg_map["G1_oos"]
        ), f"Fold {fold} Libero grade monotonicity failed: {v_pg_map}"
        assert (
            v_sg_map["D_win"]
            == 1.0
            > v_sg_map["S_att"]
            > v_sg_map["S_tip"]
            > v_sg_map["S_oos"]
            > v_sg_map["S_err"]
            == 0.0
        ), f"Fold {fold} Setter grade monotonicity failed: {v_sg_map}"

    lib_h_all = [0.0, 0]
    lib_h_k: dict[str, list[Any]] = defaultdict(lambda: [0.0, 0])
    lib_h_kp: dict[tuple[str, str], list[Any]] = defaultdict(lambda: [0.0, 0])

    set_h_all = [0.0, 0]
    set_h_k: dict[tuple[bool, str], list[Any]] = defaultdict(lambda: [0.0, 0])
    set_h_kp: dict[tuple[bool, str, str], list[Any]] = defaultdict(lambda: [0.0, 0])

    for r in tr:
        cs = r["contacts"]
        w = r["winner_side"]
        for i, c in enumerate(cs):
            if not _is_human(c.get("key")):
                continue
            if is_libero_contact(cs, i):
                vg = v_pg_map[pass_grade_dv(cs, i, w)]
                pc = cs[i - 1]
                pk_kind = pc["kind"]
                pb = power_bin(pc, cuts)
                lib_h_all[0] += vg; lib_h_all[1] += 1
                lib_h_k[pk_kind][0] += vg; lib_h_k[pk_kind][1] += 1
                lib_h_kp[(pk_kind, pb)][0] += vg; lib_h_kp[(pk_kind, pb)][1] += 1
            if is_setter_contact(c):
                vsg = v_sg_map[setter_grade(cs, i, w)]
                if i > 0:
                    pc = cs[i - 1]
                    same = (pc["side"] == c["side"])
                    pk_kind = pc["kind"]
                    pb = power_bin(pc, cuts)
                else:
                    same, pk_kind, pb = False, "none", "all"
                set_h_all[0] += vsg; set_h_all[1] += 1
                set_h_k[(same, pk_kind)][0] += vsg; set_h_k[(same, pk_kind)][1] += 1
                set_h_kp[(same, pk_kind, pb)][0] += vsg; set_h_kp[(same, pk_kind, pb)][1] += 1

    g_lib_h = lib_h_all[0] / max(1, lib_h_all[1])
    g_set_h = set_h_all[0] / max(1, set_h_all[1])

    if check_invariants:
        lib_insample_resid = sum(
            v_pg_map[pass_grade_dv(r["contacts"], i, r["winner_side"])]
            - (
                lib_h_kp[(r["contacts"][i - 1]["kind"], power_bin(r["contacts"][i - 1], cuts))][0]
                / lib_h_kp[(r["contacts"][i - 1]["kind"], power_bin(r["contacts"][i - 1], cuts))][1]
            )
            for r in tr
            for i, c in enumerate(r["contacts"])
            if _is_human(c.get("key")) and is_libero_contact(r["contacts"], i)
        )
        assert abs(lib_insample_resid) < 1e-9, f"In-sample Libero residual != 0: {lib_insample_resid}"

    def e_lib(pc: dict[str, Any]) -> float:
        k = pc["kind"]
        pb = power_bin(pc, cuts)
        sk, nk = lib_h_k.get(k, (0.0, 0))
        pk = (sk + CTX_PRIOR_M * g_lib_h) / (nk + CTX_PRIOR_M)
        sc, nc = lib_h_kp.get((k, pb), (0.0, 0))
        return (sc + CTX_PRIOR_M * pk) / (nc + CTX_PRIOR_M)

    def e_set(cs: list[dict[str, Any]], i: int) -> float:
        if i == 0:
            same, k, pb = False, "none", "all"
        else:
            pc = cs[i - 1]
            same = (pc["side"] == cs[i]["side"])
            k = pc["kind"]
            pb = power_bin(pc, cuts)
        sk, nk = set_h_k.get((same, k), (0.0, 0))
        pk = (sk + CTX_PRIOR_M * g_set_h) / (nk + CTX_PRIOR_M)
        sc, nc = set_h_kp.get((same, k, pb), (0.0, 0))
        return (sc + CTX_PRIOR_M * pk) / (nc + CTX_PRIOR_M)

    return cuts, v_pg_map, v_sg_map, e_lib, e_set


def split_half_corr(evs: list[tuple[int, str, float]], min_each: int = 15) -> tuple[float, float, int] | None:
    es: dict[str, float] = defaultdict(float)
    en: Counter[str] = Counter()
    os: dict[str, float] = defaultdict(float)
    on: Counter[str] = Counter()
    for r_idx, key, val in evs:
        if r_idx % 2 == 0:
            es[key] += val; en[key] += 1
        else:
            os[key] += val; on[key] += 1
    ks = [k for k in en if en[k] >= min_each and on[k] >= min_each]
    if len(ks) < 3:
        return None
    a = np.array([es[k] / en[k] for k in ks], dtype=np.float64)
    b = np.array([os[k] / on[k] for k in ks], dtype=np.float64)
    if np.std(a) < 1e-12 or np.std(b) < 1e-12:
        return None
    r = float(np.corrcoef(a, b)[0, 1])
    sb = 2.0 * r / (1.0 + r) if r > -1.0 else 0.0
    return round(r, 3), round(sb, 3), len(ks)


def hitter_adj_ridge_split_half(
    att_pairs: list[tuple[int, str, str, tuple[Any, ...], float]], alpha: float = 30.0
) -> tuple[float, float, int] | None:
    def fit_half(sub):
        setters = sorted({e[1] for e in sub})
        hitters = sorted({e[2] for e in sub})
        ctxs = sorted({e[3] for e in sub})
        si = {k: i for i, k in enumerate(setters)}
        hi = {k: len(setters) + i for i, k in enumerate(hitters)}
        ci = {k: len(setters) + len(hitters) + i for i, k in enumerate(ctxs)}
        X = np.zeros((len(sub), len(setters) + len(hitters) + len(ctxs)), dtype=np.float64)
        y = np.zeros(len(sub), dtype=np.float64)
        for row, e in enumerate(sub):
            X[row, si[e[1]]] = 1.0
            X[row, hi[e[2]]] = 1.0
            X[row, ci[e[3]]] = 1.0
            y[row] = e[4] * 100.0
        reg = Ridge(alpha=alpha, fit_intercept=True).fit(X, y)
        return {s: float(reg.coef_[si[s]]) for s in setters}

    even_ev = [e for e in att_pairs if e[0] % 2 == 0]
    odd_ev = [e for e in att_pairs if e[0] % 2 == 1]
    if len(even_ev) < 20 or len(odd_ev) < 20:
        return None
    ec = Counter(e[1] for e in even_ev)
    oc = Counter(e[1] for e in odd_ev)
    ks = [k for k in ec if ec[k] >= 15 and oc[k] >= 15]
    if len(ks) < 3:
        return None
    se = fit_half(even_ev)
    so = fit_half(odd_ev)
    a = np.array([se[k] for k in ks], dtype=np.float64)
    b = np.array([so[k] for k in ks], dtype=np.float64)
    if np.std(a) < 1e-12 or np.std(b) < 1e-12:
        return None
    r = float(np.corrcoef(a, b)[0, 1])
    sb = 2.0 * r / (1.0 + r) if r > -1.0 else 0.0
    return round(r, 3), round(sb, 3), len(ks)


def _corr_pair(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 3:
        return None
    ax = np.array(xs, dtype=np.float64)
    ay = np.array(ys, dtype=np.float64)
    if np.std(ax) < 1e-12 or np.std(ay) < 1e-12:
        return None
    return round(float(np.corrcoef(ax, ay)[0, 1]), 3)


def compute_role_metrics(
    rallies: list[dict[str, Any]],
    box_matches: list[dict[str, Any]],
    pbp_rows: list[dict[str, Any]],
    mmr_key_to_idx: dict[str, int],
    display_names: dict[str, str],
) -> dict[str, Any]:
    """Compute Spiker, Setter, and Libero role ratings and validation telemetry."""
    check_invariants = len(rallies) >= 1000
    vpm_map = {r["key"]: r for r in pbp_rows}

    box_setter: dict[str, dict[str, int]] = defaultdict(lambda: {"set": 0, "ast": 0})
    for m in box_matches:
        for pl in m["players"]:
            k = pl["key"]
            if not _is_human(k):
                continue
            box_setter[k]["set"] += int(pl["set"])
            box_setter[k]["ast"] += int(pl["ast"])

    sessions = sorted({r["session"] for r in rallies})
    sess_fold = {s: idx % N_FOLDS for idx, s in enumerate(sessions)}
    oof_std_epas = fit_std_markov_oof(rallies, sess_fold)

    p_rallies: Counter[str] = Counter()
    p_touches: Counter[str] = Counter()
    p_names: dict[str, str] = {}
    p_blk_epa: dict[str, float] = defaultdict(float)
    p_blk_n: Counter[str] = Counter()
    p_fc_std_epa: dict[str, float] = defaultdict(float)

    lib_acc: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"fc_n": 0, "sr_n": 0, "dig_n": 0, "sum_delta": 0.0, "sr_delta": 0.0, "dig_delta": 0.0, "g3": 0, "clean": 0, "err": 0, "sc": 0}
    )
    set_acc: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"act": 0, "sets": 0, "dumps": 0, "sum_delta": 0.0, "dump_delta": 0.0, "attable": 0, "err": 0, "tm_att": 0, "tm_kill": 0, "tm_err": 0}
    )
    spk_acc: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"att_n": 0, "spk_n": 0, "tip_n": 0, "sum_epa": 0.0, "true_kills": 0, "att_err": 0}
    )

    ev_lib_eff: list[tuple[int, str, float]] = []
    ev_lib_std: list[tuple[int, str, float]] = []
    ev_lib_sr: list[tuple[int, str, float]] = []
    ev_lib_dig: list[tuple[int, str, float]] = []
    ev_lib_sc: list[tuple[int, str, float]] = []

    ev_set_eff: list[tuple[int, str, float]] = []
    ev_set_std: list[tuple[int, str, float]] = []
    ev_set_attable: list[tuple[int, str, float]] = []
    att_pairs: list[tuple[int, str, str, tuple[Any, ...], float]] = []

    ev_spk_epa: list[tuple[int, str, float]] = []
    ev_spk_hit: list[tuple[int, str, float]] = []

    overall_pg_cnt: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    overall_sg_cnt: dict[str, list[int]] = defaultdict(lambda: [0, 0])

    for fold in range(N_FOLDS):
        tr = [r for r in rallies if sess_fold[r["session"]] != fold]
        if not tr:
            tr = rallies
        cuts, v_pg_map, v_sg_map, e_lib, e_set = fit_role_fold(tr, fold, check_invariants)

        for r_idx, r in enumerate(rallies):
            if sess_fold[r["session"]] != fold:
                continue
            cs = r["contacts"]
            w = r["winner_side"]
            L = len(cs)
            std_epas = oof_std_epas[r_idx]

            for k in set(r["team_pos"] + r["team_neg"]):
                if _is_human(k):
                    p_rallies[k] += 1

            for i, c in enumerate(cs):
                k = c.get("key")
                kind = c["kind"]
                side = c["side"]
                won = 1 if side == w else 0

                if is_libero_contact(cs, i):
                    g = pass_grade_dv(cs, i, w)
                    if not (g == "G_overpass_nt" and i == L - 1):
                        overall_pg_cnt[g][0] += won
                        overall_pg_cnt[g][1] += 1
                if is_setter_contact(c):
                    sg = setter_grade(cs, i, w)
                    overall_sg_cnt[sg][0] += won
                    overall_sg_cnt[sg][1] += 1

                if not _is_human(k):
                    continue
                p_touches[k] += 1
                if c.get("name"):
                    p_names[k] = c["name"]

                if kind == "block":
                    p_blk_epa[k] += std_epas[i]
                    p_blk_n[k] += 1

                if is_libero_contact(cs, i):
                    pc = cs[i - 1]
                    g = pass_grade_dv(cs, i, w)
                    delta = v_pg_map[g] - e_lib(pc)
                    is_sr = pc["kind"] == "serve"
                    is_dig = pc["kind"] in HARD_DIG_INCOMING
                    is_sc = int(kind in ("shank", "carom"))
                    is_err = int(g == "G0_err")
                    is_clean = int(not is_err and not is_sc)
                    is_g3 = int(g == "G3_insys_att")

                    a = lib_acc[k]
                    a["fc_n"] += 1
                    a["sum_delta"] += delta
                    a["g3"] += is_g3
                    a["clean"] += is_clean
                    a["err"] += is_err
                    a["sc"] += is_sc
                    if is_sr:
                        a["sr_n"] += 1
                        a["sr_delta"] += delta
                        ev_lib_sr.append((r_idx, k, delta))
                    if is_dig:
                        a["dig_n"] += 1
                        a["dig_delta"] += delta
                        ev_lib_dig.append((r_idx, k, delta))

                    p_fc_std_epa[k] += std_epas[i]
                    ev_lib_eff.append((r_idx, k, delta))
                    ev_lib_std.append((r_idx, k, std_epas[i]))
                    ev_lib_sc.append((r_idx, k, float(is_sc)))

                if is_setter_contact(c):
                    sg = setter_grade(cs, i, w)
                    delta = v_sg_map[sg] - e_set(cs, i)
                    is_dump = kind == "dump"
                    is_attable = int(sg in ("S_att", "D_win", "D_alive"))
                    is_err = int(sg in ("S_err", "D_err"))

                    sa = set_acc[k]
                    sa["act"] += 1
                    sa["sum_delta"] += delta
                    sa["attable"] += is_attable
                    sa["err"] += is_err
                    if is_dump:
                        sa["dumps"] += 1
                        sa["dump_delta"] += delta
                    else:
                        sa["sets"] += 1
                        if i + 1 < L:
                            nc = cs[i + 1]
                            if nc["side"] == side and nc["kind"] in ATTACK_KINDS:
                                sa["tm_att"] += 1
                                rem = cs[i + 2 :]
                                opp_after = [x for x in rem if x["side"] != side]
                                same_after = [x for x in rem if x["side"] == side]
                                if len(same_after) == 0 and len(opp_after) <= 1 and side == w:
                                    sa["tm_kill"] += 1
                                elif len(rem) == 0 and side != w:
                                    sa["tm_err"] += 1
                                hk = nc.get("key")
                                if nc["kind"] in ("attack", "tip") and _is_human(hk) and i > 0:
                                    pc = cs[i - 1]
                                    ctx = (pc["side"] == side, pc["kind"], power_bin(pc, cuts))
                                    att_pairs.append((r_idx, k, hk, ctx, std_epas[i + 1]))

                    ev_set_eff.append((r_idx, k, delta))
                    ev_set_std.append((r_idx, k, std_epas[i]))
                    ev_set_attable.append((r_idx, k, float(is_attable)))

                if kind in ATTACK_KINDS:
                    rem = cs[i + 1 :]
                    opp_after = [x for x in rem if x["side"] != side]
                    same_after = [x for x in rem if x["side"] == side]
                    is_tk = int(len(same_after) == 0 and len(opp_after) <= 1 and side == w)
                    is_ae = int(len(rem) == 0 and side != w)
                    ska = spk_acc[k]
                    ska["att_n"] += 1
                    if kind == "attack":
                        ska["spk_n"] += 1
                    elif kind == "tip":
                        ska["tip_n"] += 1
                    ska["sum_epa"] += std_epas[i]
                    ska["true_kills"] += is_tk
                    ska["att_err"] += is_ae
                    ev_spk_epa.append((r_idx, k, std_epas[i]))
                    ev_spk_hit.append((r_idx, k, float(is_tk - is_ae)))

    mean_lib_oof = float(np.mean([e[2] for e in ev_lib_eff])) * 100.0 if ev_lib_eff else 0.0
    mean_set_oof = float(np.mean([e[2] for e in ev_set_eff])) * 100.0 if ev_set_eff else 0.0
    if check_invariants:
        assert abs(mean_lib_oof) < 0.35, f"OOF human Libero delta drift too high: {mean_lib_oof}"
        assert abs(mean_set_oof) < 0.35, f"OOF human Setter delta drift too high: {mean_set_oof}"

    setter_items: list[tuple[bool, float, list[Any]]] = []
    libero_items: list[tuple[bool, float, list[Any]]] = []
    spiker_items: list[tuple[bool, float, list[Any]]] = []
    lib_by_k: dict[str, dict[str, Any]] = {}

    all_keys = sorted(set(vpm_map.keys()) | set(p_rallies.keys()))
    for k in all_keys:
        if not _is_human(k) or p_rallies[k] == 0:
            continue
        vr = vpm_map.get(k, {})
        name = vr.get("name") or display_names.get(k) or p_names.get(k) or k.split("::", 1)[-1]
        sid4 = _short_id(k)
        mmr_idx = mmr_key_to_idx.get(k, -1)
        nr = int(p_rallies[k])
        nt = int(p_touches[k])
        vpm = vr.get("vpm")
        o_vpm = vr.get("o_vpm")
        d_vpm = vr.get("d_vpm")
        blk_epa_100r = _clean_num(100.0 * p_blk_epa[k] / nr, 2)

        sa = set_acc[k]
        if sa["act"] >= 35:
            act = sa["act"]
            s_eff = 100.0 * sa["sum_delta"] / (act + ROLE_EFF_SHRINK)
            s_eff_raw = 100.0 * sa["sum_delta"] / act
            s_vpm = 100.0 * sa["sum_delta"] / (nr + ROLE_VPM_SHRINK)
            set_share = 100.0 * act / max(1, nt)
            bs = box_setter.get(k, {"set": 0, "ast": 0})
            box_ast_pct = (100.0 * bs["ast"] / bs["set"]) if bs["set"] >= 10 else None
            tm_hit = ((sa["tm_kill"] - sa["tm_err"]) / sa["tm_att"]) if sa["tm_att"] > 0 else None
            dump_100 = (100.0 * sa["dump_delta"] / sa["dumps"]) if sa["dumps"] > 0 else None
            qual_s = bool(nr >= 100 and act >= 35)
            is_prim_s = bool(set_share >= 35.0)
            setter_items.append((
                qual_s, s_eff,
                [
                    name, sid4, mmr_idx, int(is_prim_s), int(qual_s), nr, act, sa["dumps"],
                    _clean_num(sa["sum_delta"], 4), _clean_num(s_eff_raw, 2), _clean_num(s_vpm, 2),
                    _clean_num(set_share, 1), _clean_num(act / nr, 3),
                    _clean_num(100.0 * sa["attable"] / act, 1), _clean_num(100.0 * sa["err"] / act, 1),
                    _clean_num(tm_hit, 3), sa["tm_att"],
                    _clean_num(box_ast_pct, 1), bs["ast"], bs["set"],
                    _clean_num(vpm, 2), _clean_num(dump_100, 2),
                ],
            ))

        la = lib_acc[k]
        if la["fc_n"] > 0:
            fcn = la["fc_n"]
            l_eff = 100.0 * la["sum_delta"] / (fcn + ROLE_EFF_SHRINK)
            sr_eff = (100.0 * la["sr_delta"] / (la["sr_n"] + SUBSKILL_SHRINK)) if la["sr_n"] > 0 else None
            dig_eff = (100.0 * la["dig_delta"] / (la["dig_n"] + SUBSKILL_SHRINK)) if la["dig_n"] > 0 else None
            qual_l = bool(nr >= 100 and fcn >= 40)
            lib_by_k[k] = {
                "qualified": qual_l,
                "fc_n": fcn,
                "l_eff": _clean_num(l_eff, 2),
                "sr_eff": _clean_num(sr_eff, 2),
                "dig_eff": _clean_num(dig_eff, 2),
            }
            if fcn >= 40:
                fc_share = 100.0 * fcn / max(1, nt)
                is_prim_l = bool(fc_share >= 35.0)
                libero_items.append((
                    qual_l, l_eff,
                    [
                        name, sid4, mmr_idx, int(is_prim_l), int(qual_l), nr, fcn, la["sr_n"], la["dig_n"],
                        _clean_num(la["sum_delta"], 4), _clean_num(100.0 * la["sum_delta"] / fcn, 2),
                        _clean_num(100.0 * la["sum_delta"] / (nr + ROLE_VPM_SHRINK), 2),
                        _clean_num(sr_eff, 2), _clean_num(dig_eff, 2),
                        _clean_num(fc_share, 1), _clean_num(fcn / nr, 3),
                        _clean_num(100.0 * la["g3"] / fcn, 1), _clean_num(100.0 * la["clean"] / fcn, 1),
                        _clean_num(100.0 * la["err"] / fcn, 1), _clean_num(100.0 * la["sc"] / fcn, 1),
                        blk_epa_100r, p_blk_n[k], _clean_num(d_vpm, 2),
                    ],
                ))

        ska = spk_acc[k]
        if ska["att_n"] >= 20:
            attn = ska["att_n"]
            a_eff = 100.0 * ska["sum_epa"] / (attn + ROLE_EFF_SHRINK)
            a_eff_raw = 100.0 * ska["sum_epa"] / attn
            a_vpm = 100.0 * ska["sum_epa"] / (nr + ROLE_VPM_SHRINK)
            att_share = 100.0 * attn / max(1, nt)
            true_hit = (ska["true_kills"] - ska["att_err"]) / attn
            qual_k = bool(nr >= 100 and attn >= 20)
            is_prim_k = bool(att_share >= 25.0)
            spiker_items.append((
                qual_k, a_eff,
                [
                    name, sid4, mmr_idx, int(is_prim_k), int(qual_k), nr, attn, ska["spk_n"], ska["tip_n"],
                    _clean_num(ska["sum_epa"], 4), _clean_num(a_eff_raw, 2), _clean_num(a_vpm, 2),
                    _clean_num(att_share, 1), _clean_num(attn / nr, 3), _clean_num(true_hit, 3),
                    _clean_num(100.0 * ska["true_kills"] / attn, 1), _clean_num(100.0 * ska["att_err"] / attn, 1),
                    _clean_num(100.0 * ska["tip_n"] / attn, 1), blk_epa_100r, p_blk_n[k],
                    _clean_num(o_vpm, 2), _clean_num(vpm, 2),
                ],
            ))

    setter_items.sort(key=lambda x: (not x[0], -x[1]))
    libero_items.sort(key=lambda x: (not x[0], -x[1]))
    spiker_items.sort(key=lambda x: (not x[0], -x[1]))

    setters = [x[2] for x in setter_items]
    liberos = [x[2] for x in libero_items]
    spikers = [x[2] for x in spiker_items]

    qual_pbp = [r for r in pbp_rows if r.get("is_qual")]
    dvpm_v = [float(r["d_vpm"]) for r in qual_pbp]
    srapm_v = [float(r["srv_rapm"]) for r in qual_pbp]
    blk_v = [100.0 * p_blk_epa[r["key"]] / float(r["rallies"]) for r in qual_pbp]
    fc_std_v = [100.0 * p_fc_std_epa[r["key"]] / float(r["rallies"]) for r in qual_pbp]

    qual_lib = [r for r in qual_pbp if r["key"] in lib_by_k and lib_by_k[r["key"]]["qualified"]]
    qual_sr = [r for r in qual_lib if lib_by_k[r["key"]]["sr_eff"] is not None]
    qual_dig = [r for r in qual_lib if lib_by_k[r["key"]]["dig_eff"] is not None]

    top10_d = []
    for r in sorted(qual_pbp, key=lambda x: float(x["d_vpm"]), reverse=True)[:10]:
        k = r["key"]
        lr = lib_by_k.get(k, {})
        top10_d.append([
            r["name"],
            mmr_key_to_idx.get(k, -1),
            _clean_num(r["d_vpm"], 2),
            _clean_num(r["srv_rapm"], 2),
            _clean_num(100.0 * p_blk_epa[k] / float(r["rallies"]), 2),
            int(p_blk_n[k]),
            lr.get("l_eff"),
            int(lr.get("fc_n", 0)),
        ])

    rel_specs = [
        ("Spiker Attack EPA (A-Eff)", split_half_corr(ev_spk_epa, 15), "spk"),
        ("Spiker TrueHit%", split_half_corr(ev_spk_hit, 15), "spk"),
        ("Pass-Grade L-Eff (New)", split_half_corr(ev_lib_eff, 15), "lib"),
        ("1-Step Markov FC (Old)", split_half_corr(ev_lib_std, 15), "old"),
        ("Serve-Receive SR-Eff", split_half_corr(ev_lib_sr, 10), "lib"),
        ("Floor Dig Dig-Eff", split_half_corr(ev_lib_dig, 10), "lib"),
        ("Shank + Carom %", split_half_corr(ev_lib_sc, 15), "lib"),
        ("Set Delivery S-Eff (New)", split_half_corr(ev_set_eff, 15), "set"),
        ("1-Step Markov Set (Old)", split_half_corr(ev_set_std, 15), "old"),
        ("Attackable Set %", split_half_corr(ev_set_attable, 15), "set"),
        ("Hitter-Adj Ridge (Rej.)", hitter_adj_ridge_split_half(att_pairs, alpha=30.0), "rej"),
    ]
    rel = [[lbl, res[0], res[1], res[2], grp] for lbl, res, grp in rel_specs if res is not None]

    pass_ladder = [
        [g, overall_pg_cnt[g][1], round(100.0 * overall_pg_cnt[g][0] / overall_pg_cnt[g][1], 1)]
        for g in ("G3_insys_att", "G_overpass_nt", "G2_insys_tip", "G1_shank_alive", "G1_oos", "G2_set_neutral", "G0_err")
        if overall_pg_cnt[g][1] > 0
    ]
    set_ladder = [
        [g, overall_sg_cnt[g][1], round(100.0 * overall_sg_cnt[g][0] / overall_sg_cnt[g][1], 1)]
        for g in ("D_win", "S_overpass", "S_att", "D_alive", "S_reset", "S_tip", "S_oos", "S_err", "D_err")
        if overall_sg_cnt[g][1] > 0
    ]

    return {
        "meta": {
            "total_rallies": len(rallies),
            "setter_events_human": len(ev_set_eff),
            "libero_events_human": len(ev_lib_eff),
            "spiker_events_human": len(ev_spk_epa),
            "spiker_qualified_n": sum(1 for r in spikers if r[4] == 1),
            "spiker_primary_qualified_n": sum(1 for r in spikers if r[4] == 1 and r[3] == 1),
            "setter_qualified_n": sum(1 for r in setters if r[4] == 1),
            "setter_primary_qualified_n": sum(1 for r in setters if r[4] == 1 and r[3] == 1),
            "libero_qualified_n": sum(1 for r in liberos if r[4] == 1),
            "libero_primary_qualified_n": sum(1 for r in liberos if r[4] == 1 and r[3] == 1),
            "mean_human_lib_delta_100": round(mean_lib_oof, 3),
            "mean_human_set_delta_100": round(mean_set_oof, 3),
            "dvpm_vs_serve_rapm": _corr_pair(dvpm_v, srapm_v),
            "dvpm_vs_block_epa_100r": _corr_pair(dvpm_v, blk_v),
            "dvpm_vs_fc_std_epa_100r": _corr_pair(dvpm_v, fc_std_v),
            "block_vs_fc_std_epa_100r": _corr_pair(blk_v, fc_std_v),
            "dvpm_vs_l_eff": _corr_pair([float(r["d_vpm"]) for r in qual_lib], [lib_by_k[r["key"]]["l_eff"] for r in qual_lib]),
            "dvpm_vs_sr_eff": _corr_pair([float(r["d_vpm"]) for r in qual_sr], [lib_by_k[r["key"]]["sr_eff"] for r in qual_sr]),
            "dvpm_vs_dig_eff": _corr_pair([float(r["d_vpm"]) for r in qual_dig], [lib_by_k[r["key"]]["dig_eff"] for r in qual_dig]),
            "l_eff_vs_sideout_rapm": _corr_pair([lib_by_k[r["key"]]["l_eff"] for r in qual_lib], [float(r["side_rapm"]) for r in qual_lib]),
        },
        "pass_ladder": pass_ladder,
        "set_ladder": set_ladder,
        "rel": rel,
        "top10_d": top10_d,
        "spikers": spikers,
        "setters": setters,
        "liberos": liberos,
    }
