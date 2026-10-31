/**
 * body-composition.js — Stima Multi-Sorgente Body Fat % & Classificatore 4 Settimane (Fase 4B)
 *
 * Implementa:
 *   1. Formula US Navy (Hodgdon & Beckett 1984) con conversione esplicita cm -> pollici (1 in = 2.54 cm):
 *      • Uomo:  BF% = 86.010 * log10(vita_in - collo_in) - 70.041 * log10(altezza_in) + 36.76
 *      • Donna: BF% = 163.205 * log10(vita_in + fianchi_in - collo_in) - 97.684 * log10(altezza_in) - 78.387
 *   2. Fusione a varianza inversa (1 / σ²) delle sorgenti disponibili su un check:
 *      • US Navy da circonferenze (σ = 3.5%)
 *      • Bilancia impedenziometrica `body_fat` (σ = 5.0%)
 *      • Stima visiva AI da foto `body_fat_stimato.range` (σ = max(2.5%, larghezza_range / 2))
 *      Salvata in modo additivo in `checks` come `bf_estimate: { value, sd, sources, model_version: "bodycomp@2.0" }`.
 *   3. Classificatore di traiettoria a 4 settimane (`classifyBodyCompositionState4w`):
 *      Combina ΔtrendWeight, Δvita (ombelico) e trend forza (e1RM Modello 2) in 4 stati chiari:
 *      • `fat_loss` ("Perdita di grasso")
 *      • `recomp` ("Ricomposizione corporea")
 *      • `possible_lean_loss` ("Possibile perdita di massa magra")
 *      • `water_noise` ("Oscillazione d'acqua / Rumore")
 */

export const BODY_COMP_VERSION = 'bodycomp@2.0';

const CM_PER_INCH = 2.54;

/**
 * Calcola la % di massa grassa secondo la formula US Navy (Hodgdon & Beckett 1984)
 * convertendo i centimetri in pollici (inches).
 */
export function computeNavyBodyFatPct({
  sex = 'M',
  heightCm = null,
  waistCm = null,
  neckCm = null,
  hipsCm = null
} = {}) {
  const hCm = Number(heightCm);
  const wCm = Number(waistCm);
  const nCm = Number(neckCm);
  const hipCm = Number(hipsCm);

  if (!hCm || hCm < 120 || !wCm || wCm < 45 || !nCm || nCm < 25) {
    return null;
  }

  const heightIn = hCm / CM_PER_INCH;
  const waistIn = wCm / CM_PER_INCH;
  const neckIn = nCm / CM_PER_INCH;
  const isFemale = String(sex || 'M').toUpperCase() === 'F';

  if (isFemale) {
    if (!hipCm || hipCm < 50) return null;
    const hipsIn = hipCm / CM_PER_INCH;
    const diffIn = waistIn + hipsIn - neckIn;
    if (diffIn <= 0) return null;
    const bf = 163.205 * Math.log10(diffIn) - 97.684 * Math.log10(heightIn) - 78.387;
    if (!Number.isFinite(bf) || bf < 5 || bf > 60) return null;
    return Number(bf.toFixed(1));
  }

  const diffIn = waistIn - neckIn;
  if (diffIn <= 0) return null;
  const bf = 86.010 * Math.log10(diffIn) - 70.041 * Math.log10(heightIn) + 36.76;
  if (!Number.isFinite(bf) || bf < 3 || bf > 55) return null;
  return Number(bf.toFixed(1));
}

/**
 * Estrae punto medio e deviazione standard da un range testuale di BF% (es. "13-15%" o "14.5%").
 */
export function parseVisualBfRange(rangeOrObj) {
  if (!rangeOrObj) return null;
  const rawStr = typeof rangeOrObj === 'string'
    ? rangeOrObj
    : (rangeOrObj.range || rangeOrObj.body_fat_stimato?.range || '');
  if (!rawStr || typeof rawStr !== 'string') return null;

  const rangeMatch = rawStr.match(/(\d+(?:[.,]\d+)?)\s*[-–/]\s*(\d+(?:[.,]\d+)?)/);
  if (rangeMatch) {
    const low = parseFloat(rangeMatch[1].replace(',', '.'));
    const high = parseFloat(rangeMatch[2].replace(',', '.'));
    if (low > 2 && high > low && high < 60) {
      const value = Number(((low + high) / 2).toFixed(1));
      const sd = Number(Math.max(2.5, (high - low) / 2).toFixed(2));
      return { value, sd, range: [low, high] };
    }
  }

  const singleMatch = rawStr.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (singleMatch) {
    const val = parseFloat(singleMatch[1].replace(',', '.'));
    if (val > 2 && val < 60) {
      return { value: Number(val.toFixed(1)), sd: 3.5, range: [val - 2, val + 2] };
    }
  }
  return null;
}

/**
 * Fonde a varianza inversa (1 / σ²) le stime di %BF disponibili per un check:
 *   • US Navy da circonferenze (σ = 3.5%)
 *   • Impedenziometria bilancia `check.body_fat` (σ = 5.0%)
 *   • Foto AI `ai_analysis` (σ = max(2.5, larghezza/2))
 *
 * Ritorna l'oggetto additivo `bf_estimate: { value, sd, sources, model_version: "bodycomp@2.0" }`.
 */
export function computeFusedBodyFat({
  check = {},
  profile = {},
  aiAnalysis = null
} = {}) {
  const sources = [];
  const ms = check.measurements || {};
  const waistCm = ms.waist_navel ?? ms.waist ?? check.waist ?? null;
  const neckCm = ms.neck ?? check.neck ?? null;
  const hipsCm = ms.hips ?? check.hips ?? null;
  const heightCm = profile.height ?? check.height ?? null;
  const sex = profile.sex || 'M';

  // 1. Sorgente US Navy (σ = 3.5%)
  const navyBf = computeNavyBodyFatPct({
    sex,
    heightCm,
    waistCm,
    neckCm,
    hipsCm
  });
  if (navyBf != null) {
    sources.push({
      type: 'us_navy',
      label: 'Circonferenze (US Navy)',
      value: navyBf,
      sd: 3.5
    });
  }

  // 2. Sorgente Bilancia Impedenziometrica (σ = 5.0%)
  const impBf = check.body_fat != null ? Number(check.body_fat) : null;
  if (impBf != null && impBf > 3 && impBf < 60) {
    sources.push({
      type: 'impedance',
      label: 'Bilancia impedenziometrica',
      value: Number(impBf.toFixed(1)),
      sd: 5.0
    });
  }

  // 3. Sorgente Visiva AI da foto
  let parsedAi = aiAnalysis;
  if (!parsedAi && check.ai_analysis) {
    try {
      parsedAi = typeof check.ai_analysis === 'string' ? JSON.parse(check.ai_analysis) : check.ai_analysis;
    } catch (_) {}
  }
  const visualObj = parseVisualBfRange(parsedAi?.analisi?.body_fat_stimato || parsedAi?.body_fat_stimato);
  if (visualObj) {
    sources.push({
      type: 'visual_ai',
      label: 'Analisi visiva foto AI',
      value: visualObj.value,
      sd: visualObj.sd
    });
  }

  if (sources.length === 0) {
    return null;
  }

  // Fusione a varianza inversa: w_i = 1 / sd_i^2
  let sumWeights = 0;
  let weightedSum = 0;
  for (const s of sources) {
    const invVar = 1 / Math.pow(s.sd, 2);
    sumWeights += invVar;
    weightedSum += s.value * invVar;
  }

  const fusedValue = Number((weightedSum / sumWeights).toFixed(1));
  const fusedSd = Number(Math.sqrt(1 / sumWeights).toFixed(2));

  return {
    value: fusedValue,
    sd: fusedSd,
    sources,
    model_version: BODY_COMP_VERSION
  };
}

/**
 * Classifica l'andamento della composizione corporea sulle ultime 4 settimane combinando:
 *   • ΔtrendWeight (da Modello 1)
 *   • Δvita ombelico (dai checks o daily_logs)
 *   • andamento e1RM dei big lift (da Modello 2)
 *
 * Ritorna uno dei 4 stati:
 *   • `fat_loss` ("Perdita di grasso")
 *   • `recomp` ("Ricomposizione corporea")
 *   • `possible_lean_loss` ("Possibile perdita di massa magra")
 *   • `water_noise` ("Oscillazione idrica / Rumore")
 */
export function classifyBodyCompositionState4w({
  energyOutput = {},
  trainingOutput = {},
  checks = []
} = {}) {
  const history = Array.isArray(energyOutput.history) ? energyOutput.history : [];
  if (history.length < 10) {
    return {
      model_version: BODY_COMP_VERSION,
      state: 'insufficient_data',
      label: 'Raccolta dati in corso',
      icon: '⏳',
      color: 'var(--t3)',
      summary: 'Servono almeno 2 settimane di pesate e allenamenti per classificare la variazione di composizione corporea.'
    };
  }

  const latestSnap = history[history.length - 1];
  const ref28Ago = history[Math.max(0, history.length - 29)];
  const weightDelta4w = Number((latestSnap.trendWeight - ref28Ago.trendWeight).toFixed(2));

  // Variazione circonferenza vita nelle ultime 4-6 settimane
  const validWaistChecks = (checks || [])
    .map(c => ({
      date: c.date || c.id,
      waist: Number(c.measurements?.waist_navel ?? c.measurements?.waist ?? c.waist) || null
    }))
    .filter(c => c.date && c.waist != null && c.waist > 40)
    .sort((a, b) => a.date.localeCompare(b.date));

  let waistDeltaCm = null;
  if (validWaistChecks.length >= 2) {
    const lastW = validWaistChecks[validWaistChecks.length - 1];
    const prevW = validWaistChecks[Math.max(0, validWaistChecks.length - 3)];
    waistDeltaCm = Number((lastW.waist - prevW.waist).toFixed(1));
  }

  // Trend forza su esercizi principali
  const lifts = Array.isArray(trainingOutput.lifts) ? trainingOutput.lifts : [];
  const regressCount = lifts.filter(l => l.status === 'regress').length;
  const progressCount = lifts.filter(l => l.status === 'progress' && l.trendSlopePctWeek > 0.25).length;
  const avgSlope = lifts.length > 0
    ? lifts.reduce((s, l) => s + (Number(l.trendSlopePctWeek) || 0), 0) / lifts.length
    : 0;

  // Regole di classificazione:
  // 1. Ricomposizione corporea: peso quasi stabile (|ΔW| <= 0.6 kg) + (vita in calo <= -0.5 cm OPPURE forza in aumento con leggero deficit)
  if (Math.abs(weightDelta4w) <= 0.6 && ((waistDeltaCm != null && waistDeltaCm <= -0.5) || (progressCount >= 1 && regressCount === 0))) {
    return {
      model_version: BODY_COMP_VERSION,
      state: 'recomp',
      label: 'Ricomposizione corporea',
      icon: '💪',
      color: '#7c6fff',
      weightDelta4w,
      waistDeltaCm,
      avgLiftSlopePctWeek: Number(avgSlope.toFixed(2)),
      summary: `Peso stabile (${weightDelta4w >= 0 ? '+' : ''}${weightDelta4w} kg in 4 sett)${waistDeltaCm != null ? ` con giro vita in calo (${waistDeltaCm} cm)` : ''} e carichi in miglioramento: stai sostituendo massa grassa con tessuto contrattile.`
    };
  }

  // 2. Possibile perdita di massa magra: calo peso rapido (< -2.2 kg in 4 sett o >1%/sett) + calo di forza (>=2 esercizi in regressione)
  if (weightDelta4w < -1.5 && (regressCount >= 2 || (energyOutput.weeklyRatePct != null && energyOutput.weeklyRatePct < -1.0 && regressCount >= 1))) {
    return {
      model_version: BODY_COMP_VERSION,
      state: 'possible_lean_loss',
      label: 'Attenzione: possibile perdita di massa magra',
      icon: '⚠️',
      color: '#ff6a00',
      weightDelta4w,
      waistDeltaCm,
      avgLiftSlopePctWeek: Number(avgSlope.toFixed(2)),
      summary: `Il peso scende rapidamente (${weightDelta4w} kg in 4 sett) accompagnato da un calo dei carichi su ${regressCount} esercizi. Valuta di alzare leggermente le calorie (+100/150 kcal) e verificare la quota proteica.`
    };
  }

  // 3. Perdita di grasso: peso di tendenza in discesa (< -0.4 kg in 4 sett) e forza mantenuta o in aumento
  if (weightDelta4w <= -0.4 && regressCount <= 1) {
    return {
      model_version: BODY_COMP_VERSION,
      state: 'fat_loss',
      label: 'Perdita di grasso ottimale',
      icon: '🔥',
      color: '#00dc78',
      weightDelta4w,
      waistDeltaCm,
      avgLiftSlopePctWeek: Number(avgSlope.toFixed(2)),
      summary: `Peso di tendenza in calo controllato (${weightDelta4w} kg in 4 sett)${waistDeltaCm != null && waistDeltaCm < 0 ? `, vita ${waistDeltaCm} cm` : ''} e forza preservata in palestra: dimagrimento di qualità.`
    };
  }

  // 4. Oscillazione idrica / Rumore (o fase di mantenimento/costruzione)
  return {
    model_version: BODY_COMP_VERSION,
    state: 'water_noise',
    label: 'Oscillazione idrica / Stallo apparente',
    icon: '💧',
    color: '#38bdf8',
    weightDelta4w,
    waistDeltaCm,
    avgLiftSlopePctWeek: Number(avgSlope.toFixed(2)),
    summary: `Le variazioni recenti di peso (${weightDelta4w >= 0 ? '+' : ''}${weightDelta4w} kg in 4 sett) riflettono principalmente oscillazioni di liquidi e glicogeno. Guarda la tendenza di 2-3 settimane senza reagire alle singole pesate.`
  };
}
