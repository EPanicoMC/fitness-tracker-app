/**
 * predictive-ui.js — Interfaccia utente chiara, ordinata e anti-bias per:
 *   • Dashboard "Andamento" (Peso Reale senza acqua, Metabolismo TDEE reale, Previsione e Target Kcal/Macro)
 *   • Dashboard "Carico & Forza" (Forma vs Fatica, Equilibrio del Carico, Forza Massimale Stimata 1RM, Volume Muscolare)
 *   • Card "Coach" e "Controllo Bias & Guida alla Lettura" pensate anche per chi non è esperto di statistica.
 */

const MUSCLE_LABELS_IT = {
  petto: 'Petto',
  dorso_verticale: 'Dorso (Ampiezza)',
  dorso_orizzontale: 'Dorso (Spessore)',
  quadricipiti: 'Quadricipiti',
  femorali: 'Femorali',
  glutei: 'Glutei',
  deltoide_laterale: 'Spalle (Laterale)',
  deltoide_anteriore: 'Spalle (Anteriore)',
  delt_posteriore: 'Spalle (Posteriore)',
  bicipiti: 'Bicipiti',
  tricipiti: 'Tricipiti',
  polpacci: 'Polpacci',
  altro: 'Altro'
};

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtShortDate(iso) {
  if (!iso || typeof iso !== 'string') return '—';
  const p = iso.split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}` : iso;
}

/**
 * Grafico principale Peso Bilancia (punti) vs Peso Reale senza acqua (linea arancione) + Previsione futura (linea tratteggiata viola).
 */
export function renderWeightForecastSVG(energyOutput, targetWeightKg = null) {
  const history = (energyOutput?.history || []).slice(-45);
  const dailyForecast = (energyOutput?.dailyForecast || []).filter((_, idx) => idx % 3 === 2 || idx === 0);

  if (history.length === 0) {
    return `<div style="padding:28px 16px;text-align:center;color:var(--t3);font-size:13px;background:rgba(255,255,255,0.02);border-radius:12px">
      Registra il tuo primo peso per vedere il grafico del Peso Reale e la previsione.
    </div>`;
  }

  const W = 340, H = 195;
  const padL = 36, padR = 14, padT = 18, padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const totalSteps = Math.max(1, history.length + dailyForecast.length - 1);
  const xOf = (idx) => padL + (idx / totalSteps) * plotW;

  const allWeights = [];
  history.forEach(h => {
    if (h.rawWeight != null) allWeights.push(h.rawWeight);
    if (h.trendWeight != null) allWeights.push(h.trendWeight);
  });
  dailyForecast.forEach(f => {
    if (f.low != null) allWeights.push(f.low);
    if (f.high != null) allWeights.push(f.high);
  });
  if (targetWeightKg != null && targetWeightKg > 30) allWeights.push(Number(targetWeightKg));

  const minW = Math.floor((Math.min(...allWeights) - 0.6) * 2) / 2;
  const maxW = Math.ceil((Math.max(...allWeights) + 0.6) * 2) / 2;
  const spanW = Math.max(1.5, maxW - minW);
  const yOf = (w) => padT + (1 - (w - minW) / spanW) * plotH;

  let gridSvg = '';
  for (let i = 0; i <= 3; i++) {
    const val = minW + (spanW * i) / 3;
    const y = yOf(val).toFixed(1);
    gridSvg += `
      <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
      <text x="${padL - 6}" y="${Number(y) + 3}" text-anchor="end" font-size="9.5" fill="var(--t3)">${val.toFixed(1)}</text>`;
  }

  let targetSvg = '';
  if (targetWeightKg != null && targetWeightKg >= minW && targetWeightKg <= maxW) {
    const ty = yOf(Number(targetWeightKg)).toFixed(1);
    targetSvg = `
      <line x1="${padL}" y1="${ty}" x2="${W - padR}" y2="${ty}" stroke="#30d158" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.8"/>
      <text x="${W - padR - 2}" y="${Number(ty) - 5}" text-anchor="end" font-size="8.5" font-weight="700" fill="#30d158">Obiettivo ${targetWeightKg} kg</text>`;
  }

  let ciPolygonSvg = '';
  let forecastLineSvg = '';
  if (dailyForecast.length > 0 && history.length > 0) {
    const startIdx = history.length - 1;
    const startW = history[startIdx].trendWeight;
    const upperPts = [`${xOf(startIdx).toFixed(1)},${yOf(startW).toFixed(1)}`];
    const lowerPts = [`${xOf(startIdx).toFixed(1)},${yOf(startW).toFixed(1)}`];
    const centerPts = [`${xOf(startIdx).toFixed(1)},${yOf(startW).toFixed(1)}`];

    dailyForecast.forEach((f, idx) => {
      const gx = xOf(startIdx + 1 + idx).toFixed(1);
      upperPts.push(`${gx},${yOf(Math.min(maxW, f.high)).toFixed(1)}`);
      lowerPts.unshift(`${gx},${yOf(Math.max(minW, f.low)).toFixed(1)}`);
      centerPts.push(`${gx},${yOf(f.weight).toFixed(1)}`);
    });

    ciPolygonSvg = `<polygon points="${upperPts.concat(lowerPts).join(' ')}" fill="rgba(124,111,255,0.14)" stroke="none"/>`;
    forecastLineSvg = `<polyline points="${centerPts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-dasharray="4 3"/>`;
  }

  const trendPts = history
    .map((h, i) => h.trendWeight != null ? `${xOf(i).toFixed(1)},${yOf(h.trendWeight).toFixed(1)}` : null)
    .filter(Boolean);
  const trendLineSvg = trendPts.length > 1
    ? `<polyline points="${trendPts.join(' ')}" fill="none" stroke="#ff6b35" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`
    : '';

  const dotsSvg = history.map((h, i) => {
    if (h.rawWeight == null) return '';
    const cx = xOf(i).toFixed(1);
    const cy = yOf(h.rawWeight).toFixed(1);
    const col = h.outlier ? '#ff453a' : 'rgba(255,255,255,0.42)';
    const r = h.outlier ? 3.2 : 2.3;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${col}"/>`;
  }).join('');

  const todayIdx = history.length - 1;
  const xToday = xOf(todayIdx).toFixed(1);
  const xLabelsSvg = `
    <line x1="${xToday}" y1="${padT}" x2="${xToday}" y2="${H - padB}" stroke="rgba(255,255,255,0.14)" stroke-dasharray="2 2"/>
    <text x="${padL}" y="${H - 8}" text-anchor="start" font-size="9.5" fill="var(--t3)">${fmtShortDate(history[0].date)}</text>
    <text x="${xToday}" y="${H - 8}" text-anchor="middle" font-size="9.5" font-weight="800" fill="var(--t1)">Oggi</text>
    ${dailyForecast.length > 0 ? `<text x="${W - padR}" y="${H - 8}" text-anchor="end" font-size="9.5" fill="var(--accent)">+12 sett.</text>` : ''}
  `;

  return `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
      ${gridSvg}
      ${targetSvg}
      ${ciPolygonSvg}
      ${dotsSvg}
      ${trendLineSvg}
      ${forecastLineSvg}
      ${xLabelsSvg}
    </svg>`;
}

/**
 * Grafico secondario TDEE Adattivo (visibile nella sezione dettagli tecnici).
 */
export function renderTdeeHistorySVG(energyOutput) {
  const history = (energyOutput?.history || []).slice(-45);
  if (history.length < 2) return '';

  const W = 340, H = 125;
  const padL = 36, padR = 12, padT = 12, padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xOf = (i) => padL + (i / Math.max(1, history.length - 1)) * plotW;
  const vals = [];
  history.forEach(h => {
    vals.push(h.tdeeKalman - h.tdeeSd, h.tdeeKalman + h.tdeeSd);
    if (h.intakeKcal != null) vals.push(h.intakeKcal);
  });
  const minK = Math.max(1000, Math.floor((Math.min(...vals) - 100) / 100) * 100);
  const maxK = Math.min(5000, Math.ceil((Math.max(...vals) + 100) / 100) * 100);
  const spanK = Math.max(400, maxK - minK);
  const yOf = (k) => padT + (1 - (k - minK) / spanK) * plotH;

  const upper = [], lower = [], center = [], intakeDots = [];
  history.forEach((h, i) => {
    const x = xOf(i).toFixed(1);
    const hi = Math.min(maxK, h.tdeeKalman + h.tdeeSd);
    const lo = Math.max(minK, h.tdeeKalman - h.tdeeSd);
    upper.push(`${x},${yOf(hi).toFixed(1)}`);
    lower.unshift(`${x},${yOf(lo).toFixed(1)}`);
    center.push(`${x},${yOf(h.tdeeKalman).toFixed(1)}`);
    if (h.intakeKcal != null && h.intakeComplete !== 'no') {
      intakeDots.push(`<circle cx="${x}" cy="${yOf(Math.max(minK, Math.min(maxK, h.intakeKcal))).toFixed(1)}" r="1.8" fill="#30d158" opacity="0.65"/>`);
    }
  });

  return `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
      <line x1="${padL}" y1="${yOf(minK).toFixed(1)}" x2="${W - padR}" y2="${yOf(minK).toFixed(1)}" stroke="rgba(255,255,255,0.06)"/>
      <line x1="${padL}" y1="${yOf((minK + maxK) / 2).toFixed(1)}" x2="${W - padR}" y2="${yOf((minK + maxK) / 2).toFixed(1)}" stroke="rgba(255,255,255,0.06)"/>
      <line x1="${padL}" y1="${yOf(maxK).toFixed(1)}" x2="${W - padR}" y2="${yOf(maxK).toFixed(1)}" stroke="rgba(255,255,255,0.06)"/>
      <text x="${padL - 4}" y="${yOf(maxK) + 4}" text-anchor="end" font-size="8.5" fill="var(--t3)">${maxK}</text>
      <text x="${padL - 4}" y="${yOf((minK + maxK) / 2) + 3}" text-anchor="end" font-size="8.5" fill="var(--t3)">${Math.round((minK + maxK) / 2)}</text>
      <text x="${padL - 4}" y="${yOf(minK) + 3}" text-anchor="end" font-size="8.5" fill="var(--t3)">${minK}</text>
      <polygon points="${upper.concat(lower).join(' ')}" fill="rgba(58,134,255,0.14)"/>
      ${intakeDots.join('')}
      <polyline points="${center.join(' ')}" fill="none" stroke="#3a86ff" stroke-width="2.2"/>
      <text x="${padL}" y="${H - 5}" font-size="8.5" fill="var(--t3)">${fmtShortDate(history[0].date)}</text>
      <text x="${W - padR}" y="${H - 5}" text-anchor="end" font-size="8.5" fill="var(--t3)">${fmtShortDate(history[history.length - 1].date)}</text>
    </svg>`;
}

/**
 * Grafico SVG Forma Fisica vs Fatica Recente (Modello Banister).
 */
export function renderBanisterPmcSVG(trainingOutput) {
  const history = (trainingOutput?.history || []).slice(-45);
  if (history.length < 2) {
    return `<div style="padding:24px 16px;text-align:center;color:var(--t3);font-size:13px;background:rgba(255,255,255,0.02);border-radius:12px">
      Completa almeno 2 allenamenti per visualizzare il grafico Forma vs Fatica.
    </div>`;
  }

  const W = 340, H = 165;
  const padL = 34, padR = 12, padT = 14, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xOf = (i) => padL + (i / Math.max(1, history.length - 1)) * plotW;
  const allVals = [0];
  history.forEach(d => allVals.push(d.ctl, d.atl));
  const minV = Math.floor(Math.min(...allVals, 0) - 2);
  const maxV = Math.ceil(Math.max(...allVals, 40) + 5);
  const spanV = Math.max(30, maxV - minV);
  const yOf = (v) => padT + (1 - (v - minV) / spanV) * plotH;

  const ctlPts = [], atlPts = [], tsbPts = [];
  history.forEach((d, i) => {
    const x = xOf(i).toFixed(1);
    ctlPts.push(`${x},${yOf(d.ctl).toFixed(1)}`);
    atlPts.push(`${x},${yOf(d.atl).toFixed(1)}`);
    tsbPts.push(`${x},${yOf(d.tsb).toFixed(1)}`);
  });

  const yZero = yOf(0).toFixed(1);

  return `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
      <text x="${padL - 5}" y="${Number(yZero) + 3}" text-anchor="end" font-size="8.5" fill="var(--t2)">0</text>
      <text x="${padL - 5}" y="${padT + 6}" text-anchor="end" font-size="8.5" fill="var(--t3)">${maxV}</text>
      <text x="${padL - 5}" y="${H - padB}" text-anchor="end" font-size="8.5" fill="var(--t3)">${minV}</text>
      <polyline points="${atlPts.join(' ')}" fill="none" stroke="#ff453a" stroke-width="1.9"/>
      <polyline points="${ctlPts.join(' ')}" fill="none" stroke="#3a86ff" stroke-width="2.4"/>
      <text x="${padL}" y="${H - 6}" font-size="9" fill="var(--t3)">${fmtShortDate(history[0].date)}</text>
      <text x="${W - padR}" y="${H - 6}" text-anchor="end" font-size="9" font-weight="700" fill="var(--t1)">Oggi</text>
    </svg>`;
}


// ───────────────────────────────────────────────────────────
// Componenti di base, pensati per essere capiti al volo:
//  • Un "verdetto" in parole semplici in cima
//  • Ogni grafico ha una mini-spiegazione fissa in 3 righe: COSA VEDI · DA QUALI DATI · COSA TI DICE
//  • Tutto il resto (dettagli tecnici, bias, form) è chiuso in un solo cassetto
// ───────────────────────────────────────────────────────────

function explainBox(see, data, out) {
  const row = (ico, t, txt) => `
    <div style="display:flex;gap:8px;margin-bottom:5px;align-items:flex-start">
      <span style="font-size:13px;line-height:1.3">${ico}</span>
      <div style="font-size:12px;line-height:1.4;color:var(--t2)"><b style="color:var(--t1)">${t}:</b> ${txt}</div>
    </div>`;
  return `
    <div style="background:rgba(255,255,255,0.035);border-radius:10px;padding:10px 12px;margin-top:10px">
      ${row('👀', 'Cosa vedi', see)}
      ${row('🧮', 'Da quali dati', data)}
      ${row('🎯', 'Cosa ti dice', out)}
    </div>`;
}

function verdictCard({ icon, color, title, text }) {
  return `
    <div class="card" style="margin-bottom:12px;border:1px solid ${color}55;background:${color}12">
      <div style="display:flex;gap:12px;align-items:center">
        <div style="font-size:34px;line-height:1">${icon}</div>
        <div>
          <div style="font-size:17px;font-weight:800;color:var(--t1);line-height:1.25">${esc(title)}</div>
          <div style="font-size:13px;color:var(--t2);margin-top:3px;line-height:1.4">${esc(text)}</div>
        </div>
      </div>
    </div>`;
}

function sectionTitle(t, sub) {
  return `<div style="font-size:15px;font-weight:800;color:var(--t1)">${t}</div>` +
    (sub ? `<div style="font-size:11.5px;color:var(--t3);margin-top:1px">${sub}</div>` : '');
}

/**
 * Coach: titolo + 1 frase + massimo 1 azione. La domanda libera sta dentro un cassetto.
 */
export function renderCoachCardHTML(coachReport, { isDemo = false, isLoading = false } = {}) {
  const rep = coachReport || {
    status: 'on_track', headline: 'Sto analizzando i tuoi dati…', summary: '', corrections: [], focusNextWeek: ''
  };
  const col = { on_track: '#30d158', attention: '#ffc300', off_track: '#ff453a' }[rep.status] || '#30d158';
  const ico = { on_track: '🟢', attention: '🟡', off_track: '🔴' }[rep.status] || '🟢';
  const first = (rep.corrections || [])[0];

  return `
    <div class="card" style="margin-bottom:12px;border-left:4px solid ${col}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">
        <div style="font-size:11px;font-weight:800;color:${col};letter-spacing:.5px">${ico} IL CONSIGLIO DEL COACH</div>
        ${isDemo ? `<span style="font-size:10px;background:rgba(255,107,53,0.2);color:#ff6b35;padding:2px 8px;border-radius:10px;font-weight:800">ESEMPIO</span>` : ''}
      </div>
      <div style="font-size:15px;font-weight:800;color:var(--t1);line-height:1.3">${esc(rep.headline)}</div>
      ${rep.summary ? `<div style="font-size:12.5px;color:var(--t2);line-height:1.5;margin-top:4px">${esc(rep.summary)}</div>` : ''}
      ${first ? `
        <div style="background:rgba(255,255,255,0.04);border-radius:10px;padding:9px 11px;margin-top:10px">
          <div style="font-size:10px;font-weight:800;color:var(--accent)">👉 COSA FARE</div>
          <div style="font-size:13px;font-weight:700;color:var(--t1);margin-top:2px">${esc(first.action)}</div>
        </div>` : ''}
      <details style="margin-top:10px">
        <summary style="cursor:pointer;font-size:11.5px;color:var(--accent);font-weight:700">💬 Fai una domanda al coach</summary>
        <div style="display:flex;gap:8px;margin-top:8px">
          <input type="text" id="coach-free-question" class="fi" placeholder="Es. Posso mangiare una pizza sabato?" style="flex:1;font-size:12px;padding:9px 11px" onkeydown="if(event.key==='Enter')window.askPredictiveCoach()">
          <button class="btn btn-v btn-sm" onclick="window.askPredictiveCoach()" ${isLoading ? 'disabled' : ''} style="padding:9px 13px;font-size:12px;font-weight:700">${isLoading ? '⏳' : 'Chiedi'}</button>
        </div>
      </details>
    </div>`;
}

function missingFormHTML(ma) {
  const sd = ma.smartDefaults || {};
  const missing = [...(ma.missingProfileFields || []), ...(ma.missingTodayFields || [])];
  if (!missing.length) return '';
  const lab = 'font-size:11px;color:var(--t2);font-weight:700;display:block;margin-bottom:3px';
  const inp = 'font-size:13px;padding:8px;width:100%';
  const needProfile = (ma.missingProfileFields || []).length > 0;
  const needWeightToday = (ma.missingTodayFields || []).some(f => f.startsWith('Peso'));
  return `
    <div class="card" id="guided-missing-card" style="margin-bottom:12px;border:1px dashed rgba(255,195,0,0.5)">
      <details>
        <summary style="cursor:pointer;list-style:none">
          <div style="font-size:13px;font-weight:800;color:#ffc300">✨ Rendi i calcoli più precisi</div>
          <div style="font-size:11.5px;color:var(--t2);margin-top:2px">Mancano pochi dati: ${esc(missing.slice(0, 3).join(', '))}. Tocca per inserirli.</div>
        </summary>
        <div style="margin-top:12px">
          <div style="display:flex;gap:6px;margin-bottom:10px">
            <input type="text" id="guided-ai-text" class="fi" placeholder="Oppure scrivi: Uomo, 178 cm, nato nel 1995" style="flex:1;font-size:12px;padding:8px 10px">
            <button class="btn btn-v btn-sm" onclick="window.autoFillMissingWithAI(false)" style="font-size:11.5px;padding:8px 11px;white-space:nowrap">🪄 AI</button>
          </div>
          <div id="guided-ai-note" style="font-size:10.5px;color:var(--t3);margin-bottom:8px">L'AI legge solo ciò che scrivi, non inventa numeri.</div>
          <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">
            <div><label style="${lab}">Sesso</label>
              <select id="gm-sex" class="fi" style="${inp}">
                <option value="" ${!sd.sex ? 'selected' : ''}>—</option>
                <option value="M" ${sd.sex === 'M' ? 'selected' : ''}>Uomo</option>
                <option value="F" ${sd.sex === 'F' ? 'selected' : ''}>Donna</option>
              </select></div>
            <div><label style="${lab}">Altezza (cm)</label>
              <input type="number" id="gm-height" class="fi" value="${sd.height ?? ''}" min="120" max="230" style="${inp}"></div>
            <div><label style="${lab}">Data di nascita</label>
              <input type="date" id="gm-dob" class="fi" value="${sd.dob ?? ''}" style="${inp}"></div>
            <div><label style="${lab}">Peso obiettivo (kg)</label>
              <input type="number" step="0.1" id="gm-target-w" class="fi" value="${sd.weight_target ?? ''}" style="${inp}"></div>
            ${needWeightToday ? `<div><label style="${lab}">Peso di oggi (kg)</label>
              <input type="number" step="0.1" id="gm-today-w" class="fi" value="${sd.today_weight_kg ?? ''}" style="${inp}"></div>` :
              `<input type="hidden" id="gm-today-w" value="">`}
          </div>
          <input type="hidden" id="gm-activity" value="${sd.activity_level ?? 'moderate'}">
          <input type="hidden" id="gm-goal" value="${sd.goal_type ?? 'cut'}">
          <input type="hidden" id="gm-rate" value="${sd.target_rate_kg_week ?? -0.45}">
          <input type="hidden" id="gm-today-sleep" value="${sd.today_sleep_hours ?? ''}">
          <input type="hidden" id="gm-today-complete" value="${needProfile ? (sd.today_diary_complete || 'yes') : (sd.today_diary_complete || 'yes')}">
          <button class="btn btn-g btn-sm" onclick="window.saveGuidedMissingForm()" style="width:100%;margin-top:10px;font-weight:800;padding:10px">💾 Salva</button>
        </div>
      </details>
    </div>`;
}

function reliabilityBadgeHTML(confidence = 0, modelDivergence = false) {
  const score = Number(confidence) || 0;
  let ico = '⚪', label = 'Stima in calibrazione', col = '#8e8e93';
  if (score >= 75) {
    ico = '🟢'; label = 'Stima solida'; col = '#30d158';
  } else if (score >= 45) {
    ico = '🟡'; label = 'Stima affidabile'; col = '#ffc300';
  }
  const divBadge = modelDivergence
    ? `<span style="font-size:10px;background:rgba(255,195,0,0.16);color:#ffc300;padding:2px 7px;border-radius:999px;font-weight:700;margin-left:6px" title="Il metabolismo recente sta cambiando rapidamente: il filtro si sta riallineando">⚡ Riallineamento rapido</span>`
    : '';
  return `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:800;color:${col};background:${col}18;border:1px solid ${col}44;padding:2px 8px;border-radius:999px">${ico} ${label}</span>${divBadge}`;
}

function renderBodyComp4wBadgeHTML(bodyCompState4w) {
  if (!bodyCompState4w || !bodyCompState4w.state || bodyCompState4w.state === 'insufficient_data') return '';
  const map = {
    fat_loss: { icon: '🔥', color: '#30d158', title: 'Perdita di grasso ottimale' },
    recomp: { icon: '💪', color: '#3a86ff', title: 'Ricomposizione corporea' },
    possible_lean_loss: { icon: '⚠️', color: '#ff453a', title: 'Attenzione alla massa magra' },
    water_noise: { icon: '💧', color: '#ffc300', title: 'Oscillazione idrica temporanea' },
    lean_gain: { icon: '📈', color: '#30d158', title: 'Costruzione muscolare pulita' },
    maintenance: { icon: '⚖️', color: '#8e8e93', title: 'Composizione stabile' }
  };
  const cfg = map[bodyCompState4w.state] || { icon: '📊', color: '#3a86ff', title: bodyCompState4w.label || 'Stato 4 settimane' };
  return `
    <div style="display:flex;align-items:flex-start;gap:10px;background:${cfg.color}12;border:1px solid ${cfg.color}40;border-radius:12px;padding:10px 12px;margin-top:10px">
      <div style="font-size:20px;line-height:1.1">${cfg.icon}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:800;color:var(--t1)">Qualità delle ultime 4 settimane: <span style="color:${cfg.color}">${esc(cfg.title)}</span></div>
        <div style="font-size:11.5px;color:var(--t2);line-height:1.4;margin-top:2px">${esc(bodyCompState4w.explanation || '')}</div>
      </div>
    </div>`;
}

function renderWeeklyCheckinCardHTML(proposal) {
  if (!proposal) return '';
  const weekLabel = proposal.weekId || proposal.weekKey || '';
  const curKcal = proposal.currentTargetKcal ?? proposal.currentTarget?.kcal ?? 2100;
  const propKcal = proposal.proposedTargetKcal ?? proposal.proposedTarget?.kcal ?? curKcal;
  const propMacros = proposal.macros || proposal.proposedTarget?.macros || {};
  const delta = proposal.deltaKcal ?? (propKcal - curKcal);
  const deltaStr = delta > 0 ? `+${delta} kcal` : `${delta} kcal`;
  const isConfirmed = proposal.status && proposal.status !== 'pending' && proposal.status !== 'insufficient_data';

  if (isConfirmed) {
    const confTarget = proposal.confirmedTarget || {};
    return `
      <div class="card" style="margin-bottom:12px;border:1px solid rgba(48,209,88,0.35);background:rgba(48,209,88,0.06)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div>
            <div style="font-size:10.5px;font-weight:800;color:#30d158;letter-spacing:.4px">✅ CHECK-IN SETTIMANALE CONFERMATO (${esc(weekLabel)})</div>
            <div style="font-size:14px;font-weight:800;color:var(--t1);margin-top:2px">Target attivo: ${confTarget.kcal ?? curKcal} kcal/giorno</div>
            <div style="font-size:11.5px;color:var(--t2)">Proteine ${confTarget.protein ?? propMacros.protein ?? '—'}g · Carboidrati ${confTarget.carbs ?? propMacros.carbs ?? '—'}g · Grassi ${confTarget.fats ?? propMacros.fats ?? '—'}g</div>
          </div>
          <button class="btn btn-sm" onclick="window.handleWeeklyCheckinAction && window.handleWeeklyCheckinAction('reopen')" style="font-size:11px;padding:6px 10px;background:rgba(255,255,255,0.06);color:var(--t2);border:1px solid rgba(255,255,255,0.12);border-radius:8px">Rivedi</button>
        </div>
      </div>`;
  }

  if (proposal.eligible === false) {
    return `
      <div class="card" style="margin-bottom:12px;border:1px dashed rgba(255,255,255,0.16)">
        <div style="font-size:10.5px;font-weight:800;color:var(--t3);letter-spacing:.4px">📅 CHECK-IN SETTIMANALE (${esc(weekLabel)})</div>
        <div style="font-size:12px;color:var(--t2);margin-top:4px;line-height:1.4">${esc(proposal.explanationIt || 'Registra almeno 5 giorni di diario e 8 pesate in 2 settimane per sbloccare l\'adeguamento automatico guidato.')}</div>
      </div>`;
  }

  return `
    <div class="card" id="weekly-checkin-card" style="margin-bottom:12px;border:1px solid rgba(124,111,255,0.45);background:rgba(124,111,255,0.07)">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">
        <div style="font-size:11px;font-weight:800;color:var(--accent);letter-spacing:.4px">📅 CHECK-IN SETTIMANALE GUIDATO (${esc(weekLabel)})</div>
        <span style="font-size:10px;background:rgba(255,255,255,0.07);color:var(--t2);padding:2px 7px;border-radius:999px;font-weight:700">Max ±150 kcal/sett</span>
      </div>
      <div style="font-size:14px;font-weight:800;color:var(--t1);line-height:1.3">
        ${delta === 0 ? `Mantieni ${propKcal} kcal al giorno` : `Passa da ${curKcal} a ${propKcal} kcal al giorno (${deltaStr})`}
      </div>
      <div style="font-size:12px;color:var(--t2);line-height:1.45;margin-top:4px">${esc(proposal.explanationIt || proposal.reason || '')}</div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn btn-g btn-sm" onclick="window.handleWeeklyCheckinAction && window.handleWeeklyCheckinAction('accepted')" style="flex:1;min-width:110px;font-size:12px;font-weight:800;padding:9px 10px">✅ Accetta (${propKcal} kcal)</button>
        <button class="btn btn-v btn-sm" onclick="window.toggleWeeklyCheckinCustom && window.toggleWeeklyCheckinCustom()" style="font-size:12px;font-weight:700;padding:9px 12px">✏️ Modifica</button>
        <button class="btn btn-sm" onclick="window.handleWeeklyCheckinAction && window.handleWeeklyCheckinAction('rejected')" style="font-size:12px;font-weight:700;padding:9px 12px;background:rgba(255,255,255,0.06);color:var(--t2);border:1px solid rgba(255,255,255,0.12)">Mantieni ${curKcal}</button>
      </div>
      <div id="weekly-checkin-custom-box" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08)">
        <div style="display:flex;gap:8px;align-items:center">
          <input type="number" id="weekly-checkin-custom-kcal" class="fi" value="${propKcal}" min="1200" max="5500" step="25" style="flex:1;font-size:13px;padding:8px 10px" placeholder="Kcal giornaliere">
          <button class="btn btn-v btn-sm" onclick="window.handleWeeklyCheckinAction && window.handleWeeklyCheckinAction('modified')" style="font-size:12px;font-weight:800;padding:8px 14px">Conferma Kcal</button>
        </div>
      </div>
    </div>`;
}

/**
 * Pagina 1: ANDAMENTO — "Come sta andando questa settimana? Quanto devo mangiare?"
 */
export function renderAndamentoDashboardHTML(pipelineResult, coachReport, { isDemo = false, isLoadingCoach = false } = {}) {
  const en = pipelineResult?.energyOutput || {};
  const profile = pipelineResult?.profile || {};
  const ma = pipelineResult?.missingAssistant || { missingProfileFields: [], missingTodayFields: [], smartDefaults: {}, biasChecks: [] };
  const bodyComp4w = pipelineResult?.bodyCompState4w || null;
  const weeklyCheckin = pipelineResult?.weeklyCheckinProposal || null;
  const nutritionQuality = pipelineResult?.nutritionQuality || null;
  const personalCorr = pipelineResult?.personalCorrelations || null;
  const goal = profile.goal_type || 'cut';

  // ── 1. HERO CARD ("Come sta andando questa settimana") ──
  const rate = Number(en.weeklyRateKg ?? 0);
  const absRate = Math.abs(rate).toFixed(2);
  const need = (en.missingDataRequirements || [])[0];
  let verdict;
  if (en.trendWeight == null) {
    verdict = { icon: '⚖️', color: '#8e8e93', title: 'Inserisci il tuo peso', text: 'Pesati al mattino e segna il peso: bastano pochi giorni per vedere il tuo andamento reale.' };
  } else if (en.isPreliminary) {
    verdict = { icon: '🌱', color: '#ffc300', title: 'Sto ancora imparando a conoscerti',
      text: `Servono circa 2 settimane di peso e pasti registrati${need?.daysNeeded > 0 ? ` (ancora ${need.daysNeeded} giorni)` : ''}. Per ora i numeri sono stime iniziali.` };
  } else if (Math.abs(rate) < 0.1) {
    const ok = goal === 'maintain';
    verdict = { icon: ok ? '✅' : '⏸️', color: ok ? '#30d158' : '#ffc300', title: 'Il tuo peso vero è stabile', text: ok ? 'Perfetto per il mantenimento: stai mangiando in linea con ciò che consumi.' : 'Non stai né salendo né scendendo: usa il Check-in settimanale sotto per adeguare le calorie.' };
  } else if (rate < 0) {
    const ok = goal !== 'bulk';
    verdict = { icon: ok ? '✅' : '⚠️', color: ok ? '#30d158' : '#ffc300', title: `Stai scendendo di circa ${absRate} kg a settimana`, text: ok ? 'Sei nella direzione giusta, al netto degli sbalzi d\'acqua.' : 'Il tuo obiettivo è costruire massa: ti conviene alzare leggermente le calorie.' };
  } else {
    const ok = goal === 'bulk';
    verdict = { icon: ok ? '✅' : '⚠️', color: ok ? '#30d158' : '#ffc300', title: `Stai salendo di circa ${absRate} kg a settimana`, text: ok ? 'Sei nella direzione giusta per costruire massa.' : 'Il tuo obiettivo non è salire: riduci leggermente le calorie giornaliere.' };
  }

  // ── 2. PREVISIONI (4 e 12 settimane) ────────────────────
  const fc = (en.forecast || []).filter(f => f.horizonWeeks === 4 || f.horizonWeeks === 12);
  const forecastRows = fc.map(f => `
    <div style="flex:1;background:rgba(255,255,255,0.04);border-radius:10px;padding:9px 6px;text-align:center">
      <div style="font-size:10.5px;color:var(--t3);font-weight:700">Tra ${f.horizonWeeks} settimane</div>
      <div style="font-size:17px;font-weight:800;color:var(--t1);margin:2px 0">${f.weight} kg</div>
      <div style="font-size:10px;color:var(--t3)">fascia probabile ${f.low}–${f.high} kg</div>
    </div>`).join('');

  const activeTarget = pipelineResult?.unifiedTargets || {
    kcal: en.recommendedKcal,
    macros: en.recommendedMacros || {}
  };
  const m = activeTarget.macros || en.recommendedMacros || {};
  const tdeeTxt = en.tdeeEstimate != null ? `${en.tdeeEstimate} kcal` : '—';

  // Nota 2.1e: Sotto-registrazione sospetta (>20% persistente sotto il prior teorico)
  const underReportingBanner = en.underReportingSuspected
    ? `<div style="margin-top:8px;padding:8px 10px;border-radius:10px;background:rgba(255,195,0,0.1);border:1px solid rgba(255,195,0,0.35);font-size:11.5px;color:var(--t2);line-height:1.4">
        💡 <b style="color:#ffc300">Nota sul diario:</b> il metabolismo stimato si basa sulle calorie che registri. La differenza rispetto alla stima teorica (+${Math.abs(en.underReportingGapPct || 20)}%) suggerisce che qualche condimento, assaggio o pasto fuori potrebbe non essere stato segnato.
      </div>`
    : '';

  // Qualità nutrizionale (4E) e correlazioni personali (4F)
  const nutQualityPill = nutritionQuality
    ? `<div style="margin-top:10px;padding:8px 10px;background:rgba(255,255,255,0.03);border-radius:10px;display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:var(--t2)">
        <span>🥗 <b>Distribuzione proteine oggi:</b> ${nutritionQuality.mpsMealsCount ?? 0} pasti con ≥${nutritionQuality.mpsThresholdG ?? 22}g</span>
        <span style="font-weight:800;color:${(nutritionQuality.mpsMealsCount ?? 0) >= 3 ? '#30d158' : '#ffc300'}">${(nutritionQuality.mpsMealsCount ?? 0) >= 3 ? 'Ottimale' : 'Migliorabile'}</span>
      </div>`
    : '';

  const corrBanner = personalCorr?.topInsight
    ? `<div style="margin-top:8px;padding:8px 10px;background:rgba(58,134,255,0.08);border:1px solid rgba(58,134,255,0.28);border-radius:10px;font-size:11.5px;color:var(--t2);line-height:1.4">
        🔗 <b style="color:#3a86ff">Pattern personale scoperto:</b> ${esc(personalCorr.topInsight.message)}
      </div>`
    : '';

  // ── 3. DETTAGLI + BIAS + NUMERI PER ESPERTI (chiusi in <details>) ──
  const bias = (ma.biasChecks || []).map(b => {
    const col = b.status === 'warning' ? '#ffc300' : '#30d158';
    return `<div style="border-left:3px solid ${col};padding:4px 0 4px 10px;margin-bottom:8px">
      <div style="font-size:12px;font-weight:800;color:var(--t1)">${b.status === 'warning' ? '⚠️' : '✅'} ${esc(b.title)}</div>
      <div style="font-size:11.5px;color:var(--t2);line-height:1.4">${esc(b.desc)}</div></div>`;
  }).join('');

  return `
    ${verdictCard(verdict)}
    ${renderCoachCardHTML(coachReport || pipelineResult?.deterministicCoach, { isDemo, isLoading: isLoadingCoach })}
    ${isDemo ? '' : renderWeeklyCheckinCardHTML(weeklyCheckin)}
    ${isDemo ? '' : missingFormHTML(ma)}

    <!-- GRAFICO PESO E STATO 4 SETTIMANE -->
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
        <div>${sectionTitle('⚖️ Il tuo peso nel tempo', 'Il peso "vero", depurato dagli sbalzi di acqua')}</div>
        <div>${reliabilityBadgeHTML(en.confidence, en.model_divergence)}</div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0">
        <div style="background:rgba(255,107,53,0.1);border-radius:12px;padding:10px;text-align:center">
          <div style="font-size:10.5px;color:#ff6b35;font-weight:800">PESO VERO (SENZA ACQUA)</div>
          <div style="font-size:22px;font-weight:900;color:var(--t1)">${en.trendWeight ?? '—'}<span style="font-size:12px"> kg</span></div>
          <div style="font-size:10.5px;color:var(--t3)">bilancia oggi: ${en.rawWeight != null ? en.rawWeight + ' kg' : '—'}</div>
        </div>
        <div style="background:rgba(58,134,255,0.1);border-radius:12px;padding:10px;text-align:center">
          <div style="font-size:10.5px;color:#3a86ff;font-weight:800">CALORIE CHE BRUCI</div>
          <div style="font-size:22px;font-weight:900;color:var(--t1)">${en.tdeeEstimate ?? '—'}</div>
          <div style="font-size:10.5px;color:var(--t3)">rispetto al diario registrato</div>
        </div>
      </div>

      <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--t2);margin-bottom:4px">
        <span>⚪ pesate sulla bilancia</span>
        <span style="color:#ff6b35">━ peso vero</span>
        <span style="color:var(--accent)">┄ previsione</span>
        ${profile.weight_target ? `<span style="color:#30d158">┄ obiettivo</span>` : ''}
      </div>
      ${renderWeightForecastSVG(en, profile.weight_target)}
      ${renderBodyComp4wBadgeHTML(bodyComp4w)}
      ${underReportingBanner}
      ${corrBanner}

      ${explainBox(
        'I pallini sono il numero sulla bilancia, che sale e scende ogni giorno per acqua e sale. La linea arancione è il tuo peso vero. Il tratteggio viola è dove andrai se continui così.',
        'Le tue pesate mattutine e le calorie che segni nel diario.',
        `Se la linea arancione scende, stai dimagrendo davvero, anche se la bilancia ogni tanto sale.${en.etaGoalDate ? ` Di questo passo raggiungi l'obiettivo verso il <b>${fmtShortDate(en.etaGoalDate)}</b>.` : ''}`
      )}
      ${forecastRows ? `<div style="display:flex;gap:8px;margin-top:10px">${forecastRows}</div>` : ''}
    </div>

    <!-- COSA MANGIARE -->
    <div class="card" style="margin-bottom:12px">
      ${sectionTitle('🍽️ Quanto mangiare ogni giorno', 'Il tuo obiettivo unico per procedere con calma e sicurezza')}
      <div style="background:rgba(124,111,255,0.1);border-radius:12px;padding:12px;margin:12px 0 8px;text-align:center">
        <div style="font-size:26px;font-weight:900;color:var(--t1)">${activeTarget.kcal ?? en.recommendedKcal ?? '—'} <span style="font-size:13px;font-weight:600;color:var(--t2)">kcal al giorno</span></div>
        <div style="font-size:11.5px;color:var(--t3)">negli ultimi 7 giorni hai registrato in media ${en.avgIntake7d != null ? en.avgIntake7d + ' kcal' : '—'}</div>
      </div>
      <div style="font-size:12.5px;color:var(--t2);text-align:center">
        di cui circa <b style="color:#30d158">${m.protein ?? '—'} g di proteine</b> · ${m.carbs ?? '—'} g carboidrati · ${m.fats ?? '—'} g grassi
      </div>
      ${nutQualityPill}
      ${explainBox(
        'Il numero di calorie e macronutrienti consigliato per oggi.',
        `Il tuo consumo reale stimato (${tdeeKcalSafe(tdeeTxt)}) e il ritmo di cambiamento impostato.`,
        'Restare vicino a questo valore ti porta al traguardo proteggendo muscoli ed energie.'
      )}
    </div>

    <!-- CASSETTO ESPERTI E AFFIDABILITÀ -->
    <div class="card" style="margin-bottom:12px">
      <details>
        <summary style="cursor:pointer;font-size:12.5px;font-weight:800;color:var(--t2)">🔬 Dettagli tecnici e affidabilità dei dati (${en.confidence || 0}/100)</summary>
        <div style="margin-top:10px">
          <div style="font-size:12px;color:var(--t2);line-height:1.5;margin-bottom:10px">
            Più giorni registri (peso + tutti i pasti), più l'incertezza matematica si restringe:
          </div>
          ${bias}
          <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin-top:10px;padding:9px;background:rgba(255,255,255,0.03);border-radius:10px;font-size:11px;color:var(--t2)">
            <div><b>Intervallo TDEE (95%):</b> ${en.tdeeCI ? `${en.tdeeCI[0]}–${en.tdeeCI[1]} kcal` : '—'}</div>
            <div><b>Deviazione standard:</b> ±${en.tdeeSdKcal ?? '—'} kcal</div>
            <div><b>TDEE finestra mobile:</b> ${en.windowTdee ?? '—'} kcal</div>
            <div><b>Densità energetica ρ:</b> ${en.rhoDynamicKcalPerKg ?? 7700} kcal/kg</div>
            <div><b>Aderenza diario 14gg:</b> ${en.adherence14Pct ?? 0}%</div>
            <div><b>Versione modello:</b> ${esc(en.model_version || 'energy@2.0')}</div>
          </div>
          <div style="margin-top:10px">${renderTdeeHistorySVG(en)}</div>
          <div style="margin-top:10px;text-align:right">
            <a href="model-eval.html" style="font-size:11px;color:var(--accent);font-weight:700;text-decoration:none">⚙️ Apri pannello Backtest & Feature Flags V2 →</a>
          </div>
        </div>
      </details>
    </div>
  `;
}

function tdeeKcalSafe(t) { return t; }

function renderReadinessBreakdownHTML(tr) {
  const readiness = tr.readiness ?? 75;
  const contribs = Array.isArray(tr.readinessContributions) ? tr.readinessContributions : [];
  const col = readiness >= 75 ? '#30d158' : readiness >= 50 ? '#ffc300' : '#ff453a';
  const label = readiness >= 75 ? 'Ottima prontezza' : readiness >= 50 ? 'Prontezza media' : 'Prontezza bassa (priorità recupero)';

  const barsHtml = contribs.filter(c => c.factor !== 'base').map(c => {
    const val = Number(c.delta) || 0;
    const isPos = val >= 0;
    const barCol = val > 0 ? '#30d158' : val < 0 ? '#ff453a' : '#8e8e93';
    const widthPct = Math.min(100, Math.max(8, Math.abs(val) * 5));
    const signStr = val > 0 ? `+${val}` : `${val}`;
    return `
      <div style="margin-bottom:7px">
        <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:2px">
          <span style="color:var(--t1);font-weight:700">${esc(c.label)} <span style="color:var(--t3);font-weight:400">(${esc(c.detail || '')})</span></span>
          <span style="color:${barCol};font-weight:800">${signStr} pt</span>
        </div>
        <div style="height:6px;background:rgba(255,255,255,0.06);border-radius:999px;overflow:hidden">
          <div style="height:100%;width:${widthPct}%;background:${barCol};border-radius:999px;opacity:${isPos ? '0.9' : '0.85'}"></div>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px">
        <div>
          ${sectionTitle('🔋 Perché oggi la tua prontezza è ' + readiness + '/100', label)}
        </div>
        <div style="width:46px;height:46px;border-radius:50%;border:3px solid ${col};display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900;color:${col}">
          ${readiness}
        </div>
      </div>
      <div style="font-size:11.5px;color:var(--t2);margin-bottom:8px">Partiamo da una base di <b>75 punti</b> e sommiamo o togliamo punti in base a come stai recuperando:</div>
      ${barsHtml || `<div style="font-size:12px;color:var(--t3)">Completa i prossimi allenamenti per vedere il dettaglio dei fattori.</div>`}
    </div>`;
}

/**
 * Pagina 2: ALLENAMENTO — "Sono fresco o stanco? Sto diventando più forte?"
 */
export function renderAllenamentoDashboardHTML(pipelineResult) {
  const tr = pipelineResult?.trainingOutput || {};
  const lifts = tr.lifts || [];
  const sets = tr.weeklySetsByMuscle || {};
  const volStatus = tr.muscleVolumeStatus || {};
  const n = tr.totalCompletedSessions || 0;

  // ── 1. VERDETTO ─────────────────────────────────────────
  let verdict;
  if (n < 3) {
    verdict = { icon: '🌱', color: '#8e8e93', title: 'Servono ancora alcuni allenamenti', text: `Ne hai registrati ${n}. Dopo 3-4 sedute inizio a dirti se sei fresco o affaticato.` };
  } else if (tr.deloadSuggested) {
    verdict = { icon: '🛌', color: '#ff453a', title: 'Ti conviene una settimana più leggera', text: 'Hai accumulato parecchia stanchezza e i carichi faticano a salire: riduci le serie di circa un terzo per 5-7 giorni.' };
  } else if (tr.tsb != null && tr.tsb < -15) {
    verdict = { icon: '😮‍💨', color: '#ffc300', title: 'Sei piuttosto stanco', text: 'Stai spingendo forte. Dormi bene e non forzare cedimenti estremi questa settimana.' };
  } else if (tr.tsb != null && tr.tsb > 10) {
    verdict = { icon: '⚡', color: '#3a86ff', title: 'Sei molto riposato', text: 'Hai recuperato bene: è un ottimo momento per provare ad aumentare ripetizioni o carico.' };
  } else {
    verdict = { icon: '✅', color: '#30d158', title: 'Allenamento e recupero in equilibrio', text: 'Stai costruendo forma fisica senza accumulare stanchezza eccessiva.' };
  }

  // Stato qualitativo Banister (2.2c)
  const banQual = tr.banisterQualitativeState;
  const banQualBadge = banQual
    ? `<div style="margin-bottom:10px;padding:8px 11px;border-radius:10px;background:rgba(58,134,255,0.09);border:1px solid rgba(58,134,255,0.28);font-size:12px;color:var(--t1)">
        <b>Stato di forma attuale:</b> ${esc(banQual.label)}
      </div>`
    : '';

  // ── 2. FORZA E DOPPIA PROGRESSIONE (max 6 esercizi) ─────
  const st = {
    progress: { t: '📈 Più forte', c: '#30d158' },
    plateau:  { t: '⏸️ Stabile', c: '#ffc300' },
    regress:  { t: '📉 In calo', c: '#ff453a' }
  };
  const liftsHtml = lifts.length ? lifts.slice(0, 6).map(l => {
    const s = st[l.status] || { t: '—', c: 'var(--t2)' };
    const dp = l.doubleProgression;
    const dpChip = dp
      ? `<div style="margin-top:4px;font-size:11px;color:${dp.readyToProgress ? '#30d158' : 'var(--t2)'};font-weight:${dp.readyToProgress ? '700' : '500'}">
          ${dp.readyToProgress ? '🎯' : '👉'} ${esc(dp.action)}
        </div>`
      : '';
    return `
      <div style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div style="min-width:0">
            <div style="font-size:13px;font-weight:800;color:var(--t1)">${esc(l.exerciseId)}</div>
            <div style="font-size:11px;color:var(--t3)">stima tra 4 settimane: <b style="color:var(--accent)">${l.forecast4w} kg</b></div>
          </div>
          <div style="text-align:right;white-space:nowrap">
            <div style="font-size:15px;font-weight:900;color:var(--t1)">${l.e1rm} kg</div>
            <div style="font-size:10.5px;font-weight:800;color:${s.c}">${s.t}</div>
          </div>
        </div>
        ${dpChip}
      </div>`;
  }).join('') : `<div style="font-size:12.5px;color:var(--t3);padding:10px 0;text-align:center">Registra allenamenti con peso e ripetizioni per vedere i progressi e i consigli sul carico.</div>`;

  const rirNote = lifts.some(l => l.assumedZeroRir)
    ? `<div style="font-size:11px;color:#ffc300;margin-top:8px;line-height:1.4">⚠️ In alcune serie non hai indicato quante ripetizioni ti restavano (RIR): segnarlo rende il consiglio di progressione molto più preciso.</div>` : '';

  // ── 3. VOLUME PER MUSCOLO CON SEMAFORO (2.2f) ───────────
  const rows = Object.entries(sets).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
    const vs = volStatus[k];
    const status = vs?.status || (v < 10 ? 'under' : v <= 20 ? 'ok' : 'over');
    const col = status === 'under' ? '#3a86ff' : status === 'ok' ? '#30d158' : '#ffc300';
    const txt = status === 'under' ? `sotto target (${vs?.min ?? 10}–${vs?.max ?? 20})` : status === 'ok' ? 'ottimale' : `alto (>${vs?.max ?? 20})`;
    return `<div style="display:flex;justify-content:space-between;font-size:12px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
      <span>${esc(MUSCLE_LABELS_IT[k] || k)}</span><span style="color:${col};font-weight:700">${v} serie · ${txt}</span></div>`;
  }).join('') || `<div style="font-size:12px;color:var(--t3)">Nessun allenamento negli ultimi 7 giorni.</div>`;

  return `
    ${verdictCard(verdict)}

    <!-- PRONTEZZA TRASPARENTE A BARRE (2.2e) -->
    ${renderReadinessBreakdownHTML(tr)}

    <!-- FORMA vs STANCHEZZA -->
    <div class="card" style="margin-bottom:12px">
      ${sectionTitle('⚡ Allenamento accumulato vs Stanchezza', 'Come sta rispondendo il tuo corpo settimana dopo settimana')}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0">
        <div style="background:rgba(58,134,255,0.1);border-radius:12px;padding:10px;text-align:center">
          <div style="font-size:10.5px;color:#3a86ff;font-weight:800">FORMA COSTRUITA</div>
          <div style="font-size:22px;font-weight:900;color:var(--t1)">${tr.ctl ?? 0}</div>
          <div style="font-size:10.5px;color:var(--t3)">ultime 6 settimane</div>
        </div>
        <div style="background:rgba(255,69,58,0.1);border-radius:12px;padding:10px;text-align:center">
          <div style="font-size:10.5px;color:#ff453a;font-weight:800">FATICA RECENTE</div>
          <div style="font-size:22px;font-weight:900;color:var(--t1)">${tr.atl ?? 0}</div>
          <div style="font-size:10.5px;color:var(--t3)">ultimi 7 giorni</div>
        </div>
      </div>
      ${banQualBadge}
      <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--t2);margin-bottom:4px">
        <span style="color:#3a86ff">━ forma costruita</span>
        <span style="color:#ff453a">━ fatica recente</span>
      </div>
      ${renderBanisterPmcSVG(tr)}
      ${explainBox(
        'La linea blu sale quando ti alleni con costanza. La rossa sale dopo gli allenamenti intensi e scende quando riposi.',
        'Durata, serie allenanti e voto di fatica (1-10) di ogni seduta.',
        'Quando la rossa supera di molto la blu hai bisogno di recuperare. Quando scende sotto la blu sei fresco e pronto per fare nuovi record.'
      )}
    </div>

    <!-- FORZA E PROGRESSIONE CARICHI -->
    <div class="card" style="margin-bottom:12px">
      ${sectionTitle('🏋️ Forza e prossimo passo sui carichi', 'Forza massimale stimata (1RM) e consiglio pratico per la prossima seduta')}
      <div style="margin-top:6px">${liftsHtml}</div>
      ${rirNote}
      ${explainBox(
        'Per ogni esercizio vedi il massimale teorico su 1 ripetizione (calcolato sulla tua serie migliore) e cosa fare nella prossima seduta.',
        'Peso, ripetizioni e margine (RIR) delle serie fino a 12 ripetizioni.',
        'Quando completi tutte le serie al massimo delle ripetizioni con buon margine, ti proponiamo un piccolo aumento di carico (+2.5%).'
      )}
    </div>

    <!-- VOLUME MUSCOLARE E CASSETTO ESPERTI -->
    <div class="card" style="margin-bottom:12px">
      <details open>
        <summary style="cursor:pointer;font-size:12.5px;font-weight:800;color:var(--t1)">💪 Serie per gruppo muscolare (ultimi 7 giorni)</summary>
        <div style="margin-top:10px">
          ${rows}
          <div style="font-size:11px;color:var(--t3);margin-top:8px;line-height:1.4">La fascia ottimale per la maggior parte dei muscoli è <b>10–20 serie allenanti a settimana</b>.</div>
        </div>
      </details>
      <details style="margin-top:12px">
        <summary style="cursor:pointer;font-size:12.5px;font-weight:800;color:var(--t2)">🔬 Dettagli tecnici per esperti</summary>
        <div style="margin-top:8px;display:grid;grid-template-columns:repeat(2,1fr);gap:6px;padding:9px;background:rgba(255,255,255,0.03);border-radius:10px;font-size:11px;color:var(--t2)">
          <div><b>Bilancio forma (TSB):</b> ${tr.tsb ?? 0}</div>
          <div><b>Rapporto carico (ACWR):</b> ${tr.acwr ?? '—'}</div>
          <div><b>Monotonia Foster (7gg):</b> ${tr.monotony ?? '—'}</div>
          <div><b>Strain settimanale:</b> ${tr.strain ?? '—'}</div>
          <div><b>Fattori scala carico:</b> k_hs=${tr.load_conversion?.k_hs ?? '—'}, k_ton=${tr.load_conversion?.k_ton ?? '—'}</div>
          <div><b>Versione modello:</b> ${esc(tr.model_version || 'training@2.0')}</div>
        </div>
      </details>
    </div>
  `;
}
