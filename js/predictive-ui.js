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
      <text x="${padL - 5}" y="${Number(yZero) + 3}" text-anchor="end" font-size="8.5" fill="var(--t2)">0</text>
      <text x="${padL - 5}" y="${padT + 6}" text-anchor="end" font-size="8.5" fill="var(--t3)">${maxV}</text>
      <text x="${padL - 5}" y="${H - padB}" text-anchor="end" font-size="8.5" fill="var(--t3)">${minV}</text>
      <polyline points="${tsbPts.join(' ')}" fill="none" stroke="#ffc300" stroke-width="1.6" stroke-dasharray="3 2"/>
      <polyline points="${atlPts.join(' ')}" fill="none" stroke="#ff453a" stroke-width="1.9"/>
      <polyline points="${ctlPts.join(' ')}" fill="none" stroke="#3a86ff" stroke-width="2.4"/>
      <text x="${padL}" y="${H - 6}" font-size="9" fill="var(--t3)">${fmtShortDate(history[0].date)}</text>
      <text x="${W - padR}" y="${H - 6}" text-anchor="end" font-size="9" font-weight="700" fill="var(--t1)">Oggi</text>
    </svg>`;
}

/**
 * Card "Il Punto del Coach" — chiara, diretta, senza duplicazioni.
 */
export function renderCoachCardHTML(coachReport, { isDemo = false, isLoading = false } = {}) {
  const rep = coachReport || {
    status: 'on_track',
    headline: 'Analisi in corso…',
    summary: 'Sto analizzando il tuo peso e le tue calorie.',
    corrections: [],
    focusNextWeek: 'Continua a registrare peso e pasti con costanza.',
    motivationalNote: ''
  };

  const statusMeta = {
    on_track:  { icon: '🟢', label: 'TUTTO IN LINEA',       col: '#30d158', bg: 'rgba(48,209,88,0.12)' },
    attention: { icon: '🟡', label: 'DA MONITORARE',        col: '#ffc300', bg: 'rgba(255,195,0,0.12)' },
    off_track: { icon: '🔴', label: 'CORREZIONE CONSIGLIATA', col: '#ff453a', bg: 'rgba(255,69,58,0.12)' }
  }[rep.status] || { icon: '🟢', label: 'IN LINEA', col: '#30d158', bg: 'rgba(48,209,88,0.12)' };

  const areaBadges = {
    diet:     { icon: '🥗', label: 'Alimentazione', col: '#30d158' },
    training: { icon: '🏋️', label: 'Allenamento',   col: '#3a86ff' },
    recovery: { icon: '😴', label: 'Recupero',      col: '#ffc300' }
  };

  const correctionsHtml = (rep.corrections || []).slice(0, 3).map(c => {
    const ab = areaBadges[c.area] || areaBadges.diet;
    return `
      <div style="background:rgba(255,255,255,0.035);border-left:3px solid ${ab.col};border-radius:10px;padding:10px 12px;margin-bottom:8px">
        <div style="font-size:10px;font-weight:800;color:${ab.col};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px">${ab.icon} ${ab.label}</div>
        <div style="font-size:13px;font-weight:700;color:var(--t1);line-height:1.35">${esc(c.action)}</div>
        <div style="font-size:11.5px;color:var(--t2);margin-top:3px;line-height:1.4">${esc(c.why)}</div>
      </div>`;
  }).join('');

  return `
    <div class="card" style="margin-bottom:14px;border:1px solid ${statusMeta.col}40">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:11px;font-weight:800;padding:4px 10px;border-radius:12px;background:${statusMeta.bg};color:${statusMeta.col}">
            ${statusMeta.icon} ${statusMeta.label}
          </span>
          ${isDemo ? `<span style="font-size:10px;background:rgba(255,107,53,0.2);color:#ff6b35;padding:3px 8px;border-radius:10px;font-weight:800">ESEMPIO 90 GIORNI</span>` : ''}
        </div>
        <button class="btn btn-ghost btn-xs" onclick="window.toggleDemo90Days()" style="font-size:10.5px;padding:4px 9px">
          ${isDemo ? '🔄 Torna ai tuoi dati' : '🌱 Vedi esempio con 90gg'}
        </button>
      </div>

      <div style="font-size:16px;font-weight:800;color:var(--t1);line-height:1.3;margin-bottom:6px">
        ${esc(rep.headline)}
      </div>
      <div style="font-size:13px;color:var(--t2);line-height:1.5;margin-bottom:12px">
        ${esc(rep.summary)}
      </div>

      ${correctionsHtml ? `<div style="margin-bottom:10px">${correctionsHtml}</div>` : ''}

      <div style="background:rgba(124,111,255,0.08);border:1px solid rgba(124,111,255,0.22);border-radius:10px;padding:10px 12px;margin-bottom:10px">
        <div style="font-size:10px;font-weight:800;color:var(--accent);letter-spacing:0.5px">🎯 SU COSA CONCENTRARTI QUESTA SETTIMANA</div>
        <div style="font-size:12.5px;font-weight:700;color:var(--t1);margin-top:3px">${esc(rep.focusNextWeek)}</div>
      </div>

      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <input type="text" id="coach-free-question" class="fi" placeholder="Fai una domanda al Coach (es. Posso mangiare una pizza sabato?)" style="flex:1;font-size:12px;padding:9px 11px" onkeydown="if(event.key==='Enter')window.askPredictiveCoach()">
        <button class="btn btn-v btn-sm" onclick="window.askPredictiveCoach()" ${isLoading ? 'disabled' : ''} style="white-space:nowrap;padding:9px 13px;font-size:12px;font-weight:700">
          ${isLoading ? '⏳…' : 'Chiedi'}
        </button>
      </div>
    </div>`;
}

/**
 * Dashboard 1: "Andamento" (Peso Reale, Metabolismo & Obiettivo) — ordinata, spiegata in modo semplice e attenta ai bias.
 */
export function renderAndamentoDashboardHTML(pipelineResult, coachReport, { isDemo = false, isLoadingCoach = false } = {}) {
  const en = pipelineResult?.energyOutput || {};
  const profile = pipelineResult?.profile || {};
  const ma = pipelineResult?.missingAssistant || {
    hasAnyMissing: false,
    missingProfileFields: [],
    missingTodayFields: [],
    workoutsMissingRpeCount: 0,
    smartDefaults: {},
    biasChecks: []
  };
  const sd = ma.smartDefaults || {};

  // 1. Card Coach (unificata con gli insight, niente doppioni)
  const coachCard = renderCoachCardHTML(coachReport || pipelineResult?.deterministicCoach, {
    isDemo,
    isLoading: isLoadingCoach
  });

  // 2. Banner compatto per completare i dati mancanti (chiuso di default così non invade lo schermo!)
  const missingList = [...(ma.missingProfileFields || []), ...(ma.missingTodayFields || [])];
  const missingBannerHtml = (ma.hasAnyMissing && !isDemo) ? `
    <div class="card" id="guided-missing-card" style="margin-bottom:14px;background:rgba(255,195,0,0.06);border:1px solid rgba(255,195,0,0.3)">
      <details>
        <summary style="cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:10px">
          <div>
            <div style="font-size:12px;font-weight:800;color:#ffc300">
              ✨ Personalizza il modello (${missingList.length} ${missingList.length === 1 ? 'dato mancante' : 'dati mancanti'})
            </div>
            <div style="font-size:11.5px;color:var(--t2);margin-top:2px">
              Manca: <b>${esc(missingList.slice(0, 3).join(', '))}${missingList.length > 3 ? '…' : ''}</b>. Tocca qui per completare (anche con AI).
            </div>
          </div>
          <span style="font-size:11px;font-weight:800;color:var(--accent);background:rgba(124,111,255,0.15);padding:5px 10px;border-radius:8px;white-space:nowrap">
            Compila ↓
          </span>
        </summary>

        <div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08)">
          <div style="font-size:11.5px;color:var(--t2);line-height:1.45;margin-bottom:10px">
            <b>Perché ti chiediamo questi dati (Controllo Bias):</b> senza la tua altezza, età e sesso reali, il calcolo del metabolismo parte da una media generica. Inseriscili una sola volta (o scrivi qui sotto) senza usare valori inventati.
          </div>

          <!-- Input rapido in linguaggio naturale -->
          <div style="background:rgba(0,0,0,0.25);border:1px solid rgba(124,111,255,0.28);border-radius:10px;padding:10px;margin-bottom:12px">
            <div style="font-size:10.5px;font-weight:800;color:var(--accent);margin-bottom:6px">
              🤖 SCRIVI IN UNA FRASE E LASCIA COMPILARE ALL'AI
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <input type="text" id="guided-ai-text" class="fi" placeholder="Es: Uomo, 178cm, nato 1995-05-10, obiettivo 74kg, oggi peso 77.2kg" style="flex:1;min-width:180px;font-size:12px;padding:8px 10px">
              <button class="btn btn-v btn-sm" onclick="window.autoFillMissingWithAI(false)" style="font-size:11.5px;padding:8px 12px;white-space:nowrap">
                🪄 Estrai con AI
              </button>
            </div>
            <div id="guided-ai-note" style="font-size:10.5px;color:var(--t3);margin-top:5px">
              L'AI estrae solo ciò che scrivi davvero, senza inventare numeri a caso.
            </div>
          </div>

          <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">
            <div>
              <label style="font-size:10.5px;color:var(--t2);font-weight:700;display:block;margin-bottom:3px">Sesso biologico</label>
              <select id="gm-sex" class="fi" style="font-size:12px;padding:7px 8px;width:100%">
                <option value="" ${!sd.sex ? 'selected' : ''}>— Seleziona —</option>
                <option value="M" ${sd.sex === 'M' ? 'selected' : ''}>Uomo</option>
                <option value="F" ${sd.sex === 'F' ? 'selected' : ''}>Donna</option>
              </select>
            </div>
            <div>
              <label style="font-size:10.5px;color:var(--t2);font-weight:700;display:block;margin-bottom:3px">Altezza (cm)</label>
              <input type="number" id="gm-height" class="fi" value="${sd.height ?? ''}" placeholder="Es. 178" min="120" max="230" style="font-size:12px;padding:7px 8px;width:100%">
            </div>
            <div>
              <label style="font-size:10.5px;color:var(--t2);font-weight:700;display:block;margin-bottom:3px">Data di nascita</label>
              <input type="date" id="gm-dob" class="fi" value="${sd.dob ?? ''}" style="font-size:12px;padding:7px 8px;width:100%">
            </div>
            <div>
              <label style="font-size:10.5px;color:var(--t2);font-weight:700;display:block;margin-bottom:3px">Stile di vita</label>
              <select id="gm-activity" class="fi" style="font-size:12px;padding:7px 8px;width:100%">
                <option value="sedentary" ${sd.activity_level === 'sedentary' ? 'selected' : ''}>Sedentario (ufficio)</option>
                <option value="light" ${sd.activity_level === 'light' ? 'selected' : ''}>Leggermente attivo</option>
                <option value="moderate" ${sd.activity_level === 'moderate' ? 'selected' : ''}>Moderato (3–4 allen./sett)</option>
                <option value="active" ${sd.activity_level === 'active' ? 'selected' : ''}>Molto attivo (>10k passi)</option>
              </select>
            </div>
            <div>
              <label style="font-size:10.5px;color:var(--t2);font-weight:700;display:block;margin-bottom:3px">Obiettivo</label>
              <select id="gm-goal" class="fi" style="font-size:12px;padding:7px 8px;width:100%">
                <option value="cut" ${sd.goal_type === 'cut' ? 'selected' : ''}>Dimagrimento (Definizione)</option>
                <option value="maintain" ${sd.goal_type === 'maintain' ? 'selected' : ''}>Mantenimento</option>
                <option value="bulk" ${sd.goal_type === 'bulk' ? 'selected' : ''}>Aumento Massa (Lean Bulk)</option>
              </select>
            </div>
            <div>
              <label style="font-size:10.5px;color:var(--t2);font-weight:700;display:block;margin-bottom:3px">Peso Obiettivo (kg)</label>
              <input type="number" step="0.1" id="gm-target-w" class="fi" value="${sd.weight_target ?? ''}" placeholder="Es. 74.0" style="font-size:12px;padding:7px 8px;width:100%">
            </div>
            <div>
              <label style="font-size:10.5px;color:var(--t2);font-weight:700;display:block;margin-bottom:3px">Peso di Oggi (kg)</label>
              <input type="number" step="0.1" id="gm-today-w" class="fi" value="${sd.today_weight_kg ?? ''}" placeholder="Es. 77.5" style="font-size:12px;padding:7px 8px;width:100%">
            </div>
            <div>
              <label style="font-size:10.5px;color:var(--t2);font-weight:700;display:block;margin-bottom:3px">Diario pasti di oggi</label>
              <select id="gm-today-complete" class="fi" style="font-size:12px;padding:7px 8px;width:100%">
                <option value="yes" ${sd.today_diary_complete === 'yes' ? 'selected' : ''}>✅ Completo (tutti i pasti)</option>
                <option value="partial" ${sd.today_diary_complete === 'partial' ? 'selected' : ''}>⚠️ Parziale (manca qualcosa)</option>
                <option value="no" ${sd.today_diary_complete === 'no' ? 'selected' : ''}>❌ Non registrato</option>
              </select>
            </div>
          </div>

          <input type="hidden" id="gm-rate" value="${sd.target_rate_kg_week ?? -0.45}">
          <input type="hidden" id="gm-today-sleep" value="${sd.today_sleep_hours ?? ''}">

          ${ma.workoutsMissingRpeCount > 0 ? `
          <div style="margin-top:10px;display:flex;align-items:flex-start;gap:8px;background:rgba(255,255,255,0.03);padding:8px 10px;border-radius:8px">
            <input type="checkbox" id="gm-backfill-rpe" style="width:15px;height:15px;margin-top:2px;accent-color:var(--accent)">
            <label for="gm-backfill-rpe" style="font-size:11px;color:var(--t2);cursor:pointer;line-height:1.35">
              <b>Opzionale (${ma.workoutsMissingRpeCount} allenamenti passati senza voto di fatica):</b> assegna uno sforzo medio (RPE 7.5) alle sessioni passate. <i>Lascia deselezionato se vuoi evitare stime uniformi sullo storico.</i>
            </label>
          </div>` : ''}

          <button class="btn btn-g btn-sm" onclick="window.saveGuidedMissingForm()" style="width:100%;margin-top:10px;font-weight:800;padding:10px">
            💾 Salva i tuoi dati reali
          </button>
        </div>
      </details>
    </div>` : '';

  const rateSign = (en.weeklyRateKg || 0) > 0 ? '+' : '';
  const confCol = en.confidence >= 70 ? '#30d158' : en.confidence >= 45 ? '#ffc300' : '#ff6b35';
  const confLabel = en.isPreliminary
    ? 'Stima Iniziale (servono 14gg per calibrazione completa)'
    : en.confidence >= 70 ? 'Calibrato sui tuoi dati reali' : 'In fase di affinamento';

  const forecastRows = (en.forecast || []).map(f => `
    <div style="flex:1;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:10px;padding:9px 6px;text-align:center">
      <div style="font-size:10px;color:var(--t3);font-weight:700">Tra ${f.horizonWeeks} sett.</div>
      <div style="font-size:15px;font-weight:800;color:var(--t1);margin:3px 0">${f.weight} kg</div>
      <div style="font-size:9.5px;color:var(--t3)">tra ${f.low} e ${f.high}</div>
    </div>`).join('');

  const recMacros = en.recommendedMacros || { protein: 160, carbs: 200, fats: 60, proteinPerKg: 2.0 };
  const biasChecks = ma.biasChecks || [];

  return `
    ${coachCard}
    ${missingBannerHtml}

    <!-- CARD UNICA: PESO REALE, METABOLISMO & GRAFICO PREVISIONE -->
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <div>
          <div style="font-size:14px;font-weight:800;color:var(--t1)">⚖️ Il tuo Peso Reale &amp; Metabolismo</div>
          <div style="font-size:11px;color:var(--t3)">Filtra via le oscillazioni d'acqua per mostrarti la vera direzione</div>
        </div>
        <span style="font-size:10px;font-weight:800;padding:3px 9px;border-radius:10px;background:${confCol}18;color:${confCol}">
          ${confLabel}
        </span>
      </div>

      <!-- 3 NUMERI CHIAVE SPIEGATI SEMPLICEMENTE -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px">
        <div style="background:rgba(255,107,53,0.08);border:1px solid rgba(255,107,53,0.25);border-radius:12px;padding:10px 8px;text-align:center">
          <div style="font-size:10px;color:#ff6b35;font-weight:800">PESO REALE</div>
          <div style="font-size:19px;font-weight:900;color:var(--t1);margin:3px 0">${en.trendWeight ?? '—'} <span style="font-size:11px;font-weight:600">kg</span></div>
          <div style="font-size:10px;color:var(--t2)">Bilancia: ${en.rawWeight != null ? en.rawWeight + ' kg' : '—'}</div>
        </div>
        <div style="background:rgba(58,134,255,0.08);border:1px solid rgba(58,134,255,0.25);border-radius:12px;padding:10px 8px;text-align:center">
          <div style="font-size:10px;color:#3a86ff;font-weight:800">CONSUMO (TDEE)</div>
          <div style="font-size:19px;font-weight:900;color:var(--t1);margin:3px 0">${en.tdeeEstimate ?? '—'}</div>
          <div style="font-size:10px;color:var(--t2)">kcal bruciate/giorno</div>
        </div>
        <div style="background:rgba(124,111,255,0.08);border:1px solid rgba(124,111,255,0.25);border-radius:12px;padding:10px 8px;text-align:center">
          <div style="font-size:10px;color:var(--accent);font-weight:800">RITMO ATTUALE</div>
          <div style="font-size:18px;font-weight:900;color:var(--t1);margin:3px 0">${rateSign}${en.weeklyRateKg ?? 0} <span style="font-size:11px;font-weight:600">kg</span></div>
          <div style="font-size:10px;color:var(--t2)">a settimana</div>
        </div>
      </div>

      <!-- LEGENDA IMMEDIATA SOPRA IL GRAFICO -->
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:6px;font-size:10.5px;color:var(--t2)">
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <span>⚪ <b>Pallini:</b> Bilancia</span>
          <span style="color:#ff6b35">━ <b>Linea continua:</b> Peso Reale</span>
          <span style="color:var(--accent)">┄ <b>Tratteggio:</b> Previsione</span>
        </div>
        ${en.etaGoalDate ? `<span style="color:#30d158;font-weight:700">🏁 Traguardo: ~${fmtShortDate(en.etaGoalDate)}</span>` : ''}
      </div>

      ${renderWeightForecastSVG(en, profile.weight_target)}

      <div style="display:flex;gap:8px;margin-top:10px">
        ${forecastRows}
      </div>

      <!-- SPIEGAZIONE SEMPLICE PER CHI NON È ESPERTO -->
      <details style="margin-top:12px;background:rgba(255,255,255,0.025);border:1px solid var(--border);border-radius:10px;padding:10px 12px">
        <summary style="cursor:pointer;font-size:11.5px;font-weight:700;color:var(--t1)">
          📖 Come funziona questo modello e come leggere il grafico? (Spiegazione semplice)
        </summary>
        <div style="margin-top:8px;font-size:12px;color:var(--t2);line-height:1.55">
          <p style="margin:0 0 6px">
            • <b>Perché la bilancia inganna (Pallini grigi):</b> se mangi una pizza, dormi male o ti alleni duramente, il giorno dopo puoi pesare <b>+1 kg</b>. Non è grasso (per mettere 1 kg di grasso servirebbero 7.700 kcal in più!), è solo acqua legata al sale e ai carboidrati.
          </p>
          <p style="margin:0 0 6px">
            • <b>Cosa fa il Peso Reale (Linea arancione):</b> usa un filtro matematico (<i>Filtro di Kalman</i>) che separa l'acqua dal peso vero incrociando quanto hai mangiato con quanto pesi. Guarda <b>solo la linea arancione</b> per capire se stai dimagrendo o crescendo.
          </p>
          <p style="margin:0">
            • <b>Come calcola il tuo Consumo Reale (TDEE):</b> invece di fidarsi di una formula fissa da internet, osserva come cambia il tuo Peso Reale rispetto alle calorie che mangi. Se mangi 2.000 kcal e perdi 0,5 kg a settimana, deduce che il tuo corpo consuma davvero circa 2.500 kcal al giorno.
          </p>
        </div>
      </details>
    </div>

    <!-- CARD CONSIGLIO PRATICO: QUANTE CALORIE E MACRO MANGIARE -->
    <div class="card" style="margin-bottom:14px">
      <div style="font-size:14px;font-weight:800;color:var(--t1);margin-bottom:4px">
        🍽️ Quante Calorie e Macro ti servono adesso
      </div>
      <div style="font-size:11.5px;color:var(--t2);margin-bottom:12px">
        Calcolato sul tuo metabolismo reale per procedere al ritmo sicuro consigliato.
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;background:rgba(124,111,255,0.08);border:1px solid rgba(124,111,255,0.25);border-radius:12px;padding:12px;margin-bottom:10px">
        <div>
          <div style="font-size:10px;color:var(--accent);font-weight:800">TARGET GIORNALIERO CONSIGLIATO</div>
          <div style="font-size:22px;font-weight:900;color:var(--t1);margin-top:2px">${en.recommendedKcal} <span style="font-size:13px;font-weight:600;color:var(--t2)">kcal / giorno</span></div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10px;color:var(--t3)">Tua media ultimi 7gg</div>
          <div style="font-size:15px;font-weight:800;color:var(--t1)">${en.avgIntake7d != null ? `${en.avgIntake7d} kcal` : 'N/D'}</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center">
        <div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:9px 6px">
          <div style="font-size:10px;color:var(--t3);font-weight:700">Proteine</div>
          <div style="font-size:16px;font-weight:800;color:#30d158;margin-top:2px">${recMacros.protein}g</div>
          <div style="font-size:9.5px;color:var(--t3)">${recMacros.proteinPerKg}g per kg</div>
        </div>
        <div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:9px 6px">
          <div style="font-size:10px;color:var(--t3);font-weight:700">Carboidrati</div>
          <div style="font-size:16px;font-weight:800;color:#3a86ff;margin-top:2px">${recMacros.carbs}g</div>
          <div style="font-size:9.5px;color:var(--t3)">Energia allenamento</div>
        </div>
        <div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:9px 6px">
          <div style="font-size:10px;color:var(--t3);font-weight:700">Grassi</div>
          <div style="font-size:16px;font-weight:800;color:#ffc300;margin-top:2px">${recMacros.fats}g</div>
          <div style="font-size:9.5px;color:var(--t3)">Equilibrio ormonale</div>
        </div>
      </div>
    </div>

    <!-- SEZIONE ESPANDIBILE: CONTROLLO BIAS E DETTAGLI TECNICI -->
    <div class="card" style="margin-bottom:14px">
      <details>
        <summary style="cursor:pointer;font-size:12px;font-weight:800;color:var(--t2);display:flex;justify-content:space-between;align-items:center">
          <span>🛡️ Controllo Bias &amp; Dettagli Tecnici (Affidabilità ${en.confidence || 0}/100)</span>
          <span style="font-size:10px;color:var(--accent)">Approfondisci ↓</span>
        </summary>
        <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
          <div style="font-size:11.5px;color:var(--t2);margin-bottom:10px;line-height:1.45">
            Ogni modello matematico può sbagliare se i dati in ingresso contengono <b>distorsioni (bias)</b>. Ecco come KOVA ti protegge e a cosa devi fare attenzione:
          </div>
          ${biasChecks.map(b => {
            const col = b.status === 'warning' ? '#ffc300' : '#30d158';
            const badge = b.status === 'warning' ? '⚠️ Fai attenzione' : '✅ Protetto';
            return `
              <div style="background:rgba(255,255,255,0.025);border-left:3px solid ${col};border-radius:8px;padding:9px 11px;margin-bottom:8px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
                  <span style="font-size:11.5px;font-weight:800;color:var(--t1)">${esc(b.title)}</span>
                  <span style="font-size:9.5px;font-weight:800;color:${col}">${badge}</span>
                </div>
                <div style="font-size:11px;color:var(--t2);line-height:1.4">${esc(b.desc)}</div>
              </div>`;
          }).join('')}

          <div style="margin-top:12px;font-size:11px;font-weight:700;color:var(--t2);margin-bottom:4px">
            Storico Stima Metabolismo (TDEE ± margine d'incertezza)
          </div>
          ${renderTdeeHistorySVG(en)}
          <div style="font-size:10px;color:var(--t3);margin-top:4px;display:flex;justify-content:space-between">
            <span>BMR base: ${en.bmrEstimate || '—'} kcal · Stima iniziale: ${en.priorTdee || '—'} kcal</span>
            <span>Aderenza diario 14gg: <b>${en.adherence14Pct ?? 0}%</b></span>
          </div>
        </div>
      </details>
    </div>
  `;
}

/**
 * Dashboard 2: "Carico & 1RM" — tradotta in linguaggio chiaro, con guida alla lettura e note sui bias.
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
  const acwrLabel = acwrVal == null ? 'Servono più allenamenti'
    : acwrVal < 0.8 ? 'Carico basso / Settimana leggera'
    : acwrVal <= 1.3 ? 'Equilibrio ideale (Costruzione)'
    : acwrVal <= 1.5 ? 'Carico in rapido aumento'
    : 'Attenzione: Aumento troppo brusco';

  const deloadBanner = tr.deloadSuggested ? `
    <div class="card" style="margin-bottom:14px;background:rgba(255,69,58,0.12);border:1px solid #ff453a">
      <div style="font-size:13px;font-weight:800;color:#ff453a;margin-bottom:4px">🛑 Consiglio del Modello: Settimana di Scarico (Deload)</div>
      <div style="font-size:12px;color:var(--t1);line-height:1.45">
        Hai accumulato molta fatica recente rispetto alla tua abitudine e i carichi negli esercizi stanno rallentando. Riduci le serie del 30–40% per 5–7 giorni per supercompensare.
      </div>
    </div>` : '';

  const muscleEntries = Object.entries(setsByMuscle).sort((a, b) => b[1] - a[1]);
  const muscleBarsHtml = muscleEntries.length > 0 ? muscleEntries.map(([mKey, sets]) => {
    const label = MUSCLE_LABELS_IT[mKey] || mKey;
    const pct = Math.min(100, Math.round((sets / 22) * 100));
    const col = sets < 8 ? '#3a86ff' : sets <= 20 ? '#30d158' : '#ffc300';
    const zoneTxt = sets < 8 ? 'Mantenimento' : sets <= 20 ? 'Zona crescita (10–20)' : 'Volume molto alto';
    return `
      <div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;margin-bottom:4px">
          <span>${esc(label)}</span>
          <span style="color:${col}">${sets} serie <span style="font-size:10px;color:var(--t3);font-weight:500">· ${zoneTxt}</span></span>
        </div>
        <div style="height:7px;background:rgba(255,255,255,0.07);border-radius:4px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${col};border-radius:4px"></div>
        </div>
      </div>`;
  }).join('') : `<div style="font-size:12.5px;color:var(--t3);padding:12px 0;text-align:center">Completa almeno un allenamento negli ultimi 7 giorni per vedere le serie per muscolo.</div>`;

  const hasAssumedRir = lifts.some(l => l.assumedZeroRir);

  const liftsHtml = lifts.length > 0 ? lifts.slice(0, 8).map(l => {
    const stMeta = {
      progress: { label: '📈 In aumento', col: '#30d158', bg: 'rgba(48,209,88,0.14)' },
      plateau:  { label: '⏸️ Stabile / Stallo', col: '#ffc300', bg: 'rgba(255,195,0,0.14)' },
      regress:  { label: '📉 In calo',    col: '#ff453a', bg: 'rgba(255,69,58,0.14)' }
    }[l.status] || { label: 'Stabile', col: 'var(--t2)', bg: 'rgba(255,255,255,0.06)' };
    const slopeSign = l.trendSlopePctWeek > 0 ? '+' : '';

    return `
      <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div style="font-size:13px;font-weight:800;color:var(--t1)">${esc(l.exerciseId)}</div>
          <span style="font-size:10px;font-weight:800;padding:3px 8px;border-radius:10px;background:${stMeta.bg};color:${stMeta.col}">
            ${stMeta.label}
          </span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:12px;color:var(--t2)">
          <span>Massimale teorico (1RM): <b style="color:var(--t1)">${l.e1rm} kg</b> <span style="font-size:10.5px;color:var(--t3)">(da ${l.lastWeight}kg × ${l.lastReps})</span></span>
          <span style="font-size:11px;font-weight:700;color:${stMeta.col}">${slopeSign}${l.trendSlopePctWeek}%/sett</span>
        </div>
        <div style="font-size:11px;color:var(--t3);margin-top:3px">
          Stima tra 4 settimane: <b style="color:var(--accent)">${l.forecast4w} kg</b>
        </div>
      </div>`;
  }).join('') : `<div style="font-size:12.5px;color:var(--t3);padding:12px 0;text-align:center">Nessun esercizio registrato con peso e ripetizioni.</div>`;

  return `
    ${deloadBanner}

    <!-- CARD 1: FORMA FISICA vs FATICA RECENTE -->
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <div>
          <div style="font-size:14px;font-weight:800;color:var(--t1)">⚡ Forma Fisica vs Fatica Accumulata</div>
          <div style="font-size:11px;color:var(--t3)">Capisci se ti stai allenando il giusto o se hai bisogno di recuperare</div>
        </div>
        <span style="font-size:10.5px;font-weight:800;padding:3px 9px;border-radius:10px;background:rgba(48,209,88,0.15);color:#30d158">
          Prontezza ${tr.readiness ?? 75}/100
        </span>
      </div>

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;text-align:center">
        <div style="background:rgba(58,134,255,0.09);border:1px solid rgba(58,134,255,0.22);border-radius:10px;padding:9px 6px">
          <div style="font-size:10px;color:#3a86ff;font-weight:800">CONDIZIONE</div>
          <div style="font-size:18px;font-weight:900;color:var(--t1);margin:2px 0">${tr.ctl ?? 0}</div>
          <div style="font-size:9.5px;color:var(--t3)">Base 6 settimane</div>
        </div>
        <div style="background:rgba(255,69,58,0.09);border:1px solid rgba(255,69,58,0.22);border-radius:10px;padding:9px 6px">
          <div style="font-size:10px;color:#ff453a;font-weight:800">FATICA RECENTE</div>
          <div style="font-size:18px;font-weight:900;color:var(--t1);margin:2px 0">${tr.atl ?? 0}</div>
          <div style="font-size:9.5px;color:var(--t3)">Ultimi 7 giorni</div>
        </div>
        <div style="background:rgba(255,195,0,0.09);border:1px solid rgba(255,195,0,0.22);border-radius:10px;padding:9px 6px">
          <div style="font-size:10px;color:#ffc300;font-weight:800">FRESCHEZZA</div>
          <div style="font-size:18px;font-weight:900;color:var(--t1);margin:2px 0">${(tr.tsb || 0) > 0 ? '+' : ''}${tr.tsb ?? 0}</div>
          <div style="font-size:9.5px;color:var(--t3)">Condizione − Fatica</div>
        </div>
      </div>

      <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:10.5px;color:var(--t2);margin-bottom:6px">
        <span><b style="color:#3a86ff">━ Blu:</b> Condizione acquisita</span>
        <span><b style="color:#ff453a">━ Rossa:</b> Fatica degli ultimi giorni</span>
        <span><b style="color:#ffc300">┄ Gialla:</b> Freschezza</span>
      </div>

      ${renderBanisterPmcSVG(tr)}

      <!-- EQUILIBRIO DEL CARICO -->
      <div style="background:rgba(0,0,0,0.22);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-top:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
          <span style="font-size:11.5px;font-weight:800;color:var(--t1)">Rapporto Fatica Recente / Abitudine: <span style="color:${acwrCol}">${acwrVal ?? 'N/D'}</span></span>
          <span style="font-size:10.5px;font-weight:700;color:${acwrCol}">${acwrLabel}</span>
        </div>
        <div style="font-size:10.5px;color:var(--t3);line-height:1.4">
          Indica se questa settimana hai aumentato il carico troppo bruscamente rispetto al tuo solito (ideale tra <b>0.8 e 1.3</b>). <i>Nota anti-bias: è un indicatore di cambio ritmo, non una diagnosi medica di infortunio.</i>
        </div>
      </div>

      <!-- GUIDA SEMPLICE ALLA LETTURA -->
      <details style="margin-top:10px;background:rgba(255,255,255,0.025);border:1px solid var(--border);border-radius:10px;padding:10px 12px">
        <summary style="cursor:pointer;font-size:11.5px;font-weight:700;color:var(--t1)">
          📖 Come leggere il grafico Forma vs Fatica?
        </summary>
        <div style="margin-top:8px;font-size:12px;color:var(--t2);line-height:1.55">
          <p style="margin:0 0 6px">
            • <b>Linea Blu (Condizione):</b> sale lentamente settimana dopo settimana quando ti alleni con costanza. Più è alta, più lavoro riesci a tollerare.
          </p>
          <p style="margin:0 0 6px">
            • <b>Linea Rossa (Fatica):</b> sale subito dopo i giorni di allenamento pesante e scende nei giorni di riposo.
          </p>
          <p style="margin:0">
            • <b>Linea Gialla (Freschezza):</b> quando è leggermente negativa (−5 / −15) ti stai allenando in modo produttivo; se scende molto sotto −20 per tante settimane, un piccolo scarico ti farà fare un balzo di forza.
          </p>
        </div>
      </details>
    </div>

    <!-- CARD 2: FORZA MASSIMALE STIMATA (1RM) -->
    <div class="card" style="margin-bottom:14px">
      <div style="font-size:14px;font-weight:800;color:var(--t1);margin-bottom:3px">
        🏋️ Progressione della Forza nei tuoi Esercizi
      </div>
      <div style="font-size:11.5px;color:var(--t2);margin-bottom:10px;line-height:1.4">
        Confronta serie diverse (es. 80kg×8 vs 85kg×5) calcolando il tuo <b>Massimale Teorico su 1 ripetizione (1RM)</b>.
      </div>
      ${hasAssumedRir ? `
        <div style="background:rgba(255,195,0,0.08);border-left:3px solid #ffc300;border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:11px;color:var(--t2);line-height:1.4">
          ⚠️ <b>Attenzione al Bias sulle serie a buffer:</b> in alcuni esercizi non è stato indicato quante ripetizioni avevi ancora in canna (RIR). Il modello assume prudenzialmente 0 ripetizioni di margine, quindi il tuo massimale reale potrebbe essere più alto se ti sei fermato lontano dal cedimento.
        </div>` : ''}
      ${liftsHtml}
    </div>

    <!-- CARD 3: SERIE SETTIMANALI PER MUSCOLO -->
    <div class="card" style="margin-bottom:14px">
      <div style="font-size:14px;font-weight:800;color:var(--t1);margin-bottom:3px">
        💪 Serie Settimanali per Gruppo Muscolare
      </div>
      <div style="font-size:11.5px;color:var(--t2);margin-bottom:12px">
        La fascia ottimale per la crescita muscolare è solitamente tra <b>10 e 20 serie allenanti a settimana</b> per muscolo.
      </div>
      ${muscleBarsHtml}
    </div>
  `;
}
