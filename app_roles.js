  // ROLE METRICS (SPIKER, SETTER, LIBERO)
  const ROLES = SITE_DATA.roles || null;
  const roleSpikers = ROLES ? ROLES.spikers.map((r, i) => ({
    idx: i, name: r[0], id: r[1], mmr_idx: r[2], is_primary: r[3] === 1, qualified: r[4] === 1,
    rallies: r[5], att: r[6], spk: r[7], tip: r[8], sum_epa: r[9], a_eff_raw: r[10],
    a_eff: (100 * r[9]) / (r[6] + 40), a_vpm: r[11], att_share: r[12], att_per_r: r[13],
    true_hit: r[14], kill_pct: r[15], err_pct: r[16], tip_pct: r[17],
    blk_epa: r[18], blk_n: r[19], o_vpm: r[20], vpm: r[21]
  })) : [];

  const roleSetters = ROLES ? ROLES.setters.map((r, i) => ({
    idx: i, name: r[0], id: r[1], mmr_idx: r[2], is_primary: r[3] === 1, qualified: r[4] === 1,
    rallies: r[5], act: r[6], dumps: r[7], sum_delta: r[8], s_eff_raw: r[9],
    s_eff: (100 * r[8]) / (r[6] + 40), s_vpm: r[10], set_share: r[11], sets_per_r: r[12],
    att_pct: r[13], err_pct: r[14], tm_hit: r[15], tm_att: r[16],
    box_ast_pct: r[17], box_ast: r[18], box_sets: r[19], vpm: r[20], dump_epa: r[21]
  })) : [];

  const roleLiberos = ROLES ? ROLES.liberos.map((r, i) => ({
    idx: i, name: r[0], id: r[1], mmr_idx: r[2], is_primary: r[3] === 1, qualified: r[4] === 1,
    rallies: r[5], fc_n: r[6], sr_n: r[7], dig_n: r[8], sum_delta: r[9], l_eff_raw: r[10],
    l_eff: (100 * r[9]) / (r[6] + 40), l_vpm: r[11], sr_eff: r[12], dig_eff: r[13],
    fc_share: r[14], fc_per_r: r[15], in_sys: r[16], clean: r[17], err_pct: r[18], sc_pct: r[19],
    blk_epa: r[20], blk_n: r[21], d_vpm: r[22]
  })) : [];

  // Attach qualified role efficiency metrics onto main scatter player objects
  const spkMap = new Map(roleSpikers.filter(r => r.qualified).map(r => [r.name + "::" + r.id, r]));
  const setMap = new Map(roleSetters.filter(r => r.qualified).map(r => [r.name + "::" + r.id, r]));
  const libMap = new Map(roleLiberos.filter(r => r.qualified).map(r => [r.name + "::" + r.id, r]));
  players.forEach(p => {
    const key = p.name + "::" + p.id;
    const kr = spkMap.get(key), sr = setMap.get(key), lr = libMap.get(key);
    p.a_eff = kr ? kr.a_eff : null;
    p.s_eff = sr ? sr.s_eff : null;
    p.l_eff = lr ? lr.l_eff : null;
    p.sr_eff = lr ? lr.sr_eff : null;
    p.dig_eff = lr ? lr.dig_eff : null;
  });

  Object.assign(state, {
    rKM: 40, rKPrimary: false, rKUnqual: true, rKMode: "load", rKSearch: "", rKSel: 0, rKSort: { key: "a_eff", dir: -1 },
    rSM: 40, rSPrimary: false, rSUnqual: true, rSSearch: "", rSSel: 0, rSSort: { key: "s_eff", dir: -1 },
    rLM: 40, rLPrimary: false, rLUnqual: true, rLMode: "sr_dig", rLSearch: "", rLSel: 0, rLSort: { key: "l_eff", dir: -1 }
  });

  function valCls(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return "";
    return v > 0 ? "pos" : (v < 0 ? "neg" : "");
  }

  function renderRoleKpis(elId, cards, onPickIdx) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.innerHTML = cards.map((c, ci) => {
      const canClick = onPickIdx && c.pickIdx !== undefined && c.pickIdx !== null;
      return `<div class="ledger-item ${canClick ? "is-clickable" : ""}" data-rkpi="${ci}" title="${esc(c.tip || "")}">
        <div class="muted">${esc(c.lbl)}</div>
        <div class="kpi-val tabnum">${esc(c.val)}</div>
        <div class="ledger-sub tabnum">${esc(c.sub)}</div>
      </div>`;
    }).join("");
    if (onPickIdx) {
      el.querySelectorAll(".ledger-item.is-clickable").forEach(node => {
        const c = cards[Number(node.dataset.rkpi)];
        node.addEventListener("click", () => onPickIdx(c.pickIdx));
      });
    }
  }

  function renderRoleLegend(elId, primaryLabel, secondaryLabel, showUnqual) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.innerHTML =
      `<span class="legend-item"><span class="dot" style="background:var(--chart-1)"></span>${esc(primaryLabel)}</span>` +
      `<span class="legend-item"><span class="dot" style="background:var(--chart-2)"></span>${esc(secondaryLabel)}</span>` +
      (showUnqual ? `<span class="legend-item"><span class="dot" style="background:var(--chart-1);opacity:0.4;"></span>Faded: &lt;100 rallies</span>` : "");
  }

  function renderRoleScatter(svgId, tipId, rows, cfg) {
    const svg = document.getElementById(svgId);
    const tip = document.getElementById(tipId);
    if (!svg) return;
    svg.innerHTML = "";
    const W = 640, H = 340, pad = { l: 58, r: 24, t: 20, b: 44 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

    const valid = rows.filter(p => {
      const xv = cfg.xFn(p), yv = cfg.yFn(p);
      return xv !== null && xv !== undefined && Number.isFinite(xv) && yv !== null && yv !== undefined && Number.isFinite(yv);
    });
    if (!valid.length) {
      svg.appendChild(svgEl("text", { x: W / 2, y: H / 2, "text-anchor": "middle", fill: "var(--ink-muted)", "font-size": 13 }, "No players match the current filter."));
      return;
    }

    const xs = valid.map(cfg.xFn), ys = valid.map(cfg.yFn);
    let xMin = Math.min(...xs), xMax = Math.max(...xs);
    let yMin = Math.min(...ys), yMax = Math.max(...ys);
    const xPad = (xMax - xMin || 1) * 0.1, yPad = (yMax - yMin || 1) * 0.12;
    xMin -= xPad; xMax += xPad; yMin -= yPad; yMax += yPad;

    const sx = x => pad.l + ((x - xMin) / (xMax - xMin)) * iw;
    const sy = y => pad.t + ih - ((y - yMin) / (yMax - yMin)) * ih;

    for (let i = 0; i <= 4; i++) {
      const yv = yMin + (i / 4) * (yMax - yMin), yy = sy(yv);
      svg.appendChild(svgEl("line", { x1: pad.l, y1: yy, x2: W - pad.r, y2: yy, stroke: "var(--line)", "stroke-opacity": 0.65, "stroke-dasharray": "2,3" }));
      svg.appendChild(svgEl("text", { x: pad.l - 7, y: yy + 4, "text-anchor": "end", fill: "var(--ink-muted)", "font-size": 12 }, yv.toFixed(1)));
      const xv = xMin + (i / 4) * (xMax - xMin), xx = sx(xv);
      svg.appendChild(svgEl("line", { x1: xx, y1: pad.t, x2: xx, y2: H - pad.b, stroke: "var(--line)", "stroke-opacity": 0.65, "stroke-dasharray": "2,3" }));
      svg.appendChild(svgEl("text", { x: xx, y: H - pad.b + 16, "text-anchor": "middle", fill: "var(--ink-muted)", "font-size": 12 }, xv.toFixed(cfg.xDec)));
    }
    if (xMin < 0 && xMax > 0) {
      svg.appendChild(svgEl("line", { x1: sx(0), y1: pad.t, x2: sx(0), y2: H - pad.b, stroke: "var(--ink-muted)", "stroke-dasharray": "4,3", "stroke-opacity": 0.55 }));
    }
    if (yMin < 0 && yMax > 0) {
      svg.appendChild(svgEl("line", { x1: pad.l, y1: sy(0), x2: W - pad.r, y2: sy(0), stroke: "var(--ink-muted)", "stroke-dasharray": "4,3", "stroke-opacity": 0.55 }));
    }

    svg.appendChild(svgEl("text", { x: pad.l + iw / 2, y: H - 6, "text-anchor": "middle", fill: "var(--ink)", "font-size": 12, "font-weight": 600 }, cfg.xLabel));
    svg.appendChild(svgEl("text", { x: 14, y: pad.t + ih / 2, "text-anchor": "middle", fill: "var(--ink)", "font-size": 12, "font-weight": 600, transform: `rotate(-90 14 ${pad.t + ih / 2})` }, cfg.yLabel));

    const labelIdxs = new Set(valid.slice(0, 6).map(p => p.idx));
    labelIdxs.add(cfg.selIdx);
    const placedBoxes = [];

    const drawOrder = [...valid].sort((a, b) => (a.idx === cfg.selIdx ? 1 : 0) - (b.idx === cfg.selIdx ? 1 : 0));
    drawOrder.forEach(p => {
      const cx = sx(cfg.xFn(p)), cy = sy(cfg.yFn(p)), r = cfg.rFn(p);
      const col = p.is_primary ? "var(--chart-1)" : "var(--chart-2)";
      const isSel = p.idx === cfg.selIdx;
      const baseStroke = isSel ? "var(--ink)" : "var(--surface)";
      const baseWidth = isSel ? 2.4 : 1.2;
      const dot = svgEl("circle", {
        cx, cy, r, fill: col, "fill-opacity": p.qualified ? 0.85 : 0.42,
        stroke: baseStroke, "stroke-width": baseWidth, style: "cursor:pointer;"
      });
      dot.addEventListener("mouseenter", e => {
        dot.setAttribute("stroke", "var(--ink)");
        dot.setAttribute("stroke-width", "2.4");
        tip.innerHTML = cfg.tipHtml(p);
        tip.classList.remove("hidden");
        placeTooltip(tip, e, 250, 120);
      });
      dot.addEventListener("mousemove", e => placeTooltip(tip, e, 250, 120));
      dot.addEventListener("mouseleave", () => {
        dot.setAttribute("stroke", baseStroke);
        dot.setAttribute("stroke-width", baseWidth);
        tip.classList.add("hidden");
      });
      dot.addEventListener("click", () => cfg.onSelect(p.idx));
      svg.appendChild(dot);
    });

    // Place selected player's label first, then top labels without collisions
    const labelOrder = valid.filter(p => labelIdxs.has(p.idx))
      .sort((a, b) => (b.idx === cfg.selIdx ? 1 : 0) - (a.idx === cfg.selIdx ? 1 : 0));
    labelOrder.forEach(p => {
      const cx = sx(cfg.xFn(p)), cy = sy(cfg.yFn(p)), r = cfg.rFn(p);
      const isSel = p.idx === cfg.selIdx;
      const lbl = p.name + (p.qualified ? "" : " *");
      const bw = lbl.length * 6.4 + 8, bh = 14;
      const cands = [
        { x: cx + r + 5, y: cy + 4, anchor: "start", boxX: cx + r + 5, boxY: cy + 4 },
        { x: cx - r - 5, y: cy + 4, anchor: "end", boxX: cx - r - 5 - bw, boxY: cy + 4 },
        { x: cx, y: cy - r - 5, anchor: "middle", boxX: cx - bw / 2, boxY: cy - r - 5 },
        { x: cx, y: cy + r + 14, anchor: "middle", boxX: cx - bw / 2, boxY: cy + r + 14 }
      ];
      let chosen = null;
      for (const c of cands) {
        if (c.boxX < pad.l || c.boxX + bw > W - pad.r || c.boxY - bh < pad.t || c.boxY > H - pad.b) continue;
        let hit = false;
        for (const b of placedBoxes) {
          if (!(c.boxX + bw < b.x || c.boxX > b.x + b.w || c.boxY < b.y - b.h || c.boxY - bh > b.y)) { hit = true; break; }
        }
        if (!hit) { chosen = c; break; }
      }
      if (!chosen && isSel) chosen = cands[0];
      if (chosen) {
        placedBoxes.push({ x: chosen.boxX, y: chosen.boxY, w: bw, h: bh });
        svg.appendChild(svgEl("text", {
          x: chosen.x, y: chosen.y, "text-anchor": chosen.anchor,
          fill: isSel ? "var(--ink)" : "var(--ink-muted)",
          "font-size": 12, "font-weight": isSel ? 700 : 500
        }, lbl));
      }
    });
  }

  const LADDER_LABELS = {
    D_win: "Dump kill",
    S_overpass: "Set overpass",
    S_att: "Attackable set",
    D_alive: "Dump in play",
    S_reset: "Reset pass",
    S_tip: "Tipped attack",
    S_oos: "Out of system",
    S_err: "Set error",
    D_err: "Dump error",
    G3_insys_att: "G3: In-system attack",
    G_overpass_nt: "Overpass (capped)",
    G2_insys_tip: "G2: In-system tip",
    G1_shank_alive: "G1: Shank alive",
    G1_oos: "G1: Out of system",
    G2_set_neutral: "G2: Neutral set error",
    G0_err: "G0: Direct error"
  };

  function renderRoleHBar(svgId, rows, maxVal, colorFn, labelFn) {
    const svg = document.getElementById(svgId);
    if (!svg) return;
    svg.innerHTML = "";
    if (!rows.length) {
      svg.appendChild(svgEl("text", { x: 290, y: 100, "text-anchor": "middle", fill: "var(--ink-muted)", "font-size": 13 }, "Insufficient data."));
      return;
    }
    const parts = svg.getAttribute("viewBox").split(" ");
    const W = Number(parts[2]), H = Number(parts[3]);
    const minRaw = Math.min(0, ...rows.map(r => r[2]));
    const maxRaw = Math.max(maxVal, ...rows.map(r => r[2]));
    const span = (maxRaw - minRaw) || 1;
    const padL = 190, padR = 126, padT = 10, rowH = (H - padT - 10) / rows.length;
    const iw = W - padL - padR;
    const zeroX = padL + ((0 - minRaw) / span) * iw;
    const sx = v => padL + ((v - minRaw) / span) * iw;

    if (minRaw < 0) {
      svg.appendChild(svgEl("line", { x1: zeroX, y1: padT, x2: zeroX, y2: H - 10, stroke: "var(--ink-muted)", "stroke-dasharray": "3,3", "stroke-opacity": 0.65 }));
    }
    rows.forEach((row, i) => {
      const y = padT + i * rowH, v = row[2];
      const barH = Math.max(9, rowH - 8);
      const xPos = sx(Math.min(0, v));
      const barW = Math.max(2, Math.abs(sx(v) - zeroX));
      const disp = LADDER_LABELS[row[0]] || row[0];
      svg.appendChild(svgEl("text", { x: padL - 10, y: y + rowH * 0.63, "text-anchor": "end", fill: "var(--ink)", "font-size": 12 }, disp));
      if (minRaw >= 0) {
        svg.appendChild(svgEl("rect", { x: padL, y: y + 4, width: iw, height: barH, rx: 3, fill: "var(--line)", "fill-opacity": 0.45 }));
      }
      svg.appendChild(svgEl("rect", { x: xPos, y: y + 4, width: barW, height: barH, rx: 3, fill: colorFn(row), "fill-opacity": 0.88 }));
      const valX = v >= 0 ? (xPos + barW + 8) : (zeroX + 8);
      svg.appendChild(svgEl("text", { x: valX, y: y + rowH * 0.63, fill: "var(--ink-muted)", "font-size": 12 }, labelFn(row)));
    });
  }

  function renderRoleTable(headId, bodyId, rows, cols, sortState, selIdx, onSort, onSelect, rowCellsFn) {
    const head = document.getElementById(headId), body = document.getElementById(bodyId);
    head.innerHTML = `<tr><th class="left">#</th>` + cols.map(c =>
      `<th class="sort ${c.left ? "left" : ""}" data-sort="${c.k}" title="${esc(c.tip)}">${c.lbl}${sortState.key === c.k ? (sortState.dir < 0 ? " ▼" : " ▲") : ""}</th>`
    ).join("") + `</tr>`;
    const sk = sortState.key, sd = sortState.dir;
    const sorted = [...rows].sort((a, b) => sk === "name"
      ? sd * a.name.localeCompare(b.name)
      : sd * (((a[sk] === true ? 1 : a[sk] === false ? 0 : a[sk]) ?? -1e9) - ((b[sk] === true ? 1 : b[sk] === false ? 0 : b[sk]) ?? -1e9)));
    body.innerHTML = sorted.map((r, i) => `
      <tr class="clickable ${r.idx === selIdx ? "is-selected" : ""}" data-idx="${r.idx}">
        <td class="left muted">${i + 1}</td>
        ${rowCellsFn(r)}
      </tr>`).join("");
    head.querySelectorAll("th[data-sort]").forEach(th => th.addEventListener("click", () => onSort(th.dataset.sort)));
    body.querySelectorAll("tr").forEach(tr => tr.addEventListener("click", () => onSelect(Number(tr.dataset.idx))));
  }

  function detailGridHtml(items) {
    return `<div class="kv-grid">` + items.map(([lbl, val, cls]) => `
      <div class="kv-row">
        <span class="muted">${esc(lbl)}</span>
        <span class="kv-val tabnum ${cls || ""}">${esc(val)}</span>
      </div>`).join("") + `</div>`;
  }

  // SPIKER TAB
  function renderSpikerTab() {
    if (!hasPbp || !roleSpikers.length) return;
    roleSpikers.forEach(p => { p.a_eff = (100 * p.sum_epa) / (p.att + state.rKM); });
    const qList = roleSpikers.filter(p => p.qualified);
    const byEff = [...qList].sort((a, b) => b.a_eff - a.a_eff);
    const byAvpm = [...qList].sort((a, b) => b.a_vpm - a.a_vpm);
    const byHit = [...qList].sort((a, b) => (b.true_hit ?? -9) - (a.true_hit ?? -9));
    const primCnt = qList.filter(p => p.is_primary).length;
    renderRoleKpis("spiker-kpis", [
      byEff[0] ? { lbl: `Top Spiker (A-Eff, m=${state.rKM})`, val: byEff[0].name, sub: `${fmt(byEff[0].a_eff, 2, true)} (${byEff[0].att} att)`, tip: "Highest Bayesian-shrunk Attack EPA per 100 attempts", pickIdx: byEff[0].idx } : { lbl: "Top Spiker", val: "-", sub: "" },
      byAvpm[0] ? { lbl: "Top volume attack (A-VPM)", val: byAvpm[0].name, sub: `${fmt(byAvpm[0].a_vpm, 2, true)} (${fmt(byAvpm[0].att_per_r, 2)}/R)`, tip: "Highest cumulative attack impact per 100 rallies", pickIdx: byAvpm[0].idx } : { lbl: "Top A-VPM", val: "-", sub: "" },
      byHit[0] ? { lbl: "Top TrueHit%", val: byHit[0].name, sub: `${fmt(byHit[0].true_hit, 3)} (${fmt(byHit[0].kill_pct, 1)}% kill)`, tip: "Highest (True Kills - Direct Attack Errors) / Attempts", pickIdx: byHit[0].idx } : { lbl: "Top TrueHit%", val: "-", sub: "" },
      { lbl: "Qualified spikers", val: `${qList.length} players`, sub: `${primCnt} primary (>=25%T) · ${ROLES.meta.spiker_events_human.toLocaleString()} att`, tip: "Qualified players with >=100 rallies and >=20 attacks" }
    ], idx => { state.rKSel = idx; renderSpikerTab(); });

    renderRoleLegend("r-spiker-legend", "Primary spiker (>=25%T)", "Secondary / hybrid", state.rKUnqual);
    const q = state.rKSearch.trim().toLowerCase();
    const list = roleSpikers.filter(p => (state.rKUnqual || p.qualified) && (!state.rKPrimary || p.is_primary) && (!q || p.name.toLowerCase().includes(q)));
    const isLoad = state.rKMode === "load";
    renderRoleScatter("r-spiker-svg", "r-spiker-tip", list, {
      xFn: isLoad ? p => p.att_per_r : p => p.true_hit,
      yFn: p => p.a_eff,
      rFn: p => Math.max(4.5, Math.min(13, Math.sqrt(p.att) * 0.5)),
      xDec: isLoad ? 2 : 3,
      xLabel: isLoad ? "Attack workload (attempts / rally)" : "True hitting % ((kills - err) / att)",
      yLabel: `A-Eff (attack EPA / 100 att, m=${state.rKM})`,
      selIdx: state.rKSel,
      tipHtml: p => `<b>${esc(p.name)}</b><br/>A-Eff: <b>${fmt(p.a_eff, 2, true)}</b> · A-VPM: ${fmt(p.a_vpm, 2, true)}<br/>Att: ${p.att} (${p.spk} spk, ${p.tip} tip) · TrueHit%: ${fmt(p.true_hit, 3)}`,
      onSelect: idx => { state.rKSel = idx; renderSpikerTab(); }
    });

    const p = roleSpikers[state.rKSel] || roleSpikers[0];
    const det = document.getElementById("r-spiker-detail");
    det.innerHTML = `
      <div class="between" style="padding-bottom:6px;">
        <div>
          <h3 style="font-size:var(--text-heading);">${esc(p.name)} ${p.qualified ? "" : '<span class="muted">(&lt;100R)</span>'}</h3>
          <div class="muted">${p.is_primary ? "Primary spiker" : "Secondary / hybrid"} · ${p.rallies}R</div>
        </div>
        <div style="text-align:right;">
          <div class="muted">A-Eff (m=${state.rKM})</div>
          <div class="kpi-val tabnum ${valCls(p.a_eff)}">${fmt(p.a_eff, 2, true)}</div>
        </div>
      </div>
      ${detailGridHtml([
        ["A-Eff raw (m=0)", fmt(p.a_eff_raw, 2, true), valCls(p.a_eff_raw)],
        ["A-VPM (/100R)", fmt(p.a_vpm, 2, true), valCls(p.a_vpm)],
        ["Attacks (Spk / Tip)", `${p.att} (${p.spk} / ${p.tip})`, ""],
        ["Att share / Att/R", `${fmt(p.att_share, 1)}% / ${fmt(p.att_per_r, 2)}`, ""],
        ["TrueHit%", fmt(p.true_hit, 3), valCls(p.true_hit)],
        ["Kill% / Err% / Tip%", `${fmt(p.kill_pct, 1)}% / ${fmt(p.err_pct, 1)}% / ${fmt(p.tip_pct, 1)}%`, ""],
        ["Block EPA/100R (Blk)", `${fmt(p.blk_epa, 2, true)} (${p.blk_n})`, valCls(p.blk_epa)],
        ["O-VPM / Overall VPM", `${fmt(p.o_vpm, 2, true)} / ${fmt(p.vpm, 2, true)}`, ""]
      ])}
      ${p.mmr_idx >= 0 ? `<button id="r-k-open-prof" type="button" class="btn btn-sm btn-primary" style="margin-top:auto;">Open full profile</button>` : ""}`;
    const btn = document.getElementById("r-k-open-prof");
    if (btn) btn.onclick = () => openPlayerProfile(p.mmr_idx);

    const cols = [
      { k: "name", lbl: "Player", left: true, tip: "Player display name" },
      { k: "is_primary", lbl: "Role", left: true, tip: "Primary spiker (>=25% of touches) vs Hybrid" },
      { k: "a_eff", lbl: "A-Eff", tip: "Attack Markov EPA per 100 attempts at shrinkage m" },
      { k: "a_vpm", lbl: "A-VPM", tip: "Attack value per 100 rallies (m=150)" },
      { k: "att", lbl: "Att", tip: "Total attack attempts (spikes + tips + dumps)" },
      { k: "att_share", lbl: "Att%T", tip: "Share of touches that are attacks" },
      { k: "true_hit", lbl: "TrueHit%", tip: "(True Kills - Direct Attack Errors) / Attempts" },
      { k: "kill_pct", lbl: "Kill%", tip: "True kills per attack attempt" },
      { k: "err_pct", lbl: "Err%", tip: "Direct attack error rate" },
      { k: "tip_pct", lbl: "Tip%", tip: "Share of attacks that are tips" },
      { k: "o_vpm", lbl: "O-VPM", tip: "Overall Offensive VPM" },
      { k: "vpm", lbl: "VPM", tip: "Overall Volleyball Plus-Minus" }
    ];
    renderRoleTable("r-spiker-tbl-head", "r-spiker-tbl-body", list, cols, state.rKSort, state.rKSel,
      k => { state.rKSort = { key: k, dir: state.rKSort.key === k ? -state.rKSort.dir : (k === "name" ? 1 : -1) }; renderSpikerTab(); },
      idx => { state.rKSel = idx; renderSpikerTab(); },
      r => `
        <td class="left"><b>${esc(r.name)}</b>${r.qualified ? "" : ' <span class="muted">(unq)</span>'}</td>
        <td class="left">${r.is_primary ? "Primary" : "Hybrid"}</td>
        <td class="right ${valCls(r.a_eff)}"><b>${fmt(r.a_eff, 2, true)}</b></td>
        <td class="right">${fmt(r.a_vpm, 2, true)}</td>
        <td class="right">${r.att}</td>
        <td class="right">${fmt(r.att_share, 1)}%</td>
        <td class="right">${fmt(r.true_hit, 3)}</td>
        <td class="right">${fmt(r.kill_pct, 1)}%</td>
        <td class="right">${fmt(r.err_pct, 1)}%</td>
        <td class="right">${fmt(r.tip_pct, 1)}%</td>
        <td class="right">${fmt(r.o_vpm, 2, true)}</td>
        <td class="right">${fmt(r.vpm, 2, true)}</td>`);
  }

  // SETTER TAB
  function renderSetterTab() {
    if (!hasPbp || !roleSetters.length) return;
    const rm = ROLES.meta;
    document.getElementById("setter-sub").textContent =
      `5-fold out-of-fold set-delivery model across ${rm.setter_events_human.toLocaleString()} human setting actions in ${rm.total_rallies.toLocaleString()} rallies (mean drift ${fmt(rm.mean_human_set_delta_100, 2, true)} pts/100).`;

    roleSetters.forEach(p => { p.s_eff = (100 * p.sum_delta) / (p.act + state.rSM); });
    const qList = roleSetters.filter(p => p.qualified);
    const byEff = [...qList].sort((a, b) => b.s_eff - a.s_eff);
    const bySvpm = [...qList].sort((a, b) => b.s_vpm - a.s_vpm);
    const byAtt = [...qList].sort((a, b) => b.att_pct - a.att_pct);
    const primCnt = qList.filter(p => p.is_primary).length;
    renderRoleKpis("setter-kpis", [
      byEff[0] ? { lbl: `Top Setter (S-Eff, m=${state.rSM})`, val: byEff[0].name, sub: `${fmt(byEff[0].s_eff, 2, true)} (${byEff[0].act} acts / ${byEff[0].dumps} dmp)`, tip: "Top qualified setter by context-adjusted delivery efficiency", pickIdx: byEff[0].idx } : { lbl: "Top S-Eff", val: "-", sub: "" },
      bySvpm[0] ? { lbl: "Top Setter (S-VPM)", val: bySvpm[0].name, sub: `${fmt(bySvpm[0].s_vpm, 2, true)} (${fmt(bySvpm[0].sets_per_r, 2)}/R)`, tip: "Top qualified setter by cumulative setting value per 100 rallies", pickIdx: bySvpm[0].idx } : { lbl: "Top S-VPM", val: "-", sub: "" },
      byAtt[0] ? { lbl: "Top attackable %", val: byAtt[0].name, sub: `${fmt(byAtt[0].att_pct, 1)}% (${fmt(byAtt[0].err_pct, 1)}% err)`, tip: "Highest share of sets creating a 3rd-touch attack or active dump", pickIdx: byAtt[0].idx } : { lbl: "Top Att%", val: "-", sub: "" },
      { lbl: "Qualified setters", val: `${qList.length} players`, sub: `${primCnt} primary (>=35%T)`, tip: "Qualified setters (>=100R and >=35 set actions)" }
    ], idx => { state.rSSel = idx; renderSetterTab(); });

    renderRoleLegend("r-setter-legend", "Primary setter (>=35%T)", "Secondary / spot", state.rSUnqual);
    const q = state.rSSearch.trim().toLowerCase();
    const list = roleSetters.filter(p => (state.rSUnqual || p.qualified) && (!state.rSPrimary || p.is_primary) && (!q || p.name.toLowerCase().includes(q)));
    renderRoleScatter("r-setter-svg", "r-setter-tip", list, {
      xFn: p => p.sets_per_r, yFn: p => p.s_eff,
      rFn: p => Math.max(4.5, Math.min(12.5, Math.sqrt(p.act) * 0.65)), xDec: 2,
      xLabel: "Setting workload (set + dump actions / rally)",
      yLabel: `S-Eff (pts / 100 set acts, m=${state.rSM})`,
      selIdx: state.rSSel,
      tipHtml: p => `<b>${esc(p.name)}</b><br/>S-Eff: <b>${fmt(p.s_eff, 2, true)}</b> · S-VPM: ${fmt(p.s_vpm, 2, true)}<br/>Acts: ${p.act} (${p.dumps} dmp) · Att%: ${fmt(p.att_pct, 1)}%`,
      onSelect: idx => { state.rSSel = idx; renderSetterTab(); }
    });

    const p = roleSetters[state.rSSel] || roleSetters[0];
    const det = document.getElementById("r-setter-detail");
    det.innerHTML = `
      <div class="between" style="padding-bottom:6px;">
        <div>
          <h3 style="font-size:var(--text-heading);">${esc(p.name)} ${p.qualified ? "" : '<span class="muted">(&lt;100R)</span>'}</h3>
          <div class="muted">${p.is_primary ? "Primary setter" : "Secondary / spot"} · ${p.rallies}R</div>
        </div>
        <div style="text-align:right;">
          <div class="muted">S-Eff (m=${state.rSM})</div>
          <div class="kpi-val tabnum ${valCls(p.s_eff)}">${fmt(p.s_eff, 2, true)}</div>
        </div>
      </div>
      ${detailGridHtml([
        ["S-Eff raw (m=0)", fmt(p.s_eff_raw, 2, true), valCls(p.s_eff_raw)],
        ["S-VPM (/100R)", fmt(p.s_vpm, 2, true), valCls(p.s_vpm)],
        ["Actions (Dumps)", `${p.act} (${p.dumps})`, ""],
        ["Set share / Sets/R", `${fmt(p.set_share, 1)}% / ${fmt(p.sets_per_r, 2)}`, ""],
        ["Attackable% / Err%", `${fmt(p.att_pct, 1)}% / ${fmt(p.err_pct, 1)}%`, ""],
        ["Box Ast/Set", p.box_ast_pct !== null ? `${fmt(p.box_ast_pct, 1)}% (${p.box_ast}/${p.box_sets})` : "-", ""],
        ["Teammate TrueHit%", `${fmt(p.tm_hit, 3)} (${p.tm_att})`, ""],
        ["Dump EPA / VPM", `${fmt(p.dump_epa, 1, true)} / ${fmt(p.vpm, 1, true)}`, ""]
      ])}
      ${p.mmr_idx >= 0 ? `<button id="r-s-open-prof" type="button" class="btn btn-sm btn-primary" style="margin-top:auto;">Open full profile</button>` : ""}`;
    const btn = document.getElementById("r-s-open-prof");
    if (btn) btn.onclick = () => openPlayerProfile(p.mmr_idx);

    const cols = [
      { k: "name", lbl: "Player", left: true, tip: "Player display name" },
      { k: "is_primary", lbl: "Role", left: true, tip: "Primary setter (>=35% of touches) vs Spot" },
      { k: "s_eff", lbl: "S-Eff", tip: "Set Delivery + Dump pts/100 actions at shrinkage m" },
      { k: "s_vpm", lbl: "S-VPM", tip: "Setting impact per 100 rallies played (m=150)" },
      { k: "act", lbl: "Act", tip: "Total set (touch 1-2) + dump (touch 2) actions" },
      { k: "dumps", lbl: "Dmp", tip: "2nd-touch setter dumps" },
      { k: "set_share", lbl: "Set%T", tip: "Share of touches that are sets or dumps" },
      { k: "att_pct", lbl: "Att%", tip: "Share of sets yielding 3rd-touch attack or active dump" },
      { k: "err_pct", lbl: "Err%", tip: "Direct terminal set or dump error rate" },
      { k: "tm_hit", lbl: "TmHit%", tip: "Teammate TrueHit% immediately after player's set" },
      { k: "box_ast_pct", lbl: "Ast/Set", tip: "Box-score assist conversion % (>=10 box sets)" },
      { k: "vpm", lbl: "VPM", tip: "Overall Volleyball Plus-Minus" }
    ];
    renderRoleTable("r-setter-tbl-head", "r-setter-tbl-body", list, cols, state.rSSort, state.rSSel,
      k => { state.rSSort = { key: k, dir: state.rSSort.key === k ? -state.rSSort.dir : (k === "name" ? 1 : -1) }; renderSetterTab(); },
      idx => { state.rSSel = idx; renderSetterTab(); },
      r => `
        <td class="left"><b>${esc(r.name)}</b>${r.qualified ? "" : ' <span class="muted">(unq)</span>'}</td>
        <td class="left">${r.is_primary ? "Primary" : "Spot"}</td>
        <td class="right ${valCls(r.s_eff)}"><b>${fmt(r.s_eff, 2, true)}</b></td>
        <td class="right">${fmt(r.s_vpm, 2, true)}</td>
        <td class="right">${r.act}</td>
        <td class="right">${r.dumps}</td>
        <td class="right">${fmt(r.set_share, 1)}%</td>
        <td class="right">${fmt(r.att_pct, 1)}%</td>
        <td class="right">${fmt(r.err_pct, 1)}%</td>
        <td class="right">${fmt(r.tm_hit, 3)}</td>
        <td class="right">${r.box_ast_pct !== null ? fmt(r.box_ast_pct, 1) + "%" : "-"}</td>
        <td class="right">${fmt(r.vpm, 2, true)}</td>`);

    renderRoleHBar("r-set-ladder-svg", ROLES.set_ladder, 100,
      r => r[2] >= 56 ? "var(--pos)" : (r[2] >= 45 ? "var(--chart-1)" : (r[2] > 0 ? "var(--warn)" : "var(--neg)")),
      r => `${r[2].toFixed(1)}% (${r[1]})`);
    const setRel = ROLES.rel.filter(r => r[4] === "set" || r[4] === "rej" || r[0].includes("Set"));
    renderRoleHBar("r-set-rel-svg", setRel, 0.9,
      r => r[4] === "set" ? "var(--chart-1)" : (r[4] === "old" ? "var(--chart-4)" : "var(--neg)"),
      r => `SB ${r[2].toFixed(3)} (n=${r[3]})`);
  }

  // LIBERO TAB
  function renderLiberoTab() {
    if (!hasPbp || !roleLiberos.length) return;
    const rm = ROLES.meta;
    document.getElementById("libero-sub").textContent =
      `5-fold DataVolley pass-grade model across ${rm.libero_events_human.toLocaleString()} human cross-net first contacts (mean drift ${fmt(rm.mean_human_lib_delta_100, 2, true)} pts/100).`;

    roleLiberos.forEach(p => { p.l_eff = (100 * p.sum_delta) / (p.fc_n + state.rLM); });
    const qList = roleLiberos.filter(p => p.qualified);
    const byLeff = [...qList].sort((a, b) => b.l_eff - a.l_eff);
    const bySr = [...qList].filter(p => p.sr_eff !== null).sort((a, b) => b.sr_eff - a.sr_eff);
    const byDig = [...qList].filter(p => p.dig_eff !== null).sort((a, b) => b.dig_eff - a.dig_eff);
    renderRoleKpis("libero-kpis", [
      byLeff[0] ? { lbl: `Top Libero (L-Eff, m=${state.rLM})`, val: byLeff[0].name, sub: `${fmt(byLeff[0].l_eff, 2, true)} (${fmt(byLeff[0].in_sys, 1)}% InSys)`, tip: "Top qualified player by DataVolley pass-grade L-Eff", pickIdx: byLeff[0].idx } : { lbl: "Top L-Eff", val: "-", sub: "" },
      bySr[0] ? { lbl: "Top serve-receive (SR-Eff)", val: bySr[0].name, sub: `${fmt(bySr[0].sr_eff, 2, true)} (${bySr[0].sr_n} SR)`, tip: "Top serve-receive efficiency (m=25)", pickIdx: bySr[0].idx } : { lbl: "Top SR-Eff", val: "-", sub: "" },
      byDig[0] ? { lbl: "Top floor dig (Dig-Eff)", val: byDig[0].name, sub: `${fmt(byDig[0].dig_eff, 2, true)} (${byDig[0].dig_n} digs)`, tip: "Top hard-dig efficiency off attacks/tips/blocks (m=25)", pickIdx: byDig[0].idx } : { lbl: "Top Dig-Eff", val: "-", sub: "" },
      { lbl: "D-VPM != Libero", val: `r(Blk, FC) = ${fmt(rm.block_vs_fc_std_epa_100r, 3)}`, sub: `r(D-VPM, Dig) = ${fmt(rm.dvpm_vs_dig_eff, 3)}`, tip: "Front-row blocking drives D-VPM orthogonally to backcourt passing" }
    ], idx => { state.rLSel = idx; renderLiberoTab(); });

    renderRoleLegend("r-libero-legend", "Primary libero (>=35%T)", "Two-way / hybrid", state.rLUnqual);
    const q = state.rLSearch.trim().toLowerCase();
    const list = roleLiberos.filter(p => (state.rLUnqual || p.qualified) && (!state.rLPrimary || p.is_primary) && (!q || p.name.toLowerCase().includes(q)));
    const isSrDig = state.rLMode === "sr_dig";
    renderRoleScatter("r-libero-svg", "r-libero-tip", list, {
      xFn: isSrDig ? p => p.sr_eff : p => p.d_vpm,
      yFn: isSrDig ? p => p.dig_eff : p => p.l_eff,
      rFn: p => Math.max(4.5, Math.min(12.5, Math.sqrt(p.fc_n) * 0.55)), xDec: 1,
      xLabel: isSrDig ? "Serve-receive SR-Eff (pts / 100 SR, m=25)" : "Overall defense D-VPM (Serve RAPM + Block + Def EPA)",
      yLabel: isSrDig ? "Floor hard-dig Dig-Eff (pts / 100 digs, m=25)" : `True first-contact L-Eff (pts / 100 FC, m=${state.rLM})`,
      selIdx: state.rLSel,
      tipHtml: p => `<b>${esc(p.name)}</b><br/>L-Eff: <b>${fmt(p.l_eff, 2, true)}</b> · D-VPM: ${fmt(p.d_vpm, 2, true)}<br/>SR-Eff: ${fmt(p.sr_eff, 2, true)} · Dig-Eff: ${fmt(p.dig_eff, 2, true)}<br/>FC: ${p.fc_n} · InSys: ${fmt(p.in_sys, 1)}%`,
      onSelect: idx => { state.rLSel = idx; renderLiberoTab(); }
    });

    const p = roleLiberos[state.rLSel] || roleLiberos[0];
    const det = document.getElementById("r-libero-detail");
    det.innerHTML = `
      <div class="between" style="padding-bottom:6px;">
        <div>
          <h3 style="font-size:var(--text-heading);">${esc(p.name)} ${p.qualified ? "" : '<span class="muted">(&lt;100R)</span>'}</h3>
          <div class="muted">${p.is_primary ? "Primary libero" : "Two-way / hybrid"} · ${p.rallies}R</div>
        </div>
        <div style="text-align:right;">
          <div class="muted">L-Eff (m=${state.rLM})</div>
          <div class="kpi-val tabnum ${valCls(p.l_eff)}">${fmt(p.l_eff, 2, true)}</div>
        </div>
      </div>
      ${detailGridHtml([
        [`SR-Eff (${p.sr_n} SR)`, fmt(p.sr_eff, 2, true), valCls(p.sr_eff)],
        [`Dig-Eff (${p.dig_n} Digs)`, fmt(p.dig_eff, 2, true), valCls(p.dig_eff)],
        ["L-Eff raw / L-VPM", `${fmt(p.l_eff_raw, 2, true)} / ${fmt(p.l_vpm, 2, true)}`, ""],
        [`FC (${p.fc_n}) / FC%T`, `${fmt(p.fc_share, 1)}% (${fmt(p.fc_per_r, 2)}/R)`, ""],
        ["In-System% / Clean%", `${fmt(p.in_sys, 1)}% / ${fmt(p.clean, 1)}%`, ""],
        ["Err% / Shank+Carom%", `${fmt(p.err_pct, 1)}% / ${fmt(p.sc_pct, 1)}%`, ""],
        ["D-VPM (All defense)", fmt(p.d_vpm, 2, true), valCls(p.d_vpm)],
        ["Block EPA/100R (Blk)", `${fmt(p.blk_epa, 2, true)} (${p.blk_n})`, valCls(p.blk_epa)]
      ])}
      ${p.mmr_idx >= 0 ? `<button id="r-l-open-prof" type="button" class="btn btn-sm btn-primary" style="margin-top:auto;">Open full profile</button>` : ""}`;
    const btn = document.getElementById("r-l-open-prof");
    if (btn) btn.onclick = () => openPlayerProfile(p.mmr_idx);

    const cols = [
      { k: "name", lbl: "Player", left: true, tip: "Player display name" },
      { k: "is_primary", lbl: "Role", left: true, tip: "Primary libero (>=35% FC touch share) vs Hybrid" },
      { k: "l_eff", lbl: "L-Eff", tip: "Pass-grade pts/100 cross-net first contacts at shrinkage m" },
      { k: "l_vpm", lbl: "L-VPM", tip: "First-contact value per 100 rallies (m=150)" },
      { k: "sr_eff", lbl: "SR-Eff", tip: "Serve-Receive quality vs human baseline (m=25)" },
      { k: "dig_eff", lbl: "Dig-Eff", tip: "Floor Hard-Dig quality off attacks/tips/blocks (m=25)" },
      { k: "fc_n", lbl: "FC", tip: "Total cross-net non-block first contacts" },
      { k: "fc_share", lbl: "FC%T", tip: "Share of touches that are first contacts" },
      { k: "in_sys", lbl: "InSys%", tip: "Share of passes leading to clean attack/dump (G3)" },
      { k: "clean", lbl: "Clean%", tip: "Passes avoiding terminal error, shank, or carom" },
      { k: "sc_pct", lbl: "SC%", tip: "Shank + Carom rate on first contacts" },
      { k: "d_vpm", lbl: "D-VPM", tip: "Overall Defensive VPM (Serve RAPM + Blocking)" },
      { k: "blk_epa", lbl: "BlkEPA", tip: "Front-row block Markov EPA per 100 rallies" }
    ];
    renderRoleTable("r-libero-tbl-head", "r-libero-tbl-body", list, cols, state.rLSort, state.rLSel,
      k => { state.rLSort = { key: k, dir: state.rLSort.key === k ? -state.rLSort.dir : (k === "name" ? 1 : -1) }; renderLiberoTab(); },
      idx => { state.rLSel = idx; renderLiberoTab(); },
      r => `
        <td class="left"><b>${esc(r.name)}</b>${r.qualified ? "" : ' <span class="muted">(unq)</span>'}</td>
        <td class="left">${r.is_primary ? "Primary" : "Hybrid"}</td>
        <td class="right ${valCls(r.l_eff)}"><b>${fmt(r.l_eff, 2, true)}</b></td>
        <td class="right">${fmt(r.l_vpm, 2, true)}</td>
        <td class="right">${fmt(r.sr_eff, 2, true)}</td>
        <td class="right">${fmt(r.dig_eff, 2, true)}</td>
        <td class="right">${r.fc_n}</td>
        <td class="right">${fmt(r.fc_share, 1)}%</td>
        <td class="right">${fmt(r.in_sys, 1)}%</td>
        <td class="right">${fmt(r.clean, 1)}%</td>
        <td class="right">${fmt(r.sc_pct, 1)}%</td>
        <td class="right">${fmt(r.d_vpm, 2, true)}</td>
        <td class="right">${fmt(r.blk_epa, 2, true)}</td>`);

    renderRoleHBar("r-pass-ladder-svg", ROLES.pass_ladder, 100,
      r => r[2] >= 55 ? "var(--pos)" : (r[2] >= 45 ? "var(--chart-1)" : (r[2] > 5 ? "var(--warn)" : "var(--neg)")),
      r => `${r[2].toFixed(1)}% (${r[1]})`);
    const libRel = ROLES.rel.filter(r => r[4] === "lib" || r[0].includes("FC"));
    renderRoleHBar("r-lib-rel-svg", libRel, 0.9,
      r => r[4] === "lib" ? "var(--chart-1)" : "var(--chart-4)",
      r => `SB ${r[2].toFixed(3)} (n=${r[3]})`);

    document.getElementById("r-dvpm-proof-sub").textContent =
      `D-VPM correlates with Serve RAPM (r=${fmt(rm.dvpm_vs_serve_rapm, 3, true)}) and Block EPA (r=${fmt(rm.dvpm_vs_block_epa_100r, 3, true)}), ` +
      `while blocking and first-contact passing are orthogonal (r=${fmt(rm.block_vs_fc_std_epa_100r, 3, true)}; D-VPM vs L-Eff r=${fmt(rm.dvpm_vs_l_eff, 3, true)}).`;

    const dBody = document.getElementById("r-top10-d-body");
    dBody.innerHTML = ROLES.top10_d.map(r => `
      <tr class="${r[1] >= 0 ? "clickable" : ""}" data-midx="${r[1]}">
        <td class="left"><b>${esc(r[0])}</b></td>
        <td class="right ${valCls(r[2])}"><b>${fmt(r[2], 2, true)}</b></td>
        <td class="right">${fmt(r[3], 2, true)}</td>
        <td class="right ${valCls(r[4])}">${fmt(r[4], 2, true)} (${r[5]})</td>
        <td class="right ${valCls(r[6])}"><b>${fmt(r[6], 2, true)}</b> (${r[7]})</td>
      </tr>`).join("");
    dBody.querySelectorAll("tr[data-midx]").forEach(tr => {
      const midx = Number(tr.dataset.midx);
      if (midx >= 0) tr.addEventListener("click", () => openPlayerProfile(midx));
    });
  }

  // Event wiring for Spiker / Setter / Libero tabs
  document.getElementById("r-k-m-slider").addEventListener("input", e => { state.rKM = Number(e.target.value); document.getElementById("r-k-m-val").textContent = state.rKM; renderSpikerTab(); });
  document.getElementById("r-k-primary-only").addEventListener("change", e => { state.rKPrimary = e.target.checked; renderSpikerTab(); });
  document.getElementById("r-k-show-unqual").addEventListener("change", e => { state.rKUnqual = e.target.checked; renderSpikerTab(); });
  document.getElementById("r-k-search").addEventListener("input", e => { state.rKSearch = e.target.value; renderSpikerTab(); });
  document.getElementById("r-spk-mode-load").addEventListener("click", () => {
    state.rKMode = "load";
    const loadB = document.getElementById("r-spk-mode-load"), hitB = document.getElementById("r-spk-mode-hit");
    loadB.classList.add("is-active"); loadB.setAttribute("aria-pressed", "true");
    hitB.classList.remove("is-active"); hitB.setAttribute("aria-pressed", "false");
    renderSpikerTab();
  });
  document.getElementById("r-spk-mode-hit").addEventListener("click", () => {
    state.rKMode = "hit";
    const loadB = document.getElementById("r-spk-mode-load"), hitB = document.getElementById("r-spk-mode-hit");
    hitB.classList.add("is-active"); hitB.setAttribute("aria-pressed", "true");
    loadB.classList.remove("is-active"); loadB.setAttribute("aria-pressed", "false");
    renderSpikerTab();
  });

  document.getElementById("r-s-m-slider").addEventListener("input", e => { state.rSM = Number(e.target.value); document.getElementById("r-s-m-val").textContent = state.rSM; renderSetterTab(); });
  document.getElementById("r-s-primary-only").addEventListener("change", e => { state.rSPrimary = e.target.checked; renderSetterTab(); });
  document.getElementById("r-s-show-unqual").addEventListener("change", e => { state.rSUnqual = e.target.checked; renderSetterTab(); });
  document.getElementById("r-s-search").addEventListener("input", e => { state.rSSearch = e.target.value; renderSetterTab(); });

  document.getElementById("r-l-m-slider").addEventListener("input", e => { state.rLM = Number(e.target.value); document.getElementById("r-l-m-val").textContent = state.rLM; renderLiberoTab(); });
  document.getElementById("r-l-primary-only").addEventListener("change", e => { state.rLPrimary = e.target.checked; renderLiberoTab(); });
  document.getElementById("r-l-show-unqual").addEventListener("change", e => { state.rLUnqual = e.target.checked; renderLiberoTab(); });
  document.getElementById("r-l-search").addEventListener("input", e => { state.rLSearch = e.target.value; renderLiberoTab(); });
  document.getElementById("r-lib-mode-sr").addEventListener("click", () => {
    state.rLMode = "sr_dig";
    const srB = document.getElementById("r-lib-mode-sr"), dvB = document.getElementById("r-lib-mode-dvpm");
    srB.classList.add("is-active"); srB.setAttribute("aria-pressed", "true");
    dvB.classList.remove("is-active"); dvB.setAttribute("aria-pressed", "false");
    renderLiberoTab();
  });
  document.getElementById("r-lib-mode-dvpm").addEventListener("click", () => {
    state.rLMode = "l_dvpm";
    const srB = document.getElementById("r-lib-mode-sr"), dvB = document.getElementById("r-lib-mode-dvpm");
    dvB.classList.add("is-active"); dvB.setAttribute("aria-pressed", "true");
    srB.classList.remove("is-active"); srB.setAttribute("aria-pressed", "false");
    renderLiberoTab();
  });
