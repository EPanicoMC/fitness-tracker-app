/**
 * predictive-core.js — Orchestratore Dati, Persistenza Firestore/Offline, Calcolo Incrementale e Demo Seed (90gg)
 *
 * Collega lo schema dati reale della PWA (`daily_logs`, `checks`, `settings/app`, `workout_plan`)
 * ai moduli deterministici puri:
 *   • `js/energy-model.js` (Modello 1: Filtro di Kalman 2D Peso + TDEE, Hall Lancet 2011 forecast)
 *   • `js/training-model.js` (Modello 2: Banister PMC CTL/ATL/TSB, EWMA ACWR, Epley e1RM + Theil-Sen, Volume)
 *   • `js/coach-rules.js` (Motore di regole incrociate deterministico)
 *   • `js/gemini.js` (Fase 5: Strato Coach Gemini Flash con schema JSON fisso e fallback offline)
 *
 * Persistenza (Firestore + localStorage offline-first):
 *   • `users/{uid}/model_daily_snapshots/{date}`
 *   • `users/{uid}/model_params/current`
 *   • `users/{uid}/insights/{date}`
 *   • `users/{uid}/coach_reports/{hash}`
 */

import { db, doc, setDoc, getDoc, getDocs, collection } from './firebase-config.js';
import { getCurrentUser } from './auth.js';
import { getTodayStr } from './app.js';
import { runEnergyBalanceModel, addDaysISO, diffDaysISO } from './energy-model.js';
import { runTrainingModel, DEFAULT_EXERCISE_CATALOG } from './training-model.js';
import { evaluateCrossRules, buildDeterministicCoachFallback } from './coach-rules.js';
import { generatePredictiveCoachAI, parseMissingDataWithAI } from './gemini.js';

const LOCAL_SNAPSHOT_CACHE_KEY = 'fittracker_predictive_state_v1';
const LOCAL_COACH_WEEKLY_KEY = 'fittracker_coach_weekly_meta_v1';

function getUid() {
  return getCurrentUser() || 'default_user';
}

/**
 * Normalizza i dati grezzi della PWA (`daily_logs`, `checks`, `settings`) nelle serie giornaliere
 * richieste da Modello 1 e Modello 2.
 */
export function normalizeLogsForModels({
  dailyLogs = [],
  checks = [],
  settings = {},
  todayStr = null
} = {}) {
  const refToday = todayStr || getTodayStr();
  const byDate = new Map();

  const ensureDay = (dateStr) => {
    if (!byDate.has(dateStr)) {
      byDate.set(dateStr, {
        date: dateStr,
        weightKg: null,
        waistCm: null,
        bodyFatPct: null,
        intakeKcal: null,
        proteinG: null,
        carbsG: null,
        fatsG: null,
        intakeComplete: null,
        steps: null,
        sleepHours: null,
        sleepQuality: null,
        anomalous: false,
        workout: null
      });
    }
    return byDate.get(dateStr);
  };

  // 1. Popola da checks (pesate dedicate, circonferenza vita, %BF)
  for (const ch of (checks || [])) {
    const dt = ch.date || ch.id;
    if (!dt || typeof dt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dt)) continue;
    const rec = ensureDay(dt);
    if (ch.weight != null && Number(ch.weight) > 25) rec.weightKg = Number(ch.weight);
    if (ch.waist != null && Number(ch.waist) > 30) rec.waistCm = Number(ch.waist);
    if (ch.body_fat != null && Number(ch.body_fat) > 2) rec.bodyFatPct = Number(ch.body_fat);
  }

  // 2. Popola da daily_logs (nutrizione, peso giornaliero, passi, sonno, flag giornata completa, workout)
  for (const log of (dailyLogs || [])) {
    const dt = log.date || log.id;
    if (!dt || typeof dt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dt)) continue;
    const rec = ensureDay(dt);

    if (log.weight_kg != null && Number(log.weight_kg) > 25) {
      rec.weightKg = Number(log.weight_kg);
    }
    if (log.waist_cm != null && Number(log.waist_cm) > 30) {
      rec.waistCm = Number(log.waist_cm);
    }
    if (log.steps != null && Number(log.steps) >= 0) {
      rec.steps = Number(log.steps);
    }
    if (log.sleep_hours != null && Number(log.sleep_hours) > 0) {
      rec.sleepHours = Number(log.sleep_hours);
    }
    if (log.sleep_quality != null && Number(log.sleep_quality) >= 1) {
      rec.sleepQuality = Number(log.sleep_quality);
    }
    if (log.anomalous_day === true) {
      rec.anomalous = true;
    }

    // Estrai kcal e macro da nutrition.totals o calcola dai pasti
    const totals = log.nutrition?.totals;
    let kcal = totals?.kcal != null ? Number(totals.kcal) : null;
    let pro = totals?.protein != null ? Number(totals.protein) : null;
    let carbs = totals?.carbs != null ? Number(totals.carbs) : null;
    let fats = totals?.fats != null ? Number(totals.fats) : null;

    if ((kcal == null || kcal === 0) && log.nutrition?.meals) {
      let sumK = 0, sumP = 0, sumC = 0, sumF = 0;
      for (const mItems of Object.values(log.nutrition.meals)) {
        if (!Array.isArray(mItems)) continue;
        for (const it of mItems) {
          sumK += Number(it.kcal) || 0;
          sumP += Number(it.protein) || 0;
          sumC += Number(it.carbs) || 0;
          sumF += Number(it.fats) || 0;
        }
      }
      if (sumK > 0) {
        kcal = Math.round(sumK);
        pro = Number(sumP.toFixed(1));
        carbs = Number(sumC.toFixed(1));
        fats = Number(sumF.toFixed(1));
      }
    }

    if (kcal != null && kcal > 0) {
      rec.intakeKcal = kcal;
      rec.proteinG = pro;
      rec.carbsG = carbs;
      rec.fatsG = fats;
    }

    // Flag "giornata registrata completamente": esplicito ('yes' | 'partial' | 'no') o derivato
    if (['yes', 'partial', 'no'].includes(log.diary_complete)) {
      rec.intakeComplete = log.diary_complete;
    } else if (['yes', 'partial', 'no'].includes(log.nutrition?.diary_complete)) {
      rec.intakeComplete = log.nutrition.diary_complete;
    } else if (kcal != null && kcal > 0) {
      // Se ci sono >= 800 kcal registrate, considera 'yes', tra 1 e 799 'partial'
      rec.intakeComplete = kcal >= 800 ? 'yes' : 'partial';
    } else {
      rec.intakeComplete = 'no';
    }

    if (log.workout && log.workout.completed) {
      rec.workout = log.workout;
    }
  }

  const allDays = Array.from(byDate.values())
    .filter(d => d.date <= refToday)
    .sort((a, b) => a.date.localeCompare(b.date));

  return allDays;
}

/**
 * Costruisce il riepilogo settimanale aggregato delle ultime 4 settimane per il payload compatto Coach.
 */
export function computeLast4WeeksSummary(allDays, energyHistory = [], trainingHistory = [], refToday = null) {
  const today = refToday || getTodayStr();
  const energyByDate = new Map((energyHistory || []).map(s => [s.date, s]));
  const trainByDate = new Map((trainingHistory || []).map(s => [s.date, s]));
  const rawByDate = new Map((allDays || []).map(d => [d.date, d]));

  const weeks = [];
  for (let w = 3; w >= 0; w--) {
    const endDay = addDaysISO(today, -w * 7);
    const startDay = addDaysISO(endDay, -6);
    let sumKcal = 0, countKcal = 0;
    let sumPro = 0, countPro = 0;
    let sumSteps = 0, countSteps = 0;
    let workoutsDone = 0;
    let startTrendW = null, endTrendW = null;

    for (let d = 0; d < 7; d++) {
      const dt = addDaysISO(startDay, d);
      const raw = rawByDate.get(dt);
      const en = energyByDate.get(dt);
      if (en?.trendWeight != null) {
        if (startTrendW == null) startTrendW = en.trendWeight;
        endTrendW = en.trendWeight;
      }
      if (raw?.intakeKcal != null && raw.intakeComplete !== 'no') {
        sumKcal += raw.intakeKcal;
        countKcal++;
      }
      if (raw?.proteinG != null && raw.proteinG > 0) {
        sumPro += raw.proteinG;
        countPro++;
      }
      if (raw?.steps != null && raw.steps > 0) {
        sumSteps += raw.steps;
        countSteps++;
      }
      if (raw?.workout?.completed) {
        workoutsDone++;
      }
    }

    const endTrain = trainByDate.get(endDay);
    weeks.push({
      weekRange: `${startDay}..${endDay}`,
      avgKcal: countKcal > 0 ? Math.round(sumKcal / countKcal) : null,
      avgProteinG: countPro > 0 ? Math.round(sumPro / countPro) : null,
      loggedDays: countKcal,
      avgSteps: countSteps > 0 ? Math.round(sumSteps / countSteps) : null,
      workoutsDone,
      trendWeightEnd: endTrendW,
      weightDeltaKg: (startTrendW != null && endTrendW != null) ? Number((endTrendW - startTrendW).toFixed(2)) : null,
      ctlEnd: endTrain?.ctl ?? null,
      tsbEnd: endTrain?.tsb ?? null,
      acwrEnd: endTrain?.acwr ?? null
    });
  }
  return weeks;
}

/**
 * Esegue l'intera pipeline predittiva deterministica (Modello 1 + Modello 2 + Regole Incrociate)
 * e salva gli snapshot in cache locale + Firestore (in background).
 */
export async function runPredictivePipeline({
  dailyLogs = null,
  checks = null,
  settings = null,
  persistToFirestore = true
} = {}) {
  const uid = getUid();
  const todayStr = getTodayStr();

  // Carica da Firestore/cache se non passati dal chiamante
  let logsArr = dailyLogs;
  let checksArr = checks;
  let profileObj = settings;

  if (!logsArr || !checksArr || !profileObj) {
    try {
      const [logsSnap, checksSnap, settingsSnap] = await Promise.all([
        logsArr ? null : getDocs(collection(db, 'users', uid, 'daily_logs')),
        checksArr ? null : getDocs(collection(db, 'users', uid, 'checks')),
        profileObj ? null : getDoc(doc(db, 'users', uid, 'settings', 'app'))
      ]);
      if (!logsArr && logsSnap) {
        logsArr = [];
        logsSnap.forEach(d => logsArr.push({ id: d.id, ...d.data() }));
      }
      if (!checksArr && checksSnap) {
        checksArr = [];
        checksSnap.forEach(d => checksArr.push({ id: d.id, ...d.data() }));
      }
      if (!profileObj && settingsSnap?.exists()) {
        profileObj = settingsSnap.data();
      }
    } catch (err) {
      console.warn('[PredictiveCore] Lettura Firestore non disponibile, uso cache locale:', err?.message);
    }
  }

  logsArr = logsArr || [];
  checksArr = checksArr || [];
  const rawSettings = profileObj || {};
  profileObj = { ...(rawSettings.profile || {}), ...rawSettings };

  const normalizedDays = normalizeLogsForModels({
    dailyLogs: logsArr,
    checks: checksArr,
    settings: profileObj,
    todayStr
  });

  // 1. Esegui Modello 1 (Bilancio Energetico & Previsione Peso)
  const energyOutput = runEnergyBalanceModel({
    days: normalizedDays,
    profile: profileObj,
    todayDate: todayStr
  });

  // 2. Esegui Modello 2 (Fitness-Fatigue PMC, ACWR EWMA, e1RM Epley + Theil-Sen, Volume Muscolare)
  const customCatalog = profileObj.exercise_catalog || DEFAULT_EXERCISE_CATALOG;
  const trainingOutput = runTrainingModel({
    days: normalizedDays,
    exerciseCatalog: customCatalog,
    todayDate: todayStr
  });

  // 3. Contesto aggiuntivo per il motore di regole (sonno, passi, proteine ultimi 7gg)
  const last7Raw = normalizedDays.slice(-7);
  const sleepDays = last7Raw.filter(d => d.sleepHours != null && d.sleepHours > 0);
  const avgSleep7d = sleepDays.length > 0
    ? Number((sleepDays.reduce((s, d) => s + d.sleepHours, 0) / sleepDays.length).toFixed(1))
    : null;
  const stepDays = last7Raw.filter(d => d.steps != null && d.steps > 0);
  const avgSteps7d = stepDays.length > 0
    ? Math.round(stepDays.reduce((s, d) => s + d.steps, 0) / stepDays.length)
    : null;

  // 4. Motore di regole incrociate deterministico
  const insights = evaluateCrossRules({
    energyOutput,
    trainingOutput,
    context: {
      avgSleep7d,
      avgSteps7d,
      stepsGoal: Number(profileObj.steps_goal) || 10000
    }
  });

  // 5. Ultime 4 settimane aggregate
  const weeklySummary4w = computeLast4WeeksSummary(
    normalizedDays,
    energyOutput.history,
    trainingOutput.history,
    todayStr
  );

  // 6. Coach deterministico immediato (sincrono/offline)
  const deterministicCoach = buildDeterministicCoachFallback({
    energyOutput,
    trainingOutput,
    insights
  });

  const result = {
    date: todayStr,
    energyOutput,
    trainingOutput,
    insights,
    weeklySummary4w,
    deterministicCoach,
    profile: profileObj,
    normalizedDaysCount: normalizedDays.length,
    computedAt: new Date().toISOString()
  };

  result.missingAssistant = inspectMissingAndSmartDefaults(result, logsArr);

  // Salva in localStorage per funzionamento 100% offline
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(`${LOCAL_SNAPSHOT_CACHE_KEY}_${uid}`, JSON.stringify({
        date: todayStr,
        energyOutput: { ...energyOutput, history: energyOutput.history.slice(-90) },
        trainingOutput: { ...trainingOutput, history: trainingOutput.history.slice(-90) },
        insights,
        weeklySummary4w,
        deterministicCoach,
        computedAt: result.computedAt
      }));
    } catch (_) {}
  }

  // Persistenza asincrona su Firestore (tabelle model_daily_snapshots, model_params, insights)
  if (persistToFirestore && uid && typeof navigator !== 'undefined' && navigator.onLine !== false) {
    persistModelsToFirestore(uid, result).catch(e => {
      console.warn('[PredictiveCore] Salvataggio background Firestore fallito:', e?.message);
    });
  }

  return result;
}

/**
 * Salva lo snapshot giornaliero, i parametri calibrati dei modelli e gli insight su Firestore.
 */
async function persistModelsToFirestore(uid, result) {
  const { date, energyOutput, trainingOutput, insights } = result;
  const snapDoc = {
    date,
    trendWeight: energyOutput.trendWeight,
    rawWeight: energyOutput.rawWeight,
    tdeeEstimate: energyOutput.tdeeEstimate,
    tdeeCI: energyOutput.tdeeCI,
    avgIntake7d: energyOutput.avgIntake7d,
    energyBalance7d: energyOutput.energyBalance7d,
    weeklyRateKg: energyOutput.weeklyRateKg,
    weeklyRatePct: energyOutput.weeklyRatePct,
    recommendedKcal: energyOutput.recommendedKcal,
    recommendedMacros: energyOutput.recommendedMacros,
    etaGoalDate: energyOutput.etaGoalDate,
    confidence: energyOutput.confidence,
    ctl: trainingOutput.ctl,
    atl: trainingOutput.atl,
    tsb: trainingOutput.tsb,
    acwr: trainingOutput.acwr,
    readiness: trainingOutput.readiness,
    predictedPerformance: trainingOutput.predictedPerformance,
    deloadSuggested: trainingOutput.deloadSuggested,
    weeklySetsByMuscle: trainingOutput.weeklySetsByMuscle,
    updatedAt: new Date().toISOString()
  };

  const paramsDoc = {
    date,
    kalmanState: energyOutput.kalmanState
      ? {
          x: energyOutput.kalmanState.x,
          P_row0: energyOutput.kalmanState.P[0],
          P_row1: energyOutput.kalmanState.P[1]
        }
      : null,
    banisterParams: trainingOutput.banisterParams || null,
    updatedAt: new Date().toISOString()
  };

  const insightsDoc = {
    date,
    items: insights,
    updatedAt: new Date().toISOString()
  };

  await Promise.all([
    setDoc(doc(db, 'users', uid, 'model_daily_snapshots', date), snapDoc, { merge: true }),
    setDoc(doc(db, 'users', uid, 'model_params', 'current'), paramsDoc, { merge: true }),
    setDoc(doc(db, 'users', uid, 'insights', date), insightsDoc, { merge: true })
  ]);
}

/**
 * Gestisce lo Strato Coach con Gemini:
 * - Massimo 1 chiamata automatica a settimana (es. cambio settimana ISO)
 * - Chiamata manuale quando l'utente clicca "Chiedi al coach" o invia una domanda libera
 * - Salva il report in `users/{uid}/coach_reports/{inputHash}` e in cache locale
 */
export async function getOrGenerateCoachReport(pipelineResult, {
  userQuestion = '',
  manualTrigger = false,
  forceRefresh = false
} = {}) {
  const uid = getUid();
  const todayStr = pipelineResult?.date || getTodayStr();
  const currentIsoWeek = getIsoWeekKey(todayStr);

  // Controlla se abbiamo già fatto la chiamata automatica di questa settimana
  let weeklyMeta = {};
  if (typeof localStorage !== 'undefined') {
    try {
      weeklyMeta = JSON.parse(localStorage.getItem(`${LOCAL_COACH_WEEKLY_KEY}_${uid}`) || '{}');
    } catch (_) {}
  }

  const shouldCallGemini = manualTrigger || forceRefresh || (weeklyMeta.lastAutoWeek !== currentIsoWeek);

  if (!shouldCallGemini && weeklyMeta.lastReport) {
    return { ...weeklyMeta.lastReport, cachedWeekly: true };
  }

  const report = await generatePredictiveCoachAI({
    energyOutput: pipelineResult.energyOutput,
    trainingOutput: pipelineResult.trainingOutput,
    insights: pipelineResult.insights,
    weeklySummary4w: pipelineResult.weeklySummary4w,
    profile: pipelineResult.profile,
    userQuestion,
    forceRefresh
  });

  if (typeof localStorage !== 'undefined' && !userQuestion) {
    try {
      localStorage.setItem(`${LOCAL_COACH_WEEKLY_KEY}_${uid}`, JSON.stringify({
        lastAutoWeek: currentIsoWeek,
        lastReport: report,
        updatedAt: new Date().toISOString()
      }));
    } catch (_) {}
  }

  // Salva su Firestore `coach_reports`
  if (uid && report.inputHash && typeof navigator !== 'undefined' && navigator.onLine !== false) {
    setDoc(doc(db, 'users', uid, 'coach_reports', report.inputHash), {
      ...report,
      date: todayStr,
      isoWeek: currentIsoWeek
    }, { merge: true }).catch(() => {});
  }

  return report;
}

function getIsoWeekKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Genera e salva (o restituisce in memoria) 90 giorni di dati sintetici realistici ("Seed Demo 90gg")
 * per testare immediatamente grafici, filtro di Kalman, PMC Banister, e1RM e Coach.
 */
export async function generateDemo90DaysData({ persistToFirestore = false } = {}) {
  const todayStr = getTodayStr();
  const demoLogs = [];
  const demoChecks = [];

  // PRNG deterministico
  let s = 90210;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const gauss = (mean, std) => {
    const u1 = Math.max(1e-6, rand());
    const u2 = rand();
    return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  let trueWeight = 82.4;
  let trueTdee = 2580;

  for (let i = 89; i >= 0; i--) {
    const dt = addDaysISO(todayStr, -i);
    const dayIdx = 89 - i; // 0..89
    const dow = new Date(dt + 'T12:00:00Z').getUTCDay(); // 0=Dom..6=Sab

    // Adattamento metabolico graduale (~22 kcal/kg perso)
    trueTdee = 2580 - (82.4 - trueWeight) * 22;

    // Intake medio ~2080 kcal (deficit ~450-500 kcal), con refeed domenicale
    const isRefeed = dow === 0 && dayIdx % 14 === 0;
    const intakeKcal = isRefeed
      ? Math.round(gauss(2650, 90))
      : Math.round(gauss(2060, 85));
    const proteinG = Math.round(gauss(172, 10));
    const fatsG = Math.round(gauss(62, 6));
    const carbsG = Math.max(80, Math.round((intakeKcal - proteinG * 4 - fatsG * 9) / 4));

    trueWeight += (intakeKcal - trueTdee) / 7700;

    // Spike d'acqua post-refeed (+1.4 kg) o rumore fisiologico mattutino (σ = 0.35 kg)
    const waterSpike = (dow === 1 && (dayIdx - 1) % 14 === 0) ? 1.35 : 0;
    const measuredWeight = Number((trueWeight + waterSpike + gauss(0, 0.32)).toFixed(1));

    // Allenamento 4 volte a settimana (Lun=1, Mar=2, Gio=4, Ven=5)
    let workout = null;
    const weekNum = Math.floor(dayIdx / 7);
    if ([1, 2, 4, 5].includes(dow)) {
      const isUpper = dow === 1 || dow === 4;
      const rpeSession = Number(Math.min(9.5, Math.max(6.5, 7.2 + (weekNum % 4) * 0.4 + gauss(0, 0.2))).toFixed(1));
      const durMin = Math.round(gauss(64, 6));

      const exercises = isUpper
        ? [
            {
              name: 'Panca piana manubri',
              rpe: Math.round(rpeSession),
              sets: [
                { weight: 32 + Math.floor(weekNum / 2) * 2, reps: 8 + (weekNum % 2), rir: 2, done: true },
                { weight: 32 + Math.floor(weekNum / 2) * 2, reps: 8, rir: 2, done: true },
                { weight: 32 + Math.floor(weekNum / 2) * 2, reps: 7, rir: 1, done: true }
              ]
            },
            {
              name: 'Lat machine presa neutra media',
              rpe: 8,
              sets: [
                { weight: 65 + Math.floor(weekNum / 3) * 2.5, reps: 10, rir: 2, done: true },
                { weight: 65 + Math.floor(weekNum / 3) * 2.5, reps: 10, rir: 2, done: true },
                { weight: 65 + Math.floor(weekNum / 3) * 2.5, reps: 9, rir: 1, done: true }
              ]
            },
            {
              name: 'Row machine appoggio pettorale',
              rpe: 8,
              sets: [
                { weight: 60 + Math.floor(weekNum / 3) * 2.5, reps: 10, rir: 2, done: true },
                { weight: 60 + Math.floor(weekNum / 3) * 2.5, reps: 10, rir: 1, done: true },
                { weight: 60 + Math.floor(weekNum / 3) * 2.5, reps: 9, rir: 1, done: true }
              ]
            },
            {
              name: 'Alzate laterali ai cavi',
              rpe: 9,
              sets: [
                { weight: 12.5, reps: 14, rir: 1, done: true },
                { weight: 12.5, reps: 13, rir: 1, done: true },
                { weight: 12.5, reps: 12, rir: 0, done: true }
              ]
            }
          ]
        : [
            {
              name: 'Hack squat',
              rpe: Math.round(rpeSession),
              sets: [
                { weight: 110 + weekNum * 2.5, reps: 8, rir: 2, done: true },
                { weight: 110 + weekNum * 2.5, reps: 8, rir: 2, done: true },
                { weight: 110 + weekNum * 2.5, reps: 7, rir: 1, done: true }
              ]
            },
            {
              name: 'Stacco rumeno manubri',
              rpe: 8,
              sets: [
                { weight: 36 + Math.floor(weekNum / 2) * 2, reps: 9, rir: 2, done: true },
                { weight: 36 + Math.floor(weekNum / 2) * 2, reps: 9, rir: 2, done: true },
                { weight: 36 + Math.floor(weekNum / 2) * 2, reps: 8, rir: 1, done: true }
              ]
            },
            {
              name: 'Leg curl seduto',
              rpe: 8.5,
              sets: [
                { weight: 55 + Math.floor(weekNum / 3) * 2.5, reps: 12, rir: 1, done: true },
                { weight: 55 + Math.floor(weekNum / 3) * 2.5, reps: 11, rir: 1, done: true },
                { weight: 55 + Math.floor(weekNum / 3) * 2.5, reps: 10, rir: 0, done: true }
              ]
            },
            {
              name: 'Calf in piedi',
              rpe: 9,
              sets: [
                { weight: 70, reps: 15, rir: 1, done: true },
                { weight: 70, reps: 14, rir: 1, done: true },
                { weight: 70, reps: 13, rir: 0, done: true }
              ]
            }
          ];

      workout = {
        completed: true,
        session_day: isUpper ? 'Upper A' : 'Lower A',
        duration_seconds: durMin * 60,
        duration_minutes: durMin,
        session_rpe: rpeSession,
        exercises
      };
    }

    demoLogs.push({
      id: dt,
      date: dt,
      weight_kg: measuredWeight,
      steps: Math.round(gauss(9800, 1400)),
      sleep_hours: Number(Math.max(5.5, Math.min(8.5, gauss(7.2, 0.5))).toFixed(1)),
      sleep_quality: 4,
      diary_complete: 'yes',
      nutrition: {
        diary_complete: 'yes',
        totals: {
          kcal: intakeKcal,
          protein: proteinG,
          carbs: carbsG,
          fats: fatsG
        }
      },
      workout
    });

    if (dayIdx % 7 === 0 || i === 0) {
      demoChecks.push({
        id: dt,
        date: dt,
        weight: measuredWeight,
        waist: Number((84 - (82.4 - trueWeight) * 0.85).toFixed(1)),
        body_fat: Number((16.5 - (82.4 - trueWeight) * 0.45).toFixed(1))
      });
    }
  }

  const demoProfile = {
    sex: 'M',
    dob: '1995-05-15',
    height: 178,
    activity_level: 'moderate',
    goal_type: 'cut',
    weight_target: 75.0,
    target_rate_kg_week: -0.5,
    steps_goal: 10000
  };

  if (persistToFirestore) {
    const uid = getUid();
    for (const l of demoLogs.slice(-28)) {
      await setDoc(doc(db, 'users', uid, 'daily_logs', l.date), l, { merge: true });
    }
  }

  return runPredictivePipeline({
    dailyLogs: demoLogs,
    checks: demoChecks,
    settings: demoProfile,
    persistToFirestore: false
  });
}

/**
 * Analizza tutti i campi mancanti o parziali (Profilo, Oggi, Allenamenti passati senza RPE/RIR)
 * e calcola valori pre-compilati intelligenti basati sullo storico reale dell'utente.
 */
export function inspectMissingAndSmartDefaults(pipelineResult, rawLogs = []) {
  const todayStr = pipelineResult?.date || getTodayStr();
  const profile = pipelineResult?.profile || {};
  const en = pipelineResult?.energyOutput || {};

  // Trova log di oggi
  const todayLog = (rawLogs || []).find(l => (l.date || l.id) === todayStr) || {};

  // Statistiche storiche per inferenza intelligente
  let sumSteps = 0, cntSteps = 0;
  let lastKnownWeight = en.trendWeight || en.rawWeight || null;
  let workoutsMissingRpeCount = 0;

  for (const l of (rawLogs || [])) {
    if (l.steps != null && Number(l.steps) > 0) {
      sumSteps += Number(l.steps);
      cntSteps++;
    }
    if (!lastKnownWeight && l.weight_kg != null && Number(l.weight_kg) > 30) {
      lastKnownWeight = Number(l.weight_kg);
    }
    if (l.workout?.completed) {
      const hasSessionRpe = l.workout.session_rpe != null && Number(l.workout.session_rpe) > 0;
      const exs = Array.isArray(l.workout.exercises) ? l.workout.exercises : [];
      const hasExRpe = exs.some(ex => ex.rpe != null || (ex.sets || []).some(s => s.rir != null));
      if (!hasSessionRpe || !hasExRpe) {
        workoutsMissingRpeCount++;
      }
    }
  }

  const avgSteps = cntSteps > 0 ? Math.round(sumSteps / cntSteps) : 8500;
  const inferredActivity = avgSteps >= 11500
    ? 'active'
    : avgSteps >= 7500
      ? 'moderate'
      : avgSteps >= 4500
        ? 'light'
        : 'moderate';

  const curW = Number(lastKnownWeight || profile.current_weight || 78.0);
  const inferredGoal = profile.goal_type || (en.energyBalance7d != null && en.energyBalance7d > 100 ? 'bulk' : 'cut');
  const inferredTargetW = profile.weight_target != null && Number(profile.weight_target) > 30
    ? Number(profile.weight_target)
    : Number((inferredGoal === 'cut' ? curW - 4.0 : inferredGoal === 'bulk' ? curW + 3.0 : curW).toFixed(1));
  const inferredRate = profile.target_rate_kg_week != null && !isNaN(Number(profile.target_rate_kg_week))
    ? Number(profile.target_rate_kg_week)
    : (inferredGoal === 'cut' ? -0.45 : inferredGoal === 'bulk' ? 0.25 : 0);

  const missingProfileFields = [];
  if (!profile.sex) missingProfileFields.push('Sesso biologico');
  if (!profile.height) missingProfileFields.push('Altezza (cm)');
  if (!profile.dob && !profile.age) missingProfileFields.push('Data di nascita');
  if (!profile.activity_level) missingProfileFields.push('Livello attività (PAL)');
  if (!profile.goal_type) missingProfileFields.push('Obiettivo (Cut/Maintain/Bulk)');
  if (!profile.weight_target) missingProfileFields.push('Peso Obiettivo (kg)');

  const missingTodayFields = [];
  if (todayLog.weight_kg == null) missingTodayFields.push('Peso di oggi (kg)');
  if (todayLog.sleep_hours == null) missingTodayFields.push('Ore di sonno oggi');
  if (!todayLog.diary_complete && !todayLog.nutrition?.diary_complete) {
    missingTodayFields.push('Conferma completezza diario oggi');
  }

  const smartDefaults = {
    sex: profile.sex || 'M',
    height: Number(profile.height) || 176,
    dob: profile.dob || '1994-06-15',
    activity_level: profile.activity_level || inferredActivity,
    goal_type: inferredGoal,
    weight_target: inferredTargetW,
    target_rate_kg_week: inferredRate,
    today_weight_kg: todayLog.weight_kg != null ? Number(todayLog.weight_kg) : Number(curW.toFixed(1)),
    today_sleep_hours: todayLog.sleep_hours != null ? Number(todayLog.sleep_hours) : 7.5,
    today_diary_complete: todayLog.diary_complete || todayLog.nutrition?.diary_complete || 'yes',
    default_session_rpe: 7.5
  };

  const hasAnyMissing = missingProfileFields.length > 0 || missingTodayFields.length > 0 || workoutsMissingRpeCount > 0;

  return {
    hasAnyMissing,
    missingProfileFields,
    missingTodayFields,
    workoutsMissingRpeCount,
    smartDefaults,
    avgStepsInferred: avgSteps
  };
}

/**
 * Usa Gemini Flash + euristiche sullo storico dell'utente per compilare i dati mancanti
 * (da testo libero dell'utente oppure in modalità 100% automatica con 1 click).
 */
export async function compileMissingDataWithAI(userText = '', pipelineResult = null, rawLogs = []) {
  const info = inspectMissingAndSmartDefaults(pipelineResult, rawLogs);
  const base = { ...info.smartDefaults };

  const contextSummary = {
    currentTrendWeightKg: pipelineResult?.energyOutput?.trendWeight || base.today_weight_kg,
    avgIntake7dKcal: pipelineResult?.energyOutput?.avgIntake7d || null,
    avgSteps: info.avgStepsInferred,
    existingProfile: {
      sex: pipelineResult?.profile?.sex || null,
      height: pipelineResult?.profile?.height || null,
      dob: pipelineResult?.profile?.dob || null,
      activity_level: pipelineResult?.profile?.activity_level || null,
      goal_type: pipelineResult?.profile?.goal_type || null,
      weight_target: pipelineResult?.profile?.weight_target || null
    },
    missingProfileFields: info.missingProfileFields,
    missingTodayFields: info.missingTodayFields,
    workoutsMissingRpeCount: info.workoutsMissingRpeCount
  };

  try {
    const aiRes = await parseMissingDataWithAI(userText, contextSummary);
    if (aiRes?.success && aiRes.parsed) {
      const p = aiRes.parsed;
      if (p.sex === 'M' || p.sex === 'F') base.sex = p.sex;
      if (p.height != null && Number(p.height) >= 120 && Number(p.height) <= 230) base.height = Math.round(Number(p.height));
      if (p.dob && /^\d{4}-\d{2}-\d{2}$/.test(p.dob)) base.dob = p.dob;
      if (['sedentary', 'light', 'moderate', 'active', 'very_active'].includes(p.activity_level)) {
        base.activity_level = p.activity_level;
      }
      if (['cut', 'maintain', 'bulk'].includes(p.goal_type)) base.goal_type = p.goal_type;
      if (p.weight_target != null && Number(p.weight_target) >= 35 && Number(p.weight_target) <= 200) {
        base.weight_target = Number(Number(p.weight_target).toFixed(1));
      }
      if (p.target_rate_kg_week != null && Math.abs(Number(p.target_rate_kg_week)) <= 1.5) {
        base.target_rate_kg_week = Number(Number(p.target_rate_kg_week).toFixed(2));
      }
      if (p.today_weight_kg != null && Number(p.today_weight_kg) >= 35 && Number(p.today_weight_kg) <= 220) {
        base.today_weight_kg = Number(Number(p.today_weight_kg).toFixed(1));
      }
      if (p.today_sleep_hours != null && Number(p.today_sleep_hours) >= 2 && Number(p.today_sleep_hours) <= 14) {
        base.today_sleep_hours = Number(Number(p.today_sleep_hours).toFixed(1));
      }
      if (['yes', 'partial', 'no'].includes(p.today_diary_complete)) {
        base.today_diary_complete = p.today_diary_complete;
      }
      if (p.default_session_rpe != null && Number(p.default_session_rpe) >= 5 && Number(p.default_session_rpe) <= 10) {
        base.default_session_rpe = Number(Number(p.default_session_rpe).toFixed(1));
      }
      return {
        compiled: base,
        aiNote: p.ai_note || 'Campi compilati con Gemini Flash a partire dal tuo storico.',
        source: 'gemini_flash'
      };
    }
  } catch (e) {
    console.warn('[PredictiveCore] Fallback euristico locale per compilazione AI:', e?.message);
  }

  return {
    compiled: base,
    aiNote: 'Campi pre-compilati automaticamente analizzando il tuo storico di pesate, passi e allenamenti.',
    source: 'smart_heuristic'
  };
}

/**
 * Salva su Firestore i dati compilati tramite l'Assistente Guidato / Auto-Compilazione AI:
 * 1. Aggiorna `users/{uid}/settings/app` (profilo e target).
 * 2. Aggiorna `users/{uid}/daily_logs/{today}` (peso di oggi, sonno, completezza diario).
 * 3. Opzionalmente stima e completa RPE/RIR mancanti negli allenamenti passati (`backfillWorkoutsRpe`).
 */
export async function saveGuidedMissingData({
  profileUpdates = {},
  todayUpdates = {},
  backfillWorkoutsRpe = false,
  defaultSessionRpe = 7.5,
  rawLogs = []
} = {}) {
  const uid = getUid();
  const todayStr = getTodayStr();

  const cleanProfile = {
    sex: profileUpdates.sex || 'M',
    height: Number(profileUpdates.height) || 176,
    dob: profileUpdates.dob || '1994-06-15',
    activity_level: profileUpdates.activity_level || 'moderate',
    goal_type: profileUpdates.goal_type || 'cut',
    weight_target: Number(profileUpdates.weight_target) || 75.0,
    target_rate_kg_week: Number(profileUpdates.target_rate_kg_week ?? -0.45)
  };

  const settingsPayload = {
    ...cleanProfile,
    profile: cleanProfile,
    updated_at: new Date().toISOString()
  };

  const todayPayload = {
    date: todayStr,
    updated_at: new Date().toISOString()
  };
  if (todayUpdates.weight_kg != null && Number(todayUpdates.weight_kg) > 30) {
    todayPayload.weight_kg = Number(todayUpdates.weight_kg);
  }
  if (todayUpdates.sleep_hours != null && Number(todayUpdates.sleep_hours) > 0) {
    todayPayload.sleep_hours = Number(todayUpdates.sleep_hours);
  }
  if (['yes', 'partial', 'no'].includes(todayUpdates.diary_complete)) {
    todayPayload.diary_complete = todayUpdates.diary_complete;
    todayPayload.nutrition = { diary_complete: todayUpdates.diary_complete };
  }

  const writes = [
    setDoc(doc(db, 'users', uid, 'settings', 'app'), settingsPayload, { merge: true }),
    setDoc(doc(db, 'users', uid, 'daily_logs', todayStr), todayPayload, { merge: true })
  ];

  let backfilledWorkouts = 0;
  const updatedLogsMap = {};

  if (backfillWorkoutsRpe && Array.isArray(rawLogs)) {
    for (const log of rawLogs) {
      const dt = log.date || log.id;
      if (!dt || !log.workout?.completed) continue;

      const w = { ...log.workout };
      let changed = false;

      if (w.session_rpe == null || Number(w.session_rpe) <= 0) {
        w.session_rpe = Number(defaultSessionRpe) || 7.5;
        changed = true;
      }
      if (!w.duration_minutes && !w.duration_seconds) {
        w.duration_minutes = 60;
        w.duration_seconds = 3600;
        changed = true;
      }
      if (Array.isArray(w.exercises)) {
        w.exercises = w.exercises.map(ex => {
          const exCopy = { ...ex };
          if (exCopy.rpe == null) {
            exCopy.rpe = Math.round(Number(defaultSessionRpe) || 8);
            changed = true;
          }
          if (Array.isArray(exCopy.sets)) {
            exCopy.sets = exCopy.sets.map((s, idx, arr) => {
              if (s.rir != null) return s;
              changed = true;
              return { ...s, rir: idx === arr.length - 1 ? 1 : 2 };
            });
          }
          return exCopy;
        });
      }

      if (changed) {
        backfilledWorkouts++;
        updatedLogsMap[dt] = { ...log, workout: w };
        if (backfilledWorkouts <= 30) {
          writes.push(setDoc(doc(db, 'users', uid, 'daily_logs', dt), { workout: w }, { merge: true }));
        }
      }
    }
  }

  await Promise.all(writes);

  return {
    settingsPayload,
    todayPayload,
    backfilledWorkouts,
    updatedLogsMap
  };
}

