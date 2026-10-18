/**
 * predictive-ui.js — Componenti UI e Grafici SVG per:
 *   • Dashboard "Andamento" (Modello 1: Peso Trend Kalman/EMA, Forecast 4/8/12w con banda CI, TDEE adattivo, Kcal/Macro)
 *   • Dashboard "Allenamento" (Modello 2: PMC Banister CTL/ATL/TSB, ACWR EWMA 7/28, e1RM Epley + Theil-Sen, Volume Muscolare)
 *   • Card "Coach" (Semaforo on_track/attention/off_track, sintesi, max 3 correzioni, domanda libera, Demo 90gg)
 */

const MUSCLE_LABELS_IT = {
  petto: 'Petto',
  dorso_verticale: 'Dorso (Ampiezza)',
  dorso_orizzontale: 'Dorso (Spessore)',
  quadricipiti: 'Quadricipiti',
  femorali: 'Femorali',
  glutei: 'Glutei',
  deltoide_laterale: 'Deltoide Laterale',
  deltoide_anteriore: 'Deltoide Anteriore',
  delt_posteriore: 'Deltoide Posteriore',
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
 * Grafico SVG Peso Grezzo (punti) + Trend Weight (Kalman/EMA) + Previsione 4/8/12w con banda di confidenza 95%.
 */
export function renderWeightForecastSVG(energyOutput, targetWeightKg = null) {
  const history = (energyOutput?.history || []).slice(-60);
  const dailyForecast = (energyOutput?.dailyForecast || []).filter((_, idx) => idx % 3 === 2 || idx === 0);

  if (history.length === 0) {
    return `<div style="padding:24px;text-align:center;color:var(--t3);font-size:12px">Nessun dato di peso disponibile</div>`;
  }

  const W = 340, H = 185;
  const padL = 34, padR = 14, padT = 16, padB = 26;
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

  const minW = Math.floor((Math.min(...allWeights) - 0.8) * 2) / 2;
  const maxW = Math.ceil((Math.max(...allWeights) + 0.8) * 2) / 2;
  const spanW = Math.max(1.5, maxW - minW);
  const yOf = (w) => padT + (1 - (w - minW) / spanW) * plotH;

  // Griglia orizzontale (4 linee)
  let gridSvg = '';
  for (let i = 0; i <= 3; i++) {
    const val = minW + (spanW * i) / 3;
    const y = yOf(val).toFixed(1);
    gridSvg += `
      <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
      <text x="${padL - 5}" y="${Number(y) + 3}" text-anchor="end" font-size="9" fill="var(--t3)">${val.toFixed(1)}</text>`;
  }

  // Linea target peso se presente
  let targetSvg = '';
  if (targetWeightKg != null && targetWeightKg >= minW && targetWeightKg <= maxW) {
    const ty = yOf(Number(targetWeightKg)).toFixed(1);
    targetSvg = `
      <line x1="${padL}" y1="${ty}" x2="${W - padR}" y2="${ty}" stroke="#30d158" stroke-width="1" stroke-dasharray="4 3" opacity="0.7"/>
      <text x="${W - padR - 2}" y="${Number(ty) - 4}" text-anchor="end" font-size="8" font-weight="700" fill="#30d158">Target ${targetWeightKg}kg</text>`;
  }

  // Poligono banda di confidenza forecast
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

    ciPolygonSvg = `<polygon points="${upperPts.concat(lowerPts).join(' ')}" fill="rgba(124,111,255,0.16)" stroke="none"/>`;
    forecastLineSvg = `<polyline points="${centerPts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="4 3"/>`;
  }

  // Linea continua trendWeight
  const trendPts = history
    .map((h, i) => h.trendWeight != null ? `${xOf(i).toFixed(1)},${yOf(h.trendWeight).toFixed(1)}` : null)
    .filter(Boolean);
  const trendLineSvg = trendPts.length > 1
    ? `<polyline points="${trendPts.join(' ')}" fill="none" stroke="#ff6b35" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>`
    : '';

  // Punti peso grezzo
  const dotsSvg = history.map((h, i) => {
    if (h.rawWeight == null) return '';
    const cx = xOf(i).toFixed(1);
    const cy = yOf(h.rawWeight).toFixed(1);
    const col = h.outlier ? '#ff453a' : 'rgba(255,255,255,0.45)';
    const r = h.outlier ? 3.2 : 2.1;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${col}"/>`;
  }).join('');

  // Etichette asse X (Inizio, Oggi, +12w)
  const todayIdx = history.length - 1;
  const xToday = xOf(todayIdx).toFixed(1);
  const xLabelsSvg = `
    <line x1="${xToday}" y1="${padT}" x2="${xToday}" y2="${H - padB}" stroke="rgba(255,255,255,0.12)" stroke-dasharray="2 2"/>
    <text x="${padL}" y="${H - 8}" text-anchor="start" font-size="9" fill="var(--t3)">${fmtShortDate(history[0].date)}</text>
    <text x="${xToday}" y="${H - 8}" text-anchor="middle" font-size="9" font-weight="700" fill="var(--t1)">Oggi</text>
    ${dailyForecast.length > 0 ? `<text x="${W - padR}" y="${H - 8}" text-anchor="end" font-size="9" fill="var(--accent)">+12 sett</text>` : ''}
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
 * Grafico SVG TDEE Adattivo + Banda di Confidenza nel tempo.
 */
export function renderTdeeHistorySVG(energyOutput) {
  const history = (energyOutput?.history || []).slice(-45);
  if (history.length < 2) return '';

  const W = 340, H = 130;
  const padL = 36, padR = 12, padT = 14, padB = 22;
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
      <text x="${padL - 4}" y="${yOf(maxK) + 4}" text-anchor="end" font-size="8" fill="var(--t3)">${maxK}</text>
      <text x="${padL - 4}" y="${yOf((minK + maxK) / 2) + 3}" text-anchor="end" font-size="8" fill="var(--t3)">${Math.round((minK + maxK) / 2)}</text>
      <text x="${padL - 4}" y="${yOf(minK) + 3}" text-anchor="end" font-size="8" fill="var(--t3)">${minK}</text>
      <polygon points="${upper.concat(lower).join(' ')}" fill="rgba(58,134,255,0.15)"/>
      ${intakeDots.join('')}
      <polyline points="${center.join(' ')}" fill="none" stroke="#3a86ff" stroke-width="2.2"/>
      <text x="${padL}" y="${H - 5}" font-size="8" fill="var(--t3)">${fmtShortDate(history[0].date)}</text>
      <text x="${W - padR}" y="${H - 5}" text-anchor="end" font-size="8" fill="var(--t3)">${fmtShortDate(history[history.length - 1].date)}</text>
    </svg>`;
}

/**
 * Grafico SVG Performance Management Chart (PMC — Banister CTL 42d, ATL 7d, TSB = CTL - ATL).
 */
export function renderBanisterPmcSVG(trainingOutput) {
  const history = (trainingOutput?.history || []).slice(-60);
  if (history.length < 2) {
    return `<div style="padding:20px;text-align:center;color:var(--t3);font-size:12px">Registra almeno 2 sessioni per visualizzare il grafico Fitness-Fatigue (PMC).</div>`;
  }

  const W = 340, H = 160;
  const padL = 32, padR = 12, padT = 14, padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xOf = (i) => padL + (i / Math.max(1, history.length - 1)) * plotW;
  const allVals = [0];
  history.forEach(d => allVals.push(d.ctl, d.atl, d.tsb));
  const minV = Math.floor(Math.min(...allVals, -20) - 5);
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
      <line x1="${padL}" y1="${yZero}" x2="${W - padR}" y2="${yZero}" stroke="rgba(255,255,255,0.18)" stroke-dasharray="3 3"/>
      <text x="${padL - 4}" y="${Number(yZero) + 3}" text-anchor="end" font-size="8" fill="var(--t2)">0</text>
      <text x="${padL - 4}" y="${padT + 6}" text-anchor="end" font-size="8" fill="var(--t3)">${maxV}</text>
      <text x="${padL - 4}" y="${H - padB}" text-anchor="end" font-size="8" fill="var(--t3)">${minV}</text>
      <polyline points="${tsbPts.join(' ')}" fill="none" stroke="#ffc300" stroke-width="1.6" stroke-dasharray="3 2"/>
      <polyline points="${atlPts.join(' ')}" fill="none" stroke="#ff453a" stroke-width="1.8"/>
      <polyline points="${ctlPts.join(' ')}" fill="none" stroke="#3a86ff" stroke-width="2.3"/>
      <text x="${padL}" y="${H - 6}" font-size="8" fill="var(--t3)">${fmtShortDate(history[0].date)}</text>
      <text x="${W - padR}" y="${H - 6}" text-anchor="end" font-size="8" fill="var(--t3)">Oggi</text>
    </svg>`;
}

/**
 * Renderizza la Card "Coach Predittivo" (semaforo, sintesi <=80 parole, max 3 correzioni, focus, domanda libera).
 */
export function renderCoachCardHTML(coachReport, { isDemo = false, isLoading = false } = {}) {
  const rep = coachReport || {
    status: 'on_track',
    headline: 'Analisi in corso…',
    summary: 'Calcolo dei modelli predittivi in corso.',
    corrections: [],
    focusNextWeek: 'Continua a registrare peso e pasti.',
    motivationalNote: ''
  };

  const statusMeta = {
    on_track:  { icon: '🟢', label: 'IN LINEA (ON TRACK)', col: '#30d158', bg: 'rgba(48,209,88,0.12)' },
    attention: { icon: '🟡', label: 'ATTENZIONE',          col: '#ffc300', bg: 'rgba(255,195,0,0.12)' },
    off_track: { icon: '🔴', label: 'FUORI ROTTA / AZIONE', col: '#ff453a', bg: 'rgba(255,69,58,0.12)' }
  }[rep.status] || { icon: '🟢', label: 'IN LINEA', col: '#30d158', bg: 'rgba(48,209,88,0.12)' };

  const areaBadges = {
    diet:     { icon: '🥗', label: 'DIETA',    col: '#30d158' },
    training: { icon: '🏋️', label: 'ALLENAMENTO', col: '#3a86ff' },
    recovery: { icon: '😴', label: 'RECUPERO', col: '#ffc300' }
  };

  const correctionsHtml = (rep.corrections || []).slice(0, 3).map(c => {
    const ab = areaBadges[c.area] || areaBadges.diet;
    return `
      <div style="background:rgba(255,255,255,0.03);border-left:3px solid ${ab.col};border-radius:8px;padding:10px 12px;margin-bottom:8px">
        <div style="font-size:10px;font-weight:800;color:${ab.col};letter-spacing:0.6px;margin-bottom:3px">${ab.icon} ${ab.label}</div>
        <div style="font-size:13px;font-weight:700;color:var(--t1);line-height:1.35">${esc(c.action)}</div>
        <div style="font-size:11px;color:var(--t2);margin-top:3px;line-height:1.35">${esc(c.why)}</div>
      </div>`;
  }).join('');

  const srcBadge = rep.source === 'gemini_flash'
    ? `<span style="font-size:9px;background:rgba(124,111,255,0.18);color:var(--accent);padding:2px 7px;border-radius:10px;font-weight:700">🤖 Gemini Flash</span>`
    : `<span style="font-size:9px;background:rgba(255,255,255,0.08);color:var(--t2);padding:2px 7px;border-radius:10px;font-weight:700">⚙️ Motore Deterministico</span>`;

  return `
    <div class="card" style="margin-bottom:16px;border:1px solid ${statusMeta.col}40;background:linear-gradient(145deg,rgba(255,255,255,0.03),rgba(0,0,0,0.2))">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:11px;font-weight:800;padding:3px 9px;border-radius:12px;background:${statusMeta.bg};color:${statusMeta.col};border:1px solid ${statusMeta.col}50">
            ${statusMeta.icon} ${statusMeta.label}
          </span>
          ${isDemo ? `<span style="font-size:9px;background:rgba(255,107,53,0.2);color:#ff6b35;padding:2px 7px;border-radius:10px;font-weight:800">DEMO 90GG</span>` : ''}
        </div>
        ${srcBadge}
      </div>

      <div style="font-size:16px;font-weight:800;color:var(--t1);line-height:1.3;margin-bottom:6px">
        ${esc(rep.headline)}
      </div>
      <div style="font-size:12.5px;color:var(--t2);line-height:1.5;margin-bottom:12px">
        ${esc(rep.summary)}
      </div>

      ${correctionsHtml ? `<div style="margin-bottom:10px">${correctionsHtml}</div>` : ''}

      <div style="background:rgba(124,111,255,0.08);border:1px solid rgba(124,111,255,0.25);border-radius:10px;padding:9px 12px;margin-bottom:10px">
        <div style="font-size:10px;font-weight:800;color:var(--accent);letter-spacing:0.6px">🎯 FOCUS PROSSIMA SETTIMANA</div>
        <div style="font-size:12px;font-weight:700;color:var(--t1);margin-top:2px">${esc(rep.focusNextWeek)}</div>
      </div>

      ${rep.motivationalNote ? `<div style="font-size:11px;font-style:italic;color:var(--t3);margin-bottom:12px">"${esc(rep.motivationalNote)}"</div>` : ''}

      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <input type="text" id="coach-free-question" class="fi" placeholder="Fai una domanda al Coach (es. Posso alzare i carbo nel weekend?)" style="flex:1;font-size:12px;padding:8px 10px" onkeydown="if(event.key==='Enter')window.askPredictiveCoach()">
        <button class="btn btn-v btn-sm" onclick="window.askPredictiveCoach()" ${isLoading ? 'disabled' : ''} style="white-space:nowrap;padding:8px 12px;font-size:12px;font-weight:700">
          ${isLoading ? '⏳…' : '🤖 Chiedi al Coach'}
        </button>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;padding-top:8px;border-top:1px solid var(--border)">
        <span style="font-size:10px;color:var(--t3)">I numeri sono calcolati dai modelli deterministici; Gemini li interpreta soltanto.</span>
        <button class="btn btn-ghost btn-xs" onclick="window.toggleDemo90Days()" style="font-size:10px;padding:3px 8px">
          ${isDemo ? '🔄 Torna ai Dati Reali' : '🌱 Prova Demo 90gg'}
        </button>
      </div>
    </div>`;
}

/**
 * Renderizza l'intera Dashboard "Andamento" (Modello 1 + Coach + Regole).
 */
export function renderAndamentoDashboardHTML(pipelineResult, coachReport, { isDemo = false, isLoadingCoach = false } = {}) {
  const en = pipelineResult?.energyOutput || {};
  const tr = pipelineResult?.trainingOutput || {};
  const insights = pipelineResult?.insights || [];
  const profile = pipelineResult?.profile || {};

  const coachCard = renderCoachCardHTML(coachReport || pipelineResult?.deterministicCoach, {
    isDemo,
    isLoading: isLoadingCoach
  });

  // Box requisiti dati mancanti + Assistente Guidato & Auto-Compilazione AI
  const allMissing = [
    ...(en.missingDataRequirements || []),
    ...(tr.missingDataRequirements || [])
  ];
  const ma = pipelineResult?.missingAssistant || {
    hasAnyMissing: allMissing.length > 0,
    missingProfileFields: [],
    missingTodayFields: [],
    workoutsMissingRpeCount: 0,
    smartDefaults: {
      sex: profile.sex || 'M',
      height: profile.height || 176,
      dob: profile.dob || '1994-06-15',
      activity_level: profile.activity_level || 'moderate',
      goal_type: profile.goal_type || 'cut',
      weight_target: profile.weight_target || 75,
      target_rate_kg_week: profile.target_rate_kg_week ?? -0.45,
      today_weight_kg: en.rawWeight || en.trendWeight || 78,
      today_sleep_hours: 7.5,
      today_diary_complete: 'yes',
      default_session_rpe: 7.5
    }
  };
  const sd = ma.smartDefaults;

  const missingTags = [
    ...ma.missingProfileFields.map(f => `<span style="font-size:10px;background:rgba(255,195,0,0.16);color:#ffc300;padding:2px 7px;border-radius:8px;font-weight:700">Profilo: ${esc(f)}</span>`),
    ...ma.missingTodayFields.map(f => `<span style="font-size:10px;background:rgba(58,134,255,0.16);color:#3a86ff;padding:2px 7px;border-radius:8px;font-weight:700">Oggi: ${esc(f)}</span>`),
    ...(ma.workoutsMissingRpeCount > 0 ? [`<span style="font-size:10px;background:rgba(124,111,255,0.18);color:var(--accent);padding:2px 7px;border-radius:8px;font-weight:700">${ma.workoutsMissingRpeCount} workout senza RPE/RIR</span>`] : [])
  ].join(' ');

  const missingBannerHtml = (allMissing.length > 0 || ma.hasAnyMissing) && !isDemo ? `
    <div class="card" id="guided-missing-card" style="margin-bottom:14px;background:linear-gradient(145deg,rgba(255,195,0,0.08),rgba(124,111,255,0.06));border:1px solid rgba(255,195,0,0.35)">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
        <div style="font-size:11px;font-weight:800;color:#ffc300;letter-spacing:0.6px">
          🧭 ASSISTENTE DATI MANCANTI &amp; AUTO-COMPILAZIONE AI
        </div>
        <span style="font-size:9px;background:rgba(255,195,0,0.2);color:#ffc300;padding:2px 7px;border-radius:10px;font-weight:800">
          ${en.isPreliminary ? 'MODALITÀ PRIOR ATTIVA' : 'DATI PARZIALI RILEVATI'}
        </span>
      </div>

      <div style="font-size:11.5px;color:var(--t2);line-height:1.45;margin-bottom:8px">
        Alcune informazioni sono parziali: i modelli stanno già funzionando usando stime a priori, ma puoi <b>completarle qui sotto in modo guidato</b> oppure farle <b>compilare direttamente all'AI</b> dal tuo storico:
      </div>

      ${missingTags ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px">${missingTags}</div>` : ''}

      ${allMissing.map(m => `
        <div style="font-size:11px;color:var(--t3);margin-bottom:3px;line-height:1.35">
          • <b>${esc(m.feature)}</b>: ${m.daysNeeded > 0 ? `servono ancora <b>${m.daysNeeded} giorni</b> di` : 'richiede'} <i>${esc(m.missing)}</i>.
        </div>`).join('')}

      <!-- COMPILAZIONE RAPIDA CON AI (TESTO LIBERO O 1-CLICK AUTOMATICO) -->
      <div style="background:rgba(0,0,0,0.25);border:1px solid rgba(124,111,255,0.3);border-radius:10px;padding:10px;margin-top:10px">
        <div style="font-size:10px;font-weight:800;color:var(--accent);letter-spacing:0.5px;margin-bottom:5px">
          🤖 COMPILAZIONE INTELLIGENTE CON GEMINI FLASH
        </div>
        <div style="display:flex;gap:6px;margin-bottom:7px;flex-wrap:wrap">
          <input type="text" id="guided-ai-text" class="fi" placeholder="Es: 'Uomo 178cm nato 1995, obiettivo 74kg, oggi 77.2kg e 7.5h sonno' (o lascia vuoto per stima da storico)" style="flex:1;min-width:190px;font-size:11.5px;padding:7px 9px">
          <button class="btn btn-ghost btn-sm" onclick="window.autoFillMissingWithAI(false)" style="font-size:11px;padding:7px 10px;white-space:nowrap">
            🪄 Compila Campi con AI
          </button>
          <button class="btn btn-v btn-sm" onclick="window.autoFillMissingWithAI(true)" style="font-size:11px;padding:7px 10px;white-space:nowrap;font-weight:800">
            ⚡ Auto-Compila e Salva (AI)
          </button>
        </div>
        <div id="guided-ai-note" style="font-size:10.5px;color:var(--t3)">
          💡 I campi qui sotto sono già pre-compilati con le migliori stime ricavate dal tuo storico (pesate, passi medi e allenamenti).
        </div>
      </div>

      <!-- PROCEDURA GUIDATA INLINE (PASSO 1: PROFILO, PASSO 2: OGGI, PASSO 3: STORICO RPE) -->
      <details open style="margin-top:10px">
        <summary style="cursor:pointer;font-size:11px;font-weight:800;color:var(--t1);padding:4px 0">
          📝 Verifica o modifica i campi guidati passo-passo
        </summary>
        <div style="margin-top:8px;display:grid;grid-template-columns:repeat(2,1fr);gap:8px">
          <div>
            <label style="font-size:10px;color:var(--t3);font-weight:700;display:block;margin-bottom:2px">1. Sesso Biologico (BMR)</label>
            <select id="gm-sex" class="fi" style="font-size:12px;padding:6px 8px;width:100%">
              <option value="M" ${sd.sex === 'M' ? 'selected' : ''}>Uomo (M)</option>
              <option value="F" ${sd.sex === 'F' ? 'selected' : ''}>Donna (F)</option>
            </select>
          </div>
          <div>
            <label style="font-size:10px;color:var(--t3);font-weight:700;display:block;margin-bottom:2px">2. Altezza (cm)</label>
            <input type="number" id="gm-height" class="fi" value="${sd.height}" min="120" max="230" style="font-size:12px;padding:6px 8px;width:100%">
          </div>
          <div>
            <label style="font-size:10px;color:var(--t3);font-weight:700;display:block;margin-bottom:2px">3. Data di Nascita</label>
            <input type="date" id="gm-dob" class="fi" value="${sd.dob}" style="font-size:12px;padding:6px 8px;width:100%">
          </div>
          <div>
            <label style="font-size:10px;color:var(--t3);font-weight:700;display:block;margin-bottom:2px">4. Attività (PAL Prior)</label>
            <select id="gm-activity" class="fi" style="font-size:12px;padding:6px 8px;width:100%">
              <option value="sedentary" ${sd.activity_level === 'sedentary' ? 'selected' : ''}>Sedentario (×1.2)</option>
              <option value="light" ${sd.activity_level === 'light' ? 'selected' : ''}>Leggero (×1.375)</option>
              <option value="moderate" ${sd.activity_level === 'moderate' ? 'selected' : ''}>Moderato (×1.55)</option>
              <option value="active" ${sd.activity_level === 'active' ? 'selected' : ''}>Attivo (×1.725)</option>
              <option value="very_active" ${sd.activity_level === 'very_active' ? 'selected' : ''}>Molto Attivo (×1.9)</option>
            </select>
          </div>
          <div>
            <label style="font-size:10px;color:var(--t3);font-weight:700;display:block;margin-bottom:2px">5. Obiettivo</label>
            <select id="gm-goal" class="fi" style="font-size:12px;padding:6px 8px;width:100%">
              <option value="cut" ${sd.goal_type === 'cut' ? 'selected' : ''}>Definizione (Cut)</option>
              <option value="maintain" ${sd.goal_type === 'maintain' ? 'selected' : ''}>Mantenimento</option>
              <option value="bulk" ${sd.goal_type === 'bulk' ? 'selected' : ''}>Massa (Lean Bulk)</option>
            </select>
          </div>
          <div>
            <label style="font-size:10px;color:var(--t3);font-weight:700;display:block;margin-bottom:2px">6. Peso Target (kg)</label>
            <input type="number" step="0.1" id="gm-target-w" class="fi" value="${sd.weight_target}" style="font-size:12px;padding:6px 8px;width:100%">
          </div>
          <div>
            <label style="font-size:10px;color:var(--t3);font-weight:700;display:block;margin-bottom:2px">7. Ritmo Target (kg/sett)</label>
            <input type="number" step="0.05" id="gm-rate" class="fi" value="${sd.target_rate_kg_week}" style="font-size:12px;padding:6px 8px;width:100%">
          </div>
          <div>
            <label style="font-size:10px;color:var(--t3);font-weight:700;display:block;margin-bottom:2px">8. Peso di Oggi (kg)</label>
            <input type="number" step="0.1" id="gm-today-w" class="fi" value="${sd.today_weight_kg}" style="font-size:12px;padding:6px 8px;width:100%">
          </div>
          <div>
            <label style="font-size:10px;color:var(--t3);font-weight:700;display:block;margin-bottom:2px">9. Ore Sonno Oggi</label>
            <input type="number" step="0.5" id="gm-today-sleep" class="fi" value="${sd.today_sleep_hours}" style="font-size:12px;padding:6px 8px;width:100%">
          </div>
          <div>
            <label style="font-size:10px;color:var(--t3);font-weight:700;display:block;margin-bottom:2px">10. Diario Oggi Completo?</label>
            <select id="gm-today-complete" class="fi" style="font-size:12px;padding:6px 8px;width:100%">
              <option value="yes" ${sd.today_diary_complete === 'yes' ? 'selected' : ''}>✅ Sì, registrato tutto</option>
              <option value="partial" ${sd.today_diary_complete === 'partial' ? 'selected' : ''}>⚠️ Parziale (usa media)</option>
              <option value="no" ${sd.today_diary_complete === 'no' ? 'selected' : ''}>❌ Non registrato</option>
            </select>
          </div>
        </div>

        <div style="margin-top:8px;display:flex;align-items:center;gap:8px;background:rgba(255,255,255,0.03);padding:7px 10px;border-radius:8px">
          <input type="checkbox" id="gm-backfill-rpe" checked style="width:15px;height:15px;accent-color:var(--accent)">
          <label for="gm-backfill-rpe" style="font-size:11px;color:var(--t2);cursor:pointer;flex:1">
            Stima e compila automaticamente <b>Session RPE (~${sd.default_session_rpe}) e RIR</b> negli allenamenti passati con info parziali (${ma.workoutsMissingRpeCount} sessioni rilevate)
          </label>
        </div>

        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-g btn-sm" onclick="window.saveGuidedMissingForm()" style="flex:1;font-weight:800;padding:9px">
            💾 Salva Dati e Ricalibra Modelli
          </button>
        </div>
      </details>
    </div>` : '';

  const rateSign = (en.weeklyRateKg || 0) > 0 ? '+' : '';
  const pctSign = (en.weeklyRatePct || 0) > 0 ? '+' : '';
  const confCol = en.confidence >= 70 ? '#30d158' : en.confidence >= 45 ? '#ffc300' : '#ff6b35';

  const forecastRows = (en.forecast || []).map(f => `
    <div style="flex:1;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:10px;padding:8px;text-align:center">
      <div style="font-size:10px;color:var(--t3);font-weight:700">Tra ${f.horizonWeeks} sett.</div>
      <div style="font-size:15px;font-weight:800;color:var(--t1);margin:2px 0">${f.weight} kg</div>
      <div style="font-size:9px;color:var(--t3)">CI: ${f.low}–${f.high}</div>
    </div>`).join('');

  const recMacros = en.recommendedMacros || { protein: 160, carbs: 200, fats: 60, proteinPerKg: 2.0 };

  return `
    ${coachCard}
    ${missingBannerHtml}

    <!-- KPI PESO & TDEE -->
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-size:11px;font-weight:800;color:var(--t2);letter-spacing:0.8px">⚖️ BILANCIO ENERGETICO ADATTIVO (KALMAN 2 STATI)</span>
        <span style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:10px;background:${confCol}20;color:${confCol}">
          Affidabilità ${en.confidence || 0}/100 ${en.isPreliminary ? '· Preliminare' : ''}
        </span>
      </div>

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
        <div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--t3);font-weight:700">PESO TREND</div>
          <div style="font-size:18px;font-weight:900;color:#ff6b35;margin-top:2px">${en.trendWeight ?? '—'} <span style="font-size:11px">kg</span></div>
          <div style="font-size:10px;color:var(--t2)">Bilancia: ${en.rawWeight != null ? en.rawWeight + ' kg' : '—'}</div>
        </div>
        <div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--t3);font-weight:700">TDEE REALE</div>
          <div style="font-size:18px;font-weight:900;color:#3a86ff;margin-top:2px">${en.tdeeEstimate ?? '—'} <span style="font-size:11px">kcal</span></div>
          <div style="font-size:9px;color:var(--t3)">CI 95%: ${en.tdeeCI ? `${en.tdeeCI[0]}–${en.tdeeCI[1]}` : '—'}</div>
        </div>
        <div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--t3);font-weight:700">RITMO 7GG</div>
          <div style="font-size:17px;font-weight:900;color:var(--t1);margin-top:2px">${rateSign}${en.weeklyRateKg ?? 0} <span style="font-size:11px">kg/s</span></div>
          <div style="font-size:10px;color:var(--t2)">(${pctSign}${en.weeklyRatePct ?? 0}%/sett)</div>
        </div>
      </div>

      <!-- GRAFICO PESO + PREVISIONE HALL 4/8/12 SETTIMANE -->
      <div style="font-size:11px;font-weight:700;color:var(--t2);margin-bottom:4px;display:flex;justify-content:space-between">
        <span>📈 Peso Grezzo vs Trend &amp; Previsione (Hall Lancet 2011)</span>
        ${en.etaGoalDate ? `<span style="color:#30d158">🏁 ETA Target: ${fmtShortDate(en.etaGoalDate)} (${en.daysToGoal}gg)</span>` : ''}
      </div>
      ${renderWeightForecastSVG(en, profile.weight_target)}

      <div style="display:flex;gap:8px;margin-top:10px">
        ${forecastRows}
      </div>
    </div>

    <!-- GRAFICO TDEE NEL TEMPO & CONFRONTO KCAL/MACRO -->
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:11px;font-weight:800;color:var(--t2);letter-spacing:0.8px">🔥 TDEE ADATTIVO &amp; RACCOMANDAZIONE NUTRIZIONALE</span>
        <span style="font-size:10px;color:var(--t3)">BMR: ${en.bmrEstimate || '—'} kcal · Prior: ${en.priorTdee || '—'} kcal</span>
      </div>

      ${renderTdeeHistorySVG(en)}
      <div style="font-size:10px;color:var(--t3);margin:4px 0 12px;display:flex;justify-content:space-between">
        <span>Linea blu: TDEE Kalman ± 1σ · Punti verdi: Intake giornaliero</span>
        <span>Aderenza 14gg: <b>${en.adherence14Pct ?? 0}%</b></span>
      </div>

      <div style="background:rgba(0,0,0,0.22);border:1px solid var(--border);border-radius:12px;padding:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div>
            <div style="font-size:10px;color:var(--t3);font-weight:700">INTAKE MEDIO 7GG vs RACCOMANDATO</div>
            <div style="font-size:16px;font-weight:800;color:var(--t1);margin-top:2px">
              ${en.avgIntake7d != null ? `${en.avgIntake7d} kcal` : 'N/D'}
              <span style="font-size:12px;color:var(--t3)">→ Target consigliato:</span>
              <span style="color:var(--accent)">${en.recommendedKcal} kcal</span>
            </div>
          </div>
          <div style="text-align:right">
            <div style="font-size:10px;color:var(--t3)">Bilancio 7gg</div>
            <div style="font-size:14px;font-weight:800;color:${(en.energyBalance7d || 0) <= 0 ? '#30d158' : '#ff6b35'}">
              ${en.energyBalance7d != null ? `${en.energyBalance7d > 0 ? '+' : ''}${en.energyBalance7d} kcal/gg` : '—'}
            </div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding-top:8px;border-top:1px solid var(--border);text-align:center">
          <div>
            <div style="font-size:10px;color:var(--t3)">Proteine (${recMacros.proteinPerKg}g/kg)</div>
            <div style="font-size:14px;font-weight:800;color:#30d158">${recMacros.protein}g</div>
          </div>
          <div>
            <div style="font-size:10px;color:var(--t3)">Carboidrati</div>
            <div style="font-size:14px;font-weight:800;color:#3a86ff">${recMacros.carbs}g</div>
          </div>
          <div>
            <div style="font-size:10px;color:var(--t3)">Grassi</div>
            <div style="font-size:14px;font-weight:800;color:#ffc300">${recMacros.fats}g</div>
          </div>
        </div>
      </div>
    </div>

    <!-- INSIGHT DEL MOTORE DI REGOLE INCROCIATE -->
    ${insights.length > 0 ? `
    <div class="card" style="margin-bottom:14px">
      <div style="font-size:11px;font-weight:800;color:var(--t2);letter-spacing:0.8px;margin-bottom:10px">
        ⚡ INSIGHT REGOLE INCROCIATE (${insights.length})
      </div>
      ${insights.map(ins => {
        const col = ins.severity === 'high' ? '#ff453a' : ins.severity === 'medium' ? '#ffc300' : '#3a86ff';
        return `
          <div style="background:rgba(255,255,255,0.025);border-left:3px solid ${col};border-radius:8px;padding:10px 12px;margin-bottom:8px">
            <div style="font-size:12px;font-weight:700;color:var(--t1)">${esc(ins.message)}</div>
            <div style="font-size:11.5px;color:var(--accent);margin-top:4px;font-weight:600">➡️ ${esc(ins.action)}</div>
          </div>`;
      }).join('')}
    </div>` : ''}
  `;
}

/**
 * Renderizza la Dashboard "Allenamento & Forza" (Modello 2: Banister PMC, ACWR EWMA, e1RM Epley + Theil-Sen, Volume Muscolare).
 */
export function renderAllenamentoDashboardHTML(pipelineResult) {
  const tr = pipelineResult?.trainingOutput || {};
  const lifts = tr.lifts || [];
  const setsByMuscle = tr.weeklySetsByMuscle || {};

  const acwrVal = tr.acwr;
  const acwrCol = acwrVal == null ? 'var(--t3)'
    : acwrVal < 0.8 ? '#3a86ff'
    : acwrVal <= 1.3 ? '#30d158'
    : acwrVal <= 1.5 ? '#ffc300'
    : '#ff453a';
  const acwrLabel = acwrVal == null ? 'Dati insufficienti'
    : acwrVal < 0.8 ? 'Sottocarico / Scarico (<0.8)'
    : acwrVal <= 1.3 ? 'Sweet Spot Ottimale (0.8–1.3)'
    : acwrVal <= 1.5 ? 'Zona Cautela (1.3–1.5)'
    : 'Attenzione Sovraccarico (>1.5)';

  const deloadBanner = tr.deloadSuggested ? `
    <div class="card" style="margin-bottom:14px;background:rgba(255,69,58,0.12);border:1px solid #ff453a">
      <div style="font-size:12px;font-weight:800;color:#ff453a;margin-bottom:4px">🛑 SCARICO (DELOAD) CONSIGLIATO DAL MODELLO</div>
      <div style="font-size:12px;color:var(--t1);line-height:1.4">
        Rilevata fatica acuta elevata (TSB ${tr.tsb}, ACWR ${tr.acwr ?? '—'}) associata a stallo/calo dell'e1RM. Riduci le serie del 30–40% e mantieni RIR ≥ 3 per 5–7 giorni.
      </div>
    </div>` : '';

  const muscleEntries = Object.entries(setsByMuscle).sort((a, b) => b[1] - a[1]);
  const muscleBarsHtml = muscleEntries.length > 0 ? muscleEntries.map(([mKey, sets]) => {
    const label = MUSCLE_LABELS_IT[mKey] || mKey;
    const pct = Math.min(100, Math.round((sets / 22) * 100));
    const col = sets < 8 ? '#3a86ff' : sets <= 20 ? '#30d158' : '#ffc300';
    return `
      <div style="margin-bottom:9px">
        <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;margin-bottom:3px">
          <span>${esc(label)}</span>
          <span style="color:${col}">${sets} serie <span style="font-size:10px;color:var(--t3)">(target 10–20)</span></span>
        </div>
        <div style="height:6px;background:rgba(255,255,255,0.07);border-radius:4px;overflow:hidden;position:relative">
          <div style="height:100%;width:${pct}%;background:${col};border-radius:4px"></div>
        </div>
      </div>`;
  }).join('') : `<div style="font-size:12px;color:var(--t3);padding:8px 0">Completa almeno un allenamento negli ultimi 7 giorni per calcolare il volume per gruppo muscolare.</div>`;

  const liftsHtml = lifts.length > 0 ? lifts.slice(0, 10).map(l => {
    const stMeta = {
      progress: { label: '📈 In crescita', col: '#30d158', bg: 'rgba(48,209,88,0.14)' },
      plateau:  { label: '⏸️ Plateau',     col: '#ffc300', bg: 'rgba(255,195,0,0.14)' },
      regress:  { label: '📉 In calo',     col: '#ff453a', bg: 'rgba(255,69,58,0.14)' }
    }[l.status] || { label: 'Stabile', col: 'var(--t2)', bg: 'rgba(255,255,255,0.06)' };
    const slopeSign = l.trendSlopePctWeek > 0 ? '+' : '';

    return `
      <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div style="font-size:13px;font-weight:800;color:var(--t1)">${esc(l.exerciseId)}</div>
          <span style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:10px;background:${stMeta.bg};color:${stMeta.col}">
            ${stMeta.label}
          </span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:11.5px;color:var(--t2)">
          <span>e1RM attuale: <b style="color:var(--t1)">${l.e1rm} kg</b> <span style="font-size:10px;color:var(--t3)">(${l.lastWeight}kg×${l.lastReps}${l.assumedZeroRir ? ', RIR 0 ass.' : ''})</span></span>
          <span>Trend: <b style="color:${stMeta.col}">${slopeSign}${l.trendSlopePctWeek}%/sett</b></span>
        </div>
        <div style="font-size:10.5px;color:var(--t3);margin-top:3px">
          Proiezione e1RM a 4 settimane (Theil-Sen): <b style="color:var(--accent)">${l.forecast4w} kg</b> · ${l.sessionsCount} sessioni
        </div>
      </div>`;
  }).join('') : `<div style="font-size:12px;color:var(--t3);padding:8px 0">Nessun esercizio registrato con peso e ripetizioni.</div>`;

  return `
    ${deloadBanner}

    <!-- PMC BANISTER & ACWR EWMA -->
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-size:11px;font-weight:800;color:var(--t2);letter-spacing:0.8px">⚡ FITNESS-FATIGUE (BANISTER PMC) &amp; READINESS</span>
        <span style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:10px;background:rgba(48,209,88,0.15);color:#30d158">
          Readiness ${tr.readiness ?? 75}/100
        </span>
      </div>

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:12px;text-align:center">
        <div style="background:rgba(58,134,255,0.1);border-radius:8px;padding:8px 4px">
          <div style="font-size:9px;color:#3a86ff;font-weight:800">CTL (42gg)</div>
          <div style="font-size:16px;font-weight:900;color:var(--t1)">${tr.ctl ?? 0}</div>
          <div style="font-size:8px;color:var(--t3)">Fitness</div>
        </div>
        <div style="background:rgba(255,69,58,0.1);border-radius:8px;padding:8px 4px">
          <div style="font-size:9px;color:#ff453a;font-weight:800">ATL (7gg)</div>
          <div style="font-size:16px;font-weight:900;color:var(--t1)">${tr.atl ?? 0}</div>
          <div style="font-size:8px;color:var(--t3)">Fatica</div>
        </div>
        <div style="background:rgba(255,195,0,0.1);border-radius:8px;padding:8px 4px">
          <div style="font-size:9px;color:#ffc300;font-weight:800">TSB</div>
          <div style="font-size:16px;font-weight:900;color:var(--t1)">${(tr.tsb || 0) > 0 ? '+' : ''}${tr.tsb ?? 0}</div>
          <div style="font-size:8px;color:var(--t3)">Forma</div>
        </div>
        <div style="background:rgba(124,111,255,0.1);border-radius:8px;padding:8px 4px">
          <div style="font-size:9px;color:var(--accent);font-weight:800">PERF IDX</div>
          <div style="font-size:16px;font-weight:900;color:var(--t1)">${tr.predictedPerformance ?? 100}</div>
          <div style="font-size:8px;color:var(--t3)">${tr.banisterParams?.calibrated ? 'Calibrato' : 'Prior'}</div>
        </div>
      </div>

      ${renderBanisterPmcSVG(tr)}
      <div style="font-size:10px;color:var(--t3);margin:4px 0 12px;display:flex;justify-content:space-between">
        <span><b style="color:#3a86ff">━ CTL</b> Fitness · <b style="color:#ff453a">━ ATL</b> Fatica · <b style="color:#ffc300">┄ TSB</b> Forma</span>
        <span>Sessioni: ${tr.totalCompletedSessions || 0}</span>
      </div>

      <!-- ACWR EWMA 7/28 (Williams et al. 2017) -->
      <div style="background:rgba(0,0,0,0.22);border:1px solid var(--border);border-radius:10px;padding:10px 12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span style="font-size:11px;font-weight:800;color:var(--t1)">ACWR (EWMA 7/28gg): <span style="color:${acwrCol}">${acwrVal ?? 'N/D'}</span></span>
          <span style="font-size:10px;font-weight:700;color:${acwrCol}">${acwrLabel}</span>
        </div>
        <div style="font-size:10px;color:var(--t3);line-height:1.35">
          ℹ️ <i>Nota metodologica (Williams et al. 2017; Impellizzeri et al. 2020)</i>: l'ACWR è un indicatore descrittivo discusso della variazione di carico, non uno strumento diagnostico di infortunio.
        </div>
      </div>
    </div>

    <!-- PROGRESSIONE FORZA e1RM (EPLEY + RIR & THEIL-SEN) -->
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-size:11px;font-weight:800;color:var(--t2);letter-spacing:0.8px">🏋️ PROGRESSIONE e1RM (EPLEY + RIR · THEIL-SEN)</span>
        <span style="font-size:10px;color:var(--t3)">Previsione a 4 sett.</span>
      </div>
      ${liftsHtml}
    </div>

    <!-- VOLUME SETTIMANALE PER GRUPPO MUSCOLARE (SCHOENFELD 2017) -->
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-size:11px;font-weight:800;color:var(--t2);letter-spacing:0.8px">💪 SERIE IMPEGNATIVE SETTIMANALI PER MUSCOLO</span>
        <span style="font-size:10px;color:var(--t3)">Primario=1 · Secondario=0.5</span>
      </div>
      ${muscleBarsHtml}
    </div>
  `;
}
