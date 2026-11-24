  // TAB 3: UNIVERSAL PLAYER PROFILE & MATCHUPS
  const profSelect = document.getElementById("prof-select");
  const profFilter = document.getElementById("prof-filter");
  function populateProfileSelect(filter = "") {
    const q = filter.trim().toLowerCase();
    const sorted = [...mmrPlayers].sort((a, b) => b.gp - a.gp || b.bt_mmr - a.bt_mmr);
    const list = sorted.filter(p => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
    profSelect.innerHTML = "";
    list.forEach(p => profSelect.add(new Option(`${p.name} ${p.id} (${p.gp} GP · ${p.bt_mmr.toFixed(0)} MMR)`, p.idx)));
    if (list.length && !list.some(p => p.idx === state.profileIdx)) {
      state.profileIdx = list[0].idx;
      state.profSelectedGame = Math.max(0, list[0].timeline.length - 1);
    }
    profSelect.value = String(state.profileIdx);
  }
  populateProfileSelect();

  function computeMatchupsFor(mmrIdx) {
    const pl = mmrPlayers[mmrIdx];
    if (!pl) return [];
    const agg = new Map();
    const ensure = idx => {
      if (!agg.has(idx)) {
        const m = mmrPlayers[idx];
        agg.set(idx, { idx, name: m.name, id: m.id, bt_mmr: m.bt_mmr, ww: 0, wl: 0, vw: 0, vl: 0 });
      }
      return agg.get(idx);
    };
    pl.timeline.forEach(g => {
      const seenM = new Set(), seenO = new Set();
      g.mates.forEach(x => {
        if (x < 0 || seenM.has(x)) return; seenM.add(x);
        const rec = ensure(x); if (g.won) rec.ww++; else rec.wl++;
      });
      g.opps.forEach(x => {
        if (x < 0 || seenO.has(x)) return; seenO.add(x);
        const rec = ensure(x);
        if (g.won) rec.vl++; else rec.vw++;
      });
    });
    return [...agg.values()].map(d => ({ ...d, withTot: d.ww + d.wl, vsTot: d.vw + d.vl, shared: d.ww + d.wl + d.vw + d.vl }));
  }

  function formatPlayerList(idxs) {
    return idxs.map(x => x < 0 ? "[CPU]" : mmrPlayers[x].name).join(", ") || "-";
  }

  function renderProfile() {
    const pl = mmrPlayers[state.profileIdx];
    if (!pl) return;
    const pbp = pbpByMmrIdx.get(pl.idx);

    const cmpBtn = document.getElementById("prof-compare-btn");
    if (hasPbp && pbp) {
      cmpBtn.classList.remove("hidden");
      cmpBtn.onclick = () => {
        state.cmpA = pbp.idx;
        if (state.cmpB === pbp.idx && players.length > 1) state.cmpB = pbp.idx === 0 ? 1 : 0;
        cmpA.value = state.cmpA; cmpB.value = state.cmpB;
        switchTab("compare");
      };
    } else {
      cmpBtn.classList.add("hidden");
    }

    const cards = [
      { lbl: "Global BT MMR", val: pl.bt_mmr.toFixed(1), sub: `Rank #${pl.rank} / ${mmrPlayers.length}` },
      { lbl: "Chronological Elo", val: pl.elo_mmr.toFixed(1), sub: `Peak ${pl.peak_elo.toFixed(1)} · Low ${pl.low_elo.toFixed(1)}` },
      { lbl: "Match record", val: `${pl.w}-${pl.l} (${pl.win_pct.toFixed(1)}%)`, sub: `${pl.gp} online matches` },
      { lbl: "Streaks", val: fmtStreak(pl.cur_streak), sub: `Best win streak: ${pl.longest_win}W` },
      pbp && pbp.qualified
        ? { lbl: "Impact (VPM / RAPM)", val: `${fmt(pbp.vpm, 2, true)}`, sub: `RAPM ${fmt(pbp.rapm, 2, true)} · ${pbp.rallies}R` }
        : { lbl: "PBP efficiency", val: pbp ? `${pbp.rallies}R` : "N/A", sub: pbp ? "Unqualified (<100R)" : "No PBP telemetry" },
      pbp && pbp.qualified
        ? { lbl: "Efficiency (V-Eff)", val: `${fmt(pbp.v_eff, 2, true)}`, sub: `Use ${fmt(pbp.usage, 2)} · Hit ${fmt(pbp.true_hit, 3)}` }
        : { lbl: "Wins Above Repl", val: "-", sub: "Needs >=100 PBP rallies" }
    ];
    document.getElementById("prof-summary").innerHTML = cards.map(c => `
      <div class="ledger-item">
        <div class="muted">${esc(c.lbl)}</div>
        <div class="kpi-val tabnum">${esc(c.val)}</div>
        <div class="ledger-sub tabnum">${esc(c.sub)}</div>
      </div>`).join("");

    const tl = pl.timeline;
    const span = tl.length ? `${tl[0].ts.slice(0, 10)} to ${tl[tl.length - 1].ts.slice(0, 10)}` : "";
    document.getElementById("prof-traj-sub").textContent = `${pl.name} (${pl.id}): ${tl.length} chronological matches (${span}). Hover or click any node to inspect.`;

    // Elo SVG
    const svg = document.getElementById("elo-svg");
    svg.innerHTML = "";
    const W = 960, H = 320, pad = { l: 58, r: 58, t: 26, b: 40 };
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    const elos = tl.map(g => g.elo).concat([1500]);
    const eMin = Math.floor((Math.min(...elos) - 25) / 25) * 25;
    const eMax = Math.ceil((Math.max(...elos) + 25) / 25) * 25;
    const sx = gno => tl.length <= 1 ? (pad.l + pw / 2) : pad.l + ((gno - 1) / (tl.length - 1)) * pw;
    const sy = e => pad.t + ph - ((e - eMin) / Math.max(1, eMax - eMin)) * ph;

    const defs = svgEl("defs");
    const grad = svgEl("linearGradient", { id: "elo-area-grad", x1: "0", y1: "0", x2: "0", y2: "1" });
    grad.appendChild(svgEl("stop", { offset: "0%", "stop-color": "var(--chart-1)", "stop-opacity": "0.22" }));
    grad.appendChild(svgEl("stop", { offset: "100%", "stop-color": "var(--chart-1)", "stop-opacity": "0.0" }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    for (let i = 0; i <= 4; i++) {
      const ev = eMin + (i / 4) * (eMax - eMin), y = sy(ev);
      svg.appendChild(svgEl("line", { x1: pad.l, y1: y, x2: pad.l + pw, y2: y, stroke: "var(--line)", "stroke-opacity": 0.65, "stroke-dasharray": "2,3" }));
      svg.appendChild(svgEl("text", { x: pad.l - 8, y: y + 4, "text-anchor": "end", fill: "var(--ink-muted)", "font-size": 12 }, Math.round(ev)));
    }
    svg.appendChild(svgEl("line", { x1: pad.l, y1: sy(1500), x2: pad.l + pw, y2: sy(1500), stroke: "var(--ink-muted)", "stroke-dasharray": "4,4", "stroke-opacity": 0.55 }));

    const stepX = Math.max(1, Math.ceil(tl.length / 8));
    tl.forEach((g, idx) => {
      if (idx === 0 || idx === tl.length - 1 || (idx + 1) % stepX === 0) {
        svg.appendChild(svgEl("text", { x: sx(g.gno), y: H - 14, "text-anchor": "middle", fill: "var(--ink-muted)", "font-size": 12 }, "#" + g.gno));
      }
    });

    if (state.rollingWin && tl.length >= 2) {
      const syP = p => pad.t + ph - p * ph;
      [0.25, 0.5, 0.75, 1.0].forEach(p => svg.appendChild(svgEl("text", { x: W - pad.r + 8, y: syP(p) + 4, fill: "var(--chart-2)", "font-size": 12 }, Math.round(p * 100) + "%")));
      let dR = "";
      tl.forEach((g, i) => {
        const sl = tl.slice(Math.max(0, i - 9), i + 1);
        const wp = sl.reduce((s, x) => s + (x.won ? 1 : 0), 0) / sl.length;
        dR += (i === 0 ? "M" : "L") + `${sx(g.gno).toFixed(1)},${syP(wp).toFixed(1)}`;
      });
      svg.appendChild(svgEl("path", { d: dR, fill: "none", stroke: "var(--chart-2)", "stroke-width": 1.8, "stroke-opacity": 0.8, "stroke-dasharray": "5,3" }));
    }

    if (tl.length >= 2) {
      let dL = "", dA = "";
      tl.forEach((g, i) => {
        const x = sx(g.gno).toFixed(1), y = sy(g.elo).toFixed(1);
        dL += (i === 0 ? "M" : "L") + `${x},${y}`;
        dA += (i === 0 ? `M${x},${sy(eMin).toFixed(1)} L${x},${y}` : ` L${x},${y}`);
      });
      dA += ` L${sx(tl.length).toFixed(1)},${sy(eMin).toFixed(1)} Z`;
      svg.appendChild(svgEl("path", { d: dA, fill: "url(#elo-area-grad)" }));
      svg.appendChild(svgEl("path", { d: dL, fill: "none", stroke: "var(--chart-1)", "stroke-width": 2.4 }));
    }

    const selIdx = Math.min(state.profSelectedGame, Math.max(0, tl.length - 1));
    let peakG = tl[0], lowG = tl[0];
    tl.forEach((g, i) => {
      if (g.elo > peakG.elo) peakG = g;
      if (g.elo < lowG.elo) lowG = g;
      const isSel = i === selIdx;
      const cx = sx(g.gno), cy = sy(g.elo);
      if (isSel) {
        svg.appendChild(svgEl("circle", { cx, cy, r: 10, fill: "var(--chart-1)", "fill-opacity": 0.18 }));
      }
      svg.appendChild(svgEl("circle", {
        cx, cy, r: isSel ? 6 : 4,
        fill: g.won ? "var(--pos)" : "var(--neg)",
        stroke: isSel ? "var(--ink)" : "var(--surface)",
        "stroke-width": isSel ? 2 : 1.2
      }));
      const hit = svgEl("circle", { cx, cy, r: 10, fill: "transparent", style: "cursor:pointer;" });
      const pick = () => { state.profSelectedGame = i; renderProfile(); };
      hit.addEventListener("mouseenter", pick); hit.addEventListener("click", pick);
      svg.appendChild(hit);
    });

    if (tl.length > 1) {
      svg.appendChild(svgEl("text", { x: sx(peakG.gno), y: Math.max(pad.t + 12, sy(peakG.elo) - 10), "text-anchor": peakG.gno > tl.length * 0.8 ? "end" : "middle", fill: "var(--pos)", "font-size": 12, "font-weight": 600 }, `Peak ${peakG.elo.toFixed(1)} (#${peakG.gno})`));
      if (lowG.gno !== peakG.gno) svg.appendChild(svgEl("text", { x: sx(lowG.gno), y: Math.min(H - 22, sy(lowG.elo) + 18), "text-anchor": lowG.gno > tl.length * 0.8 ? "end" : "middle", fill: "var(--neg)", "font-size": 12, "font-weight": 600 }, `Low ${lowG.elo.toFixed(1)} (#${lowG.gno})`));
    }

    const gm = tl[selIdx];
    document.getElementById("match-inspector").innerHTML = gm ? `
      <div class="between" style="margin-bottom:6px;">
        <b>Game #${gm.gno} · ${esc(gm.ts)} · ${esc(gm.mode)} (${esc(gm.stage)})</b>
        <span class="tabnum ${gm.won ? "pos" : "neg"}" style="font-weight:700;">
          ${gm.won ? "WIN" : "LOSS"} ${esc(gm.setsStr)} · Elo ${gm.elo.toFixed(1)} (${gm.delta >= 0 ? "+" : ""}${gm.delta.toFixed(1)})
        </span>
      </div>
      <div class="grid-2 muted">
        <div><b style="color:var(--ink);">Teammates:</b> ${esc(formatPlayerList(gm.mates))}</div>
        <div><b style="color:var(--ink);">Opponents:</b> ${esc(formatPlayerList(gm.opps))}</div>
      </div>` : `<span class="muted">No matches recorded.</span>`;

    // Match Log table
    document.getElementById("prof-match-log").innerHTML = [...tl].reverse().map(g => `
      <tr class="clickable ${g.gno - 1 === selIdx ? "is-selected" : ""}" data-gi="${g.gno - 1}">
        <td class="left muted">${g.gno}</td>
        <td class="left">${esc(g.ts.slice(5))}</td>
        <td class="left">${esc(g.mode)} ${esc(g.stage)}</td>
        <td class="right"><b class="${g.won ? "pos" : "neg"}">${g.won ? "W" : "L"}</b></td>
        <td class="right">${esc(g.setsStr)}</td>
        <td class="right">${g.elo.toFixed(1)}</td>
      </tr>`).join("");
    document.querySelectorAll("#prof-match-log tr").forEach(tr => tr.addEventListener("click", () => {
      state.profSelectedGame = Number(tr.dataset.gi); renderProfile();
    }));

    // Matchups SVG
    document.getElementById("matchups-title").textContent = `Shared games with ${pl.name}`;
    const mSvg = document.getElementById("matchups-svg");
    mSvg.innerHTML = "";
    let mList = computeMatchupsFor(pl.idx).filter(d => d.shared >= state.minShared);
    mList.sort((a, b) => state.matchupSort === "with" ? (b.withTot - a.withTot || b.shared - a.shared) : state.matchupSort === "vs" ? (b.vsTot - a.vsTot || b.shared - a.shared) : (b.shared - a.shared || b.bt_mmr - a.bt_mmr));
    mList = mList.slice(0, 14);
    if (!mList.length) {
      mSvg.appendChild(svgEl("text", { x: 320, y: 195, "text-anchor": "middle", fill: "var(--ink-muted)", "font-size": 13 }, `No players with >= ${state.minShared} shared games.`));
      return;
    }

    const rowH = 25, mH = 44 + mList.length * rowH + 14;
    mSvg.setAttribute("viewBox", `0 0 640 ${mH}`);
    const cx0 = 395, maxHalf = 108, maxTot = Math.max(...mList.map(d => Math.max(d.withTot, d.vsTot)), 1);
    const sc = v => (v / maxTot) * maxHalf;
    mSvg.appendChild(svgEl("text", { x: cx0 - 12, y: 20, "text-anchor": "end", fill: "var(--ink)", "font-size": 12, "font-weight": 600 }, "As teammate (W-L)"));
    mSvg.appendChild(svgEl("text", { x: cx0 + 12, y: 20, "text-anchor": "start", fill: "var(--ink)", "font-size": 12, "font-weight": 600 }, "As opponent (W-L)"));
    mSvg.appendChild(svgEl("line", { x1: cx0, y1: 30, x2: cx0, y2: mH - 12, stroke: "var(--ink-muted)", "stroke-dasharray": "3,3", "stroke-opacity": 0.55 }));

    mList.forEach((d, i) => {
      const y = 38 + i * rowH;
      const nmEl = svgEl("text", { x: 186, y: y + 14, "text-anchor": "end", fill: "var(--link)", "font-size": 12, "font-weight": 500, style: "cursor:pointer;" }, `${d.name.slice(0, 15)} (${d.bt_mmr.toFixed(0)})`);
      nmEl.addEventListener("click", () => openPlayerProfile(d.idx));
      mSvg.appendChild(nmEl);

      const wwW = sc(d.ww), wlW = sc(d.wl), vwW = sc(d.vw), vlW = sc(d.vl);
      if (wwW) mSvg.appendChild(svgEl("rect", { x: cx0 - 6 - wwW, y: y + 3, width: wwW, height: 14, fill: "var(--pos)", rx: 2 }));
      if (wlW) mSvg.appendChild(svgEl("rect", { x: cx0 - 6 - wwW - wlW, y: y + 3, width: wlW, height: 14, fill: "var(--neg)", rx: 2 }));
      if (d.withTot) mSvg.appendChild(svgEl("text", { x: cx0 - 12 - wwW - wlW, y: y + 14, "text-anchor": "end", fill: "var(--ink-muted)", "font-size": 12 }, `${d.ww}-${d.wl}`));

      if (vwW) mSvg.appendChild(svgEl("rect", { x: cx0 + 6, y: y + 3, width: vwW, height: 14, fill: "var(--pos)", rx: 2 }));
      if (vlW) mSvg.appendChild(svgEl("rect", { x: cx0 + 6 + vwW, y: y + 3, width: vlW, height: 14, fill: "var(--neg)", rx: 2 }));
      if (d.vsTot) mSvg.appendChild(svgEl("text", { x: cx0 + 12 + vwW + vlW, y: y + 14, fill: "var(--ink-muted)", "font-size": 12 }, `${d.vw}-${d.vl}`));
    });
  }

  profFilter.addEventListener("input", e => { populateProfileSelect(e.target.value); renderProfile(); });
  profSelect.addEventListener("change", e => openPlayerProfile(Number(e.target.value)));
  document.getElementById("chk-rolling").addEventListener("change", e => { state.rollingWin = e.target.checked; renderProfile(); });
  document.getElementById("min-shared").addEventListener("input", e => {
    state.minShared = Number(e.target.value);
    document.getElementById("min-shared-val").textContent = state.minShared;
    renderProfile();
  });
  document.getElementById("matchup-sort").addEventListener("change", e => { state.matchupSort = e.target.value; renderProfile(); });

  // TAB 4: METHODOLOGY & VALIDATION
  function renderEngine() {
    if (!hasPbp) return;
    const m = SITE_DATA.meta;
    document.getElementById("bpm-sub").textContent = `Scaled to pts = +3.0 across ${m.box_matches} box-score matches (LOO-CV R^2 = ${m.bpm_r2 ?? "-"}). Passive volume touches turn negative once points are controlled.`;
    document.getElementById("cv-sub").textContent = `Out-of-sample rally log-loss (longer bar = lower loss) and Spearman-Brown split-half reliability across ${m.pbp_qualified} qualified players.`;

    const svg = document.getElementById("kinds-svg");
    svg.innerHTML = "";
    const kinds = SITE_DATA.markov_kinds;
    const valFn = k => state.kindMetric === "epa" ? k[2] : (state.kindMetric === "v_all" ? 100 * k[3] : (state.kindMetric === "v_nt" ? 100 * k[4] : k[1]));
    const vals = kinds.map(valFn);
    const minV = state.kindMetric === "epa" ? Math.min(...vals, 0) : 0, maxV = Math.max(...vals, 1);
    const padL = minV < 0 ? 142 : 96, padR = 72, iw = 580 - padL - padR;
    const lblX = minV < 0 ? 78 : padL - 10;
    const sx0 = padL + ((0 - minV) / (maxV - minV)) * iw;
    const sc = v => padL + ((v - minV) / (maxV - minV)) * iw;
    svg.appendChild(svgEl("line", { x1: sx0, y1: 18, x2: sx0, y2: 318, stroke: "var(--ink-muted)", "stroke-dasharray": "3,3", "stroke-opacity": 0.55 }));
    kinds.forEach((k, i) => {
      const v = valFn(k), y = 24 + i * 26, sel = k[0] === state.selectedKind;
      const xStart = Math.min(sx0, sc(v)), bw = Math.max(2, Math.abs(sc(v) - sx0));
      const rect = svgEl("rect", {
        x: xStart, y: y + 2, width: bw, height: 18, rx: 3,
        fill: state.kindMetric === "epa" ? (v >= 0 ? "var(--pos)" : "var(--neg)") : "var(--chart-1)",
        "fill-opacity": sel ? 1 : 0.72,
        stroke: sel ? "var(--ink)" : "none", "stroke-width": sel ? 1.6 : 0, style: "cursor:pointer;"
      });
      const lbl = svgEl("text", { x: lblX, y: y + 15, "text-anchor": "end", fill: "var(--ink)", "font-size": 12, "font-weight": sel ? 700 : 500, style: "cursor:pointer;" }, k[0]);
      const pick = () => { state.selectedKind = k[0]; renderEngine(); };
      rect.addEventListener("click", pick); lbl.addEventListener("click", pick);
      svg.appendChild(rect); svg.appendChild(lbl);
      const txtVal = state.kindMetric === "count" ? `${k[1]}` : (state.kindMetric === "epa" ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : `${v.toFixed(1)}%`);
      svg.appendChild(svgEl("text", { x: v >= 0 ? xStart + bw + 7 : xStart - 7, y: y + 15, "text-anchor": v >= 0 ? "start" : "end", fill: "var(--ink-muted)", "font-size": 12 }, txtVal));
    });

    document.getElementById("substate-title").textContent = "Sub-states: " + state.selectedKind;
    const rows = SITE_DATA.markov_states.filter(s => s[0] === state.selectedKind).sort((a, b) => a[1] - b[1] || a[2].localeCompare(b[2]));
    document.getElementById("substate-body").innerHTML = rows.map(s => `
      <tr>
        <td class="left">T${s[1]}</td><td class="left muted">${esc(s[2])}</td>
        <td class="right">${s[3]}</td>
        <td class="right">${(100 * s[4]).toFixed(1)}%</td>
        <td class="right pri"><b>${s[6] !== null ? (100 * s[6]).toFixed(1) + "%" : "-"}</b></td>
        <td class="right">${(100 * s[7]).toFixed(1)}%</td>
      </tr>`).join("");

    // BPM Weights
    const bpmSvg = document.getElementById("bpm-svg");
    bpmSvg.innerHTML = "";
    const bpm = SITE_DATA.bpm_weights;
    if (bpm.length) {
      const bMin = Math.min(0, ...bpm.map(b => Math.min(b[1], b[2]))) - 0.3;
      const bMax = Math.max(0, ...bpm.map(b => Math.max(b[1], b[2]))) + 0.3;
      const bPadL = 62, bPadR = 148, bW = 560 - bPadL - bPadR;
      const scB = v => bPadL + ((v - bMin) / (bMax - bMin)) * bW;
      const zeroX = scB(0);
      bpmSvg.appendChild(svgEl("line", { x1: zeroX, y1: 22, x2: zeroX, y2: 266, stroke: "var(--ink-muted)", "stroke-dasharray": "3,3", "stroke-opacity": 0.55 }));
      bpm.forEach((b, i) => {
        const y = 30 + i * 29;
        bpmSvg.appendChild(svgEl("text", { x: bPadL - 10, y: y + 15, "text-anchor": "end", fill: "var(--ink)", "font-size": 12, "font-weight": 600 }, b[0]));
        const ox = Math.min(zeroX, scB(b[1])), ow = Math.max(2, Math.abs(scB(b[1]) - zeroX));
        const ex = Math.min(zeroX, scB(b[2])), ew = Math.max(2, Math.abs(scB(b[2]) - zeroX));
        bpmSvg.appendChild(svgEl("rect", { x: ox, y: y + 2, width: ow, height: 9, fill: "var(--chart-2)", rx: 2 }));
        bpmSvg.appendChild(svgEl("rect", { x: ex, y: y + 13, width: ew, height: 9, fill: b[2] >= 0 ? "var(--chart-1)" : "var(--neg)", rx: 2 }));
        bpmSvg.appendChild(svgEl("text", { x: Math.max(ox + ow, ex + ew) + 8, y: y + 16, fill: "var(--ink-muted)", "font-size": 12 }, `Off ${b[1].toFixed(1)} / Emp ${b[2] >= 0 ? "+" : ""}${b[2].toFixed(2)}`));
      });
      bpmSvg.appendChild(svgEl("rect", { x: bPadL, y: 279, width: 12, height: 8, fill: "var(--chart-2)", rx: 2 }));
      bpmSvg.appendChild(svgEl("text", { x: bPadL + 18, y: 287, fill: "var(--ink)", "font-size": 12 }, "In-game MVP"));
      bpmSvg.appendChild(svgEl("rect", { x: bPadL + 130, y: 279, width: 12, height: 8, fill: "var(--chart-1)", rx: 2 }));
      bpmSvg.appendChild(svgEl("text", { x: bPadL + 148, y: 287, fill: "var(--ink)", "font-size": 12 }, "Empirical LOO-CV BPM"));
    }

    // CV Chart (dynamic scale so lower log-loss cleanly reads as longer bar)
    const cvSvg = document.getElementById("cv-svg");
    cvSvg.innerHTML = "";
    const cvRows = SITE_DATA.cv_bench;
    if (cvRows.length) {
      const losses = cvRows.map(c => c[2]);
      const lMax = Math.max(...losses) + 0.0012;
      const lMin = Math.min(...losses) - 0.0012;
      const cPadL = 186, cPadR = 148, cW = 560 - cPadL - cPadR;
      cvRows.forEach((c, i) => {
        const y = 16 + i * 28;
        const w = Math.max(10, ((lMax - c[2]) / Math.max(1e-6, lMax - lMin)) * cW);
        const last = i === cvRows.length - 1;
        cvSvg.appendChild(svgEl("text", { x: cPadL - 10, y: y + 14, "text-anchor": "end", fill: "var(--ink)", "font-size": 12, "font-weight": last ? 700 : 500 }, c[0]));
        cvSvg.appendChild(svgEl("rect", { x: cPadL, y: y + 2, width: cW, height: 16, rx: 3, fill: "var(--line)", "fill-opacity": 0.4 }));
        cvSvg.appendChild(svgEl("rect", { x: cPadL, y: y + 2, width: w, height: 16, rx: 3, fill: last ? "var(--pos)" : "var(--chart-1)" }));
        cvSvg.appendChild(svgEl("text", { x: cPadL + w + 8, y: y + 14, fill: "var(--ink-muted)", "font-size": 12 }, `${c[2].toFixed(5)} · AUC ${c[4].toFixed(3)}`));
      });
    }

    // Reliability Chart
    const relSvg = document.getElementById("rel-svg");
    relSvg.innerHTML = "";
    const rPadL = 196, rPadR = 142, rW = 560 - rPadL - rPadR;
    SITE_DATA.reliability.forEach((r, i) => {
      const y = 12 + i * 23;
      const barW = Math.max(4, Math.min(1, r[2]) * rW);
      relSvg.appendChild(svgEl("text", { x: rPadL - 10, y: y + 13, "text-anchor": "end", fill: "var(--ink)", "font-size": 12 }, r[0]));
      relSvg.appendChild(svgEl("rect", { x: rPadL, y: y + 3, width: rW, height: 12, rx: 2, fill: "var(--line)", "fill-opacity": 0.4 }));
      relSvg.appendChild(svgEl("rect", { x: rPadL, y: y + 3, width: barW, height: 12, rx: 2, fill: r[2] >= 0.6 ? "var(--pos)" : "var(--warn)" }));
      relSvg.appendChild(svgEl("text", { x: rPadL + barW + 8, y: y + 13, fill: "var(--ink-muted)", "font-size": 12 }, `SB ${r[2].toFixed(2)} (r=${r[1].toFixed(2)})`));
    });
  }
  document.getElementById("kind-metric").addEventListener("change", e => { state.kindMetric = e.target.value; renderEngine(); });

  // Glossary Modal (100% player-agnostic)
  const GLOSSARY_GROUPS = [
    {
      title: "Core composite and efficiency metrics",
      items: [
        ["VPM", "Volleyball Plus-Minus", "Flagship overall effectiveness rating (team-equivalent expected point margin per 100 rallies above average): 75% calibrated PBP EPA/100R + 25% Rally RAPM."],
        ["O-VPM / D-VPM", "Offensive & Defensive VPM", "Additive split of VPM (O-VPM + D-VPM = VPM) combining offensive PBP EPA + Sideout RAPM vs. defensive PBP EPA + Serve RAPM."],
        ["V-Eff", "Volleyball Touch Efficiency", "Play-by-play Markov Expected Points Added per 100 Touches (EPA/100T). Measures per-touch execution quality independent of touch volume."],
        ["EPA", "Expected Points Added", "Zero-sum change in rally win probability caused by a contact: V(after) - V(before). Positive EPA increases your team's rally win odds."],
        ["Usage (Use)", "Touch Share per Rally", "Attributed contacts divided by rallies played."],
        ["V-WAR", "Volleyball Wins Above Replacement", "Cumulative Best-of-3 (21-pt) match wins contributed above replacement level (p20 of qualified humans), scaled by 1/team_size slot exposure."]
      ]
    },
    {
      title: "Lineup impact and matchmaking ratings",
      items: [
        ["RAPM", "Regularized Adjusted Plus-Minus", "Ridge regression (alpha = 40) predicting rally outcomes from on-court lineups, controlling for teammates, opponents, CPU fills, and serving team."],
        ["Serve / Sideout RAPM", "Phase-Split RAPM", "Serve RAPM measures breakpoint impact when your team serves; Sideout RAPM measures receive/offense impact when returning serve."],
        ["BT MMR", "Global Bradley-Terry MMR", "L2-regularized logistic skill rating fitted across all verified matches simultaneously, scaled to Elo units and centered at 1500 (no match-order bias)."],
        ["Elo MMR", "Chronological Team Elo", "Sequential match-by-match rating (start 1500, K = 32) updated from mean team Elo after each game."]
      ]
    },
    {
      title: "Volleyball splits and validation",
      items: [
        ["TrueHit%", "True Hitting Percentage", "(True Kills - Direct Attack Errors) / Attack Attempts across spikes, tips, and dumps, including kills forced off a failed defensive touch."],
        ["TrueAce% / ServeErr%", "Serve Splits", "TrueAce% counts direct aces plus serves forcing a failed receive/shank; ServeErr% is direct serve fault rate."],
        ["Shank%", "Shank Rate", "Percentage of defensive/receive touches classified as a shank."],
        ["Empirical BPM", "LOO-CV Box Plus-Minus", "Match point-margin weights learned via Leave-One-Out Ridge regression across box-score matches, compared against the game's hardcoded MVP weights."],
        ["V_all / V_nt", "Markov State Values", "V_all = overall empirical win probability after a state; V_nt = win probability conditioned on the rally continuing (used in EPA to prevent mixture bias)."],
        ["SB", "Spearman-Brown Reliability", "Full-sample reliability estimate 2r / (1 + r) from odd/even rally split-half correlation r."]
      ]
    },
    {
      title: "Role metrics (Spiker, Setter, Libero)",
      items: [
        ["A-Eff / A-VPM", "Spiker Attack Efficiency & Impact", "Non-terminal Markov attack EPA per 100 attempts (spikes, tips, dumps) shrunk by m=40 (A-Eff), or per 100 rallies at m=150 (A-VPM)."],
        ["S-Eff / S-VPM", "Setter Delivery Efficiency & Impact", "Expected win-probability points per 100 setting actions (sets touch 1-2 + 2nd-touch dumps) above context-matched human baselines, shrunk by m=40 (S-Eff) or per 100 rallies at m=150 (S-VPM)."],
        ["Att% (Setter)", "Attackable Set Rate", "Share of setting actions producing a 3rd-touch teammate attack or an active 2nd-touch dump."],
        ["L-Eff / L-VPM", "Libero First-Contact Efficiency & Impact", "DataVolley pass-grade points per 100 cross-net non-block first contacts above the human incoming-ball baseline, shrunk by m=40 (L-Eff) or per 100 rallies at m=150 (L-VPM)."],
        ["SR-Eff / Dig-Eff", "Serve-Receive vs. Floor-Dig Efficiency", "Sub-skill splits of L-Eff (m=25) separating incoming serves (SR-Eff) from incoming attacks, tips, and blocks (Dig-Eff)."],
        ["G3 / G2 / G1 / G0", "DataVolley Pass-Grade Ladder", "G3_insys_att leads to attack/dump; G_overpass_nt caps lucky bounce overpasses; G2_insys_tip; G1_shank_alive; G1_oos; G2_set_neutral neutralizes setter errors; G0_err is a terminal error."]
      ]
    }
  ];

  const glossaryModal = document.getElementById("glossary-modal"), glossarySearch = document.getElementById("glossary-search");
  function renderGlossary(filter = "") {
    const q = filter.trim().toLowerCase();
    const html = GLOSSARY_GROUPS.map(g => {
      const hits = g.items.filter(([c, n, d]) => !q || c.toLowerCase().includes(q) || n.toLowerCase().includes(q) || d.toLowerCase().includes(q));
      if (!hits.length) return "";
      return `<div><h3 style="margin-bottom:8px;">${esc(g.title)}</h3><div class="glossary-grid">${hits.map(([c, n, d]) => `
        <div class="glossary-item">
          <div class="between"><b class="pri">${esc(c)}</b><span class="muted">${esc(n)}</span></div>
          <p class="prose" style="font-size:var(--text-sm);">${esc(d)}</p>
        </div>`).join("")}</div></div>`;
    }).join("");
    document.getElementById("glossary-body").innerHTML = html || `<p class="muted">No glossary entries match "${esc(filter)}".</p>`;
  }
  const openGlossary = () => { glossaryModal.classList.remove("hidden"); renderGlossary(glossarySearch.value); glossarySearch.focus(); };
  document.getElementById("open-glossary").addEventListener("click", openGlossary);
  document.getElementById("footer-glossary").addEventListener("click", openGlossary);
  document.getElementById("close-glossary").addEventListener("click", () => glossaryModal.classList.add("hidden"));
  glossaryModal.addEventListener("click", e => { if (e.target === glossaryModal) glossaryModal.classList.add("hidden"); });
  glossarySearch.addEventListener("input", e => renderGlossary(e.target.value));
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !glossaryModal.classList.contains("hidden")) glossaryModal.classList.add("hidden"); });

  function renderActiveTab() {
    if (state.tab === "scatter") { renderScatter(); renderSandboxTable(); }
    else if (state.tab === "spiker") { renderSpikerTab(); }
    else if (state.tab === "setter") { renderSetterTab(); }
    else if (state.tab === "libero") { renderLiberoTab(); }
    else if (state.tab === "compare") { renderCompare(); renderMainTable(); }
    else if (state.tab === "profile") { renderProfile(); }
    else if (state.tab === "engine") { renderEngine(); }
  }

  // Graceful MMR-only mode if dataset has no PBP telemetry
  if (!hasPbp) {
    ["scatter", "spiker", "setter", "libero", "engine"].forEach(t => {
      document.querySelector(`[data-tab="${t}"]`).classList.add("hidden");
    });
  }

  initHeader();
  recomputeSandbox();
  syncSandboxLabels();
  switchTab(state.tab);
