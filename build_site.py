"""Compute Just Volleyball ratings and metrics (Elo, BT MMR, Box BPM, PBP Markov
EPA, Rally RAPM, VPM, V-WAR) and build a standalone, player-agnostic HTML site.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import pathlib
import sys
from collections import Counter, defaultdict

import numpy as np
from scipy import sparse
from scipy.stats import pearsonr, spearmanr
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.model_selection import GroupKFold, LeaveOneOut

SITE_DIR = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(SITE_DIR))
import ingest as ing  # noqa: E402
import role_metrics as rm  # noqa: E402

CPU_KEY = ing.CPU_KEY
OFFENSE_KINDS = {"attack", "tip", "dump", "set", "serve"}
DEFENSE_KINDS = {"receive", "bump", "dig", "block", "carom", "shank"}
ATTACK_KINDS = {"attack", "tip", "dump"}
FAILED_RETURN_KINDS = {"bump", "carom", "dig", "shank", "receive", "block"}
SERVE_FAILED_RETURN_KINDS = {"bump", "carom", "dig", "shank", "receive", "set"}
DIRECT_ERROR_REASONS = {"ball out", "outside the antenna", "four touches", "line fault"}

BOX_STATS_8 = ["pts", "spk", "blk", "rcv", "set", "ast", "ace", "dig"]
MVP_WEIGHTS = {"pts": 3.0, "ace": 2.0, "blk": 2.0, "ast": 2.0, "dig": 2.0, "set": 1.0, "rcv": 1.0}
QUAL_MIN_RALLIES = 100
QUAL_MIN_TOUCHES = 40
BO3_21_SLOPE = 7.8984
BO3_21_RALLIES = 93.0898
RAPM_ALPHA = 40.0
SPLIT_RAPM_ALPHA = 40.0


def short_id(key: str) -> str:
    return "…" + key.split("::", 1)[1][-4:] if key.startswith("SID::") else "unlinked"


def r2(v) -> float:
    return round(float(v), 2)


def r3(v) -> float:
    return round(float(v), 3)


def r4(v) -> float:
    return round(float(v), 4)


def check_finite(obj, path: str = "root") -> None:
    if isinstance(obj, float):
        if not math.isfinite(obj):
            raise ValueError(f"Non-finite float at {path}: {obj}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            check_finite(v, f"{path}[{i}]")
    elif isinstance(obj, dict):
        for k, v in obj.items():
            check_finite(v, f"{path}.{k}")


def compute_elo(matches: list[ing.MatchRecord], k_factor: float = 32.0) -> dict[str, float]:
    elo: dict[str, float] = defaultdict(lambda: 1500.0)
    for m in matches:
        r_a = sum(elo[p] for p in m.team_a) / len(m.team_a)
        r_b = sum(elo[p] for p in m.team_b) / len(m.team_b)
        e_a = 1.0 / (1.0 + 10.0 ** ((r_b - r_a) / 400.0))
        s_a = 1.0 if m.winner == "A" else 0.0
        da = k_factor * (s_a - e_a)
        for p in m.team_a:
            elo[p] += da
        for p in m.team_b:
            elo[p] -= da
    return dict(elo)


def compute_bradley_terry(matches: list[ing.MatchRecord], players: list[str], lam: float = 0.5) -> dict[str, float]:
    idx = {p: i for i, p in enumerate(players)}
    n = len(players)
    rows_x = []
    y = np.zeros(len(matches), dtype=np.float64)
    for mi, m in enumerate(matches):
        v = np.zeros(n, dtype=np.float64)
        for p in m.team_a:
            v[idx[p]] += 1.0 / len(m.team_a)
        for p in m.team_b:
            v[idx[p]] -= 1.0 / len(m.team_b)
        rows_x.append(v)
        y[mi] = 1.0 if m.winner == "A" else 0.0

    X = np.vstack(rows_x)
    theta = np.zeros(n, dtype=np.float64)
    for _ in range(50):
        logits = X @ theta
        probs = 1.0 / (1.0 + np.exp(-np.clip(logits, -30, 30)))
        grad = X.T @ (probs - y) + lam * theta
        if np.linalg.norm(grad, ord=np.inf) < 1e-9:
            break
        w = probs * (1.0 - probs)
        H = (X.T * w) @ X + lam * np.eye(n)
        theta -= np.linalg.solve(H, grad)

    scale = 400.0 / math.log(10.0)
    raw = {p: 1500.0 + scale * float(theta[idx[p]]) for p in players}
    hvals = [v for p, v in raw.items() if p != CPU_KEY]
    shift = 1500.0 - (sum(hvals) / len(hvals)) if hvals else 0.0
    return {p: v + shift for p, v in raw.items()}


def compute_box_metrics(box_matches: list[dict]) -> dict:
    if len(box_matches) < 10:
        return {"weights": [], "bpm_r2": None, "player_box": {}}
    agg = defaultdict(lambda: {
        "matches": 0, "rallies": 0, "team_diff_sum": 0, "mvp": 0,
        "pts": 0, "spk": 0, "blk": 0, "rcv": 0, "set": 0, "ast": 0, "ace": 0, "dig": 0,
    })
    rows = []
    for m in box_matches:
        tr = m["total_rallies"]
        da = m["point_diff_a"]
        ta = [p for p in m["players"] if p["team"] == "A"]
        tb = [p for p in m["players"] if p["team"] == "B"]
        sa = {k: sum(p[k] for p in ta) for k in BOX_STATS_8}
        sb = {k: sum(p[k] for p in tb) for k in BOX_STATS_8}
        rows.append((da / tr, np.array([(sa[k] - sb[k]) / tr for k in BOX_STATS_8])))
        for p in m["players"]:
            d = agg[p["key"]]
            d["matches"] += 1
            d["rallies"] += tr
            d["team_diff_sum"] += da if p["team"] == "A" else -da
            d["mvp"] += p["mvp_score"]
            for s in BOX_STATS_8:
                d[s] += p[s]

    y = np.array([r[0] for r in rows])
    X = np.vstack([r[1] for r in rows])
    loo = LeaveOneOut()
    best_rmse, best_alpha, best_r2 = 1e9, 0.1, 0.0
    for alpha in [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0]:
        preds = np.empty(len(y))
        for tr_i, te_i in loo.split(X):
            preds[te_i] = Ridge(alpha=alpha, fit_intercept=True).fit(X[tr_i], y[tr_i]).predict(X[te_i])
        rmse = float(np.sqrt(np.mean((preds - y) ** 2)))
        ss_tot = float(np.sum((y - np.mean(y)) ** 2))
        r2_v = float(1.0 - np.sum((preds - y) ** 2) / ss_tot) if ss_tot > 0 else 0.0
        if rmse < best_rmse:
            best_rmse, best_alpha, best_r2 = rmse, alpha, r2_v

    full = Ridge(alpha=best_alpha, fit_intercept=True).fit(X, y)
    w8 = {s: float(w) for s, w in zip(BOX_STATS_8, full.coef_)}
    scale = 3.0 / w8["pts"] if abs(w8["pts"]) > 1e-9 else 1.0
    bpm_weights = [
        [stat, float(MVP_WEIGHTS.get(stat, 0.0)), r2(w8[stat] * scale)]
        for stat in ["pts", "spk", "ast", "ace", "blk", "dig", "set", "rcv"]
    ]

    pbox = {}
    for k, d in agg.items():
        ral = d["rallies"]
        raw_bpm = 100.0 * sum(w8[s] * (d[s] / ral) for s in BOX_STATS_8)
        pbox[k] = {
            "matches": d["matches"], "rallies": ral,
            "mvp_per_r": d["mvp"] / ral,
            "margin_100": 100.0 * d["team_diff_sum"] / ral,
            "raw_bpm": raw_bpm,
        }
    tot_h = sum(v["rallies"] for k, v in pbox.items() if k != CPU_KEY)
    mean_bpm = (
        sum(v["raw_bpm"] * v["rallies"] for k, v in pbox.items() if k != CPU_KEY) / tot_h
        if tot_h else 0.0
    )
    for v in pbox.values():
        v["bpm8"] = v["raw_bpm"] - mean_bpm

    return {"weights": bpm_weights, "bpm_r2": r3(best_r2), "player_box": pbox}


def _cap_touch(kind: str, tno: int) -> int:
    if kind == "block":
        return 0
    if kind == "serve":
        return 1
    return min(max(int(tno), 1), 3)


def _fit_power_cuts(rallies: list[dict], nonterm_only: bool) -> dict[str, tuple[float, float] | None]:
    by_k: dict[str, list[float]] = defaultdict(list)
    for r in rallies:
        cs = r["contacts"]
        last = len(cs) - 1
        for i, c in enumerate(cs):
            if (nonterm_only and i == last) or (c["kind"] == "serve" and c.get("is_float")):
                continue
            by_k[c["kind"]].append(float(c.get("power", 0.0)))
    cuts: dict[str, tuple[float, float] | None] = {}
    for k, vals in by_k.items():
        if len(vals) < 30:
            cuts[k] = None
        else:
            vals.sort()
            n = len(vals)
            cuts[k] = (vals[n // 3], vals[(2 * n) // 3])
    return cuts


def _pbin(c: dict, cuts: dict[str, tuple[float, float] | None]) -> str:
    k = c["kind"]
    if k == "serve" and c.get("is_float"):
        return "float"
    q = cuts.get(k)
    if q is None:
        return "all"
    q33, q67 = q
    p = float(c.get("power", 0.0))
    if q33 == q67:
        return "base" if p <= q33 else "high"
    return "low" if p <= q33 else ("mid" if p <= q67 else "high")


def fit_markov_model(train_rallies: list[dict], nonterm_only: bool = True, m_hier: tuple[float, float, float] = (5.0, 20.0, 40.0)):
    cuts = _fit_power_cuts(train_rallies, nonterm_only=nonterm_only)
    c_k: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    c_kt: dict[tuple[str, int], list[int]] = defaultdict(lambda: [0, 0])
    c_st: dict[tuple[str, int, str], list[int]] = defaultdict(lambda: [0, 0])
    sw = sn = 0
    for r in train_rallies:
        cs, w = r["contacts"], r["winner_side"]
        sw += 1 if cs[0]["side"] == w else 0
        sn += 1
        last = len(cs) - 1
        for i, c in enumerate(cs):
            if nonterm_only and i == last:
                continue
            won = 1 if c["side"] == w else 0
            k, t, pb = c["kind"], _cap_touch(c["kind"], c["touch_no"]), _pbin(c, cuts)
            c_k[k][0] += won; c_k[k][1] += 1
            c_kt[(k, t)][0] += won; c_kt[(k, t)][1] += 1
            c_st[(k, t, pb)][0] += won; c_st[(k, t, pb)][1] += 1

    m1, m2, m3 = m_hier
    v_start = sw / sn if sn else 0.5

    def lookup(c: dict) -> float:
        k, t, pb = c["kind"], _cap_touch(c["kind"], c["touch_no"]), _pbin(c, cuts)
        kw, kn = c_k.get(k, (0, 0))
        vk = (kw + m1 * 0.5) / (kn + m1)
        ktw, ktn = c_kt.get((k, t), (0, 0))
        vkt = (ktw + m2 * vk) / (ktn + m2)
        stw, stn = c_st.get((k, t, pb), (0, 0))
        return (stw + m3 * vkt) / (stn + m3)

    return v_start, cuts, lookup


def _pad_team(team: list[str], mode: str) -> list[str]:
    try:
        n = int(mode.split("v")[0])
    except Exception:
        n = len(team)
    out = list(team)
    while len(out) < n:
        out.append(CPU_KEY)
    return out


def compute_pbp_and_rapm(rallies: list[dict], box_res: dict, display_names: dict[str, str], mmr_rows: dict[str, dict]) -> dict:
    def parse_ridx(rid: str) -> int:
        try:
            return int(rid.split("#")[-1])
        except Exception:
            return 0

    rallies = sorted(rallies, key=lambda r: (r["ts"], r["session"], parse_ridx(r["rally_id"])))
    sessions = sorted({r["session"] for r in rallies})
    n_folds = min(5, len(sessions))
    sess_fold = {s: i % n_folds for i, s in enumerate(sessions)}

    # 1. OOF Markov EPA scoring (V_nonterm) + overall state table
    rally_epas: list[list[float]] = [[] for _ in rallies]
    for fold in range(n_folds):
        tr_r = [r for r in rallies if sess_fold[r["session"]] != fold]
        v_start, _, lookup = fit_markov_model(tr_r, nonterm_only=True)
        for ri, r in enumerate(rallies):
            if sess_fold[r["session"]] != fold:
                continue
            cs, w = r["contacts"], r["winner_side"]
            v_prev, prev_s, last = v_start, cs[0]["side"], len(cs) - 1
            epas = []
            for i, c in enumerate(cs):
                s = c["side"]
                vb = v_prev if s == prev_s else (1.0 - v_prev)
                va = (1.0 if s == w else 0.0) if i == last else lookup(c)
                epas.append(va - vb)
                v_prev, prev_s = va, s
            rally_epas[ri] = epas

    # Markov kind summary + state table
    cuts_all = _fit_power_cuts(rallies, nonterm_only=False)
    st_agg = defaultdict(lambda: [0, 0, 0, 0, 0])  # n_all, w_all, n_nt, w_nt, term_n
    kind_agg = defaultdict(lambda: [0, 0.0, 0, 0, 0, 0])  # count, sum_epa, n_all, w_all, n_nt, w_nt
    for ri, r in enumerate(rallies):
        cs, w, epas = r["contacts"], r["winner_side"], rally_epas[ri]
        last = len(cs) - 1
        for i, c in enumerate(cs):
            k = c["kind"]
            t = _cap_touch(k, c["touch_no"])
            pb = _pbin(c, cuts_all)
            won = 1 if c["side"] == w else 0
            st = st_agg[(k, t, pb)]
            st[0] += 1; st[1] += won
            ka = kind_agg[k]
            ka[0] += 1; ka[1] += epas[i]; ka[2] += 1; ka[3] += won
            if i < last:
                st[2] += 1; st[3] += won
                ka[4] += 1; ka[5] += won
            else:
                st[4] += 1

    markov_states = [
        [k, t, pb, d[0], r3(d[1] / d[0]), d[2], r3(d[3] / d[2]) if d[2] else None, r3(d[4] / d[0])]
        for (k, t, pb), d in sorted(st_agg.items())
        if d[0] >= 15
    ]
    markov_kinds = [
        [
            k, d[0], r2(100.0 * d[1] / d[0]),
            r3(d[3] / d[2]) if d[2] else 0.5,
            r3(d[5] / d[4]) if d[4] else 0.5,
        ]
        for k, d in sorted(kind_agg.items(), key=lambda x: -(x[1][1] / max(x[1][0], 1)))
    ]

    # 2. Accumulate player EPA & true splits (+ even/odd split-half)
    def empty_acc():
        return {
            "r": 0, "t": 0, "tot": 0.0, "o": 0.0, "d": 0.0,
            "att": 0, "tk": 0, "dae": 0, "srv": 0, "ace": 0, "se": 0, "dt": 0, "shk": 0,
        }

    p_full, p_even, p_odd = defaultdict(empty_acc), defaultdict(empty_acc), defaultdict(empty_acc)
    p_seq: dict[str, int] = defaultdict(int)
    p_slot_exp: dict[str, float] = defaultdict(float)

    for ri, r in enumerate(rallies):
        cs, w, reason, epas = r["contacts"], r["winner_side"], r.get("reason", ""), rally_epas[ri]
        last = len(cs) - 1
        tpos, tneg = _pad_team(r["team_pos"], r["mode"]), _pad_team(r["team_neg"], r["mode"])
        n_m = len(tpos)
        for pk in set(tpos + tneg):
            if pk != CPU_KEY:
                p_slot_exp[pk] += (tpos.count(pk) + tneg.count(pk)) / n_m

        in_rally = {k for k in set(r["team_pos"]) | set(r["team_neg"]) if k != CPU_KEY}
        for c in cs:
            if c.get("key") and c["key"] != CPU_KEY:
                in_rally.add(c["key"])

        parity = {}
        for k in sorted(in_rally):
            par = p_seq[k] % 2
            p_seq[k] += 1
            parity[k] = par
            p_full[k]["r"] += 1
            (p_even if par == 0 else p_odd)[k]["r"] += 1

        for i, c in enumerate(cs):
            k = c.get("key")
            if not k or k == CPU_KEY:
                continue
            epa = epas[i]
            kind = c["kind"]
            won = c["side"] == w
            targets = (p_full[k], (p_even if parity[k] == 0 else p_odd)[k])
            for acc in targets:
                acc["t"] += 1
                acc["tot"] += epa
                if kind in OFFENSE_KINDS:
                    acc["o"] += epa
                else:
                    acc["d"] += epa
                if kind in ATTACK_KINDS:
                    acc["att"] += 1
                    if i == last:
                        if won:
                            acc["tk"] += 1
                        else:
                            acc["dae"] += 1
                    elif i + 1 == last:
                        nxt = cs[i + 1]
                        if nxt["side"] != c["side"] and won and nxt["kind"] in FAILED_RETURN_KINDS:
                            acc["tk"] += 1
                        elif nxt["side"] == c["side"] and not won and reason in DIRECT_ERROR_REASONS:
                            acc["dae"] += 1
                elif kind == "serve":
                    acc["srv"] += 1
                    if i == last:
                        if won:
                            acc["ace"] += 1
                        else:
                            acc["se"] += 1
                    elif i + 1 == last:
                        nxt = cs[i + 1]
                        if nxt["side"] != c["side"] and won and nxt["kind"] in SERVE_FAILED_RETURN_KINDS:
                            acc["ace"] += 1
                        elif nxt["side"] == c["side"] and not won and reason == "serve foul":
                            acc["se"] += 1
                if kind in DEFENSE_KINDS:
                    acc["dt"] += 1
                    if kind == "shank":
                        acc["shk"] += 1

    # 3. Full Rally RAPM & Serve/Sideout RAPM
    all_keys = sorted({pk for r in rallies for pk in (_pad_team(r["team_pos"], r["mode"]) + _pad_team(r["team_neg"], r["mode"]))})
    k_idx = {k: i for i, k in enumerate(all_keys)}
    n_p = len(all_keys)
    cpu_i = k_idx[CPU_KEY]

    def build_rapm_mats(sub_rallies):
        rp, cp, vp = [], [], []
        y_pm = np.empty(len(sub_rallies), dtype=np.float64)
        y_bin = np.empty(len(sub_rallies), dtype=np.int64)
        srv_cov = np.zeros(len(sub_rallies), dtype=np.float64)
        s_rows, s_cols, s_vals, s_y = [], [], [], []
        srv_idx = 0
        for ri, r in enumerate(sub_rallies):
            tp, tn = _pad_team(r["team_pos"], r["mode"]), _pad_team(r["team_neg"], r["mode"])
            inv_n = 1.0 / len(tp)
            for pk in tp:
                rp.append(ri); cp.append(k_idx[pk]); vp.append(inv_n)
            for pk in tn:
                rp.append(ri); cp.append(k_idx[pk]); vp.append(-inv_n)
            y_pm[ri] = 1.0 if r["winner_side"] == 1 else -1.0
            y_bin[ri] = 1 if r["winner_side"] == 1 else 0
            cs = r["contacts"]
            if cs and cs[0]["kind"] == "serve":
                ss = cs[0]["side"]
                srv_cov[ri] = float(ss)
                st_team = tp if ss == 1 else tn
                rt_team = tn if ss == 1 else tp
                for pk in st_team:
                    s_rows.append(srv_idx); s_cols.append(k_idx[pk]); s_vals.append(inv_n)
                for pk in rt_team:
                    s_rows.append(srv_idx); s_cols.append(n_p + k_idx[pk]); s_vals.append(-inv_n)
                s_y.append(1.0 if r["winner_side"] == ss else -1.0)
                srv_idx += 1
        X_r = sparse.hstack(
            [sparse.csr_matrix((vp, (rp, cp)), shape=(len(sub_rallies), n_p)), sparse.csr_matrix((srv_cov * 1000.0)[:, None])],
            format="csr",
        )
        X_sp = sparse.csr_matrix((s_vals, (s_rows, s_cols)), shape=(srv_idx, 2 * n_p))
        return X_r, y_pm, y_bin, srv_cov, X_sp, np.array(s_y, dtype=np.float64)

    X_r, y_pm, y_bin, srv_cov, X_sp, s_y = build_rapm_mats(rallies)
    w_rapm = Ridge(alpha=RAPM_ALPHA, fit_intercept=True, solver="lsqr", tol=1e-10).fit(X_r, y_pm).coef_[:n_p]
    w_split = Ridge(alpha=SPLIT_RAPM_ALPHA, fit_intercept=True, solver="lsqr", tol=1e-10).fit(X_sp, s_y).coef_
    w_srv_r, w_side_r = w_split[:n_p], w_split[n_p:]

    # 4. 5-fold CV Benchmark & k_epa calibration
    X_dense = X_r[:, :n_p].toarray()
    gkf = GroupKFold(n_splits=n_folds)
    groups = np.array([r["session"] for r in rallies])
    oof_srv = np.zeros(len(rallies))
    oof_bt = np.zeros(len(rallies))
    oof_epa = np.zeros(len(rallies))
    oof_rapm = np.zeros(len(rallies))

    for tr_i, va_i in gkf.split(X_dense, y_bin, groups):
        tr_r = [rallies[i] for i in tr_i]
        oof_srv[va_i] = LogisticRegression(C=1e6).fit(srv_cov[tr_i, None], y_bin[tr_i]).decision_function(srv_cov[va_i, None])

        lr_bt = LogisticRegression(C=2.0, fit_intercept=False).fit(X_dense[tr_i], y_bin[tr_i])
        bt_cal = LogisticRegression(C=1e6).fit(np.column_stack([X_dense[tr_i] @ lr_bt.coef_[0], srv_cov[tr_i]]), y_bin[tr_i])
        oof_bt[va_i] = bt_cal.decision_function(np.column_stack([X_dense[va_i] @ lr_bt.coef_[0], srv_cov[va_i]]))

        # Fold EPA
        v_s, _, lk = fit_markov_model(tr_r, nonterm_only=True)
        fe_ral, fe_tot = Counter(), defaultdict(float)
        for r in tr_r:
            for k in set(_pad_team(r["team_pos"], r["mode"]) + _pad_team(r["team_neg"], r["mode"])):
                fe_ral[k] += 1
            cs, w = r["contacts"], r["winner_side"]
            vp, ps, last = v_s, cs[0]["side"], len(cs) - 1
            for i, c in enumerate(cs):
                s = c["side"]
                vb = vp if s == ps else (1.0 - vp)
                va = (1.0 if s == w else 0.0) if i == last else lk(c)
                pk = c.get("key") or CPU_KEY
                fe_tot[pk] += va - vb
                vp, ps = va, s
        e_vec = np.zeros(n_p)
        for pk, ip in k_idx.items():
            nr = fe_ral[pk]
            if nr:
                e_vec[ip] = (fe_tot[pk] / nr) * (nr / (nr + 200.0))
        ec = LogisticRegression(C=1e6).fit(np.column_stack([X_dense[tr_i] @ e_vec, srv_cov[tr_i]]), y_bin[tr_i])
        oof_epa[va_i] = ec.decision_function(np.column_stack([X_dense[va_i] @ e_vec, srv_cov[va_i]]))

        rc = Ridge(alpha=RAPM_ALPHA, fit_intercept=True, solver="lsqr", tol=1e-8).fit(X_r[tr_i], y_pm[tr_i]).coef_[:n_p]
        rcal = LogisticRegression(C=1e6).fit(np.column_stack([X_dense[tr_i] @ rc, srv_cov[tr_i]]), y_bin[tr_i])
        oof_rapm[va_i] = rcal.decision_function(np.column_stack([X_dense[va_i] @ rc, srv_cov[va_i]]))

    def eval_lg(lg):
        pr = 1.0 / (1.0 + np.exp(-np.clip(lg, -20.0, 20.0)))
        return [
            round(float(brier_score_loss(y_bin, pr)), 5),
            round(float(log_loss(y_bin, pr)), 5),
            r4(np.mean((pr >= 0.5) == (y_bin >= 0.5))),
            r4(roc_auc_score(y_bin, pr)),
        ]

    oof_vpm = 0.25 * oof_rapm + 0.75 * oof_epa
    cv_bench = [
        ["Serve Baseline"] + eval_lg(oof_srv),
        ["In-fold BT MMR"] + eval_lg(oof_bt),
        ["Rally RAPM (α=40)"] + eval_lg(oof_rapm),
        ["PBP Markov EPA"] + eval_lg(oof_epa),
        ["Blended VPM (0.25/0.75)"] + eval_lg(oof_vpm),
    ]

    # Calibrate k_epa
    m_shr = 200.0
    w_epa = 0.75
    epa_shr_vec = np.zeros(n_p)
    for pk, ip in k_idx.items():
        if pk == CPU_KEY:
            continue
        acc = p_full[pk]
        if acc["r"]:
            epa_shr_vec[ip] = (100.0 * acc["tot"] / acc["r"]) * (acc["r"] / (acc["r"] + m_shr))
    cal_e = LogisticRegression(C=1e6).fit(np.column_stack([X_dense @ epa_shr_vec, srv_cov]), y_bin)
    cal_r = LogisticRegression(C=1e6).fit(np.column_stack([X_dense @ (100.0 * w_rapm), srv_cov]), y_bin)
    k_epa = float(cal_e.coef_[0][0] / cal_r.coef_[0][0]) if abs(cal_r.coef_[0][0]) > 1e-9 else 10.0

    # 5. Split-half reliability across qualified players
    qual_keys = [
        k for k, acc in p_full.items()
        if acc["r"] >= QUAL_MIN_RALLIES and acc["t"] >= QUAL_MIN_TOUCHES
    ]

    def sb_pair(xs, ys):
        if len(xs) < 3 or np.std(xs) < 1e-12 or np.std(ys) < 1e-12:
            return [0.0, 0.0]
        r_val = float(pearsonr(xs, ys)[0])
        sb_val = (2.0 * r_val / (1.0 + r_val)) if (1.0 + r_val) > 1e-9 else 0.0
        return [r3(r_val), r3(sb_val)]

    # RAPM odd-even split
    sess_cnt = Counter()
    r_even, r_odd = [], []
    for r in rallies:
        c = sess_cnt[r["session"]]; sess_cnt[r["session"]] += 1
        (r_even if c % 2 == 0 else r_odd).append(r)
    q_idx = [k_idx[k] for k in qual_keys]
    Xa, ypa, _, _, Xsa, ysa = build_rapm_mats(r_even)
    Xb, ypb, _, _, Xsb, ysb = build_rapm_mats(r_odd)
    wa_r = Ridge(alpha=RAPM_ALPHA * 0.5, fit_intercept=True, solver="lsqr", tol=1e-10).fit(Xa, ypa).coef_[:n_p]
    wb_r = Ridge(alpha=RAPM_ALPHA * 0.5, fit_intercept=True, solver="lsqr", tol=1e-10).fit(Xb, ypb).coef_[:n_p]
    wsa_r = Ridge(alpha=SPLIT_RAPM_ALPHA * 0.5, fit_intercept=True, solver="lsqr", tol=1e-10).fit(Xsa, ysa).coef_
    wsb_r = Ridge(alpha=SPLIT_RAPM_ALPHA * 0.5, fit_intercept=True, solver="lsqr", tol=1e-10).fit(Xsb, ysb).coef_

    reliability = [
        ["Usage (Touches/Rally)"] + sb_pair([p_even[k]["t"] / p_even[k]["r"] for k in qual_keys], [p_odd[k]["t"] / p_odd[k]["r"] for k in qual_keys]),
        ["Rally RAPM"] + sb_pair(wa_r[q_idx], wb_r[q_idx]),
        ["PBP EPA / 100 Rallies"] + sb_pair([100 * p_even[k]["tot"] / p_even[k]["r"] for k in qual_keys], [100 * p_odd[k]["tot"] / p_odd[k]["r"] for k in qual_keys]),
        ["Serve RAPM"] + sb_pair(wsa_r[:n_p][q_idx], wsb_r[:n_p][q_idx]),
        ["V-Eff (EPA / 100 Touches)"] + sb_pair([100 * p_even[k]["tot"] / max(p_even[k]["t"], 1) for k in qual_keys], [100 * p_odd[k]["tot"] / max(p_odd[k]["t"], 1) for k in qual_keys]),
        ["O-EPA / 100 Rallies"] + sb_pair([100 * p_even[k]["o"] / p_even[k]["r"] for k in qual_keys], [100 * p_odd[k]["o"] / p_odd[k]["r"] for k in qual_keys]),
        ["Sideout RAPM"] + sb_pair(wsa_r[n_p:][q_idx], wsb_r[n_p:][q_idx]),
        ["D-EPA / 100 Rallies"] + sb_pair([100 * p_even[k]["d"] / p_even[k]["r"] for k in qual_keys], [100 * p_odd[k]["d"] / p_odd[k]["r"] for k in qual_keys]),
    ]

    # 6. Synthesize VPM, O-VPM, D-VPM, V-WAR & classify archetypes
    box_players = box_res["player_box"]
    cand_keys = set(qual_keys) | {k for k, d in box_players.items() if k != CPU_KEY and d["matches"] >= 3}

    def calc_vpm(pk: str):
        acc = p_full[pk]
        nr = acc["r"]
        shr = nr / (nr + m_shr) if nr else 0.0
        ip = k_idx.get(pk)
        rp = 100.0 * float(w_rapm[ip]) if ip is not None else 0.0
        srp = 100.0 * float(w_srv_r[ip]) if ip is not None else 0.0
        sdp = 100.0 * float(w_side_r[ip]) if ip is not None else 0.0
        ep_r = (100.0 * acc["tot"] / nr) if nr else 0.0
        o_r = (100.0 * acc["o"] / nr) if nr else 0.0
        d_r = (100.0 * acc["d"] / nr) if nr else 0.0
        vpm = (1.0 - w_epa) * rp + w_epa * (ep_r * shr * k_epa)
        o_raw = (1.0 - w_epa) * sdp + w_epa * (o_r * shr * k_epa)
        d_raw = (1.0 - w_epa) * srp + w_epa * (d_r * shr * k_epa)
        diff = vpm - (o_raw + d_raw)
        return vpm, o_raw + 0.5 * diff, d_raw + 0.5 * diff, rp, srp, sdp, ep_r, o_r, d_r

    qual_vpms = [calc_vpm(k)[0] for k in qual_keys]
    repl_vpm = float(np.percentile(qual_vpms, 20)) if qual_vpms else -7.5

    rows_out = []
    for pk in cand_keys:
        acc = p_full[pk]
        nr, nt = acc["r"], acc["t"]
        is_qual = pk in qual_keys
        vpm, ovpm, dvpm, rp, srp, sdp, ep_r, o_r, d_r = calc_vpm(pk)
        veff = (100.0 * acc["tot"] / nt) if nt else 0.0
        usage = (nt / nr) if nr else 0.0
        slot_exp = p_slot_exp.get(pk, 0.0)
        v_war = (0.5 * ((vpm - repl_vpm) / 100.0) * slot_exp) * (BO3_21_SLOPE / BO3_21_RALLIES)

        mm = mmr_rows.get(pk, {})
        bt_v = float(mm["bt_mmr"]) if "bt_mmr" in mm else None
        elo_v = float(mm["elo_mmr"]) if "elo_mmr" in mm else None
        arch = 4
        if is_qual:
            mmr_use = bt_v if bt_v is not None else 1500.0
            if veff >= 2.0 and (vpm >= 10.0 or usage >= 0.68):
                arch = 0
            elif veff >= 2.0:
                arch = 1
            elif rp >= 5.0 or vpm >= 5.0 or mmr_use >= 1560.0:
                arch = 2
            else:
                arch = 3

        bx = box_players.get(pk)
        rows_out.append({
            "key": pk,
            "is_qual": is_qual,
            "name": mm.get("name") or display_names.get(pk) or pk.split("::", 1)[-1],
            "sid4": short_id(pk),
            "arch": arch,
            "vpm": r2(vpm), "o_vpm": r2(ovpm), "d_vpm": r2(dvpm), "v_eff": r2(veff),
            "epa_100r": r2(ep_r), "o_epa_100r": r2(o_r), "d_epa_100r": r2(d_r),
            "usage": r3(usage),
            "true_hit": r3((acc["tk"] - acc["dae"]) / acc["att"]) if acc["att"] else None,
            "att": acc["att"],
            "true_ace": round(100.0 * acc["ace"] / acc["srv"], 1) if acc["srv"] else None,
            "srv_err": round(100.0 * acc["se"] / acc["srv"], 1) if acc["srv"] else None,
            "shank": round(100.0 * acc["shk"] / acc["dt"], 1) if acc["dt"] else None,
            "rapm": r2(rp), "srv_rapm": r2(srp), "side_rapm": r2(sdp),
            "v_war": r3(v_war), "slot_exp": r2(slot_exp),
            "rallies": nr, "touches": nt,
            "bt_mmr": bt_v, "elo_mmr": elo_v,
            "gp": mm.get("gp", 0), "w": mm.get("w", 0), "l": mm.get("l", 0),
            "box_m": bx["matches"] if bx else 0,
            "box_mvp_r": r3(bx["mvp_per_r"]) if bx else None,
            "box_margin": r2(bx["margin_100"]) if bx else None,
            "box_bpm8": r2(bx["bpm8"]) if bx else None,
        })

    rows_out.sort(key=lambda r: (-int(r["is_qual"]), -r["vpm"], -r["v_eff"]))
    return {
        "k_epa": round(k_epa, 4),
        "repl_vpm": round(repl_vpm, 3),
        "n_qual": len(qual_keys),
        "pbp_rows": rows_out,
        "markov_kinds": markov_kinds,
        "markov_states": markov_states,
        "cv_bench": cv_bench,
        "reliability": reliability,
    }


def build_site(
    local_root: pathlib.Path | None,
    submissions_dir: pathlib.Path | None,
    include_local: bool,
    out_path: pathlib.Path,
) -> None:
    blobs = ing.discover_profile_blobs(local_root, submissions_dir, include_local=include_local)
    sid_latest, _, name_to_sid = ing.build_identity_maps(blobs)
    prof_recs, _ = ing.load_profile_matches(blobs, sid_latest, name_to_sid)
    vbr_recs, _ = ing.load_vbr_matches(local_root, submissions_dir, include_local, sid_latest, name_to_sid)
    sess_recs, _ = ing.load_vbtsess_matches(local_root, include_local, sid_latest, name_to_sid)
    matches, _ = ing.verify_and_deduplicate(prof_recs, vbr_recs, sess_recs)

    display_names = {CPU_KEY: "[CPU]"}
    for sid, nm in sid_latest.items():
        display_names[f"SID::{sid}"] = nm
    for m in matches:
        for k in m.team_a + m.team_b:
            if k not in display_names:
                display_names[k] = k.split("::", 1)[-1]

    all_keys = sorted({p for m in matches for p in (m.team_a + m.team_b)})
    human_keys = [p for p in all_keys if p != CPU_KEY]

    elo_map = compute_elo(matches, k_factor=32.0) if matches else {}
    bt_map = compute_bradley_terry(matches, all_keys, lam=0.5) if matches else {}

    gp, wins, losses = Counter(), Counter(), Counter()
    for m in matches:
        wt = set(m.team_a if m.winner == "A" else m.team_b)
        for p in set(m.team_a + m.team_b):
            gp[p] += 1
            if p in wt:
                wins[p] += 1
            else:
                losses[p] += 1

    mmr_objs = []
    mmr_lookup: dict[str, dict] = {}
    for p in human_keys:
        obj = {
            "key": p,
            "name": display_names[p],
            "sid4": short_id(p),
            "bt_mmr": round(bt_map[p], 1),
            "elo_mmr": round(elo_map[p], 1),
            "gp": gp[p],
            "w": wins[p],
            "l": losses[p],
        }
        mmr_objs.append(obj)
        mmr_lookup[p] = obj
    mmr_objs.sort(key=lambda r: (-r["bt_mmr"], -r["gp"], r["name"].lower()))

    mmr_key_to_idx = {r["key"]: i for i, r in enumerate(mmr_objs)}
    mmr_key_to_idx[CPU_KEY] = -1

    mmr_players = [
        [r["name"], r["sid4"], r["bt_mmr"], r["elo_mmr"], r["gp"], r["w"], r["l"]]
        for r in mmr_objs
    ]
    compact_matches = [
        [
            dt.datetime.fromtimestamp(m.ts).strftime("%Y-%m-%d %H:%M"),
            m.mode,
            m.stage,
            m.sets_a,
            m.sets_b,
            1 if m.winner == "A" else 0,
            [mmr_key_to_idx[k] for k in m.team_a],
            [mmr_key_to_idx[k] for k in m.team_b],
        ]
        for m in matches
    ]

    box_data = ing.extract_box_matches(blobs, sid_latest, name_to_sid)
    box_res = compute_box_metrics(box_data["matches"])
    pbp_data = ing.extract_pbp_rallies(local_root, include_local, sid_latest, name_to_sid)
    rallies = pbp_data["rallies"]
    has_pbp = len(rallies) >= 200 and len({r["session"] for r in rallies}) >= 5

    pbp_res = (
        compute_pbp_and_rapm(rallies, box_res, display_names, mmr_lookup)
        if has_pbp
        else {"k_epa": 10.0, "repl_vpm": 0.0, "n_qual": 0, "pbp_rows": [], "markov_kinds": [], "markov_states": [], "cv_bench": [], "reliability": []}
    )
    roles_res = (
        rm.compute_role_metrics(rallies, box_data["matches"], pbp_res["pbp_rows"], mmr_key_to_idx, display_names)
        if has_pbp
        else None
    )

    pbp_players = [
        [
            r["name"], r["sid4"], mmr_key_to_idx.get(r["key"], -1), r["arch"],
            r["vpm"], r["o_vpm"], r["d_vpm"], r["v_eff"],
            r["epa_100r"], r["o_epa_100r"], r["d_epa_100r"],
            r["usage"], r["true_hit"], r["att"], r["true_ace"], r["srv_err"], r["shank"],
            r["rapm"], r["srv_rapm"], r["side_rapm"], r["v_war"], r["slot_exp"],
            r["rallies"], r["touches"], r["bt_mmr"], r["elo_mmr"],
            r["gp"], r["w"], r["l"],
            r["box_m"], r["box_mvp_r"], r["box_margin"], r["box_bpm8"],
        ]
        for r in pbp_res["pbp_rows"]
    ]

    date_min = dt.datetime.fromtimestamp(matches[0].ts).strftime("%Y-%m-%d") if matches else ""
    date_max = dt.datetime.fromtimestamp(matches[-1].ts).strftime("%Y-%m-%d") if matches else ""

    bundle = {
        "meta": {
            "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
            "date_min": date_min,
            "date_max": date_max,
            "has_pbp": has_pbp,
            "mmr_matches": len(matches),
            "mmr_players": len(mmr_players),
            "pbp_rallies": len(rallies),
            "pbp_sessions": len({r["session"] for r in rallies}),
            "pbp_contacts": sum(len(r["contacts"]) for r in rallies),
            "pbp_qualified": pbp_res["n_qual"],
            "box_matches": len(box_data["matches"]),
            "k_epa": pbp_res["k_epa"],
            "default_w_epa": 0.75,
            "default_m": 200.0,
            "repl_vpm": pbp_res["repl_vpm"],
            "bo3_slope": BO3_21_SLOPE,
            "bo3_rallies": BO3_21_RALLIES,
            "bpm_r2": box_res["bpm_r2"],
        },
        "mmr_players": mmr_players,
        "matches": compact_matches,
        "pbp_players": pbp_players,
        "markov_kinds": pbp_res["markov_kinds"],
        "markov_states": pbp_res["markov_states"],
        "cv_bench": pbp_res["cv_bench"],
        "bpm_weights": box_res["weights"],
        "reliability": pbp_res["reliability"],
        "roles": roles_res,
    }

    check_finite(bundle)
    template_path = SITE_DIR / "template.html"
    tpl = template_path.read_text(encoding="utf-8")
    for ph in ("__SITE_DATA_JSON__", "__APP_CORE_JS__", "__APP_ROLES_JS__", "__APP_VIEWS_JS__"):
        if ph not in tpl:
            raise RuntimeError(f"Missing {ph} placeholder in template.html")
    site_json = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))
    core_js = (SITE_DIR / "app_core.js").read_text(encoding="utf-8")
    roles_js = (SITE_DIR / "app_roles.js").read_text(encoding="utf-8")
    views_js = (SITE_DIR / "app_views.js").read_text(encoding="utf-8")
    out_html = (
        tpl.replace("__SITE_DATA_JSON__", site_json, 1)
        .replace("__APP_CORE_JS__", core_js, 1)
        .replace("__APP_ROLES_JS__", roles_js, 1)
        .replace("__APP_VIEWS_JS__", views_js, 1)
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(out_html, encoding="utf-8")
    role_summary = ""
    if roles_res:
        rmeta = roles_res["meta"]
        role_summary = (
            f"; roles qualified: {rmeta['spiker_qualified_n']} spikers, "
            f"{rmeta['setter_qualified_n']} setters, {rmeta['libero_qualified_n']} liberos"
        )
    print(
        f"Built {out_path} ({len(out_html.encode('utf-8')):,} bytes): "
        f"{len(matches)} matches, {len(mmr_players)} MMR players, "
        f"{len(rallies)} PBP rallies ({pbp_res['n_qual']} qualified){role_summary}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Build standalone Just Volleyball analytics site.")
    parser.add_argument("--submissions", type=pathlib.Path, default=SITE_DIR / "submissions", help="Folder of submitted .zip files")
    parser.add_argument("--local-root", type=pathlib.Path, default=ing.DEFAULT_LOCAL_ROOT, help="Local Godot userdata root")
    parser.add_argument("--no-local", action="store_true", help="Build strictly from submitted .zip files without local userdata")
    parser.add_argument("--out", type=pathlib.Path, default=SITE_DIR / "index.html", help="Output HTML path")
    args = parser.parse_args()
    build_site(args.local_root, args.submissions, not args.no_local, args.out)


if __name__ == "__main__":
    main()
