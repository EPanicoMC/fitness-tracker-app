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

export const TRAINING_MODEL_DEFAULTS = {
  tauCtlDays: 42,
  tauAtlDays: 7,
  acwrAcuteDays: 7,
  acwrChronicDays: 28,
  defaultSessionDurationMin: 60,
  defaultHardSetFactor: 18, // unità di carico equivalente per serie allenante se mancano durata/sRPE
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
 * Anagrafica esercizi predefinita con muscoli primari (peso 1.0) e secondari (peso 0.5).
 * Espandibile con il catalogo utente salvato su Firestore.
 */
export const DEFAULT_EXERCISE_CATALOG = {
  'Hack squat': { primary: ['quadricipiti'], secondary: ['glutei'], isBigLift: true },
  'Pressa 45 gradi': { primary: ['quadricipiti'], secondary: ['glutei'], isBigLift: true },
  'Bulgarian split squat manubri': { primary: ['quadricipiti', 'glutei'], secondary: ['femorali'], isBigLift: false },
  'Leg extension': { primary: ['quadricipiti'], secondary: [], isBigLift: false },
  'Stacco rumeno manubri': { primary: ['femorali', 'glutei'], secondary: ['dorso_orizzontale'], isBigLift: true },
  'Leg curl seduto': { primary: ['femorali'], secondary: ['polpacci'], isBigLift: false },
  'Leg curl sdraiato': { primary: ['femorali'], secondary: ['polpacci'], isBigLift: false },
  'Trazioni alla sbarra': { primary: ['dorso_verticale'], secondary: ['bicipiti', 'delt_posteriore'], isBigLift: true },
  'Lat machine presa neutra media': { primary: ['dorso_verticale'], secondary: ['bicipiti'], isBigLift: true },
  'Row machine appoggio pettorale': { primary: ['dorso_orizzontale'], secondary: ['delt_posteriore', 'bicipiti'], isBigLift: true },
  'Rematore singolo manubrio': { primary: ['dorso_orizzontale'], secondary: ['bicipiti', 'delt_posteriore'], isBigLift: false },
  'Panca piana manubri': { primary: ['petto'], secondary: ['tricipiti', 'deltoide_anteriore'], isBigLift: true },
  'Chest press machine': { primary: ['petto'], secondary: ['tricipiti', 'deltoide_anteriore'], isBigLift: true },
  'Alzate laterali ai cavi': { primary: ['deltoide_laterale'], secondary: [], isBigLift: false },
  'Alzate laterali manubri seduto schienale 80 gradi': { primary: ['deltoide_laterale'], secondary: [], isBigLift: false },
  'Incline side-lying lateral raise': { primary: ['deltoide_laterale'], secondary: [], isBigLift: false },
  'Face pull ai cavi': { primary: ['delt_posteriore'], secondary: ['dorso_orizzontale'], isBigLift: false },
  'Reverse pec deck': { primary: ['delt_posteriore'], secondary: ['dorso_orizzontale'], isBigLift: false },
  'Calf in piedi': { primary: ['polpacci'], secondary: [], isBigLift: false },
  'Calf alla pressa': { primary: ['polpacci'], secondary: [], isBigLift: false },
  'Superset: Curl EZ + French press ai cavi': { primary: ['bicipiti', 'tricipiti'], secondary: [], isBigLift: false },
  'Superset: Spider curl + Pushdown corda': { primary: ['bicipiti', 'tricipiti'], secondary: [], isBigLift: false }
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
  if (w <= 0 || r <= 0) return { e1rm: 0, rir: 0, assumedZeroRir: false };

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
    assumedZeroRir
  };
}

/**
 * Calcola tutti i descrittori di carico di una singola sessione (in ordine di preferenza):
 *   1. sRPE (Foster et al. 2001) = RPE_sessione (CR-10) × durata_minuti
 *   2. hardSetsLoad = serie allenanti (RIR ≤ 3 o completate) × fattore
 *   3. tonnageKg = Σ (carico × reps)
 * Restituisce tutti i valori disponibili più `primaryLoad` (in unità arbitrarie comparabili a sRPE AU).
 */
export function computeSessionLoadMetrics(workout, config = TRAINING_MODEL_DEFAULTS) {
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
  const hardSetsLoad = Math.round(hardSetsCount * (config.defaultHardSetFactor || 18));
  const normalizedTonnageLoad = tonnageKg > 0 ? Math.round(tonnageKg / 25) : 0;

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
 * Stimatore robusto di Theil-Sen (Theil 1950; Sen 1968):
 * Calcola la mediana di tutte le pendenze (y_j - y_i) / (x_j - x_i) per i < j.
 * Ritorna { slopePerDay, intercept, slopePctPerWeek }.
 */
export function theilSenRegression(points) {
  if (!points || points.length < 2) {
    const y0 = Number(points?.[0]?.y ?? points?.[0]?.e1rm) || 0;
    return { slopePerDay: 0, intercept: y0, slopePctPerWeek: 0 };
  }
  const normPts = points.map((p, idx) => ({
    xDays: p.xDays != null ? Number(p.xDays) : idx,
    y: Number(p.y ?? p.e1rm) || 0
  }));
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

  // Intercetta mediana: median(y_i - slope * x_i)
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

/**
 * Calibrazione vincolata e regolarizzata (Ridge / Tikhonov) dei parametri di Banister
 *   p(t) = p_0 + k_1 · CTL(t) − k_2 · ATL(t)
 * contro i valori iniziali (k1_0, k2_0) quando sono disponibili ≥ 8 settimane di dati
 * con misurazioni di performance (indice composito e1RM normalizzato a base 100).
 * Impone i vincoli fisiologici k_1 ≥ 0.01, k_2 ≥ k_1 (Busso 2003).
 */
export function fitBanisterParameters(samples, config = TRAINING_MODEL_DEFAULTS) {
  const k1Prior = config.defaultK1 || 0.08;
  const k2Prior = config.defaultK2 || 0.12;
  const p0Prior = 100;

  if (!samples || samples.length < 8) {
    return { p0: p0Prior, k1: k1Prior, k2: k2Prior, calibrated: false };
  }

  // Grid-search / coordinate descent vincolato con regolarizzazione L2 verso i prior
  const lambda = config.regularizationLambda || 5.0;
  let bestP0 = p0Prior, bestK1 = k1Prior, bestK2 = k2Prior;
  let bestLoss = Infinity;

  const meanPerf = samples.reduce((s, x) => s + x.perfIndex, 0) / samples.length;

  for (let k1 = 0.02; k1 <= 0.30; k1 += 0.01) {
    for (let k2 = k1; k2 <= 0.45; k2 += 0.01) {
      // p0 ottimo analitico per k1, k2 fissati
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

  return { p0: bestP0, k1: bestK1, k2: bestK2, calibrated: true };
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
 * @param {Array<{date:string, workout?:Object|null}>} params.days
 * @param {Object} [params.exerciseCatalog] mappa custom esercizio -> {primary[], secondary[], isBigLift}
 * @param {string} [params.todayDate]
 * @param {Object} [params.config]
 */
export function runTrainingModel({
  days = [],
  exerciseCatalog = {},
  todayDate = null,
  config = {}
} = {}) {
  const cfg = { ...TRAINING_MODEL_DEFAULTS, ...config };
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
    const loadMetrics = computeSessionLoadMetrics(d.workout, cfg);
    const wLoad = loadMetrics.primaryLoad;

    if (d.workout?.completed) {
      totalCompletedSessions++;
      if (loadMetrics.loadSource !== 'sRPE') {
        anyMissingSessionRpe = true;
      }

      // Estrai il miglior e1RM per ogni esercizio nella sessione
      const exercises = Array.isArray(d.workout.exercises) ? d.workout.exercises : [];
      for (const ex of exercises) {
        if (!ex.name || (Array.isArray(ex.componenti) && ex.componenti.length > 0)) continue;
        let bestSet = null;
        for (const s of (ex.sets || [])) {
          if (s.done === false) continue;
          const weight = Number(s.weight ?? s.actual_weight) || 0;
          const reps = parseInt(s.reps ?? s.actual_reps, 10) || 0;
          if (weight <= 0 || reps <= 0) continue;
          const e1rmObj = computeEpleyE1RM(weight, reps, {
            rir: s.rir,
            rpe: s.rpe ?? ex.rpe ?? ex.rpe_target
          });
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

    const reg = theilSenRegression(seriesToFit);
    const spanDays = seriesToFit.length >= 2
      ? diffDaysISO(seriesToFit[0].date, seriesToFit[seriesToFit.length - 1].date)
      : 0;

    // Valuta anche le ultime 3 settimane per rilevare plateau o regressione recente
    const last3wPts = pts.filter(p => p.date >= cutoff21Str);
    const reg3w = last3wPts.length >= 2 ? theilSenRegression(last3wPts) : reg;

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

  // Indice di Readiness (0–100) basato su TSB e ACWR
  let readiness = 75;
  if (latestSnap.ctl > 5) {
    // TSB ideale per performance/allenamento produttivo: tra -10 e +15
    const tsbPenalty = latestSnap.tsb < -15
      ? Math.min(45, Math.abs(latestSnap.tsb + 15) * 1.2)
      : (latestSnap.tsb > 25 ? 10 : 0);
    const acwrPenalty = latestSnap.acwr != null && latestSnap.acwr > 1.35
      ? Math.min(35, (latestSnap.acwr - 1.35) * 60)
      : 0;
    readiness = Math.max(15, Math.min(100, Math.round(88 - tsbPenalty - acwrPenalty)));
  }

  // Rilevamento necessità di scarico (deloadSuggested)
  const regressCount = lifts.filter(l => l.status === 'regress').length;
  const plateauCount = lifts.filter(l => l.status === 'plateau').length;
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

  return {
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
    readiness,
    predictedPerformance,
    banisterParams,
    lifts,
    weeklySetsByMuscle,
    deloadSuggested,
    confidence,
    totalCompletedSessions,
    missingDataRequirements,
    warnings,
    history: dailySeries
  };
}
