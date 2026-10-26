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

/**
 * Pagina 1: ANDAMENTO — "Sto dimagrendo? Quanto devo mangiare?"
 */
export function renderAndamentoDashboardHTML(pipelineResult, coachReport, { isDemo = false, isLoadingCoach = false } = {}) {
  const en = pipelineResult?.energyOutput || {};
  const profile = pipelineResult?.profile || {};
  const ma = pipelineResult?.missingAssistant || { missingProfileFields: [], missingTodayFields: [], smartDefaults: {}, biasChecks: [] };
  const goal = profile.goal_type || 'cut';

  // ── 1. VERDETTO ─────────────────────────────────────────
  const rate = Number(en.weeklyRateKg ?? 0);
  const absRate = Math.abs(rate).toFixed(2);
  const need = (en.missingDataRequirements || [])[0];
  let verdict;
  if (en.trendWeight == null) {
    verdict = { icon: '⚖️', color: '#8e8e93', title: 'Inserisci il tuo peso', text: 'Pesati al mattino e segna il peso: bastano pochi giorni per vedere il tuo andamento.' };
  } else if (en.isPreliminary) {
    verdict = { icon: '🌱', color: '#ffc300', title: 'Sto ancora imparando a conoscerti',
      text: `Servono circa 2 settimane di peso e pasti registrati${need?.daysNeeded > 0 ? ` (ancora ${need.daysNeeded} giorni)` : ''}. Per ora i numeri sono stime.` };
  } else if (Math.abs(rate) < 0.1) {
    const ok = goal === 'maintain';
    verdict = { icon: ok ? '✅' : '⏸️', color: ok ? '#30d158' : '#ffc300', title: 'Il tuo peso è stabile', text: ok ? 'Perfetto per il mantenimento.' : 'Non stai né salendo né scendendo in modo apprezzabile.' };
  } else if (rate < 0) {
    const ok = goal !== 'bulk';
    verdict = { icon: ok ? '✅' : '⚠️', color: ok ? '#30d158' : '#ffc300', title: `Stai scendendo: circa ${absRate} kg a settimana`, text: ok ? 'Sei nella direzione giusta.' : 'Il tuo obiettivo è salire: servirebbe mangiare un po\' di più.' };
  } else {
    const ok = goal === 'bulk';
    verdict = { icon: ok ? '✅' : '⚠️', color: ok ? '#30d158' : '#ffc300', title: `Stai salendo: circa ${absRate} kg a settimana`, text: ok ? 'Sei nella direzione giusta.' : 'Il tuo obiettivo non è salire: servirebbe mangiare un po\' meno.' };
  }

  // ── 2. PREVISIONI (solo 4 e 12 settimane) ───────────────
  const fc = (en.forecast || []).filter(f => f.horizonWeeks === 4 || f.horizonWeeks === 12);
  const forecastRows = fc.map(f => `
    <div style="flex:1;background:rgba(255,255,255,0.04);border-radius:10px;padding:9px 6px;text-align:center">
      <div style="font-size:10.5px;color:var(--t3);font-weight:700">Tra ${f.horizonWeeks} settimane</div>
      <div style="font-size:17px;font-weight:800;color:var(--t1);margin:2px 0">${f.weight} kg</div>
      <div style="font-size:10px;color:var(--t3)">probabile tra ${f.low} e ${f.high}</div>
    </div>`).join('');

  const m = en.recommendedMacros || {};
  const tdeeTxt = en.tdeeEstimate != null ? `${en.tdeeEstimate} kcal` : '—';

  // ── 3. DETTAGLI + BIAS (un solo cassetto) ───────────────
  const bias = (ma.biasChecks || []).map(b => {
    const col = b.status === 'warning' ? '#ffc300' : '#30d158';
    return `<div style="border-left:3px solid ${col};padding:4px 0 4px 10px;margin-bottom:8px">
      <div style="font-size:12px;font-weight:800;color:var(--t1)">${b.status === 'warning' ? '⚠️' : '✅'} ${esc(b.title)}</div>
      <div style="font-size:11.5px;color:var(--t2);line-height:1.4">${esc(b.desc)}</div></div>`;
  }).join('');

  return `
    ${verdictCard(verdict)}
    ${renderCoachCardHTML(coachReport || pipelineResult?.deterministicCoach, { isDemo, isLoading: isLoadingCoach })}
    ${isDemo ? '' : missingFormHTML(ma)}

    <!-- GRAFICO PESO -->
    <div class="card" style="margin-bottom:12px">
      ${sectionTitle('⚖️ Il tuo peso nel tempo', 'Il peso "vero", senza gli sbalzi di acqua')}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0">
        <div style="background:rgba(255,107,53,0.1);border-radius:12px;padding:10px;text-align:center">
          <div style="font-size:10.5px;color:#ff6b35;font-weight:800">PESO VERO</div>
          <div style="font-size:22px;font-weight:900;color:var(--t1)">${en.trendWeight ?? '—'}<span style="font-size:12px"> kg</span></div>
          <div style="font-size:10.5px;color:var(--t3)">bilancia oggi: ${en.rawWeight != null ? en.rawWeight + ' kg' : '—'}</div>
        </div>
        <div style="background:rgba(58,134,255,0.1);border-radius:12px;padding:10px;text-align:center">
          <div style="font-size:10.5px;color:#3a86ff;font-weight:800">CALORIE CHE BRUCI</div>
          <div style="font-size:22px;font-weight:900;color:var(--t1)">${en.tdeeEstimate ?? '—'}</div>
          <div style="font-size:10.5px;color:var(--t3)">al giorno (stima)</div>
        </div>
      </div>

      <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--t2);margin-bottom:4px">
        <span>⚪ pesate sulla bilancia</span>
        <span style="color:#ff6b35">━ peso vero</span>
        <span style="color:var(--accent)">┄ previsione</span>
        ${profile.weight_target ? `<span style="color:#30d158">┄ obiettivo</span>` : ''}
      </div>
      ${renderWeightForecastSVG(en, profile.weight_target)}

      ${explainBox(
        'I pallini sono il numero sulla bilancia, che sale e scende ogni giorno per acqua e sale. La linea arancione è il tuo peso vero. Il tratteggio viola è dove andrai se continui così.',
        'Le tue pesate e le calorie che segni nel diario.',
        `Se la linea arancione scende, stai dimagrendo, anche se la bilancia ogni tanto sale.${en.etaGoalDate ? ` Di questo passo arrivi all'obiettivo verso il <b>${fmtShortDate(en.etaGoalDate)}</b>.` : ''}`
      )}
      ${forecastRows ? `<div style="display:flex;gap:8px;margin-top:10px">${forecastRows}</div>` : ''}
    </div>

    <!-- COSA MANGIARE -->
    <div class="card" style="margin-bottom:12px">
      ${sectionTitle('🍽️ Quanto mangiare', 'Il consiglio per proseguire con calma e in sicurezza')}
      <div style="background:rgba(124,111,255,0.1);border-radius:12px;padding:12px;margin:12px 0 8px;text-align:center">
        <div style="font-size:26px;font-weight:900;color:var(--t1)">${en.recommendedKcal ?? '—'} <span style="font-size:13px;font-weight:600;color:var(--t2)">kcal al giorno</span></div>
        <div style="font-size:11.5px;color:var(--t3)">negli ultimi 7 giorni hai mangiato in media ${en.avgIntake7d != null ? en.avgIntake7d + ' kcal' : '—'}</div>
      </div>
      <div style="font-size:12.5px;color:var(--t2);text-align:center">
        di cui circa <b style="color:#30d158">${m.protein ?? '—'} g di proteine</b> · ${m.carbs ?? '—'} g carboidrati · ${m.fats ?? '—'} g grassi
      </div>
      ${explainBox(
        'Il numero di calorie giornaliere consigliato.',
        `Quante calorie bruci davvero (${tdeeKcalSafe(tdeeTxt)}) e il ritmo di cambiamento che vuoi.`,
        'Mangiare vicino a questo valore ti porta al tuo obiettivo senza fare diete troppo dure.'
      )}
    </div>

    <!-- DETTAGLI -->
    <div class="card" style="margin-bottom:12px">
      <details>
        <summary style="cursor:pointer;font-size:12.5px;font-weight:800;color:var(--t2)">🔍 Quanto sono affidabili questi numeri? (${en.confidence || 0}/100)</summary>
        <div style="margin-top:10px">
          <div style="font-size:12px;color:var(--t2);line-height:1.5;margin-bottom:10px">
            Più giorni registri (peso + tutti i pasti), più i numeri diventano precisi. Ecco cosa può falsarli:
          </div>
          ${bias}
          <div style="font-size:11px;color:var(--t3);margin-top:6px">Aderenza al diario ultimi 14 giorni: <b>${en.adherence14Pct ?? 0}%</b></div>
        </div>
      </details>
    </div>
  `;
}

function tdeeKcalSafe(t) { return t; }

/**
 * Pagina 2: ALLENAMENTO — "Sono fresco o stanco? Sto diventando più forte?"
 */
export function renderAllenamentoDashboardHTML(pipelineResult) {
  const tr = pipelineResult?.trainingOutput || {};
  const lifts = tr.lifts || [];
  const sets = tr.weeklySetsByMuscle || {};
  const n = tr.totalCompletedSessions || 0;

  // ── VERDETTO ────────────────────────────────────────────
  let verdict;
  if (n < 3) {
    verdict = { icon: '🌱', color: '#8e8e93', title: 'Servono ancora alcuni allenamenti', text: `Ne hai registrati ${n}. Dopo 3-4 sedute inizio a dirti come stai.` };
  } else if (tr.deloadSuggested) {
    verdict = { icon: '🛌', color: '#ff453a', title: 'Ti conviene una settimana più leggera', text: 'Sei molto stanco e i carichi non salgono: riduci le serie di circa un terzo per 5-7 giorni.' };
  } else if (tr.tsb != null && tr.tsb < -15) {
    verdict = { icon: '😮‍💨', color: '#ffc300', title: 'Sei piuttosto stanco', text: 'Stai spingendo forte. Dormi bene e non aumentare i carichi questa settimana.' };
  } else if (tr.tsb != null && tr.tsb > 10) {
    verdict = { icon: '⚡', color: '#3a86ff', title: 'Sei molto riposato', text: 'Hai margine: è un buon momento per spingere un po\' di più.' };
  } else {
    verdict = { icon: '✅', color: '#30d158', title: 'Stai andando bene', text: 'Allenamento e recupero sono in equilibrio.' };
  }

  // ── FORZA (max 5 esercizi) ──────────────────────────────
  const st = {
    progress: { t: '📈 Più forte', c: '#30d158' },
    plateau:  { t: '⏸️ Fermo', c: '#ffc300' },
    regress:  { t: '📉 In calo', c: '#ff453a' }
  };
  const liftsHtml = lifts.length ? lifts.slice(0, 5).map(l => {
    const s = st[l.status] || { t: '—', c: 'var(--t2)' };
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:800;color:var(--t1)">${esc(l.exerciseId)}</div>
          <div style="font-size:11px;color:var(--t3)">tra 4 settimane: circa <b style="color:var(--accent)">${l.forecast4w} kg</b></div>
        </div>
        <div style="text-align:right;white-space:nowrap">
          <div style="font-size:15px;font-weight:900;color:var(--t1)">${l.e1rm} kg</div>
          <div style="font-size:10.5px;font-weight:800;color:${s.c}">${s.t}</div>
        </div>
      </div>`;
  }).join('') : `<div style="font-size:12.5px;color:var(--t3);padding:10px 0;text-align:center">Registra allenamenti con peso e ripetizioni per vedere i progressi.</div>`;
  const rirNote = lifts.some(l => l.assumedZeroRir)
    ? `<div style="font-size:11px;color:#ffc300;margin-top:8px;line-height:1.4">⚠️ In alcune serie non hai indicato quante ripetizioni ti restavano: ho supposto "zero", quindi la tua forza reale potrebbe essere un po' più alta.</div>` : '';

  // ── MUSCOLI (chiuso) ────────────────────────────────────
  const rows = Object.entries(sets).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
    const col = v < 8 ? '#3a86ff' : v <= 20 ? '#30d158' : '#ffc300';
    const txt = v < 8 ? 'poche' : v <= 20 ? 'giuste' : 'tante';
    return `<div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0">
      <span>${esc(MUSCLE_LABELS_IT[k] || k)}</span><span style="color:${col};font-weight:700">${v} serie · ${txt}</span></div>`;
  }).join('') || `<div style="font-size:12px;color:var(--t3)">Nessun allenamento negli ultimi 7 giorni.</div>`;

  return `
    ${verdictCard(verdict)}

    <!-- FORMA vs STANCHEZZA -->
    <div class="card" style="margin-bottom:12px">
      ${sectionTitle('⚡ Allenamento accumulato e stanchezza', 'Come sta rispondendo il tuo corpo')}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0">
        <div style="background:rgba(58,134,255,0.1);border-radius:12px;padding:10px;text-align:center">
          <div style="font-size:10.5px;color:#3a86ff;font-weight:800">ALLENAMENTO ACCUMULATO</div>
          <div style="font-size:22px;font-weight:900;color:var(--t1)">${tr.ctl ?? 0}</div>
          <div style="font-size:10.5px;color:var(--t3)">ultime 6 settimane</div>
        </div>
        <div style="background:rgba(255,69,58,0.1);border-radius:12px;padding:10px;text-align:center">
          <div style="font-size:10.5px;color:#ff453a;font-weight:800">STANCHEZZA</div>
          <div style="font-size:22px;font-weight:900;color:var(--t1)">${tr.atl ?? 0}</div>
          <div style="font-size:10.5px;color:var(--t3)">ultimi 7 giorni</div>
        </div>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--t2);margin-bottom:4px">
        <span style="color:#3a86ff">━ allenamento accumulato</span>
        <span style="color:#ff453a">━ stanchezza</span>
      </div>
      ${renderBanisterPmcSVG(tr)}
      ${explainBox(
        'La linea blu sale piano quando ti alleni con costanza. La rossa schizza dopo gli allenamenti duri e scende quando riposi.',
        'Durata e fatica (voto da 1 a 10) di ogni allenamento che chiudi.',
        'Se la rossa sta molto sopra la blu sei stanco: riposa. Se sta sotto sei fresco e puoi spingere.'
      )}
    </div>

    <!-- FORZA -->
    <div class="card" style="margin-bottom:12px">
      ${sectionTitle('🏋️ Stai diventando più forte?', 'Il peso massimo che potresti sollevare 1 volta (stima)')}
      <div style="margin-top:6px">${liftsHtml}</div>
      ${rirNote}
      ${explainBox(
        'Per ogni esercizio, la tua forza stimata e dove sarai tra 4 settimane.',
        'Peso e ripetizioni delle tue serie (non serve fare un massimale vero).',
        'Verde = stai migliorando. Giallo = sei fermo da un po\': prova a variare. Rosso = stai perdendo forza: controlla recupero e calorie.'
      )}
    </div>

    <!-- DETTAGLI -->
    <div class="card" style="margin-bottom:12px">
      <details>
        <summary style="cursor:pointer;font-size:12.5px;font-weight:800;color:var(--t2)">💪 Serie per muscolo questa settimana</summary>
        <div style="margin-top:10px">
          ${rows}
          <div style="font-size:11px;color:var(--t3);margin-top:8px;line-height:1.4">Per far crescere un muscolo di solito bastano <b>10-20 serie a settimana</b>.</div>
        </div>
      </details>
      <details style="margin-top:10px">
        <summary style="cursor:pointer;font-size:12.5px;font-weight:800;color:var(--t2)">ℹ️ Da sapere</summary>
        <div style="margin-top:8px;font-size:11.5px;color:var(--t2);line-height:1.5">
          Sono stime matematiche, non diagnosi mediche. Se senti dolore, fermati e chiedi a un professionista.
          Più allenamenti registri (con il voto di fatica), più le stime sono affidabili.
        </div>
      </details>
    </div>
  `;
}
