/**
 * training-model.js — Fitness-Fatigue (Banister PMC) + ACWR (EWMA) + Strength Progression (Modello 2)
 *
 * Fonti scientifiche e implementazioni di riferimento:
 *   1. Banister EW, Calvert TW, Savage MV, Bach T, "A systems model of training for athletic
 *      performance", Aust J Sports Med, 7:57-61, 1975 (modello impulse-response Fitness-Fatigue).
 *   2. Busso T, "Variable dose-response relationship between exercise training and performance",
 *      Med Sci Sports Exerc, 35(7):1188-1195, 2003 (fitting vincolato dei parametri Banister).
 *   3. Coggan AR / TrainingPeaks, "Performance Management Chart (PMC)" (CTL τ_1 = 42 gg,
 *      ATL τ_2 = 7 gg, TSB = CTL − ATL).
 *   4. Foster C et al., "A new approach to monitoring exercise training",
 *      J Strength Cond Res, 15(1):109-115, 2001 (session-RPE: carico = RPE_CR10 × durata_minuti).
 *   5. Williams S et al., "Better way to determine the acute:chronic workload ratio?",
 *      Br J Sports Med, 51(3):209-210, 2017 (ACWR con medie mobili esponenziali EWMA 7/28 giorni;
 *      NOTA: l'ACWR è un indicatore descrittivo discusso in letteratura — Impellizzeri et al. 2020 —
 *      e non costituisce una diagnosi o predizione medica di infortunio).
 *   6. Epley B, "Poundage Chart", Boyd Epley Workout, 1985; integrato con la scala RPE/RIR di
 *      Zourdos MC, Helms ER et al., "Novel Resistance Training-Specific Rating of Perceived
 *      Exertion Scale Measuring Repetitions in Reserve", J Strength Cond Res, 30(1):267-275, 2016:
 *      e1RM = carico × (1 + (reps + RIR) / 30).
 *   7. Theil H (1950) & Sen PK (1968), "Estimates of the regression coefficient based on Kendall's
 *      tau", J Am Stat Assoc, 63(324):1379-1389, 1968 (stimatore robusto della pendenza di progressione).
 *   8. Schoenfeld BJ, Ogborn D, Krieger JW, "Dose-response relationship between weekly resistance
 *      training volume and increases in muscle mass", J Sports Sci, 35(11):1073-1082, 2017
 *      (relazione dose-risposta serie settimanali per gruppo muscolare e ipertrofia: 10–20+ serie).
 *
 * Principi architetturali:
 *   • Modulo puro deterministico (input → output), zero accesso a DB/DOM/rete.
 *   • Supporta anagrafica esercizi con muscoli primari (peso 1.0) e secondari (peso 0.5).
 */

import { isFlagEnabled } from './feature-flags.js';

export const TRAINING_MODEL_DEFAULTS = {
  tauCtlDays: 42,
  tauAtlDays: 7,
  acwrAcuteDays: 7,
  acwrChronicDays: 28,
  defaultSessionDurationMin: 60,
  defaultHardSetFactor: 18, // unità di carico equivalente per serie allenante se mancano durata/sRPE
  defaultTonnageFactor: 1.0, // fattore moltiplicativo su (tonnageKg / 25)
  // Parametri iniziali Banister p(t) = p0 + k1 * CTL_t - k2 * ATL_t
  defaultK1: 0.08,
  defaultK2: 0.12,
  minWeeksForCalibration: 8,
  regularizationLambda: 5.0,
  // Fasce volume settimanale (Schoenfeld et al. 2017)
  optimalSetsMin: 10,
  optimalSetsMax: 20
};

/**
 * Tabella RPE/RIR -> %1RM (Tuchscherer 2008 / Helms et al. 2016) per ripetizioni effettive (reps + RIR) da 1 a 12.
 */
const RPE_PCT_1RM_TABLE = [
  1.000, // 1 rep @ 0 RIR (RPE 10)
  0.955, // 2
  0.922, // 3
  0.892, // 4
  0.863, // 5
  0.837, // 6
  0.811, // 7
  0.786, // 8
  0.762, // 9
  0.739, // 10
  0.707, // 11
  0.680  // 12
];

/**
 * Anagrafica esercizi predefinita con muscoli primari (peso 1.0) e secondari (peso 0.5).
 * Espandibile con il catalogo utente salvato su Firestore.
 */
export const DEFAULT_EXERCISE_CATALOG = {
  'Hack squat': { primary: ['quadricipiti'], secondary: ['glutei'], isBigLift: true, equipment: 'machine' },
  'Pressa 45 gradi': { primary: ['quadricipiti'], secondary: ['glutei'], isBigLift: true, equipment: 'machine' },
  'Bulgarian split squat manubri': { primary: ['quadricipiti', 'glutei'], secondary: ['femorali'], isBigLift: false, equipment: 'dumbbell' },
  'Leg extension': { primary: ['quadricipiti'], secondary: [], isBigLift: false, equipment: 'machine' },
  'Stacco rumeno manubri': { primary: ['femorali', 'glutei'], secondary: ['dorso_orizzontale'], isBigLift: true, equipment: 'dumbbell' },
  'Leg curl seduto': { primary: ['femorali'], secondary: ['polpacci'], isBigLift: false, equipment: 'machine' },
  'Leg curl sdraiato': { primary: ['femorali'], secondary: ['polpacci'], isBigLift: false, equipment: 'machine' },
  'Trazioni alla sbarra': { primary: ['dorso_verticale'], secondary: ['bicipiti', 'delt_posteriore'], isBigLift: true, equipment: 'bodyweight' },
  'Lat machine presa neutra media': { primary: ['dorso_verticale'], secondary: ['bicipiti'], isBigLift: true, equipment: 'cable' },
  'Row machine appoggio pettorale': { primary: ['dorso_orizzontale'], secondary: ['delt_posteriore', 'bicipiti'], isBigLift: true, equipment: 'machine' },
  'Rematore singolo manubrio': { primary: ['dorso_orizzontale'], secondary: ['bicipiti', 'delt_posteriore'], isBigLift: false, equipment: 'dumbbell' },
  'Panca piana manubri': { primary: ['petto'], secondary: ['tricipiti', 'deltoide_anteriore'], isBigLift: true, equipment: 'dumbbell' },
  'Chest press machine': { primary: ['petto'], secondary: ['tricipiti', 'deltoide_anteriore'], isBigLift: true, equipment: 'machine' },
  'Alzate laterali ai cavi': { primary: ['deltoide_laterale'], secondary: [], isBigLift: false, equipment: 'cable' },
  'Alzate laterali manubri seduto schienale 80 gradi': { primary: ['deltoide_laterale'], secondary: [], isBigLift: false, equipment: 'dumbbell' },
  'Incline side-lying lateral raise': { primary: ['deltoide_laterale'], secondary: [], isBigLift: false, equipment: 'dumbbell' },
  'Face pull ai cavi': { primary: ['delt_posteriore'], secondary: ['dorso_orizzontale'], isBigLift: false, equipment: 'cable' },
  'Reverse pec deck': { primary: ['delt_posteriore'], secondary: ['dorso_orizzontale'], isBigLift: false, equipment: 'machine' },
  'Calf in piedi': { primary: ['polpacci'], secondary: [], isBigLift: false, equipment: 'machine' },
  'Calf alla pressa': { primary: ['polpacci'], secondary: [], isBigLift: false, equipment: 'machine' },
  'Superset: Curl EZ + French press ai cavi': { primary: ['bicipiti', 'tricipiti'], secondary: [], isBigLift: false, equipment: 'cable' },
  'Superset: Spider curl + Pushdown corda': { primary: ['bicipiti', 'tricipiti'], secondary: [], isBigLift: false, equipment: 'cable' }
};

/**
 * Risolve i gruppi muscolari primari e secondari per un nome di esercizio (con fallback per keyword).
 */
export function resolveExerciseMuscles(exerciseName, customCatalog = {}) {
  if (!exerciseName) return { primary: ['altro'], secondary: [], isBigLift: false };
  const exact = customCatalog[exerciseName] || DEFAULT_EXERCISE_CATALOG[exerciseName];
  if (exact) return exact;

  const low = exerciseName.toLowerCase();
  for (const [k, v] of Object.entries({ ...DEFAULT_EXERCISE_CATALOG, ...customCatalog })) {
    if (k.toLowerCase() === low) return v;
  }

  // Euristica per esercizi custom
  if (/squat|pressa|affond|split|leg ext/.test(low)) return { primary: ['quadricipiti'], secondary: ['glutei'], isBigLift: /squat|pressa/.test(low) };
  if (/stacco|rdl|leg curl|hip thrust|glute/.test(low)) return { primary: ['femorali'], secondary: ['glutei'], isBigLift: /stacco|hip thrust/.test(low) };
  if (/trazion|lat |pull.?down/.test(low)) return { primary: ['dorso_verticale'], secondary: ['bicipiti'], isBigLift: true };
  if (/row|rematore|pulley/.test(low)) return { primary: ['dorso_orizzontale'], secondary: ['bicipiti', 'delt_posteriore'], isBigLift: /row|pulley/.test(low) };
  if (/panca|chest|spinte|piegament|dip|croci|pec/.test(low)) return { primary: ['petto'], secondary: ['tricipiti'], isBigLift: /panca|chest|spinte/.test(low) };
  if (/alzat.*lat|lateral|military|lento avanti|shoulder/.test(low)) return { primary: ['deltoide_laterale'], secondary: ['tricipiti'], isBigLift: /military|lento|shoulder press/.test(low) };
  if (/face.?pull|rear|reverse pec|delt.*post/.test(low)) return { primary: ['delt_posteriore'], secondary: ['dorso_orizzontale'], isBigLift: false };
  if (/curl|bicip/.test(low)) return { primary: ['bicipiti'], secondary: [], isBigLift: false };
  if (/french|push.?down|tricip|skull/.test(low)) return { primary: ['tricipiti'], secondary: [], isBigLift: false };
  if (/calf|polpacc/.test(low)) return { primary: ['polpacci'], secondary: [], isBigLift: false };

  return { primary: ['altro'], secondary: [], isBigLift: false };
}

/**
 * Converte RPE (scala 1-10 di Zourdos/Helms 2016) o RIR esplicito in RIR (Repetitions in Reserve).
 * Se né RIR né RPE sono presenti, assume RIR = 0 e imposta `assumedZeroRir = true`.
 */
export function resolveRIR(setOrEx = {}) {
  if (setOrEx.rir != null && !isNaN(Number(setOrEx.rir))) {
    return { rir: Math.max(0, Math.min(6, Number(setOrEx.rir))), assumedZeroRir: false };
  }
  const rpe = setOrEx.rpe != null ? Number(setOrEx.rpe) : null;
  if (rpe != null && !isNaN(rpe) && rpe >= 5 && rpe <= 10) {
    return { rir: Math.max(0, Math.min(5, 10 - rpe)), assumedZeroRir: false };
  }
  return { rir: 0, assumedZeroRir: true };
}

/**
 * Calcola l'e1RM secondo la formula di Epley estesa con RIR (Zourdos/Helms 2016):
 *   e1RM = carico × (1 + (reps + RIR) / 30)
 */
export function computeEpleyE1RM(weightKg, reps, rirOrOpts = 0) {
  const w = Number(weightKg) || 0;
  const r = parseInt(reps, 10) || 0;
  if (w <= 0 || r <= 0) return { e1rm: 0, rir: 0, assumedZeroRir: false, effectiveReps: 0 };

  let rir = 0;
  let assumedZeroRir = false;
  if (typeof rirOrOpts === 'number') {
    rir = Math.max(0, Math.min(6, rirOrOpts));
  } else if (rirOrOpts && typeof rirOrOpts === 'object') {
    const res = resolveRIR(rirOrOpts);
    rir = res.rir;
    assumedZeroRir = res.assumedZeroRir;
  }

  const effectiveReps = r + rir;
  const e1rm = effectiveReps === 1 ? w : w * (1 + effectiveReps / 30);
  return {
    e1rm: Number(e1rm.toFixed(2)),
    rir,
    assumedZeroRir,
    effectiveReps
  };
}

/**
 * Fase 2.2b: Calcola l'e1RM usando la tabella RPE->%1RM (Tuchscherer/Helms) quando RPE/RIR è noto
 * e `reps + RIR <= 12`, mantenendo Epley come fallback.
 */
export function computeRpeTableE1RM(weightKg, reps, rirOrOpts = 0) {
  const w = Number(weightKg) || 0;
  const r = parseInt(reps, 10) || 0;
  if (w <= 0 || r <= 0) return { e1rm: 0, rir: 0, assumedZeroRir: false, effectiveReps: 0, method: 'none' };

  let rir = 0;
  let assumedZeroRir = false;
  if (typeof rirOrOpts === 'number') {
    rir = Math.max(0, Math.min(6, rirOrOpts));
  } else if (rirOrOpts && typeof rirOrOpts === 'object') {
    const res = resolveRIR(rirOrOpts);
    rir = res.rir;
    assumedZeroRir = res.assumedZeroRir;
  }

  const effectiveReps = r + rir;
  if (!assumedZeroRir && effectiveReps >= 1 && effectiveReps <= 12) {
    const lowIdx = Math.max(1, Math.min(12, Math.floor(effectiveReps))) - 1;
    const highIdx = Math.max(1, Math.min(12, Math.ceil(effectiveReps))) - 1;
    const frac = effectiveReps - Math.floor(effectiveReps);
    const pct = RPE_PCT_1RM_TABLE[lowIdx] * (1 - frac) + RPE_PCT_1RM_TABLE[highIdx] * frac;
    const e1rm = pct > 0 ? w / pct : w;
    return {
      e1rm: Number(e1rm.toFixed(2)),
      rir,
      assumedZeroRir: false,
      effectiveReps,
      method: 'rpe_table'
    };
  }

  const fallback = computeEpleyE1RM(w, r, { rir: assumedZeroRir ? null : rir });
  return {
    ...fallback,
    assumedZeroRir,
    effectiveReps,
    method: 'epley_fallback'
  };
}

/**
 * Calcola la mediana numerica di un array.
 */
function medianNumeric(arr) {
  if (!arr || !arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
}

/**
 * Fase 2.2a: Calibra per ogni utente i fattori di conversione:
 *   k_hs  = mediana(sRPE / hardSets)
 *   k_ton = mediana(sRPE / (tonnage / 25))
 * sulle sessioni che hanno entrambi i dati (minimo 5 sessioni, altrimenti usa i prior).
 */
export function calibrateLoadConversionFactors(sessionMetricsList = [], config = TRAINING_MODEL_DEFAULTS) {
  const defaultKhs = config.defaultHardSetFactor || 18;
  const defaultKton = config.defaultTonnageFactor || 1.0;

  const hsRatios = [];
  const tonRatios = [];

  for (const m of sessionMetricsList) {
    if (!m || m.sRPE == null || m.sRPE <= 0) continue;
    if (m.hardSetsCount > 0) {
      hsRatios.push(m.sRPE / m.hardSetsCount);
    }
    const normTon = (m.tonnageKg || 0) / 25;
    if (normTon > 0) {
      tonRatios.push(m.sRPE / normTon);
    }
  }

  const calibratedHs = hsRatios.length >= 5;
  const calibratedTon = tonRatios.length >= 5;

  const k_hs = calibratedHs
    ? Number(Math.max(5, Math.min(60, medianNumeric(hsRatios))).toFixed(2))
    : defaultKhs;
  const k_ton = calibratedTon
    ? Number(Math.max(0.1, Math.min(5.0, medianNumeric(tonRatios))).toFixed(3))
    : defaultKton;

  return {
    k_hs,
    k_ton,
    calibratedSessions: Math.max(hsRatios.length, tonRatios.length),
    calibrated: calibratedHs || calibratedTon
  };
}

/**
 * Calcola tutti i descrittori di carico di una singola sessione (in ordine di preferenza):
 *   1. sRPE (Foster et al. 2001) = RPE_sessione (CR-10) × durata_minuti (oppure RPE medio esercizi × durata)
 *   2. hardSetsLoad = serie allenanti (RIR ≤ 3 o completate) × fattore (k_hs)
 *   3. tonnageKg = Σ (carico × reps) convertito con k_ton
 * Restituisce tutti i valori disponibili più `primaryLoad` (in unità sRPE-equivalenti).
 */
export function computeSessionLoadMetrics(workout, config = TRAINING_MODEL_DEFAULTS, conversionFactors = null) {
  if (!workout || !workout.completed) {
    return {
      sRPE: null,
      hardSetsCount: 0,
      hardSetsLoad: 0,
      tonnageKg: 0,
      durationMin: 0,
      sessionRpeUsed: null,
      primaryLoad: 0,
      loadSource: 'none'
    };
  }

  const exercises = Array.isArray(workout.exercises) ? workout.exercises : [];
  let hardSetsCount = 0;
  let tonnageKg = 0;
  const exRpes = [];

  for (const ex of exercises) {
    if (Array.isArray(ex.componenti) && ex.componenti.length > 0) continue; // salta blocchi mobilità/core
    if (ex.rpe != null && Number(ex.rpe) > 0) exRpes.push(Number(ex.rpe));
    const sets = Array.isArray(ex.sets) ? ex.sets : [];
    for (const s of sets) {
      if (s.done === false) continue;
      const w = Number(s.weight ?? s.actual_weight) || 0;
      const r = parseInt(s.reps ?? s.actual_reps, 10) || 0;
      if (s.rpe != null && Number(s.rpe) > 0) exRpes.push(Number(s.rpe));
      const { rir } = resolveRIR({ rir: s.rir, rpe: s.rpe ?? ex.rpe ?? ex.rpe_target });
      if (r > 0 && rir <= 3) hardSetsCount++;
      if (w > 0 && r > 0) tonnageKg += w * r;
    }
  }

  const rawDurMin = workout.duration_seconds ? Math.round(workout.duration_seconds / 60) : (workout.duration_minutes || 0);
  const durationMin = rawDurMin > 5 && rawDurMin <= 240 ? rawDurMin : 0;

  const explicitSessionRpe = workout.session_rpe != null && Number(workout.session_rpe) > 0
    ? Number(workout.session_rpe)
    : null;
  const meanExRpe = exRpes.length > 0
    ? Number((exRpes.reduce((a, b) => a + b, 0) / exRpes.length).toFixed(1))
    : null;
  const sessionRpeUsed = explicitSessionRpe || meanExRpe;

  const sRPE = durationMin > 0 && sessionRpeUsed != null
    ? Math.round(durationMin * sessionRpeUsed)
    : null;

  const kHs = conversionFactors?.k_hs ?? (config.defaultHardSetFactor || 18);
  const kTon = conversionFactors?.k_ton ?? (config.defaultTonnageFactor || 1.0);

  const hardSetsLoad = Math.round(hardSetsCount * kHs);
  const normalizedTonnageLoad = tonnageKg > 0 ? Math.round((tonnageKg / 25) * kTon) : 0;

  let primaryLoad = 0;
  let loadSource = 'none';
  if (sRPE != null && sRPE > 0) {
    primaryLoad = sRPE;
    loadSource = explicitSessionRpe ? 'sRPE' : 'sRPE_derived';
  } else if (hardSetsLoad > 0) {
    primaryLoad = hardSetsLoad;
    loadSource = 'hard_sets';
  } else if (normalizedTonnageLoad > 0) {
    primaryLoad = normalizedTonnageLoad;
    loadSource = 'tonnage';
  }

  return {
    sRPE,
    hardSetsCount,
    hardSetsLoad,
    tonnageKg: Math.round(tonnageKg),
    durationMin: durationMin || config.defaultSessionDurationMin,
    sessionRpeUsed,
    primaryLoad,
    loadSource
  };
}

/**
 * Calcola la mediana pesata di coppie { value, weight }.
 */
function weightedMedian(items) {
  if (!items || !items.length) return 0;
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((s, x) => s + x.weight, 0);
  if (totalWeight <= 0) return sorted[0].value;
  let cum = 0;
  for (let i = 0; i < sorted.length; i++) {
    cum += sorted[i].weight;
    if (cum >= totalWeight / 2) {
      return sorted[i].value;
    }
  }
  return sorted[sorted.length - 1].value;
}

/**
 * Stimatore robusto di Theil-Sen (Theil 1950; Sen 1968):
 * Calcola la mediana di tutte le pendenze (y_j - y_i) / (x_j - x_i) per i < j.
 * Con `opts.weightAssumedZeroRir = true` (Fase 2.2b), i punti con `assumedZeroRir` hanno peso 0.5.
 * Ritorna { slopePerDay, intercept, slopePctPerWeek }.
 */
export function theilSenRegression(points, opts = {}) {
  if (!points || points.length < 2) {
    const y0 = Number(points?.[0]?.y ?? points?.[0]?.e1rm) || 0;
    return { slopePerDay: 0, intercept: y0, slopePctPerWeek: 0 };
  }
  const useWeighting = Boolean(opts.weightAssumedZeroRir);
  const normPts = points.map((p, idx) => ({
    xDays: p.xDays != null ? Number(p.xDays) : idx,
    y: Number(p.y ?? p.e1rm) || 0,
    w: useWeighting && p.assumedZeroRir ? 0.5 : 1.0
  }));

  if (!useWeighting) {
    const slopes = [];
    for (let i = 0; i < normPts.length; i++) {
      for (let j = i + 1; j < normPts.length; j++) {
        const dx = normPts[j].xDays - normPts[i].xDays;
        if (dx > 0) {
          slopes.push((normPts[j].y - normPts[i].y) / dx);
        }
      }
    }
    if (!slopes.length) {
      return { slopePerDay: 0, intercept: normPts[0].y, slopePctPerWeek: 0 };
    }
    slopes.sort((a, b) => a - b);
    const mid = Math.floor(slopes.length / 2);
    const slopePerDay = slopes.length % 2 === 1
      ? slopes[mid]
      : 0.5 * (slopes[mid - 1] + slopes[mid]);

    const intercepts = normPts.map(p => p.y - slopePerDay * p.xDays).sort((a, b) => a - b);
    const iMid = Math.floor(intercepts.length / 2);
    const intercept = intercepts.length % 2 === 1
      ? intercepts[iMid]
      : 0.5 * (intercepts[iMid - 1] + intercepts[iMid]);

    const refY = normPts[0].y > 0 ? normPts[0].y : 1;
    const slopePctPerWeek = ((slopePerDay * 7) / refY) * 100;

    return {
      slopePerDay,
      intercept,
      slopePctPerWeek: Number(slopePctPerWeek.toFixed(2))
    };
  }

  // Versione pesata (Fase 2.2b): coppie con assumedZeroRir pesano 0.5 * w_j
  const weightedSlopes = [];
  for (let i = 0; i < normPts.length; i++) {
    for (let j = i + 1; j < normPts.length; j++) {
      const dx = normPts[j].xDays - normPts[i].xDays;
      if (dx > 0) {
        weightedSlopes.push({
          value: (normPts[j].y - normPts[i].y) / dx,
          weight: normPts[i].w * normPts[j].w
        });
      }
    }
  }
  if (!weightedSlopes.length) {
    return { slopePerDay: 0, intercept: normPts[0].y, slopePctPerWeek: 0 };
  }
  const slopePerDay = weightedMedian(weightedSlopes);
  const intercept = weightedMedian(normPts.map(p => ({
    value: p.y - slopePerDay * p.xDays,
    weight: p.w
  })));

  const refY = normPts[0].y > 0 ? normPts[0].y : 1;
  const slopePctPerWeek = ((slopePerDay * 7) / refY) * 100;

  return {
    slopePerDay,
    intercept,
    slopePctPerWeek: Number(slopePctPerWeek.toFixed(2))
  };
}

/**
 * Helper interno per ottimizzare (p0, k1, k2) su un insieme di punti settimanali.
 */
function solveBanisterGrid(samples, k1Prior, k2Prior, p0Prior, lambda) {
  let bestP0 = p0Prior, bestK1 = k1Prior, bestK2 = k2Prior;
  let bestLoss = Infinity;
  const meanPerf = samples.reduce((s, x) => s + x.perfIndex, 0) / samples.length;

  for (let k1 = 0.02; k1 <= 0.30; k1 += 0.01) {
    for (let k2 = k1; k2 <= 0.45; k2 += 0.01) {
      const meanPredOffset = samples.reduce((s, x) => s + (k1 * x.ctl - k2 * x.atl), 0) / samples.length;
      const p0 = meanPerf - meanPredOffset;

      let sse = 0;
      for (const s of samples) {
        const pred = p0 + k1 * s.ctl - k2 * s.atl;
        const err = s.perfIndex - pred;
        sse += err * err;
      }
      const reg = lambda * (Math.pow((k1 - k1Prior) / k1Prior, 2) + Math.pow((k2 - k2Prior) / k2Prior, 2));
      const totalLoss = sse / samples.length + reg;
      if (totalLoss < bestLoss) {
        bestLoss = totalLoss;
        bestP0 = Number(p0.toFixed(2));
        bestK1 = Number(k1.toFixed(3));
        bestK2 = Number(k2.toFixed(3));
      }
    }
  }
  return { p0: bestP0, k1: bestK1, k2: bestK2, meanPerf };
}

/**
 * Calibrazione vincolata e regolarizzata (Ridge / Tikhonov) dei parametri di Banister
 *   p(t) = p_0 + k_1 · CTL(t) − k_2 · ATL(t)
 * Fase 2.2c: Con `training.banisterValidation` attivo, valida con leave-last-2-weeks-out:
 * se il fit non batte il modello costante (p0) sugli ultimi 2 punti settimanali, usa i prior.
 */
export function fitBanisterParameters(samples, config = TRAINING_MODEL_DEFAULTS) {
  const k1Prior = config.defaultK1 || 0.08;
  const k2Prior = config.defaultK2 || 0.12;
  const p0Prior = 100;
  const useValidation = isFlagEnabled('training.banisterValidation', config?.flags || null);

  if (!samples || samples.length < 8) {
    return { p0: p0Prior, k1: k1Prior, k2: k2Prior, calibrated: false };
  }

  const lambda = config.regularizationLambda || 5.0;

  if (useValidation) {
    const trainSamples = samples.slice(0, -2);
    const valSamples = samples.slice(-2);
    if (trainSamples.length < 6 || valSamples.length < 2) {
      return { p0: p0Prior, k1: k1Prior, k2: k2Prior, calibrated: false, validationPassed: false };
    }
    const trainFit = solveBanisterGrid(trainSamples, k1Prior, k2Prior, p0Prior, lambda);
    let valSseModel = 0;
    let valSseConst = 0;
    for (const v of valSamples) {
      const predModel = trainFit.p0 + trainFit.k1 * v.ctl - trainFit.k2 * v.atl;
      valSseModel += Math.pow(v.perfIndex - predModel, 2);
      valSseConst += Math.pow(v.perfIndex - trainFit.meanPerf, 2);
    }
    if (valSseModel >= valSseConst) {
      return {
        p0: p0Prior,
        k1: k1Prior,
        k2: k2Prior,
        calibrated: false,
        validationPassed: false,
        valRmseModel: Number(Math.sqrt(valSseModel / valSamples.length).toFixed(2)),
        valRmseConst: Number(Math.sqrt(valSseConst / valSamples.length).toFixed(2))
      };
    }
    const fullFit = solveBanisterGrid(samples, k1Prior, k2Prior, p0Prior, lambda);
    return {
      p0: fullFit.p0,
      k1: fullFit.k1,
      k2: fullFit.k2,
      calibrated: true,
      validationPassed: true,
      valRmseModel: Number(Math.sqrt(valSseModel / valSamples.length).toFixed(2)),
      valRmseConst: Number(Math.sqrt(valSseConst / valSamples.length).toFixed(2))
    };
  }

  const fullFit = solveBanisterGrid(samples, k1Prior, k2Prior, p0Prior, lambda);
  return { p0: fullFit.p0, k1: fullFit.k1, k2: fullFit.k2, calibrated: true };
}

/**
 * Fase 2.2d: Calcola la Monotonia di Foster (media / deviazione standard del carico giornaliero su 7gg)
 * e lo Strain (carico settimanale × monotonia).
 */
export function computeFosterMonotonyAndStrain(loads7d = []) {
  const arr = Array.from({ length: 7 }, (_, idx) => Number(loads7d[idx]) || 0);
  const sum7 = arr.reduce((a, b) => a + b, 0);
  if (sum7 <= 0) {
    return { weeklyLoad: 0, monotony: 0, strain: 0, highStrain: false };
  }
  const mean7 = sum7 / 7;
  const variance = arr.reduce((acc, v) => acc + Math.pow(v - mean7, 2), 0) / 7;
  const sd7 = Math.sqrt(variance);
  // Evita esplosione numerica quando sd7 -> 0
  const monotony = Number(Math.min(6.0, mean7 / Math.max(10, sd7)).toFixed(2));
  const strain = Math.round(sum7 * monotony);
  return {
    weeklyLoad: Math.round(sum7),
    monotony,
    strain,
    highStrain: monotony > 2.0 && strain > 2500
  };
}

/**
 * Fase 2.2f: Valuta lo stato del volume settimanale per ogni muscolo rispetto ai target configurabili
 * (default 10–20 serie/settimana, override opzionale in `profile.volume_targets`).
 */
export function evaluateMuscleVolumeStatus(weeklySetsByMuscle = {}, profileVolumeTargets = null, config = TRAINING_MODEL_DEFAULTS) {
  const defaultMin = config.optimalSetsMin || 10;
  const defaultMax = config.optimalSetsMax || 20;
  const statusMap = {};

  const allMuscles = new Set([
    ...Object.keys(weeklySetsByMuscle || {}),
    ...Object.keys(profileVolumeTargets || {})
  ]);

  for (const muscle of allMuscles) {
    if (muscle === 'altro') continue;
    const sets = Number(weeklySetsByMuscle[muscle]) || 0;
    const custom = profileVolumeTargets?.[muscle];
    const min = custom?.min != null ? Number(custom.min) : defaultMin;
    const max = custom?.max != null ? Number(custom.max) : defaultMax;
    const status = sets < min ? 'under' : (sets > max ? 'over' : 'ok');
    statusMap[muscle] = {
      sets,
      min,
      max,
      status
    };
  }
  return statusMap;
}

/**
 * Fase 2.2g: Progressione deterministica (Doppia Progressione).
 * Se in un esercizio tutte le serie allenanti dell'ultima sessione raggiungono o superano
 * il top del range di ripetizioni target con RIR >= targetRir (default 1), suggerisce +2.5%
 * (o il minimo incremento disponibile per l'attrezzo).
 */
export function computeDoubleProgressionSuggestions({
  days = [],
  program = null,
  exerciseCatalog = {},
  increments = { dumbbell: 2, barbell: 2.5, machine: 2.5, cable: 2.5 }
} = {}) {
  // Mappa opzionale esercizio -> { repMin, repMax, targetRir } dalla scheda attiva
  const plannedByEx = new Map();
  if (program?.schedule && typeof program.schedule === 'object') {
    for (const dayPlan of Object.values(program.schedule)) {
      for (const ex of (dayPlan?.exercises || [])) {
        if (!ex?.name) continue;
        const repStr = String(ex.reps || '8-10');
        const m = repStr.match(/(\d+)\s*[-–]\s*(\d+)/);
        const single = repStr.match(/(\d+)/);
        const repMin = m ? parseInt(m[1], 10) : (single ? parseInt(single[1], 10) : 8);
        const repMax = m ? parseInt(m[2], 10) : (single ? parseInt(single[1], 10) : 10);
        const targetRir = ex.rir_target != null ? Number(ex.rir_target) : 1;
        plannedByEx.set(ex.name.toLowerCase(), { repMin, repMax, targetRir });
      }
    }
  }

  // Trova l'ultima sessione completata per ogni esercizio
  const latestSessionByEx = new Map();
  const sortedDays = [...(days || [])].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of sortedDays) {
    if (!d.workout?.completed) continue;
    for (const ex of (d.workout.exercises || [])) {
      if (!ex?.name || (Array.isArray(ex.componenti) && ex.componenti.length > 0)) continue;
      const doneSets = (ex.sets || []).filter(s => s.done !== false && (parseInt(s.reps ?? s.actual_reps, 10) || 0) > 0);
      if (doneSets.length > 0) {
        latestSessionByEx.set(ex.name, { date: d.date, ex, doneSets });
      }
    }
  }

  const suggestions = [];
  for (const [exName, info] of latestSessionByEx.entries()) {
    const planRule = plannedByEx.get(exName.toLowerCase()) || {};
    const repStr = String(info.ex.reps_target || info.ex.reps || '');
    const m = repStr.match(/(\d+)\s*[-–]\s*(\d+)/);
    const repMin = planRule.repMin ?? (m ? parseInt(m[1], 10) : 8);
    const repMax = planRule.repMax ?? (m ? parseInt(m[2], 10) : 10);
    const targetRir = planRule.targetRir ?? (info.ex.rir_target != null ? Number(info.ex.rir_target) : 1);

    const parsedSets = info.doneSets.map(s => {
      const weight = Number(s.weight ?? s.actual_weight) || 0;
      const reps = parseInt(s.reps ?? s.actual_reps, 10) || 0;
      const { rir } = resolveRIR({ rir: s.rir, rpe: s.rpe ?? info.ex.rpe ?? info.ex.rpe_target });
      return { weight, reps, rir };
    });

    const maxWeight = Math.max(...parsedSets.map(s => s.weight));
    const allHitTopReps = parsedSets.length >= 2 && parsedSets.every(s => s.reps >= repMax && s.rir >= targetRir);
    const anyBelowMinReps = parsedSets.some(s => s.reps < repMin);

    const catInfo = resolveExerciseMuscles(exName, exerciseCatalog);
    const equip = catInfo.equipment || (/manubr|dumbbell/i.test(exName) ? 'dumbbell' : /cavi|cable|lat|pushdown/i.test(exName) ? 'cable' : 'machine');
    const minInc = increments[equip] || 2.5;

    if (allHitTopReps && maxWeight > 0) {
      const rawStep = Math.max(minInc, maxWeight * 0.025);
      const roundedStep = Math.round(rawStep / minInc) * minInc || minInc;
      const nextWeight = Number((maxWeight + roundedStep).toFixed(1));
      suggestions.push({
        exerciseId: exName,
        action: 'increase_load',
        currentWeightKg: maxWeight,
        suggestedWeightKg: nextWeight,
        incrementKg: roundedStep,
        targetRepRange: `${repMin}-${repMax}`,
        reason: `Tutte le ${parsedSets.length} serie hanno raggiunto ≥${repMax} reps con RIR ≥${targetRir}: aumenta a ${nextWeight} kg (+${roundedStep} kg) e riparti da ${repMin} reps.`
      });
    } else if (anyBelowMinReps && maxWeight > 0) {
      suggestions.push({
        exerciseId: exName,
        action: 'hold_or_reduce',
        currentWeightKg: maxWeight,
        suggestedWeightKg: maxWeight,
        incrementKg: 0,
        targetRepRange: `${repMin}-${repMax}`,
        reason: `Almeno una serie è scesa sotto il minimo di ${repMin} reps: mantieni ${maxWeight} kg e consolida il range ${repMin}-${repMax}.`
      });
    } else {
      suggestions.push({
        exerciseId: exName,
        action: 'add_reps',
        currentWeightKg: maxWeight,
        suggestedWeightKg: maxWeight,
        incrementKg: 0,
        targetRepRange: `${repMin}-${repMax}`,
        reason: `Mantieni ${maxWeight} kg e punta ad aggiungere 1 ripetizione per serie fino a completare tutte le serie a ${repMax} reps.`
      });
    }
  }

  return suggestions;
}

function addDaysISO(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().split('T')[0];
}

function diffDaysISO(dateA, dateB) {
  const [y1, m1, d1] = dateA.split('-').map(Number);
  const [y2, m2, d2] = dateB.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/**
 * Esegue l'intero Modello 2 ("Fitness-Fatigue + Strength Progression") su una serie storica
 * di log giornalieri.
 *
 * @param {Object} params
 * @param {Array<{date:string, workout?:Object|null, sleepHours?:number|null, sleepQuality?:number|null}>} params.days
 * @param {Object} [params.exerciseCatalog] mappa custom esercizio -> {primary[], secondary[], isBigLift}
 * @param {Object} [params.profile] profilo utente (per volume_targets personalizzati)
 * @param {Object} [params.program] scheda allenamento attiva (per doppia progressione)
 * @param {Object} [params.context] contesto esterno (es. { energyBalance7d } da Modello 1)
 * @param {string} [params.todayDate]
 * @param {Object} [params.config]
 */
export function runTrainingModel({
  days = [],
  exerciseCatalog = {},
  profile = {},
  program = null,
  context = {},
  todayDate = null,
  config = {}
} = {}) {
  const cfg = { ...TRAINING_MODEL_DEFAULTS, ...config };
  const flagOverrides = cfg.flags || null;
  const useHomogeneousLoad = isFlagEnabled('training.homogeneousLoad', flagOverrides);
  const useE1rmV2 = isFlagEnabled('training.e1rmV2', flagOverrides);
  const useReadinessV2 = isFlagEnabled('training.readinessV2', flagOverrides);

  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const refDate = todayDate || (sorted.length ? sorted[sorted.length - 1].date : new Date().toISOString().split('T')[0]);

  let continuousDays = [];
  if (sorted.length > 0) {
    const mapByDate = new Map(sorted.map(d => [d.date, d]));
    const firstDate = sorted[0].date;
    const lastDate = sorted[sorted.length - 1].date > refDate ? sorted[sorted.length - 1].date : refDate;
    const span = Math.min(365, Math.max(0, diffDaysISO(firstDate, lastDate)));
    for (let i = 0; i <= span; i++) {
      const dt = addDaysISO(firstDate, i);
      continuousDays.push(mapByDate.get(dt) || { date: dt, workout: null });
    }
  } else {
    continuousDays = [{ date: refDate, workout: null }];
  }

  // Fase 2.2a: Calibrazione fattori di conversione carico omogeneo (k_hs, k_ton)
  const rawSessionMetrics = continuousDays
    .filter(d => d.workout?.completed)
    .map(d => computeSessionLoadMetrics(d.workout, cfg));
  const loadConversion = calibrateLoadConversionFactors(rawSessionMetrics, cfg);

  // Costanti di decadimento esponenziale
  // Banister / PMC: exp(-1/τ)
  const decayCtl = Math.exp(-1 / cfg.tauCtlDays);
  const decayAtl = Math.exp(-1 / cfg.tauAtlDays);
  // Williams et al. 2017 EWMA per ACWR: λ = 2 / (N + 1)
  const lambdaAcute = 2 / (cfg.acwrAcuteDays + 1);
  const lambdaChronic = 2 / (cfg.acwrChronicDays + 1);

  let ctl = 0;
  let atl = 0;
  let ewmaAcute = 0;
  let ewmaChronic = 0;

  const dailySeries = [];
  const liftHistoryByEx = new Map(); // exerciseId -> [{date, xDays, e1rm, weight, reps, rir, assumedZeroRir}]
  let anyAssumedZeroRir = false;
  let anyMissingSessionRpe = false;
  let totalCompletedSessions = 0;

  const firstDateStr = continuousDays[0].date;

  for (let i = 0; i < continuousDays.length; i++) {
    const d = continuousDays[i];
    const loadMetrics = computeSessionLoadMetrics(
      d.workout,
      cfg,
      useHomogeneousLoad ? loadConversion : null
    );
    const wLoad = loadMetrics.primaryLoad;

    if (d.workout?.completed) {
      totalCompletedSessions++;
      if (loadMetrics.loadSource !== 'sRPE') {
        anyMissingSessionRpe = true;
      }

      // Estrai il miglior e1RM (top set) per ogni esercizio nella sessione
      const exercises = Array.isArray(d.workout.exercises) ? d.workout.exercises : [];
      for (const ex of exercises) {
        if (!ex.name || (Array.isArray(ex.componenti) && ex.componenti.length > 0)) continue;
        let bestSet = null;
        for (const s of (ex.sets || [])) {
          if (s.done === false) continue;
          const weight = Number(s.weight ?? s.actual_weight) || 0;
          const reps = parseInt(s.reps ?? s.actual_reps, 10) || 0;
          if (weight <= 0 || reps <= 0) continue;

          const rirOpts = {
            rir: s.rir,
            rpe: s.rpe ?? ex.rpe ?? ex.rpe_target
          };
          const e1rmObj = useE1rmV2
            ? computeRpeTableE1RM(weight, reps, rirOpts)
            : computeEpleyE1RM(weight, reps, rirOpts);

          // Fase 2.2b: Con training.e1rmV2 attivo, usa solo serie con reps + RIR <= 12 per il trend della forza
          if (useE1rmV2 && (reps + e1rmObj.rir) > 12) {
            continue;
          }

          if (e1rmObj.assumedZeroRir) anyAssumedZeroRir = true;
          if (!bestSet || e1rmObj.e1rm > bestSet.e1rm) {
            bestSet = {
              date: d.date,
              xDays: diffDaysISO(firstDateStr, d.date),
              e1rm: e1rmObj.e1rm,
              weight,
              reps,
              rir: e1rmObj.rir,
              assumedZeroRir: e1rmObj.assumedZeroRir
            };
          }
        }
        if (bestSet) {
          if (!liftHistoryByEx.has(ex.name)) liftHistoryByEx.set(ex.name, []);
          liftHistoryByEx.get(ex.name).push(bestSet);
        }
      }
    }

    // Aggiornamento ricorsivo PMC / Banister impulse-response:
    // CTL_t = CTL_{t-1} * e^{-1/τ1} + w_t * (1 - e^{-1/τ1})
    ctl = ctl * decayCtl + wLoad * (1 - decayCtl);
    atl = atl * decayAtl + wLoad * (1 - decayAtl);
    const tsb = ctl - atl;

    // Aggiornamento EWMA per ACWR (Williams et al. 2017)
    ewmaAcute = i === 0 ? wLoad : wLoad * lambdaAcute + (1 - lambdaAcute) * ewmaAcute;
    ewmaChronic = i === 0 ? wLoad : wLoad * lambdaChronic + (1 - lambdaChronic) * ewmaChronic;
    const acwr = ewmaChronic > 5 ? Number((ewmaAcute / ewmaChronic).toFixed(2)) : null;

    dailySeries.push({
      date: d.date,
      load: wLoad,
      loadSource: loadMetrics.loadSource,
      sRPE: loadMetrics.sRPE,
      hardSetsCount: loadMetrics.hardSetsCount,
      tonnageKg: loadMetrics.tonnageKg,
      ctl: Number(ctl.toFixed(1)),
      atl: Number(atl.toFixed(1)),
      tsb: Number(tsb.toFixed(1)),
      acwr
    });
  }

  // Analisi progressione e1RM per esercizio (ultime 8 settimane = 56 giorni)
  const cutoff56Str = addDaysISO(refDate, -56);
  const cutoff21Str = addDaysISO(refDate, -21);
  const lifts = [];

  for (const [exerciseId, pts] of liftHistoryByEx.entries()) {
    const recentPts = pts.filter(p => p.date >= cutoff56Str);
    const seriesToFit = recentPts.length >= 2 ? recentPts : pts;
    const latestPt = pts[pts.length - 1];

    const reg = theilSenRegression(seriesToFit, { weightAssumedZeroRir: useE1rmV2 });
    const spanDays = seriesToFit.length >= 2
      ? diffDaysISO(seriesToFit[0].date, seriesToFit[seriesToFit.length - 1].date)
      : 0;

    // Valuta anche le ultime 3 settimane per rilevare plateau o regressione recente
    const last3wPts = pts.filter(p => p.date >= cutoff21Str);
    const reg3w = last3wPts.length >= 2 ? theilSenRegression(last3wPts, { weightAssumedZeroRir: useE1rmV2 }) : reg;

    let status = 'progress';
    if (pts.length < 2) {
      status = 'progress';
    } else if (reg3w.slopePctPerWeek < -0.6 || reg.slopePctPerWeek < -0.5) {
      status = 'regress';
    } else if (spanDays >= 18 && Math.abs(reg3w.slopePctPerWeek) <= 0.25 && reg.slopePctPerWeek <= 0.25) {
      status = 'plateau';
    }

    const forecast4w = Number(Math.max(0, latestPt.e1rm + reg.slopePerDay * 28).toFixed(1));
    const muscleInfo = resolveExerciseMuscles(exerciseId, exerciseCatalog);

    lifts.push({
      exerciseId,
      e1rm: Number(latestPt.e1rm.toFixed(1)),
      lastWeight: latestPt.weight,
      lastReps: latestPt.reps,
      lastDate: latestPt.date,
      sessionsCount: pts.length,
      trendSlopePctWeek: reg.slopePctPerWeek,
      forecast4w,
      status,
      isBigLift: !!muscleInfo.isBigLift,
      assumedZeroRir: latestPt.assumedZeroRir,
      history: pts.slice(-12)
    });
  }

  // Ordina mettendo prima i big lift e gli esercizi più frequenti
  lifts.sort((a, b) => (Number(b.isBigLift) - Number(a.isBigLift)) || (b.sessionsCount - a.sessionsCount));

  // Calibrazione Banister p(t) dopo ≥ 8 settimane se ci sono big lift
  const weeklyPerfSamples = [];
  if (continuousDays.length >= 56 && lifts.length > 0) {
    const refLifts = lifts.filter(l => l.isBigLift).length ? lifts.filter(l => l.isBigLift) : lifts.slice(0, 3);
    const baselineByLift = new Map(refLifts.map(l => [l.exerciseId, l.history[0]?.e1rm || l.e1rm]));

    for (let wStart = 0; wStart + 6 < dailySeries.length; wStart += 7) {
      const wEndDate = dailySeries[wStart + 6].date;
      const wStartDate = dailySeries[wStart].date;
      const norms = [];
      for (const l of refLifts) {
        const inWeek = (liftHistoryByEx.get(l.exerciseId) || []).filter(p => p.date >= wStartDate && p.date <= wEndDate);
        if (inWeek.length > 0) {
          const bestW = Math.max(...inWeek.map(p => p.e1rm));
          const base = baselineByLift.get(l.exerciseId) || bestW;
          if (base > 0) norms.push((bestW / base) * 100);
        }
      }
      if (norms.length > 0) {
        const daySnap = dailySeries[wStart + 6];
        weeklyPerfSamples.push({
          date: wEndDate,
          ctl: daySnap.ctl,
          atl: daySnap.atl,
          perfIndex: norms.reduce((a, b) => a + b, 0) / norms.length
        });
      }
    }
  }

  const banisterParams = fitBanisterParameters(weeklyPerfSamples, cfg);
  const latestSnap = dailySeries[dailySeries.length - 1];
  const predictedPerformance = Number(
    (banisterParams.p0 + banisterParams.k1 * latestSnap.ctl - banisterParams.k2 * latestSnap.atl).toFixed(1)
  );

  // Stato qualitativo Banister per la UI (Fase 2.2c)
  const banisterQualitativeState = latestSnap.ctl < 10
    ? { code: 'building_base', label: 'Costruzione base atletica', description: 'Stai costruendo la base di condizionamento cronico.' }
    : latestSnap.tsb >= 5 && latestSnap.tsb <= 20
      ? { code: 'optimal_form', label: 'Picco di forma (fresco e allenato)', description: 'Buona base di lavoro con fatica acuta bassa: ottimo momento per spingere sui carichi.' }
      : latestSnap.tsb >= -15 && latestSnap.tsb < 5
        ? { code: 'productive_load', label: 'Carico produttivo in corso', description: 'Stai accumulando stimolo allenante in modo sostenibile.' }
        : latestSnap.tsb < -15
          ? { code: 'accumulated_fatigue', label: 'Fatica acuta elevata', description: 'Il carico degli ultimi 7 giorni supera nettamente la tua abitudine: priorità al recupero.' }
          : { code: 'detraining_or_taper', label: 'Scarico / Riposo prolungato', description: 'Fatica azzerata; se non sei in scarico programmato, puoi riprendere gradualmente il volume.' };

  // Volume settimanale (ultimi 7 giorni) per gruppo muscolare (primario = 1.0, secondario = 0.5)
  const cutoff7Str = addDaysISO(refDate, -6);
  const weeklySetsByMuscle = {};
  for (const d of continuousDays) {
    if (d.date < cutoff7Str || d.date > refDate || !d.workout?.completed) continue;
    for (const ex of (d.workout.exercises || [])) {
      if (!ex.name || (Array.isArray(ex.componenti) && ex.componenti.length > 0)) continue;
      const validSets = (ex.sets || []).filter(s => {
        if (s.done === false) return false;
        const r = parseInt(s.reps ?? s.actual_reps, 10) || 0;
        const { rir } = resolveRIR({ rir: s.rir, rpe: s.rpe ?? ex.rpe ?? ex.rpe_target });
        return r > 0 && rir <= 3;
      }).length;
      if (validSets <= 0) continue;

      const mInfo = resolveExerciseMuscles(ex.name, exerciseCatalog);
      for (const pm of (mInfo.primary || [])) {
        weeklySetsByMuscle[pm] = Number(((weeklySetsByMuscle[pm] || 0) + validSets * 1.0).toFixed(1));
      }
      for (const sm of (mInfo.secondary || [])) {
        weeklySetsByMuscle[sm] = Number(((weeklySetsByMuscle[sm] || 0) + validSets * 0.5).toFixed(1));
      }
    }
  }

  // Fase 2.2f: Stato volume per muscolo (under / ok / over)
  const muscleVolumeStatus = evaluateMuscleVolumeStatus(
    weeklySetsByMuscle,
    profile?.volume_targets || null,
    cfg
  );

  // Fase 2.2d: Monotonia e Strain di Foster (ultimi 7 giorni)
  const fosterMetrics = computeFosterMonotonyAndStrain(dailySeries.slice(-7).map(s => s.load));

  // Fase 2.2e: Readiness trasparente a contributi espliciti
  const regressCount = lifts.filter(l => l.status === 'regress').length;
  const plateauCount = lifts.filter(l => l.status === 'plateau').length;

  // Calcola sonno medio 3gg e qualità sonno 3gg
  const last3Days = continuousDays.slice(-3);
  const sleepPts3 = last3Days.filter(d => d.sleepHours != null && Number(d.sleepHours) > 0);
  const avgSleep3d = sleepPts3.length > 0
    ? sleepPts3.reduce((s, d) => s + Number(d.sleepHours), 0) / sleepPts3.length
    : null;
  const qualPts3 = last3Days.filter(d => d.sleepQuality != null && Number(d.sleepQuality) > 0);
  const avgSleepQuality3d = qualPts3.length > 0
    ? qualPts3.reduce((s, d) => s + Number(d.sleepQuality), 0) / qualPts3.length
    : null;

  const baseReadiness = 85;
  const tsbDelta = latestSnap.ctl <= 5
    ? 0
    : latestSnap.tsb < -10
      ? -Math.round(Math.min(30, Math.abs(latestSnap.tsb + 10) * 1.1))
      : latestSnap.tsb > 5 && latestSnap.tsb <= 20
        ? +5
        : latestSnap.tsb > 25
          ? -5
          : 0;

  let sleepDelta = 0;
  if (avgSleep3d != null) {
    if (avgSleep3d < 6.5) sleepDelta -= Math.round(Math.min(18, (6.5 - avgSleep3d) * 10));
    else if (avgSleep3d >= 7.5) sleepDelta += 4;
  }
  if (avgSleepQuality3d != null) {
    if (avgSleepQuality3d < 2.5) sleepDelta -= 5;
    else if (avgSleepQuality3d >= 4) sleepDelta += 3;
  }

  const energyBalance7d = context?.energyBalance7d != null ? Number(context.energyBalance7d) : null;
  const deficitDelta = energyBalance7d != null && energyBalance7d < -550
    ? -Math.round(Math.min(12, Math.abs(energyBalance7d + 550) / 45))
    : 0;

  // ACWR con peso ridotto (max -12 punti anziché -35)
  const acwrDelta = latestSnap.acwr != null && latestSnap.acwr > 1.4
    ? -Math.round(Math.min(12, (latestSnap.acwr - 1.4) * 25))
    : 0;

  const regressionDelta = regressCount > 0
    ? -Math.min(15, regressCount * 6)
    : 0;

  const readinessV2Score = Math.max(
    15,
    Math.min(100, Math.round(baseReadiness + tsbDelta + sleepDelta + deficitDelta + acwrDelta + regressionDelta))
  );

  const readinessContributions = [
    {
      key: 'tsb',
      label: 'Bilancio Fatica/Forma (TSB)',
      delta: tsbDelta,
      value: latestSnap.tsb,
      reason: tsbDelta < 0
        ? `Fatica acuta superiore alla base cronica (TSB ${latestSnap.tsb})`
        : tsbDelta > 0
          ? `Ottima freschezza muscolare (TSB +${latestSnap.tsb})`
          : 'Equilibrio tra carico e recupero nella norma'
    },
    {
      key: 'sleep',
      label: 'Sonno ultimi 3 giorni',
      delta: sleepDelta,
      value: avgSleep3d != null ? `${avgSleep3d.toFixed(1)}h` : 'N/D',
      reason: avgSleep3d == null
        ? 'Ore di sonno non registrate negli ultimi 3 giorni'
        : sleepDelta < 0
          ? `Media sonno ridotta (${avgSleep3d.toFixed(1)}h/notte)`
          : `Buon riposo notturno (${avgSleep3d.toFixed(1)}h/notte)`
    },
    {
      key: 'deficit',
      label: 'Deficit calorico settimanale',
      delta: deficitDelta,
      value: energyBalance7d != null ? `${energyBalance7d} kcal/gg` : 'N/D',
      reason: deficitDelta < 0
        ? `Deficit energetico marcato (${energyBalance7d} kcal/gg)`
        : 'Disponibilità energetica compatibile con il recupero'
    },
    {
      key: 'acwr',
      label: 'Variazione carico settimanale (ACWR)',
      delta: acwrDelta,
      value: latestSnap.acwr ?? 'N/D',
      reason: acwrDelta < 0
        ? `Incremento rapido del carico settimanale (ACWR ${latestSnap.acwr})`
        : 'Progressione del carico graduale'
    },
    {
      key: 'regressions',
      label: 'Andamento carichi (e1RM)',
      delta: regressionDelta,
      value: `${regressCount} in calo`,
      reason: regressCount > 0
        ? `${regressCount} esercizio/i in calo di forza nelle ultime 3 settimane`
        : 'Nessun calo di forza rilevato sugli esercizi principali'
    }
  ];

  // Indice di Readiness (0–100): usa formula v2 se training.readinessV2 è attivo, altrimenti formula classica per non-regressione
  let readiness = 75;
  if (useReadinessV2) {
    readiness = latestSnap.ctl > 5 ? readinessV2Score : 75;
  } else if (latestSnap.ctl > 5) {
    const tsbPenalty = latestSnap.tsb < -15
      ? Math.min(45, Math.abs(latestSnap.tsb + 15) * 1.2)
      : (latestSnap.tsb > 25 ? 10 : 0);
    const acwrPenalty = latestSnap.acwr != null && latestSnap.acwr > 1.35
      ? Math.min(35, (latestSnap.acwr - 1.35) * 60)
      : 0;
    readiness = Math.max(15, Math.min(100, Math.round(88 - tsbPenalty - acwrPenalty)));
  }

  // Fase 2.2g: Suggerimenti di doppia progressione deterministica
  const doubleProgressionSuggestions = computeDoubleProgressionSuggestions({
    days: continuousDays,
    program,
    exerciseCatalog
  });

  // Rilevamento necessità di scarico (deloadSuggested)
  const highFatigue = latestSnap.tsb < -20 || (latestSnap.acwr != null && latestSnap.acwr > 1.5);
  const deloadSuggested = (regressCount >= 2 && latestSnap.tsb < -10) ||
                          (highFatigue && (regressCount >= 1 || plateauCount >= 2));

  // Avvisi, disclaimer metodologici e requisiti dati mancanti
  const warnings = [
    "Nota metodologica: l'ACWR (EWMA 7/28, Williams et al. 2017) è un indicatore descrittivo discusso del rapporto carico acuto/cronico, non una diagnosi né un predittore medico di infortunio."
  ];
  const missingDataRequirements = [];

  if (totalCompletedSessions < 4) {
    const needed = Math.max(1, (4 - totalCompletedSessions) * 2);
    warnings.push(`Stima preliminare del carico: registrate solo ${totalCompletedSessions} sessioni. Servono almeno 2-4 settimane di allenamenti per stabilizzare CTL e ACWR.`);
    missingDataRequirements.push({
      feature: 'Modello Fitness-Fatigue (CTL/ATL) e ACWR',
      missing: 'Sessioni di allenamento completate con RPE e durata',
      daysNeeded: needed
    });
  }
  if (anyMissingSessionRpe) {
    warnings.push('Alcune sessioni non avevano un RPE globale di sessione: il carico è stato stimato dalle serie allenanti (RIR ≤ 3) o dal tonnellaggio.');
  }
  if (anyAssumedZeroRir) {
    warnings.push('In alcune serie mancava il RIR/RPE: è stato assunto RIR = 0 nella formula di Epley per l\'e1RM.');
  }
  if (latestSnap.acwr != null && latestSnap.acwr > 1.5) {
    warnings.push(`ACWR elevato (${latestSnap.acwr}): il carico acuto (7gg) supera di oltre il 50% la media cronica (28gg). Valuta di moderare il volume.`);
  } else if (latestSnap.acwr != null && latestSnap.acwr < 0.8 && latestSnap.ctl > 15) {
    warnings.push(`ACWR basso (${latestSnap.acwr}): fase di sottocarico o scarico rispetto allo storico recente.`);
  }

  const confidence = Math.max(
    10,
    Math.min(
      100,
      Math.round(
        Math.min(50, totalCompletedSessions * 4) +
        (anyMissingSessionRpe ? 15 : 25) +
        (anyAssumedZeroRir ? 10 : 25)
      )
    )
  );

  const confidenceScore = Number((confidence / 100).toFixed(2));
  const rpeCoverage = totalCompletedSessions > 0
    ? (anyMissingSessionRpe ? 0.5 : 1.0)
    : 0;

  return {
    model_version: 'training@2.0',
    date: latestSnap.date,
    ctl: latestSnap.ctl,
    atl: latestSnap.atl,
    tsb: latestSnap.tsb,
    acwr: latestSnap.acwr,
    acwrZone: latestSnap.acwr == null ? 'insufficient_data'
      : latestSnap.acwr < 0.8 ? 'underload'
      : latestSnap.acwr <= 1.3 ? 'optimal'
      : latestSnap.acwr <= 1.5 ? 'caution'
      : 'high_risk',
    monotony: fosterMetrics.monotony,
    strain: fosterMetrics.strain,
    weeklyLoad: fosterMetrics.weeklyLoad,
    readiness,
    readinessV2Score,
    readinessContributions,
    predictedPerformance,
    banisterParams,
    banisterQualitativeState,
    load_conversion: loadConversion,
    lifts,
    weeklySetsByMuscle,
    muscleVolumeStatus,
    doubleProgressionSuggestions,
    deloadSuggested,
    confidence,
    confidenceScore,
    dataQuality: {
      daysLogged: totalCompletedSessions,
      weighIns: null,
      rpeCoverage,
      missingFields: missingDataRequirements.map(m => m.missing)
    },
    totalCompletedSessions,
    missingDataRequirements,
    warnings,
    history: dailySeries
  };
}

