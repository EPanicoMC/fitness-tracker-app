/**
 * model-eval.js — Harness di valutazione e backtest causale (Fase 0)
 *
 * Eseguibile sia da Node.js (`node --import ./tests/node-loader.mjs js/model-eval.js`)
 * sia dal browser / console (`window.runKovaModelEval()`) o dalla pagina dev `model-eval.html`.
 *
 * Calcola tramite replay causale (walk-forward senza data leakage dal futuro):
 *   1. MAE 1-giorno (kg): errore medio assoluto tra predizione a priori di Kalman w_{t|t-1} e pesata bilancia z_t
 *      (calcolato sia su tutte le pesate sia escludendo gli spike outlier estremi).
 *   2. MAE Forecast a 28 giorni (kg): per ogni giorno t (con t >= 14 e t + 28 <= N), esegue il modello solo fino al
 *      giorno t, simula il forecast a +28gg (usando l'intake medio reale dei 28gg successivi per isolare l'accuratezza
 *      del modello metabolico, più la variante con intake pianificato al tempo t) e lo confronta con il `trendWeight`
 *      reale osservato al giorno t + 28.
 *   3. Copertura empirica della banda di confidenza al 95% (%): percentuale di traiettorie a +28gg in cui il
 *      `trendWeight` reale cade dentro `[low_95, high_95]` previsto al giorno t (target ben calibrato: 90–97%).
 *   4. Stabilità del TDEE stimato (kcal/settimana): deviazione standard delle variazioni settimanali
 *      ΔTDEE_w = TDEE(t) − TDEE(t − 7) dopo il periodo di warm-up (giorno >= 14).
 */

import { runEnergyBalanceModel, simulateWeightForecast, addDaysISO, diffDaysISO } from './energy-model.js';
import { runTrainingModel } from './training-model.js';
import { getAllFlags } from './feature-flags.js';

function mean(arr) {
  if (!arr || !arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr) {
  if (!arr || arr.length < 2) return 0;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + Math.pow(x - m, 2), 0) / (arr.length - 1);
  return Math.sqrt(v);
}

/**
 * Esegue la valutazione completa del Modello 1 e Modello 2 su una serie di giorni normalizzati.
 *
 * @param {Object} params
 * @param {Array} params.days serie giornaliera normalizzata
 * @param {Object} params.profile profilo utente
 * @param {Array} [params.checks] lista checks (per %BF / vita)
 * @param {Object} [params.flags] override espliciti dei feature flag da testare
 * @param {number} [params.warmupDays=14] giorni iniziali di warm-up prima di valutare forecast 28d e stabilità TDEE
 */
export function evaluateModelsOnHistory({
  days = [],
  profile = {},
  checks = [],
  flags = null,
  warmupDays = 14
} = {}) {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) {
    return {
      error: 'Nessun giorno disponibile per la valutazione',
      daysCount: 0
    };
  }

  // 1. Replay completo fino alla fine per ottenere la traiettoria di riferimento e le innovazioni a 1 giorno
  const fullEnergy = runEnergyBalanceModel({
    days: sorted,
    profile,
    checks,
    todayDate: sorted[sorted.length - 1].date,
    config: { flags }
  });

  const fullTraining = runTrainingModel({
    days: sorted,
    profile,
    energyOutput: fullEnergy,
    todayDate: sorted[sorted.length - 1].date,
    config: { flags }
  });

  const snaps = fullEnergy.history || [];

  // 2. MAE a 1 giorno: |z_t - w_{t|t-1}|
  // Nota: se lo snapshot espone `priorWeightPred` lo usiamo direttamente; altrimenti lo ricostruiamo
  // esattamente dalla dinamica a 1 passo dello stato t-1.
  const oneDayErrorsAll = [];
  const oneDayErrorsClean = [];

  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1];
    const curr = snaps[i];
    if (curr.rawWeight == null) continue;

    let wPriorPred = curr.priorWeightPred;
    if (wPriorPred == null) {
      const rho = 7700;
      const hasIntake = curr.effectiveIntakeKcal != null && curr.intakeComplete !== 'no';
      wPriorPred = hasIntake
        ? prev.kalmanWeight + (curr.effectiveIntakeKcal - prev.tdeeKalman) / rho
        : prev.kalmanWeight;
    }

    const absErr = Math.abs(curr.rawWeight - wPriorPred);
    oneDayErrorsAll.push(absErr);
    if (!curr.outlier) {
      oneDayErrorsClean.push(absErr);
    }
  }

  // 3. Walk-forward causale per Forecast a 28 giorni e Copertura Banda 95%
  // Per ogni giorno t >= warmupDays tale che esista t + 28 giorni:
  const forecastErrorsRealIntake = [];
  const forecastErrorsPlannedIntake = [];
  let insideBand95RealIntake = 0;
  let insideBand95PlannedIntake = 0;
  let total28dEvalPoints = 0;

  for (let idx = warmupDays; idx + 28 < snaps.length; idx += 2) {
    const prefixDays = sorted.slice(0, idx + 1);
    const tDate = snaps[idx].date;
    const targetSnap28 = snaps[idx + 28];
    if (!targetSnap28 || targetSnap28.trendWeight == null) continue;

    const causalOut = runEnergyBalanceModel({
      days: prefixDays,
      profile,
      checks: checks.filter(c => (c.date || c.id) <= tDate),
      todayDate: tDate,
      config: { flags }
    });

    // Calcola l'intake medio effettivo nei 28 giorni successivi per valutare la qualità del modello fisico+TDEE
    const futureSlice = snaps.slice(idx + 1, idx + 29);
    const futureIntakes = futureSlice
      .filter(s => s.effectiveIntakeKcal != null && s.intakeComplete !== 'no')
      .map(s => s.effectiveIntakeKcal);
    const realizedAvgIntake28d = futureIntakes.length > 0
      ? mean(futureIntakes)
      : (causalOut.avgIntake7d ?? causalOut.recommendedKcal);

    const weightSd = causalOut.kalmanState?.P?.[0]?.[0]
      ? Math.sqrt(Math.max(0.02, causalOut.kalmanState.P[0][0]))
      : 0.25;
    const tdeeSd = causalOut.history[causalOut.history.length - 1]?.tdeeSd || 120;

    // A) Forecast con intake realizzato (isola l'errore di stima TDEE + fisica di Hall)
    const simReal = simulateWeightForecast({
      startDate: tDate,
      startWeightKg: causalOut.trendWeight,
      tdeeEstimate: causalOut.tdeeEstimate,
      tdeeSdKcal: tdeeSd,
      weightSdKg: weightSd,
      plannedIntakeKcal: realizedAvgIntake28d,
      horizonsDays: [28],
      maxDays: 28,
      config: { rhoKcalPerKg: causalOut.rhoKcalPerKg || 7700 }
    });
    const cpReal = simReal.checkpoints[0];

    // B) Forecast operativo (con intake medio 7gg noto al tempo t)
    const cpPlan = (causalOut.forecast || []).find(f => f.horizonWeeks === 4) || cpReal;

    if (cpReal && cpPlan) {
      total28dEvalPoints++;
      const actualTrend28 = targetSnap28.trendWeight;

      forecastErrorsRealIntake.push(Math.abs(cpReal.weight - actualTrend28));
      forecastErrorsPlannedIntake.push(Math.abs(cpPlan.weight - actualTrend28));

      if (actualTrend28 >= cpReal.low && actualTrend28 <= cpReal.high) {
        insideBand95RealIntake++;
      }
      if (actualTrend28 >= cpPlan.low && actualTrend28 <= cpPlan.high) {
        insideBand95PlannedIntake++;
      }
    }
  }

  // 4. Stabilità del TDEE stimato (deviazione standard delle variazioni settimanali dopo warm-up)
  const weeklyTdeeDeltas = [];
  for (let i = Math.max(warmupDays, 7); i < snaps.length; i++) {
    const delta7 = snaps[i].tdeeKalman - snaps[i - 7].tdeeKalman;
    weeklyTdeeDeltas.push(delta7);
  }
  const tdeeWeeklyDeltaSd = stdDev(weeklyTdeeDeltas);
  const tdeeWeeklyAbsChangeMean = mean(weeklyTdeeDeltas.map(Math.abs));

  const coverage95RealizedPct = total28dEvalPoints > 0
    ? Number(((insideBand95RealIntake / total28dEvalPoints) * 100).toFixed(1))
    : null;
  const coverage95PlannedPct = total28dEvalPoints > 0
    ? Number(((insideBand95PlannedIntake / total28dEvalPoints) * 100).toFixed(1))
    : null;
  const coverage95Pct = coverage95PlannedPct;

  let calibrationVerdict = 'unknown';
  if (coverage95Pct != null) {
    if (coverage95Pct >= 90 && coverage95Pct <= 97) calibrationVerdict = 'well_calibrated (90-97%)';
    else if (coverage95Pct > 97) calibrationVerdict = 'underconfident_wide_band (>97%)';
    else calibrationVerdict = 'overconfident_narrow_band (<90%)';
  }

  return {
    evaluatedAt: new Date().toISOString(),
    daysCount: snaps.length,
    evalPoints28d: total28dEvalPoints,
    activeFlags: getAllFlags(flags),
    metrics: {
      mae1DayAllKg: oneDayErrorsAll.length ? Number(mean(oneDayErrorsAll).toFixed(3)) : null,
      mae1DayCleanKg: oneDayErrorsClean.length ? Number(mean(oneDayErrorsClean).toFixed(3)) : null,
      mae28DayKg: forecastErrorsRealIntake.length ? Number(mean(forecastErrorsRealIntake).toFixed(3)) : null,
      mae28DayPlannedKg: forecastErrorsPlannedIntake.length ? Number(mean(forecastErrorsPlannedIntake).toFixed(3)) : null,
      coverage95Pct,
      coverage95PlannedPct,
      coverage95RealizedPct,
      calibrationVerdict,
      tdeeWeeklyDeltaSdKcal: Number(tdeeWeeklyDeltaSd.toFixed(1)),
      tdeeWeeklyAbsChangeMeanKcal: tdeeWeeklyAbsChangeMean != null ? Number(tdeeWeeklyAbsChangeMean.toFixed(1)) : null
    },
    finalStateSummary: {
      trendWeightKg: fullEnergy.trendWeight,
      tdeeEstimateKcal: fullEnergy.tdeeEstimate,
      tdeeCI95: fullEnergy.tdeeCI,
      tdeeWindowCrossCheck: fullEnergy.tdeeWindowCrossCheck,
      rhoKcalPerKg: fullEnergy.rhoKcalPerKg,
      underReportingSuspected: fullEnergy.underReportingSuspected,
      modelDivergence: fullEnergy.modelDivergence ?? false,
      ctl: fullTraining.ctl,
      atl: fullTraining.atl,
      tsb: fullTraining.tsb,
      monotony: fullTraining.monotony,
      strain: fullTraining.strain,
      readiness: fullTraining.readiness,
      banisterParams: fullTraining.banisterParams,
      loadConversion: fullTraining.load_conversion
    }
  };
}

/**
 * Confronta la baseline (tutti i flag OFF) con uno specifico set di flag candidato
 * e decide se il candidato migliora le metriche senza degradare la calibrazione.
 */
export function compareFlagCandidate({ days, profile, checks = [], candidateFlags = {}, label = 'candidate' }) {
  const baseRes = evaluateModelsOnHistory({ days, profile, checks, flags: {} });
  const candRes = evaluateModelsOnHistory({ days, profile, checks, flags: candidateFlags });

  const bm = baseRes.metrics;
  const cm = candRes.metrics;

  const deltaMae1d = (cm.mae1DayCleanKg != null && bm.mae1DayCleanKg != null)
    ? Number((cm.mae1DayCleanKg - bm.mae1DayCleanKg).toFixed(4))
    : 0;
  const deltaMae28d = (cm.mae28DayKg != null && bm.mae28DayKg != null)
    ? Number((cm.mae28DayKg - bm.mae28DayKg).toFixed(4))
    : 0;
  const deltaTdeeSd = Number((cm.tdeeWeeklyDeltaSdKcal - bm.tdeeWeeklyDeltaSdKcal).toFixed(1));

  return {
    label,
    candidateFlags,
    baseline: bm,
    candidate: cm,
    candidateSummary: candRes.finalStateSummary,
    deltas: {
      mae1DayCleanKg: deltaMae1d,
      mae28DayKg: deltaMae28d,
      tdeeWeeklyDeltaSdKcal: deltaTdeeSd,
      coverage95Pct: cm.coverage95Pct != null && bm.coverage95Pct != null
        ? Number((cm.coverage95Pct - bm.coverage95Pct).toFixed(1))
        : 0
    }
  };
}

if (typeof window !== 'undefined') {
  window.KOVA_MODEL_EVAL = {
    evaluateModelsOnHistory,
    compareFlagCandidate
  };
}

// Esecuzione diretta da CLI Node.js
if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === `file://${process.argv[1]}`) {
  import('../tests/snapshot.mjs').then(({ buildOrLoadFixture }) => {
    const fixture = buildOrLoadFixture();
    if (process.argv.includes('--compare-fase2')) {
      const candidates = [
        { label: '2.1a energy.trendKalmanOnly', flags: { 'energy.trendKalmanOnly': true } },
        { label: '2.1b energy.normalizedGating', flags: { 'energy.normalizedGating': true } },
        { label: '2.1c energy.dynamicRho', flags: { 'energy.dynamicRho': true } },
        { label: '2.1d energy.stepsCovariate', flags: { 'energy.stepsCovariate': true } },
        { label: '2.1 ALL Energy V2', flags: { 'energy.trendKalmanOnly': true, 'energy.normalizedGating': true, 'energy.dynamicRho': true, 'energy.stepsCovariate': true } },
        { label: '2.2 ALL Training V2', flags: { 'training.homogeneousLoad': true, 'training.e1rmV2': true, 'training.banisterValidation': true, 'training.readinessV2': true, 'training.volumeTargets': true, 'training.doubleProgression': true } }
      ];
      console.log('\n════════════════════════════════════════════════════════════');
      console.log(' 📊 KOVA FASE 2 FLAG BACKTEST COMPARISON');
      console.log('════════════════════════════════════════════════════════════');
      for (const c of candidates) {
        const cmp = compareFlagCandidate({
          days: fixture.days,
          profile: fixture.profile,
          checks: fixture.checks,
          candidateFlags: c.flags,
          label: c.label
        });
        console.log(`\n▶ ${c.label}:`);
        console.log('  Metrics:', JSON.stringify(cmp.candidate));
        console.log('  Deltas vs Baseline:', JSON.stringify(cmp.deltas));
        if (c.label.includes('Training')) {
          console.log('  Training Summary:', JSON.stringify(cmp.candidateSummary));
        }
      }
      return;
    }

    const report = evaluateModelsOnHistory({
      days: fixture.days,
      profile: fixture.profile,
      checks: fixture.checks
    });
    console.log('\n════════════════════════════════════════════════════════════');
    console.log(' 📊 KOVA MODEL EVALUATION HARNESS (FASE 0)');
    console.log('════════════════════════════════════════════════════════════');
    console.log(JSON.stringify(report, null, 2));
  });
}
