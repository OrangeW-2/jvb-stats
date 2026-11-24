  // Theme initialization & toggle (Court Chalk light default, Night Arena dark option)
  const savedTheme = localStorage.getItem("jv_theme") || "light";
  document.documentElement.setAttribute("data-theme", savedTheme);
  const themeBtn = document.getElementById("theme-toggle");
  const SUN_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`;
  const MOON_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;
  function syncThemeBtn() {
    const cur = document.documentElement.getAttribute("data-theme") || "light";
    const toDark = cur === "light";
    themeBtn.innerHTML = `${toDark ? MOON_SVG : SUN_SVG}<span>${toDark ? "Dark" : "Light"}</span>`;
    themeBtn.setAttribute("aria-label", toDark ? "Switch to dark theme" : "Switch to light theme");
  }
  syncThemeBtn();
  themeBtn.addEventListener("click", () => {
    const nxt = (document.documentElement.getAttribute("data-theme") || "light") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", nxt);
    localStorage.setItem("jv_theme", nxt);
    syncThemeBtn();
    renderActiveTab();
  });

  const ARCH_NAMES = ["Elite Both", "Pure Efficiency", "Effective Anchor", "Developing", "Box-Only (<100R)"];
  const ARCH_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

  // Unpack mmr_players: [name, sid4, bt_mmr, elo_mmr, gp, w, l]
  const mmrPlayers = SITE_DATA.mmr_players.map((r, i) => ({
    idx: i, rank: i + 1, name: r[0], id: r[1], bt_mmr: r[2], elo_mmr: r[3],
    gp: r[4], w: r[5], l: r[6], win_pct: r[4] ? (100 * r[5] / r[4]) : 0,
    peak_elo: r[3], low_elo: r[3], cur_streak: 0, longest_win: 0, timeline: []
  }));

  // Replay all chronological matches once so every player gets full Elo history, peak/low, streaks, and matchups
  function computeAllPlayerMatchStats() {
    const eloByIdx = new Float64Array(mmrPlayers.length);
    eloByIdx.fill(1500.0);
    let cpuElo = 1500.0;
    const getE = i => (i < 0 ? cpuElo : eloByIdx[i]);
    const addE = (i, d) => { if (i < 0) cpuElo += d; else eloByIdx[i] += d; };

    SITE_DATA.matches.forEach(m => {
      const [ts, mode, stage, sa, sb, wA, tA, tB] = m;
      const rA = tA.reduce((s, x) => s + getE(x), 0) / tA.length;
      const rB = tB.reduce((s, x) => s + getE(x), 0) / tB.length;
      const eA = 1.0 / (1.0 + Math.pow(10.0, (rB - rA) / 400.0));
      const dA = 32.0 * ((wA ? 1.0 : 0.0) - eA);
      tA.forEach(x => addE(x, dA));
      tB.forEach(x => addE(x, -dA));

      const pushSide = (team, oppTeam, won, setsStr, delta) => {
        const seen = new Set();
        team.forEach(pi => {
          if (pi < 0 || seen.has(pi)) return;
          seen.add(pi);
          const pl = mmrPlayers[pi];
          const eloNow = eloByIdx[pi];
          const gno = pl.timeline.length + 1;
          pl.timeline.push({
            gno, ts, mode, stage, won, setsStr, elo: eloNow, delta,
            mates: team.filter(x => x !== pi),
            opps: oppTeam.slice()
          });
          if (gno === 1) { pl.peak_elo = eloNow; pl.low_elo = eloNow; }
          else {
            if (eloNow > pl.peak_elo) pl.peak_elo = eloNow;
            if (eloNow < pl.low_elo) pl.low_elo = eloNow;
          }
          if (won) {
            pl.cur_streak = pl.cur_streak > 0 ? pl.cur_streak + 1 : 1;
            if (pl.cur_streak > pl.longest_win) pl.longest_win = pl.cur_streak;
          } else {
            pl.cur_streak = pl.cur_streak < 0 ? pl.cur_streak - 1 : -1;
          }
        });
      };
      pushSide(tA, tB, !!wA, `${sa}-${sb}`, dA);
      pushSide(tB, tA, !wA, `${sb}-${sa}`, -dA);
    });
  }
  computeAllPlayerMatchStats();

  // Unpack pbp_players
  const players = SITE_DATA.pbp_players.map((r, i) => ({
    idx: i, name: r[0], id: r[1], mmr_idx: r[2], arch: r[3], qualified: r[3] !== 4,
    vpm: r[4], o_vpm: r[5], d_vpm: r[6], v_eff: r[7],
    epa_100r: r[8], o_epa_100r: r[9], d_epa_100r: r[10],
    usage: r[11], true_hit: r[12], att: r[13], true_ace: r[14], srv_err: r[15], shank: r[16],
    rapm: r[17], srv_rapm: r[18], side_rapm: r[19], v_war: r[20], slot_exp: r[21],
    rallies: r[22], touches: r[23], bt_mmr: r[24], elo_mmr: r[25],
    mmr_gp: r[26], mmr_w: r[27], mmr_l: r[28],
    box_m: r[29], box_mvp_r: r[30], box_margin: r[31], box_bpm8: r[32],
    custom_vpm: r[4], custom_war: r[20]
  }));

  const pbpByMmrIdx = new Map();
  players.forEach(p => { if (p.mmr_idx >= 0) pbpByMmrIdx.set(p.mmr_idx, p); });
  const qualPlayers = players.filter(p => p.qualified);
  const defRankMap = new Map();
  [...qualPlayers].sort((a, b) => b.vpm - a.vpm).forEach((p, idx) => defRankMap.set(p.name + p.id, idx + 1));

  // Default profile player: highest GP (tiebreak highest BT MMR)
  const defaultMmrPlayer = mmrPlayers.length
    ? [...mmrPlayers].sort((a, b) => b.gp - a.gp || b.bt_mmr - a.bt_mmr)[0]
    : null;

  const hasPbp = !!SITE_DATA.meta.has_pbp && qualPlayers.length > 0;
  const state = {
    tab: hasPbp ? "scatter" : "profile",
    xKey: "v_eff", yKey: "vpm", sizeKey: "rallies", colorKey: "arch",
    minRallies: 100, search: "", activePreset: "eff_vpm",
    pinned: players[0] || null, pinnedMmr: null,
    wEpa: SITE_DATA.meta.default_w_epa, mShr: SITE_DATA.meta.default_m, tilt: 0,
    cmpA: 0, cmpB: Math.min(1, Math.max(0, players.length - 1)),
    tblMode: hasPbp ? "eff" : "mmr",
    tblSort: { key: hasPbp ? "vpm" : "bt_mmr", dir: -1 },
    tblArch: "all", tblSearch: "",
    profileIdx: defaultMmrPlayer ? defaultMmrPlayer.idx : 0,
    profSelectedGame: defaultMmrPlayer ? Math.max(0, defaultMmrPlayer.timeline.length - 1) : 0,
    rollingWin: true, minShared: 2, matchupSort: "total",
    kindMetric: "epa", selectedKind: "attack"
  };

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function svgEl(tag, attrs = {}, text = null) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text !== null) el.textContent = text;
    return el;
  }
  function fmt(v, d = 2, plus = false) {
    if (v === null || v === undefined || Number.isNaN(v)) return "-";
    const s = Number(v).toFixed(d);
    return (plus && Number(v) > 0) ? "+" + s : s;
  }
  function fmtStreak(st) {
    if (!st) return "-";
    return st > 0 ? `${st}W` : `${Math.abs(st)}L`;
  }
  function placeTooltip(el, e, maxW = 270, maxH = 150) {
    const left = Math.max(8, Math.min(window.innerWidth - maxW - 8, e.clientX + 14));
    const top = Math.max(8, Math.min(window.innerHeight - maxH - 8, e.clientY - 18));
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  // Header Meta, Footer Meta & 4-Column Leader Ledger
  function initHeader() {
    const m = SITE_DATA.meta;
    const summaryParts = [`${m.mmr_matches} matches`, `${m.mmr_players} players`];
    if (m.has_pbp) summaryParts.push(`${m.pbp_rallies.toLocaleString()} rallies (${m.pbp_qualified} qualified)`);
    else if (m.box_matches) summaryParts.push(`${m.box_matches} box matches`);
    document.getElementById("hdr-sub").textContent = summaryParts.join(" · ");

    const footerParts = [`${m.date_min} to ${m.date_max}`, `${m.mmr_matches} matches`, `${m.mmr_players} players`];
    if (m.has_pbp) footerParts.push(`${m.pbp_contacts.toLocaleString()} contacts across ${m.pbp_sessions} sessions`);
    footerParts.push(`Updated ${m.generated_utc}`);
    document.getElementById("footer-meta").textContent = footerParts.join(" · ");

    const strip = document.getElementById("kpi-strip");
    if (!hasPbp) document.getElementById("tab-profile").prepend(strip);

    const cards = [];
    if (hasPbp) {
      const topVpm = [...qualPlayers].sort((a, b) => b.vpm - a.vpm)[0];
      const topMmr = mmrPlayers[0];
      const topEff = [...qualPlayers].sort((a, b) => b.v_eff - a.v_eff)[0];
      const topRapm = [...qualPlayers].sort((a, b) => b.rapm - a.rapm)[0];
      cards.push(
        { lbl: "#1 Overall VPM", val: topVpm.name, sub: `${fmt(topVpm.vpm, 2, true)} pts/100R (${topVpm.rallies}R)`, tip: "Volleyball Plus-Minus leader among qualified players", mmrIdx: topVpm.mmr_idx },
        { lbl: "#1 Global BT MMR", val: topMmr.name, sub: `${topMmr.bt_mmr.toFixed(1)} (${topMmr.w}-${topMmr.l})`, tip: "Global Regularized Bradley-Terry MMR leader across all players", mmrIdx: topMmr.idx },
        { lbl: "#1 Touch efficiency (V-Eff)", val: topEff.name, sub: `${fmt(topEff.v_eff, 2, true)} EPA/100T`, tip: "Highest Markov EPA per 100 touches among qualified players", mmrIdx: topEff.mmr_idx },
        { lbl: "#1 Lineup RAPM", val: topRapm.name, sub: `${fmt(topRapm.rapm, 2, true)} pts/100R`, tip: "Highest Ridge Regularized Adjusted Plus-Minus", mmrIdx: topRapm.mmr_idx }
      );
    } else {
      const qualMmr = mmrPlayers.filter(x => x.gp >= 5);
      const winLeader = [...(qualMmr.length ? qualMmr : mmrPlayers)].sort((a, b) => b.win_pct - a.win_pct || b.gp - a.gp)[0];
      const topMmr = mmrPlayers[0];
      const topElo = [...mmrPlayers].sort((a, b) => b.elo_mmr - a.elo_mmr)[0];
      const mostActive = [...mmrPlayers].sort((a, b) => b.gp - a.gp || b.bt_mmr - a.bt_mmr)[0];
      cards.push(
        { lbl: "#1 Global BT MMR", val: topMmr ? topMmr.name : "-", sub: topMmr ? `${topMmr.bt_mmr.toFixed(1)} (${topMmr.w}-${topMmr.l})` : "", tip: "Global Bradley-Terry MMR leader", mmrIdx: topMmr ? topMmr.idx : null },
        { lbl: "#1 Chronological Elo", val: topElo ? topElo.name : "-", sub: topElo ? `${topElo.elo_mmr.toFixed(1)} (${topElo.gp} GP)` : "", tip: "Sequential team Elo leader", mmrIdx: topElo ? topElo.idx : null },
        { lbl: "#1 Win% (5+ GP)", val: winLeader ? winLeader.name : "-", sub: winLeader ? `${winLeader.win_pct.toFixed(1)}% (${winLeader.w}-${winLeader.l})` : "", tip: "Best match win rate with >= 5 GP", mmrIdx: winLeader ? winLeader.idx : null },
        { lbl: "Most active", val: mostActive ? mostActive.name : "-", sub: mostActive ? `${mostActive.gp} GP (${mostActive.w}-${mostActive.l})` : "", tip: "Most online matches recorded", mmrIdx: mostActive ? mostActive.idx : null }
      );
    }

    strip.innerHTML = cards.map((c, ci) => {
      const canClick = c.mmrIdx !== undefined && c.mmrIdx !== null && c.mmrIdx >= 0;
      return `<div class="ledger-item ${canClick ? "is-clickable" : ""}" data-kpi="${ci}" title="${esc(c.tip)}">
        <div class="muted">${esc(c.lbl)}</div>
        <div class="kpi-val tabnum">${esc(c.val)}</div>
        <div class="ledger-sub tabnum">${esc(c.sub)}</div>
      </div>`;
    }).join("");
    strip.querySelectorAll(".ledger-item.is-clickable").forEach(el => {
      const c = cards[Number(el.dataset.kpi)];
      el.addEventListener("click", () => openPlayerProfile(c.mmrIdx));
    });
  }

  function switchTab(tabName) {
    state.tab = tabName;
    document.querySelectorAll(".tab-btn").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === tabName ? "true" : "false"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
    document.getElementById("tab-" + state.tab).classList.remove("hidden");
    renderActiveTab();
  }
  document.querySelectorAll(".tab-btn").forEach(btn => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

  function openPlayerProfile(mmrIdx) {
    if (mmrIdx < 0 || mmrIdx >= mmrPlayers.length) return;
    state.profileIdx = mmrIdx;
    const pl = mmrPlayers[mmrIdx];
    state.profSelectedGame = Math.max(0, pl.timeline.length - 1);
    const profSel = document.getElementById("prof-select");
    if (profSel) profSel.value = String(mmrIdx);
    const matchups = computeMatchupsFor(mmrIdx);
    const hasMulti = matchups.some(x => x.shared >= 2);
    state.minShared = hasMulti ? 2 : 1;
    document.getElementById("min-shared").value = state.minShared;
    document.getElementById("min-shared-val").textContent = state.minShared;
    switchTab("profile");
  }

  // SANDBOX RECOMPUTE
  function recomputeSandbox() {
    if (!hasPbp) return;
    const wE = state.wEpa, wR = 1 - wE, m = state.mShr, kEpa = SITE_DATA.meta.k_epa;
    const oMult = 1 + state.tilt / 100, dMult = 1 - state.tilt / 100;
    for (const p of players) {
      const shr = p.rallies / (p.rallies + m);
      const oComp = wR * p.side_rapm + wE * (p.o_epa_100r * shr * kEpa);
      const dComp = wR * p.srv_rapm + wE * (p.d_epa_100r * shr * kEpa);
      const rawV = wR * p.rapm + wE * (p.epa_100r * shr * kEpa);
      const tilted = oMult * oComp + dMult * dComp;
      p.custom_vpm = state.tilt === 0 ? rawV : (0.5 * rawV + 0.5 * tilted);
    }
    const qVals = qualPlayers.map(p => p.custom_vpm).sort((a, b) => a - b);
    const repl = qVals[Math.floor(0.2 * (qVals.length - 1))] || 0;
    for (const p of players) {
      p.custom_war = (0.5 * ((p.custom_vpm - repl) / 100) * p.slot_exp) * (SITE_DATA.meta.bo3_slope / SITE_DATA.meta.bo3_rallies);
    }
  }

  // TAB 1: SCATTER & UNIFIED SEARCH
  const AXES = [
    { key: "v_eff", label: "V-Eff (EPA / 100 Touches)", zero: true },
    { key: "vpm", label: "VPM (Blended Pts / 100 Rallies)", zero: true },
    { key: "custom_vpm", label: "Custom VPM (Sandbox)", zero: true },
    { key: "o_vpm", label: "O-VPM (Offense)", zero: true },
    { key: "d_vpm", label: "D-VPM (Defense & Serve)", zero: true },
    { key: "usage", label: "Usage (Touches / Rally)", zero: false },
    { key: "rapm", label: "Rally RAPM (/ 100 Rallies)", zero: true },
    { key: "srv_rapm", label: "Serve RAPM", zero: true },
    { key: "side_rapm", label: "Sideout RAPM", zero: true },
    { key: "true_hit", label: "True Hitting %", zero: true },
    { key: "true_ace", label: "True Ace %", zero: false },
    { key: "bt_mmr", label: "BT MMR", zero: false },
    { key: "v_war", label: "V-WAR (Match Wins)", zero: true },
    { key: "box_mvp_r", label: "Box Naive MVP / Rally", zero: false },
    { key: "box_margin", label: "Box Team Margin / 100R", zero: true },
    { key: "a_eff", label: "A-Eff (Spiker EPA / 100 Att)", zero: true },
    { key: "s_eff", label: "S-Eff (Setter Delivery / 100 Acts)", zero: true },
    { key: "l_eff", label: "L-Eff (Libero Pass-Grade / 100 FC)", zero: true },
    { key: "sr_eff", label: "SR-Eff (Serve-Receive / 100 SR)", zero: true },
    { key: "dig_eff", label: "Dig-Eff (Floor Hard-Dig / 100 Digs)", zero: true }
  ];
  const AXIS_MAP = Object.fromEntries(AXES.map(a => [a.key, a]));

  const selX = document.getElementById("sel-x"), selY = document.getElementById("sel-y");
  AXES.forEach(a => { selX.add(new Option(a.label, a.key)); selY.add(new Option(a.label, a.key)); });
  selX.value = state.xKey; selY.value = state.yKey;

  function syncPresetButtons() {
    document.querySelectorAll("#preset-btns [data-preset]").forEach(b => {
      const on = b.dataset.preset === state.activePreset;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function renderScatter() {
    if (!hasPbp) return;
    const svg = document.getElementById("scatter-svg");
    svg.innerHTML = "";
    const W = 820, H = 450, pad = { l: 64, r: 28, t: 22, b: 48 };
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    const xMeta = AXIS_MAP[state.xKey], yMeta = AXIS_MAP[state.yKey];
    const pts = players.filter(p => p.rallies >= state.minRallies && p[state.xKey] !== null && p[state.yKey] !== null);
    if (!pts.length) {
      svg.appendChild(svgEl("text", { x: W / 2, y: H / 2, "text-anchor": "middle", fill: "var(--ink-muted)", "font-size": 13 }, "No players match the current filter."));
      return;
    }

    const xs = pts.map(p => p[state.xKey]), ys = pts.map(p => p[state.yKey]);
    let xMin = Math.min(...xs), xMax = Math.max(...xs), yMin = Math.min(...ys), yMax = Math.max(...ys);
    const xPad = (xMax - xMin || 1) * 0.08, yPad = (yMax - yMin || 1) * 0.1;
    xMin -= xPad; xMax += xPad; yMin -= yPad; yMax += yPad;
    const sx = v => pad.l + ((v - xMin) / (xMax - xMin)) * pw;
    const sy = v => pad.t + ph - ((v - yMin) / (yMax - yMin)) * ph;

    for (let i = 0; i <= 5; i++) {
      const xv = xMin + (i / 5) * (xMax - xMin), yv = yMin + (i / 5) * (yMax - yMin);
      const gx = sx(xv), gy = sy(yv);
      svg.appendChild(svgEl("line", { x1: gx, y1: pad.t, x2: gx, y2: pad.t + ph, stroke: "var(--line)", "stroke-opacity": 0.65, "stroke-dasharray": "2,3" }));
      svg.appendChild(svgEl("line", { x1: pad.l, y1: gy, x2: pad.l + pw, y2: gy, stroke: "var(--line)", "stroke-opacity": 0.65, "stroke-dasharray": "2,3" }));
      svg.appendChild(svgEl("text", { x: gx, y: H - 24, "text-anchor": "middle", fill: "var(--ink-muted)", "font-size": 12 }, Math.abs(xv) >= 100 ? xv.toFixed(0) : xv.toFixed(1)));
      svg.appendChild(svgEl("text", { x: pad.l - 8, y: gy + 4, "text-anchor": "end", fill: "var(--ink-muted)", "font-size": 12 }, Math.abs(yv) >= 100 ? yv.toFixed(0) : yv.toFixed(1)));
    }
    if (xMeta.zero && xMin < 0 && xMax > 0) svg.appendChild(svgEl("line", { x1: sx(0), y1: pad.t, x2: sx(0), y2: pad.t + ph, stroke: "var(--ink-muted)", "stroke-opacity": 0.5, "stroke-dasharray": "5,4" }));
    if (yMeta.zero && yMin < 0 && yMax > 0) svg.appendChild(svgEl("line", { x1: pad.l, y1: sy(0), x2: pad.l + pw, y2: sy(0), stroke: "var(--ink-muted)", "stroke-opacity": 0.5, "stroke-dasharray": "5,4" }));
    svg.appendChild(svgEl("text", { x: pad.l + pw / 2, y: H - 6, "text-anchor": "middle", fill: "var(--ink)", "font-size": 12, "font-weight": 600 }, xMeta.label));
    svg.appendChild(svgEl("text", { x: 16, y: pad.t + ph / 2, "text-anchor": "middle", fill: "var(--ink)", "font-size": 12, "font-weight": 600, transform: `rotate(-90 16 ${pad.t + ph / 2})` }, yMeta.label));

    const sMax = Math.max(...pts.map(p => Math.max(0, Number(p[state.sizeKey] || 0))), 1);
    const getRadius = p => state.sizeKey === "uniform" ? 6 : 4.5 + 12.5 * Math.sqrt(Math.max(0, Number(p[state.sizeKey] || 0)) / sMax);
    const getColor = p => {
      if (state.colorKey === "arch") return ARCH_COLORS[p.arch];
      if (state.colorKey === "veff") return p.v_eff >= 0 ? "var(--pos)" : "var(--neg)";
      return (!state.pinnedMmr && state.pinned && state.pinned.idx === p.idx) ? "var(--chart-1)" : "var(--chart-4)";
    };

    const legEl = document.getElementById("scatter-legend");
    if (state.colorKey === "arch") {
      legEl.innerHTML = [0, 1, 2, 3].map(c => `<span class="legend-item"><span class="dot" style="background:${ARCH_COLORS[c]}"></span>${ARCH_NAMES[c]}</span>`).join("");
    } else if (state.colorKey === "veff") {
      legEl.innerHTML = `<span class="legend-item"><span class="dot" style="background:var(--pos)"></span>V-Eff &ge; 0</span><span class="legend-item"><span class="dot" style="background:var(--neg)"></span>V-Eff &lt; 0</span>`;
    } else {
      legEl.innerHTML = `<span class="legend-item"><span class="dot" style="background:var(--chart-1)"></span>Pinned player</span>`;
    }

    const q = state.search.trim().toLowerCase();
    const tt = document.getElementById("scatter-tooltip");
    const ordered = [...pts].sort((a, b) => a.rallies - b.rallies);

    const labelTargets = new Set();
    [...pts].sort((a, b) => b.vpm - a.vpm).slice(0, 4).forEach(p => labelTargets.add(p.idx));
    [...pts].sort((a, b) => b.v_eff - a.v_eff).slice(0, 3).forEach(p => labelTargets.add(p.idx));
    [...pts].sort((a, b) => b.rapm - a.rapm).slice(0, 3).forEach(p => labelTargets.add(p.idx));
    [...pts].sort((a, b) => b.rallies - a.rallies).slice(0, 4).forEach(p => labelTargets.add(p.idx));

    const placedBoxes = [];
    const canPlace = (lx, ly, txt) => {
      const bw = txt.length * 6.5 + 6, bh = 14;
      if (lx < pad.l || lx + bw > W - pad.r || ly - bh < pad.t || ly > H - pad.b) return false;
      for (const b of placedBoxes) if (!(lx + bw < b.x || lx > b.x + b.w || ly < b.y - b.h || ly - bh > b.y)) return false;
      placedBoxes.push({ x: lx, y: ly, w: bw, h: bh });
      return true;
    };

    ordered.forEach(p => {
      const cx = sx(p[state.xKey]), cy = sy(p[state.yKey]), r = getRadius(p);
      const isMatch = q && (p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
      const isPinned = !state.pinnedMmr && state.pinned && state.pinned.idx === p.idx;
      const baseStroke = (isPinned || isMatch) ? "var(--ink)" : "var(--surface)";
      const baseWidth = (isPinned || isMatch) ? 2.4 : 1.2;
      const circ = svgEl("circle", {
        cx, cy, r, fill: getColor(p), "fill-opacity": q ? (isMatch ? 0.95 : 0.22) : 0.85,
        stroke: baseStroke, "stroke-width": baseWidth, style: "cursor:pointer;"
      });
      circ.addEventListener("mouseenter", e => {
        circ.setAttribute("stroke", "var(--ink)");
        circ.setAttribute("stroke-width", "2.4");
        tt.innerHTML = `
          <div><b>${esc(p.name)}</b> <span class="muted">${esc(p.id)}</span></div>
          <div class="muted">${ARCH_NAMES[p.arch]} · ${p.rallies}R · ${p.touches}T</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;margin-top:6px;" class="tabnum">
            <span>VPM: <b>${fmt(p.vpm, 2, true)}</b></span><span>V-Eff: <b>${fmt(p.v_eff, 2, true)}</b></span>
            <span>RAPM: <b>${fmt(p.rapm, 2, true)}</b></span><span>Use: <b>${fmt(p.usage, 2)}</b></span>
            <span>TrueHit%: <b>${fmt(p.true_hit, 3)}</b></span><span>BT MMR: <b>${fmt(p.bt_mmr, 1)}</b></span>
          </div>`;
        tt.classList.remove("hidden");
        placeTooltip(tt, e, 270, 140);
      });
      circ.addEventListener("mousemove", e => placeTooltip(tt, e, 270, 140));
      circ.addEventListener("mouseleave", () => {
        circ.setAttribute("stroke", baseStroke);
        circ.setAttribute("stroke-width", baseWidth);
        tt.classList.add("hidden");
      });
      circ.addEventListener("click", () => { state.pinned = p; state.pinnedMmr = null; renderScatter(); });
      svg.appendChild(circ);
    });

    const labelCands = pts.filter(p =>
      (q && (p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))) ||
      (!state.pinnedMmr && state.pinned && state.pinned.idx === p.idx) ||
      labelTargets.has(p.idx)
    );
    labelCands.sort((a, b) => {
      const aP = (!state.pinnedMmr && state.pinned && state.pinned.idx === a.idx) ? 1 : 0;
      const bP = (!state.pinnedMmr && state.pinned && state.pinned.idx === b.idx) ? 1 : 0;
      if (aP !== bP) return bP - aP;
      return b.rallies - a.rallies;
    });
    const tryPlaceLabel = (cx, cy, r, txt, bold, forceRight) => {
      const bw = txt.length * 6.5 + 6, bh = 14;
      const cands = [
        { x: cx + r + 5, y: cy + 4, anchor: "start", boxX: cx + r + 5, boxY: cy + 4 },
        { x: cx - r - 5, y: cy + 4, anchor: "end", boxX: cx - r - 5 - bw, boxY: cy + 4 },
        { x: cx, y: cy - r - 5, anchor: "middle", boxX: cx - bw / 2, boxY: cy - r - 5 },
        { x: cx, y: cy + r + 14, anchor: "middle", boxX: cx - bw / 2, boxY: cy + r + 14 }
      ];
      for (const c of cands) {
        if (c.boxX < pad.l || c.boxX + bw > W - pad.r || c.boxY - bh < pad.t || c.boxY > H - pad.b) continue;
        let hit = false;
        for (const b of placedBoxes) {
          if (!(c.boxX + bw < b.x || c.boxX > b.x + b.w || c.boxY < b.y - b.h || c.boxY - bh > b.y)) { hit = true; break; }
        }
        if (!hit) {
          placedBoxes.push({ x: c.boxX, y: c.boxY, w: bw, h: bh });
          svg.appendChild(svgEl("text", { x: c.x, y: c.y, "text-anchor": c.anchor, fill: "var(--ink)", "font-size": 12, "font-weight": bold ? 700 : 500 }, txt));
          return;
        }
      }
      if (forceRight) {
        const c = cands[0];
        placedBoxes.push({ x: c.boxX, y: c.boxY, w: bw, h: bh });
        svg.appendChild(svgEl("text", { x: c.x, y: c.y, "text-anchor": "start", fill: "var(--ink)", "font-size": 12, "font-weight": 700 }, txt));
      }
    };
    labelCands.forEach(p => {
      const cx = sx(p[state.xKey]), cy = sy(p[state.yKey]), r = getRadius(p);
      const isPinned = !state.pinnedMmr && state.pinned && state.pinned.idx === p.idx;
      tryPlaceLabel(cx, cy, r, p.name, isPinned, isPinned);
    });

    // Pinned Inspector
    const ins = document.getElementById("scatter-inspector");
    if (state.pinnedMmr) {
      const m = state.pinnedMmr;
      ins.innerHTML = `
        <div class="between">
          <div class="row" style="gap:8px;">
            <b style="font-size:var(--text-body);">${esc(m.name)}</b>
            <span class="muted">${esc(m.id)} · No play-by-play telemetry (&lt;100R)</span>
          </div>
          <button id="ins-prof-btn" type="button" class="btn btn-sm btn-primary">View profile</button>
        </div>
        <div class="row tabnum" style="gap:4px 14px;font-size:var(--text-sm);">
          <span>BT MMR: <b>${fmt(m.bt_mmr, 1)}</b> (#${m.rank} / ${mmrPlayers.length})</span>
          <span>Elo: <b>${fmt(m.elo_mmr, 1)}</b></span>
          <span>Peak: <b>${fmt(m.peak_elo, 1)}</b></span>
          <span>Record: <b>${m.w}-${m.l}</b> (${fmt(m.win_pct, 1)}%)</span>
        </div>`;
      document.getElementById("ins-prof-btn").addEventListener("click", () => openPlayerProfile(m.idx));
    } else {
      const p = state.pinned || pts[0];
      ins.innerHTML = `
        <div class="between">
          <div class="row" style="gap:8px;">
            <b style="font-size:var(--text-body);">${esc(p.name)}</b>
            <span class="muted">${esc(p.id)} · ${ARCH_NAMES[p.arch]}</span>
          </div>
          <div class="row" style="gap:6px;">
            ${p.mmr_idx >= 0 ? `<button id="ins-prof-btn" type="button" class="btn btn-sm btn-primary">View profile</button>` : ""}
            <button id="ins-cmp-btn" type="button" class="btn btn-sm">Compare</button>
          </div>
        </div>
        <div class="row tabnum" style="gap:4px 14px;font-size:var(--text-sm);">
          <span>VPM: <b>${fmt(p.vpm, 2, true)}</b> (O ${fmt(p.o_vpm, 1, true)} / D ${fmt(p.d_vpm, 1, true)})</span>
          <span>Custom: <b class="pri">${fmt(p.custom_vpm, 2, true)}</b></span>
          <span>V-Eff: <b>${fmt(p.v_eff, 2, true)}</b></span>
          <span>RAPM: <b>${fmt(p.rapm, 2, true)}</b></span>
          <span>TrueHit%: <b>${fmt(p.true_hit, 3)}</b></span>
          <span>MMR: <b>${fmt(p.bt_mmr, 1)}</b></span>
          <span>${p.rallies}R / ${p.touches}T</span>
        </div>`;
      const pBtn = document.getElementById("ins-prof-btn");
      if (pBtn) pBtn.addEventListener("click", () => openPlayerProfile(p.mmr_idx));
      document.getElementById("ins-cmp-btn").addEventListener("click", () => {
        state.cmpA = p.idx;
        if (state.cmpB === p.idx && players.length > 1) state.cmpB = p.idx === 0 ? 1 : 0;
        cmpA.value = state.cmpA; cmpB.value = state.cmpB;
        switchTab("compare");
      });
    }
  }

  function renderSandboxTable() {
    if (!hasPbp) return;
    recomputeSandbox();
    const tbody = document.getElementById("sandbox-top12");
    const titleEl = document.getElementById("sandbox-table-title");
    const ranked = [...qualPlayers].sort((a, b) => b.custom_vpm - a.custom_vpm).map((p, idx) => ({ p, rank: idx + 1 }));
    const q = state.search.trim().toLowerCase();
    let list;
    if (q) {
      const filtered = ranked.filter(({ p }) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
      titleEl.textContent = `Custom VPM matches (${filtered.length} of ${ranked.length})`;
      list = filtered.slice(0, 12);
    } else {
      titleEl.textContent = "Live Top 12 by Custom VPM (vs. default rank)";
      list = ranked.slice(0, 12);
    }
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="left muted" style="padding:12px;">No qualified PBP players match (check search results for MMR-only players).</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map(({ p, rank }) => {
      const diff = (defRankMap.get(p.name + p.id) || 0) - rank;
      const shiftHtml = diff > 0 ? `<span class="pos">+${diff}</span>` : (diff < 0 ? `<span class="neg">${diff}</span>` : `<span class="muted">-</span>`);
      const isPinned = !state.pinnedMmr && state.pinned && state.pinned.idx === p.idx;
      return `<tr class="clickable ${isPinned ? "is-selected" : ""}" data-pidx="${p.idx}">
        <td class="left muted">${rank}</td>
        <td class="left" style="font-weight:500;max-width:130px;overflow:hidden;text-overflow:ellipsis;">${esc(p.name)}</td>
        <td class="right" style="font-weight:600;">${fmt(p.custom_vpm, 2, true)}</td>
        <td class="right">${fmt(p.custom_war, 2, true)}</td>
        <td class="right">${shiftHtml}</td>
      </tr>`;
    }).join("");
    tbody.querySelectorAll("tr").forEach(tr => tr.addEventListener("click", () => {
      state.pinned = players[Number(tr.dataset.pidx)]; state.pinnedMmr = null;
      renderScatter(); renderSandboxTable();
    }));
  }

  // Unified Global Player Search
  const pbpMmrSet = new Set(players.filter(p => p.mmr_idx >= 0).map(p => p.mmr_idx));
  const unifiedIndex = [
    ...players.map(p => ({ kind: "pbp", name: p.name, id: p.id, pbp: p, mmr: p.mmr_idx >= 0 ? mmrPlayers[p.mmr_idx] : null })),
    ...mmrPlayers.filter(m => !pbpMmrSet.has(m.idx)).map(m => ({ kind: "mmr", name: m.name, id: m.id, pbp: null, mmr: m }))
  ];
  function searchAllPlayers(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits = unifiedIndex.filter(it => it.name.toLowerCase().includes(q) || it.id.toLowerCase().includes(q));
    hits.sort((a, b) => {
      const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
      const ae = an === q ? 0 : (an.startsWith(q) ? 1 : 2), be = bn === q ? 0 : (bn.startsWith(q) ? 1 : 2);
      if (ae !== be) return ae - be;
      if (a.kind !== b.kind) return a.kind === "pbp" ? -1 : 1;
      const as = a.pbp ? a.pbp.vpm : (a.mmr ? (a.mmr.bt_mmr - 1500) / 25 : -999);
      const bs = b.pbp ? b.pbp.vpm : (b.mmr ? (b.mmr.bt_mmr - 1500) / 25 : -999);
      return bs - as;
    });
    return hits;
  }

  const mainSearchInput = document.getElementById("main-player-search");
  const mainSearchResults = document.getElementById("main-search-results");
  const mainSearchClear = document.getElementById("main-search-clear");
  const mainSearchStatus = document.getElementById("main-search-status");
  const mainSearchKbd = document.getElementById("main-search-kbd");
  const mainSearchWrap = document.getElementById("main-search-wrap");
  mainSearchStatus.textContent = `${qualPlayers.length} PBP · ${mmrPlayers.length} MMR`;

  function selectSearchResult(item) {
    mainSearchResults.classList.add("hidden");
    if (state.tab !== "scatter") {
      if (item.mmr) {
        openPlayerProfile(item.mmr.idx);
        return;
      }
      if (item.pbp) {
        state.pinned = item.pbp; state.pinnedMmr = null;
        switchTab("scatter");
        return;
      }
    }
    if (item.kind === "pbp" && item.pbp) {
      state.pinned = item.pbp; state.pinnedMmr = null;
      if (state.minRallies > item.pbp.rallies && item.pbp.rallies >= 100) {
        state.minRallies = 100;
        document.getElementById("min-rallies").value = 100;
        document.getElementById("min-rallies-val").textContent = 100;
      }
    } else if (item.mmr) {
      state.pinned = null; state.pinnedMmr = item.mmr;
    }
    renderScatter(); renderSandboxTable();
  }

  function renderSearchDropdown() {
    const q = state.search.trim();
    if (!q) {
      mainSearchResults.classList.add("hidden");
      mainSearchClear.classList.add("hidden");
      mainSearchKbd.classList.remove("hidden");
      mainSearchStatus.textContent = `${qualPlayers.length} PBP · ${mmrPlayers.length} MMR`;
      return;
    }
    mainSearchClear.classList.remove("hidden");
    mainSearchKbd.classList.add("hidden");
    const matches = searchAllPlayers(q);
    mainSearchStatus.textContent = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
    if (!matches.length) {
      mainSearchResults.innerHTML = `<div class="muted" style="padding:12px 14px;">No players match "${esc(q)}".</div>`;
      mainSearchResults.classList.remove("hidden");
      return;
    }
    const shown = matches.slice(0, 12);
    mainSearchResults.innerHTML = shown.map((it, idx) => {
      if (it.kind === "pbp") {
        const p = it.pbp;
        return `<button type="button" class="dd-item" data-ri="${idx}">
          <span><b>${esc(p.name)}</b> <span class="muted">${esc(p.id)} · ${ARCH_NAMES[p.arch]}</span></span>
          <span class="tabnum muted">VPM <b style="color:var(--ink)">${fmt(p.vpm, 2, true)}</b> · V-Eff <b>${fmt(p.v_eff, 2, true)}</b> · RAPM <b>${fmt(p.rapm, 2, true)}</b> · ${p.rallies}R</span>
        </button>`;
      }
      const m = it.mmr;
      return `<button type="button" class="dd-item" data-ri="${idx}">
        <span><b>${esc(m.name)}</b> <span class="muted">${esc(m.id)} · MMR only</span></span>
        <span class="tabnum muted">BT MMR <b style="color:var(--ink)">${fmt(m.bt_mmr, 1)}</b> (#${m.rank}) · ${m.w}-${m.l} (${m.gp} GP)</span>
      </button>`;
    }).join("");
    mainSearchResults.classList.remove("hidden");
    mainSearchResults.querySelectorAll("button[data-ri]").forEach(b => b.addEventListener("click", () => selectSearchResult(shown[Number(b.dataset.ri)])));
  }

  mainSearchInput.addEventListener("input", e => {
    state.search = e.target.value;
    renderSearchDropdown();
    if (state.tab === "scatter") { renderScatter(); renderSandboxTable(); }
  });
  mainSearchInput.addEventListener("focus", () => { if (state.search.trim()) renderSearchDropdown(); });
  mainSearchInput.addEventListener("keydown", e => {
    if (e.key === "Enter") { const m = searchAllPlayers(state.search); if (m.length) { e.preventDefault(); selectSearchResult(m[0]); } }
    else if (e.key === "Escape") {
      state.search = ""; mainSearchInput.value = "";
      renderSearchDropdown();
      if (state.tab === "scatter") { renderScatter(); renderSandboxTable(); }
      mainSearchInput.blur();
    }
  });
  mainSearchClear.addEventListener("click", () => {
    state.search = ""; mainSearchInput.value = "";
    renderSearchDropdown();
    if (state.tab === "scatter") { renderScatter(); renderSandboxTable(); }
    mainSearchInput.focus();
  });
  document.addEventListener("click", e => { if (!mainSearchWrap.contains(e.target)) mainSearchResults.classList.add("hidden"); });
  document.addEventListener("keydown", e => {
    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
        e.preventDefault();
        mainSearchInput.focus();
      }
    }
  });

  ["sel-x", "sel-y", "sel-size", "sel-color"].forEach(id => {
    document.getElementById(id).addEventListener("change", e => {
      state[{ "sel-x": "xKey", "sel-y": "yKey", "sel-size": "sizeKey", "sel-color": "colorKey" }[id]] = e.target.value;
      if (id === "sel-x" || id === "sel-y") { state.activePreset = null; syncPresetButtons(); }
      renderScatter();
    });
  });
  document.getElementById("min-rallies").addEventListener("input", e => {
    state.minRallies = Number(e.target.value);
    document.getElementById("min-rallies-val").textContent = state.minRallies;
    renderScatter();
  });
  document.querySelectorAll("[data-preset]").forEach(btn => {
    btn.addEventListener("click", () => {
      const presets = {
        eff_vpm: ["v_eff", "vpm", 100], use_eff: ["usage", "v_eff", 100],
        off_def: ["o_vpm", "d_vpm", 100], rapm_eff: ["v_eff", "rapm", 100], mvp_margin: ["box_mvp_r", "box_margin", 100]
      };
      const [xk, yk, mr] = presets[btn.dataset.preset];
      state.xKey = xk; state.yKey = yk; state.minRallies = mr; state.activePreset = btn.dataset.preset;
      selX.value = xk; selY.value = yk;
      document.getElementById("min-rallies").value = mr;
      document.getElementById("min-rallies-val").textContent = mr;
      syncPresetButtons();
      renderScatter();
    });
  });
  function syncSandboxLabels() {
    const wp = Math.round(state.wEpa * 100);
    document.getElementById("lbl-wepa").textContent = `${wp}% EPA / ${100 - wp}% RAPM`;
    document.getElementById("lbl-m").textContent = state.mShr;
    document.getElementById("lbl-tilt").textContent = state.tilt === 0 ? "Balanced (50/50)" : (state.tilt > 0 ? `+${state.tilt}% Offense` : `${state.tilt}% Defense`);
  }
  document.getElementById("sld-wepa").addEventListener("input", e => { state.wEpa = Number(e.target.value) / 100; syncSandboxLabels(); renderSandboxTable(); renderScatter(); });
  document.getElementById("sld-m").addEventListener("input", e => { state.mShr = Number(e.target.value); syncSandboxLabels(); renderSandboxTable(); renderScatter(); });
  document.getElementById("sld-tilt").addEventListener("input", e => { state.tilt = Number(e.target.value); syncSandboxLabels(); renderSandboxTable(); renderScatter(); });
  document.getElementById("reset-sandbox").addEventListener("click", () => {
    state.wEpa = SITE_DATA.meta.default_w_epa; state.mShr = SITE_DATA.meta.default_m; state.tilt = 0;
    document.getElementById("sld-wepa").value = Math.round(state.wEpa * 100);
    document.getElementById("sld-m").value = state.mShr;
    document.getElementById("sld-tilt").value = 0;
    syncSandboxLabels(); renderSandboxTable(); renderScatter();
  });

  // TAB 2: COMPARE & LEADERBOARDS
  const cmpA = document.getElementById("cmp-a"), cmpB = document.getElementById("cmp-b");
  players.forEach((p, i) => { cmpA.add(new Option(`${p.name} (${p.rallies}R)`, i)); cmpB.add(new Option(`${p.name} (${p.rallies}R)`, i)); });
  cmpA.value = state.cmpA; cmpB.value = state.cmpB;
  document.getElementById("radar-qual-lbl").textContent = `Qualified (n=${qualPlayers.length})`;
  document.getElementById("tbl-mode-eff").textContent = `Efficiency & VPM (${players.length})`;
  document.getElementById("tbl-mode-mmr").textContent = `Global MMR (${mmrPlayers.length})`;

  if (hasPbp) {
    const chipsEl = document.getElementById("quick-chips");
    const chipIdxs = [];
    const pushTop = arr => { const x = arr.find(q => !chipIdxs.includes(q.idx) && q.idx !== 0); if (x) chipIdxs.push(x.idx); };
    pushTop([...qualPlayers].sort((a, b) => b.vpm - a.vpm));
    pushTop([...qualPlayers].sort((a, b) => b.v_eff - a.v_eff));
    pushTop([...qualPlayers].sort((a, b) => b.d_vpm - a.d_vpm));
    pushTop([...qualPlayers].sort((a, b) => b.rapm - a.rapm));
    pushTop([...qualPlayers].sort((a, b) => (b.bt_mmr || 0) - (a.bt_mmr || 0)));
    pushTop([...qualPlayers].sort((a, b) => b.rallies - a.rallies));
    const lbl = document.createElement("span");
    lbl.className = "muted";
    lbl.textContent = "Quick compare:";
    chipsEl.appendChild(lbl);
    chipIdxs.forEach(idx => {
      const p = players[idx];
      const b = document.createElement("button");
      b.type = "button";
      b.className = "quick-link"; b.textContent = "vs " + p.name;
      b.onclick = () => { state.cmpB = idx; cmpB.value = idx; renderCompare(); };
      chipsEl.appendChild(b);
    });
  } else {
    document.getElementById("compare-cards").classList.add("hidden");
    document.getElementById("tbl-mode-eff").classList.add("hidden");
    document.getElementById("tbl-arch-filter").classList.add("hidden");
    const mmrBtn = document.getElementById("tbl-mode-mmr");
    mmrBtn.classList.add("is-active");
    mmrBtn.setAttribute("aria-selected", "true");
  }

  function pctRank(key, val) {
    const vals = qualPlayers.map(p => p[key]).filter(v => v !== null && v !== undefined).sort((a, b) => a - b);
    if (!vals.length || val === null || val === undefined) return 0.5;
    let c = 0; for (const v of vals) if (v <= val) c++;
    return c / vals.length;
  }

  function renderCompare() {
    if (!hasPbp || !players.length) return;
    const pA = players[state.cmpA], pB = players[state.cmpB];
    const svg = document.getElementById("radar-svg");
    svg.innerHTML = "";
    const cx = 210, cy = 165, R = 110;
    const axes = [
      { key: "o_vpm", lbl: "O-VPM" }, { key: "d_vpm", lbl: "D-VPM" }, { key: "v_eff", lbl: "V-Eff" },
      { key: "true_hit", lbl: "TrueHit%" }, { key: "true_ace", lbl: "TrueAce%" }, { key: "rapm", lbl: "RAPM" }
    ];
    [0.25, 0.5, 0.75, 1.0].forEach(lvl => {
      const pts = axes.map((_, i) => {
        const a = -Math.PI / 2 + (2 * Math.PI * i) / axes.length;
        return `${cx + R * lvl * Math.cos(a)},${cy + R * lvl * Math.sin(a)}`;
      }).join(" ");
      svg.appendChild(svgEl("polygon", { points: pts, fill: "none", stroke: "var(--line)", "stroke-opacity": 0.75 }));
    });
    axes.forEach((ax, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / axes.length;
      svg.appendChild(svgEl("line", { x1: cx, y1: cy, x2: cx + R * Math.cos(a), y2: cy + R * Math.sin(a), stroke: "var(--line)" }));
      svg.appendChild(svgEl("text", { x: cx + (R + 22) * Math.cos(a), y: cy + (R + 18) * Math.sin(a) + 4, "text-anchor": "middle", fill: "var(--ink)", "font-size": 12, "font-weight": 500 }, ax.lbl));
    });
    const drawPoly = (p, col, dash) => {
      const pts = axes.map((ax, i) => {
        const pct = Math.max(0.08, pctRank(ax.key, p[ax.key]));
        const a = -Math.PI / 2 + (2 * Math.PI * i) / axes.length;
        return `${cx + R * pct * Math.cos(a)},${cy + R * pct * Math.sin(a)}`;
      }).join(" ");
      svg.appendChild(svgEl("polygon", { points: pts, fill: col, "fill-opacity": 0.20, stroke: col, "stroke-width": 2.2, ...(dash ? { "stroke-dasharray": dash } : {}) }));
    };
    drawPoly(pA, "var(--chart-1)", null);
    drawPoly(pB, "var(--chart-2)", "5,3");
    svg.appendChild(svgEl("circle", { cx: 22, cy: 322, r: 5, fill: "var(--chart-1)" }));
    svg.appendChild(svgEl("text", { x: 32, y: 326, fill: "var(--ink)", "font-size": 12, "font-weight": 600 }, pA.name));
    svg.appendChild(svgEl("circle", { cx: 220, cy: 322, r: 5, fill: "var(--chart-2)" }));
    svg.appendChild(svgEl("text", { x: 230, y: 326, fill: "var(--ink)", "font-size": 12, "font-weight": 600 }, pB.name));

    const metrics = [
      { lbl: "VPM (Pts/100R)", k: "vpm", d: 2, plus: true, min: -20, max: 32 },
      { lbl: "O-VPM", k: "o_vpm", d: 2, plus: true, min: -12, max: 25 },
      { lbl: "D-VPM", k: "d_vpm", d: 2, plus: true, min: -12, max: 14 },
      { lbl: "V-Eff (EPA/100T)", k: "v_eff", d: 2, plus: true, min: -10, max: 8 },
      { lbl: "Rally RAPM", k: "rapm", d: 2, plus: true, min: -18, max: 42 },
      { lbl: "Usage (Touches/R)", k: "usage", d: 2, plus: false, min: 0.3, max: 1.1 },
      { lbl: "True Hitting %", k: "true_hit", d: 3, plus: false, min: -0.35, max: 0.8 },
      { lbl: "True Ace %", k: "true_ace", d: 1, plus: false, min: 0, max: 48 },
      { lbl: "BT MMR", k: "bt_mmr", d: 1, plus: false, min: 1400, max: 1960 },
      { lbl: "V-WAR", k: "v_war", d: 2, plus: true, min: -0.3, max: 18 }
    ];
    const norm = (v, mn, mx) => (v === null || v === undefined) ? 0 : Math.max(0, Math.min(100, (100 * (v - mn)) / (mx - mn)));
    document.getElementById("cmp-bars").innerHTML = metrics.map(m => {
      const va = pA[m.k], vb = pB[m.k];
      const aWins = va !== null && vb !== null && va > vb;
      const bWins = va !== null && vb !== null && vb > va;
      return `<div>
        <div class="between tabnum">
          <span style="font-weight:500;">${m.lbl}</span>
          <span>
            <span style="color:${aWins ? "var(--chart-1)" : "var(--ink-muted)"};font-weight:${aWins ? 700 : 500};">${fmt(va, m.d, m.plus)}</span>
            <span class="muted"> vs </span>
            <span style="color:${bWins ? "var(--chart-2)" : "var(--ink-muted)"};font-weight:${bWins ? 700 : 500};">${fmt(vb, m.d, m.plus)}</span>
          </span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px;">
          <div class="bar-track" style="display:flex;justify-content:flex-end;"><div class="bar-fill" style="width:${norm(va, m.min, m.max)}%;background:var(--chart-1);opacity:${aWins ? 1 : 0.65};"></div></div>
          <div class="bar-track"><div class="bar-fill" style="width:${norm(vb, m.min, m.max)}%;background:var(--chart-2);opacity:${bWins ? 1 : 0.65};"></div></div>
        </div>
      </div>`;
    }).join("");
  }

  function renderMainTable() {
    const thead = document.getElementById("main-tbl-head"), tbody = document.getElementById("main-tbl-body");
    const q = state.tblSearch.trim().toLowerCase();
    const hint = document.getElementById("tbl-hint");

    if (state.tblMode === "eff" && hasPbp) {
      hint.textContent = "Click any column header to sort. Click a row to set Player B (Shift+Click sets Player A) in the comparator above.";
      const cols = [
        { k: "name", lbl: "Player", left: true, tip: "Display name and last 4 SteamID digits" },
        { k: "arch", lbl: "Archetype", left: true, tip: "Efficiency vs. Effectiveness quadrant" },
        { k: "vpm", lbl: "VPM", tip: "Volleyball Plus-Minus: expected team pts/100 rallies (O-VPM + D-VPM)" },
        { k: "o_vpm", lbl: "O-VPM", tip: "Offensive VPM: offensive PBP EPA + Sideout RAPM" },
        { k: "d_vpm", lbl: "D-VPM", tip: "Defensive VPM: defensive PBP EPA + Serve RAPM" },
        { k: "v_eff", lbl: "V-Eff", tip: "Expected Points Added (EPA) per 100 touches" },
        { k: "true_hit", lbl: "TrueHit%", tip: "(True Kills - Direct Attack Errors) / Attack Attempts" },
        { k: "usage", lbl: "Use", tip: "Usage rate: attributed touches per rally played" },
        { k: "rapm", lbl: "RAPM", tip: "Regularized Adjusted Plus-Minus (pts/100 rallies)" },
        { k: "v_war", lbl: "V-WAR", tip: "BO3-21 match Wins Above Replacement (p20 baseline)" },
        { k: "bt_mmr", lbl: "MMR", tip: "Global Regularized Bradley-Terry MMR (mean 1500)" },
        { k: "rallies", lbl: "Rallies", tip: "Play-by-play telemetry rallies played" }
      ];
      thead.innerHTML = `<tr><th class="left">#</th>` + cols.map(c =>
        `<th class="sort ${c.left ? "left" : ""}" data-sort="${c.k}" title="${esc(c.tip)}">${c.lbl}${state.tblSort.key === c.k ? (state.tblSort.dir < 0 ? " ▼" : " ▲") : ""}</th>`
      ).join("") + `</tr>`;

      const list = players.filter(p => (state.tblArch === "all" || p.arch === Number(state.tblArch)) && (!q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)));
      const sk = state.tblSort.key, sd = state.tblSort.dir;
      list.sort((a, b) => sk === "name" ? sd * String(a[sk]).localeCompare(String(b[sk])) : sd * ((a[sk] ?? -1e9) - (b[sk] ?? -1e9)));

      tbody.innerHTML = list.map((p, i) => `
        <tr class="clickable" data-pidx="${p.idx}">
          <td class="left muted">${i + 1}</td>
          <td class="left"><b>${esc(p.name)}</b> <span class="muted">${esc(p.id)}</span></td>
          <td class="left"><span class="dot" style="background:${ARCH_COLORS[p.arch]}"></span>${ARCH_NAMES[p.arch]}</td>
          <td class="right ${valCls(p.vpm)}"><b>${fmt(p.vpm, 2, true)}</b></td>
          <td class="right">${fmt(p.o_vpm, 2, true)}</td>
          <td class="right">${fmt(p.d_vpm, 2, true)}</td>
          <td class="right ${valCls(p.v_eff)}">${fmt(p.v_eff, 2, true)}</td>
          <td class="right">${fmt(p.true_hit, 3)}</td>
          <td class="right">${fmt(p.usage, 2)}</td>
          <td class="right ${valCls(p.rapm)}">${fmt(p.rapm, 2, true)}</td>
          <td class="right">${fmt(p.v_war, 2, true)}</td>
          <td class="right">${fmt(p.bt_mmr, 1)}</td>
          <td class="right">${p.rallies}</td>
        </tr>`).join("");
      tbody.querySelectorAll("tr").forEach(tr => tr.addEventListener("click", e => {
        const idx = Number(tr.dataset.pidx);
        if (e.shiftKey) { state.cmpA = idx; cmpA.value = idx; } else { state.cmpB = idx; cmpB.value = idx; }
        renderCompare();
      }));
    } else {
      hint.textContent = "Click any column header to sort. Click any player row to open their Elo history and matchup profile.";
      const cols = [
        { k: "name", lbl: "Player", left: true, tip: "Display name and last 4 SteamID digits" },
        { k: "bt_mmr", lbl: "BT MMR", tip: "Global Regularized Bradley-Terry MMR (removes chronological bias)" },
        { k: "elo_mmr", lbl: "Elo MMR", tip: "Sequential Chronological Team Elo (start 1500, K=32)" },
        { k: "peak_elo", lbl: "Peak Elo", tip: "Highest chronological Elo reached" },
        { k: "gp", lbl: "GP", tip: "Verified online games played" },
        { k: "w", lbl: "W", tip: "Match wins" },
        { k: "l", lbl: "L", tip: "Match losses" },
        { k: "win_pct", lbl: "Win%", tip: "Match win percentage" },
        { k: "cur_streak", lbl: "Streak", tip: "Current consecutive win/loss streak" }
      ];
      thead.innerHTML = `<tr><th class="left">#</th>` + cols.map(c =>
        `<th class="sort ${c.left ? "left" : ""}" data-sort="${c.k}" title="${esc(c.tip)}">${c.lbl}${state.tblSort.key === c.k ? (state.tblSort.dir < 0 ? " ▼" : " ▲") : ""}</th>`
      ).join("") + `</tr>`;

      const list = mmrPlayers.filter(p => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
      const sk = (list.length && state.tblSort.key in list[0]) ? state.tblSort.key : "bt_mmr";
      const sd = state.tblSort.dir;
      list.sort((a, b) => sk === "name" ? sd * a.name.localeCompare(b.name) : sd * (a[sk] - b[sk]));

      tbody.innerHTML = list.map((p, i) => `
        <tr class="clickable" data-midx="${p.idx}">
          <td class="left muted">${i + 1}</td>
          <td class="left"><b>${esc(p.name)}</b> <span class="muted">${esc(p.id)}</span></td>
          <td class="right"><b>${p.bt_mmr.toFixed(1)}</b></td>
          <td class="right">${p.elo_mmr.toFixed(1)}</td>
          <td class="right">${p.peak_elo.toFixed(1)}</td>
          <td class="right">${p.gp}</td>
          <td class="right">${p.w}</td>
          <td class="right">${p.l}</td>
          <td class="right">${p.win_pct.toFixed(1)}%</td>
          <td class="right"><span class="${p.cur_streak > 0 ? "pos" : "neg"}">${fmtStreak(p.cur_streak)}</span></td>
        </tr>`).join("");
      tbody.querySelectorAll("tr").forEach(tr => tr.addEventListener("click", () => openPlayerProfile(Number(tr.dataset.midx))));
    }

    thead.querySelectorAll("th[data-sort]").forEach(th => th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (state.tblSort.key === k) state.tblSort.dir *= -1;
      else { state.tblSort.key = k; state.tblSort.dir = k === "name" ? 1 : -1; }
      renderMainTable();
    }));
  }

  cmpA.addEventListener("change", e => { state.cmpA = Number(e.target.value); renderCompare(); });
  cmpB.addEventListener("change", e => { state.cmpB = Number(e.target.value); renderCompare(); });
  document.getElementById("cmp-swap").addEventListener("click", () => {
    const tmp = state.cmpA; state.cmpA = state.cmpB; state.cmpB = tmp;
    cmpA.value = state.cmpA; cmpB.value = state.cmpB; renderCompare();
  });
  document.getElementById("tbl-mode-eff").addEventListener("click", () => {
    state.tblMode = "eff"; state.tblSort = { key: "vpm", dir: -1 };
    document.getElementById("tbl-arch-filter").classList.remove("hidden");
    const effB = document.getElementById("tbl-mode-eff"), mmrB = document.getElementById("tbl-mode-mmr");
    effB.classList.add("is-active"); effB.setAttribute("aria-selected", "true");
    mmrB.classList.remove("is-active"); mmrB.setAttribute("aria-selected", "false");
    renderMainTable();
  });
  document.getElementById("tbl-mode-mmr").addEventListener("click", () => {
    state.tblMode = "mmr"; state.tblSort = { key: "bt_mmr", dir: -1 };
    document.getElementById("tbl-arch-filter").classList.add("hidden");
    const effB = document.getElementById("tbl-mode-eff"), mmrB = document.getElementById("tbl-mode-mmr");
    mmrB.classList.add("is-active"); mmrB.setAttribute("aria-selected", "true");
    effB.classList.remove("is-active"); effB.setAttribute("aria-selected", "false");
    renderMainTable();
  });
  document.getElementById("tbl-arch-filter").addEventListener("change", e => { state.tblArch = e.target.value; renderMainTable(); });
  document.getElementById("tbl-search").addEventListener("input", e => { state.tblSearch = e.target.value; renderMainTable(); });
