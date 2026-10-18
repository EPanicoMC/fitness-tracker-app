// test-models.js
// Unit & Integration Tests for:
// - Model 1: Adaptive Energy Balance & Weight Forecast (js/energy-model.js)
// - Model 2: Fitness-Fatigue (Banister PMC), EWMA ACWR, Epley e1RM & Volume (js/training-model.js)
// - Deterministic Cross-Rules Engine (js/coach-rules.js)
// Run with: node test-models.js

import {
  runEnergyBalanceModel,
  estimatePriorBMR,
  estimatePriorTDEE,
  computeWeightEMA,
  simulateWeightForecast,
  computeCalorieAndMacroRecommendation
} from './js/energy-model.js';

import {
  runTrainingModel,
  computeEpleyE1RM,
  computeSessionLoadMetrics,
  theilSenRegression,
  resolveExerciseMuscles
} from './js/training-model.js';

import {
  evaluateCrossRules,
  buildDeterministicCoachFallback
} from './js/coach-rules.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${msg}`);
  }
}

function addDaysStr(baseDateStr, offset) {
  const [y, m, d] = baseDateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + offset));
  return dt.toISOString().slice(0, 10);
}

// Seeded deterministic PRNG for reproducible tests
function createPRNG(seed = 12345) {
  let s = seed >>> 0;
  return {
    next() {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    },
    gaussian(mean = 0, std = 1) {
      const u1 = Math.max(1e-9, this.next());
      const u2 = this.next();
      const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
      return mean + z * std;
    }
  };
}

console.log('\n=== TEST 1: Model 1 — Prior BMR (Mifflin-St Jeor) & Prior TDEE ===');
{
  const profile = {
    sex: 'M',
    age: 30,
    height: 178,
    activity_level: 'moderate'
  };
  const bmr = estimatePriorBMR(profile, 80);
  // 10*80 + 6.25*178 - 5*30 + 5 = 800 + 1112.5 - 150 + 5 = 1767.5 -> 1768
  assert(bmr === 1768, `Mifflin-St Jeor BMR for 80kg/178cm/30yo male is 1768 kcal (got ${bmr})`);
  const priorObj = estimatePriorTDEE(profile, 80);
  assert(Math.abs(priorObj.priorTdee - Math.round(1768 * 1.55)) <= 2, `Prior TDEE with moderate activity is ~2740 kcal (got ${priorObj.priorTdee})`);
}

console.log('\n=== TEST 2: Model 1 — Synthetic Known TDEE Convergence within ±100 kcal in ≤ 21 days ===');
{
  // True TDEE = 2500 kcal/day, Intake = 2000 kcal/day -> -500 kcal/day deficit (-0.064935 kg/day)
  // Start with moderate activity prior (~2740 kcal, +240 kcal error from true 2500 kcal)
  const trueTdee = 2500;
  const dailyIntake = 2000;
  const rho = 7700;
  const rng = createPRNG(101);
  let trueWeight = 80.0;
  const days = [];

  for (let i = 0; i < 21; i++) {
    const date = addDaysStr('2026-01-01', i);
    if (i > 0) {
      trueWeight += (dailyIntake - trueTdee) / rho;
    }
    const noisyWeight = Number((trueWeight + rng.gaussian(0, 0.15)).toFixed(2));
    days.push({
      date,
      weightKg: noisyWeight,
      intakeKcal: dailyIntake,
      proteinG: 165,
      intakeComplete: 'yes'
    });
  }

  const out = runEnergyBalanceModel({
    profile: {
      sex: 'M',
      age: 30,
      height: 178,
      current_weight: 80,
      activity_level: 'moderate', // Prior ~ 2740 kcal (+240 kcal above true 2500!)
      goal_type: 'cut',
      weight_target: 75,
      target_rate_kg_week: -0.5
    },
    days
  });

  const err = Math.abs(out.tdeeEstimate - trueTdee);
  assert(
    err <= 100,
    `Kalman TDEE converged from prior ~2740 to ${out.tdeeEstimate} kcal (window=${out.tdeeWindowCrossCheck}, true=${trueTdee}, error=${err} kcal <= 100 kcal in 21 days)`
  );
  assert(
    Math.abs(out.trendWeight - trueWeight) <= 0.35,
    `Trend weight (${out.trendWeight} kg) tracks true weight (${trueWeight.toFixed(2)} kg) closely`
  );
  assert(
    out.forecast.length === 3 && out.forecast[0].horizonWeeks === 4 && out.forecast[2].horizonWeeks === 12,
    `Forecast includes 4, 8, and 12 week horizons with Hall dynamic adaptation`
  );
}

console.log('\n=== TEST 3: Model 1 — Missing Weight Days & Incomplete Diary Handling ===');
{
  const days = [];
  let w = 82.0;
  for (let i = 0; i < 20; i++) {
    const date = addDaysStr('2026-02-01', i);
    w -= 0.05;
    const isMissingWeight = (i % 3 === 1); // missing weight every 3rd day
    const isMissingDiary = (i === 5 || i === 12);
    days.push({
      date,
      weightKg: isMissingWeight ? null : Number(w.toFixed(2)),
      intakeKcal: isMissingDiary ? null : 2100,
      intakeComplete: isMissingDiary ? 'no' : (i === 8 ? 'partial' : 'yes')
    });
  }

  const out = runEnergyBalanceModel({
    profile: { sex: 'M', age: 28, height: 180, current_weight: 82, activity_level: 'moderate' },
    days
  });

  assert(Number.isFinite(out.trendWeight) && out.trendWeight > 79 && out.trendWeight < 83, `Handles missing weights gracefully (trendWeight=${out.trendWeight})`);
  assert(Number.isFinite(out.tdeeEstimate) && out.tdeeEstimate > 1800 && out.tdeeEstimate < 3400, `Handles missing/partial diary days without NaN (tdeeEstimate=${out.tdeeEstimate})`);
}

console.log('\n=== TEST 4: Model 1 — Single-Day Water Retention Outlier (+3.2 kg spike) Robustness ===');
{
  const days = [];
  let w = 78.0;
  for (let i = 0; i < 18; i++) {
    const date = addDaysStr('2026-03-01', i);
    // Day 14 has a massive +3.2 kg cheat-meal / sodium water spike
    const measured = (i === 14) ? Number((w + 3.2).toFixed(2)) : Number(w.toFixed(2));
    days.push({
      date,
      weightKg: measured,
      intakeKcal: 2300,
      intakeComplete: 'yes'
    });
  }

  const out = runEnergyBalanceModel({
    profile: { sex: 'M', age: 32, height: 176, current_weight: 78, activity_level: 'light' },
    days
  });

  const spikeSnap = out.history[14];
  assert(
    spikeSnap.outlier === true,
    `Day 14 +3.2kg spike is flagged as weight outlier (outlier=${spikeSnap.outlier})`
  );
  assert(
    Math.abs(spikeSnap.trendWeight - 78.0) < 0.45,
    `Trend weight on outlier day (${spikeSnap.trendWeight} kg) resists the +3.2kg spike (measured=${spikeSnap.rawWeight} kg)`
  );
}

console.log('\n=== TEST 5: Model 2 — Banister PMC (CTL/ATL/TSB), EWMA ACWR, Epley e1RM & Muscle Volume ===');
{
  // Test Epley e1RM with RIR
  const e1rmObj = computeEpleyE1RM(100, 5, 2); // 100 * (1 + 7/30) = 123.33
  assert(Math.abs(e1rmObj.e1rm - 123.33) <= 0.15, `Epley e1RM for 100kg x 5 @ RIR 2 is 123.33kg (got ${e1rmObj.e1rm})`);

  // Simulate 9 weeks (63 days) of structured progressive training (4 sessions/week)
  const days = [];
  for (let day = 0; day < 63; day++) {
    const dow = day % 7;
    const date = addDaysStr('2026-01-01', day);
    if (dow === 0 || dow === 2 || dow === 4 || dow === 5) {
      const weekIdx = Math.floor(day / 7);
      const benchWeight = 80 + weekIdx * 1.5; // steady +1.5kg/week progression
      days.push({
        date,
        workout: {
          completed: true,
          duration_minutes: 60,
          session_rpe: 7,
          exercises: [
            {
              name: 'Panca piana manubri',
              rpe: 8,
              sets: [
                { weight: benchWeight, reps: 6, rir: 2, done: true },
                { weight: benchWeight, reps: 6, rir: 2, done: true },
                { weight: benchWeight, reps: 6, rir: 2, done: true }
              ]
            },
            {
              name: 'Hack squat',
              rpe: 8,
              sets: [
                { weight: 100, reps: 5, rir: 2, done: true },
                { weight: 100, reps: 5, rir: 2, done: true },
                { weight: 100, reps: 5, rir: 2, done: true }
              ]
            }
          ]
        }
      });
    } else {
      days.push({ date, workout: null });
    }
  }

  const trainOut = runTrainingModel({
    days,
    todayDate: addDaysStr('2026-01-01', 62)
  });

  assert(trainOut.ctl > 100 && trainOut.atl > 100, `Banister CTL (${trainOut.ctl}) and ATL (${trainOut.atl}) computed properly`);
  assert(trainOut.acwr >= 0.8 && trainOut.acwr <= 1.35, `Steady training produces optimal EWMA ACWR (${trainOut.acwr}, zone=${trainOut.acwrZone})`);
  const benchLift = trainOut.lifts.find(l => l.exerciseId === 'Panca piana manubri');
  assert(benchLift && benchLift.status === 'progress' && benchLift.trendSlopePctWeek > 0.5, `Theil-Sen detects Bench Press progression (slope=${benchLift?.trendSlopePctWeek}%/wk, status=${benchLift?.status})`);
  assert(trainOut.weeklySetsByMuscle.petto >= 10, `Weekly muscle volume counts effective sets for petto (${trainOut.weeklySetsByMuscle.petto})`);
  assert(trainOut.banisterParams && trainOut.banisterParams.calibrated === true, `Busso regularized non-linear least squares calibrates Banister params after >=8 weeks`);
}

console.log('\n=== TEST 6: Cross-Rules Engine — 1 Unit Test per Rule (All 8 Deterministic Rules) ===');
{
  // Rule 1: rapid_weight_loss (> 1%/week for 2 weeks in cut)
  const r1 = evaluateCrossRules({
    energyOutput: {
      goalType: 'cut',
      trendWeight: 80,
      weeklyRatePct: -1.35,
      weeklyRateKg: -1.08,
      recommendedKcal: 2100,
      adherence14Pct: 90,
      history: []
    },
    trainingOutput: { lifts: [] }
  });
  assert(r1.some(i => i.id === 'rapid_weight_loss'), 'Rule 1 (rapid_weight_loss) triggers when loss > 1%/week in cut');

  // Rule 2: low_protein_intake (< 1.6 g/kg over 7 days)
  const r2 = evaluateCrossRules({
    energyOutput: {
      trendWeight: 80,
      history: []
    },
    trainingOutput: { lifts: [] },
    context: { avgProtein7d: 100 } // 100 / 80 = 1.25 g/kg < 1.6 g/kg
  });
  assert(r2.some(i => i.id === 'low_protein_intake'), 'Rule 2 (low_protein_intake) triggers when avg protein < 1.6 g/kg');

  // Rule 3: deficit_fatigue_strength_drop (deficit + >=2 lifts regressing + TSB <= -15)
  const r3 = evaluateCrossRules({
    energyOutput: {
      trendWeight: 78,
      energyBalance7d: -550,
      recommendedKcal: 2000,
      tdeeEstimate: 2550,
      history: []
    },
    trainingOutput: {
      tsb: -22,
      acwr: 1.35,
      lifts: [
        { exerciseId: 'Panca Piana', status: 'regress', trendSlopePctWeek: -1.1 },
        { exerciseId: 'Hack Squat', status: 'regress', trendSlopePctWeek: -0.9 }
      ]
    }
  });
  assert(r3.some(i => i.id === 'deficit_fatigue_strength_drop'), 'Rule 3 (deficit_fatigue_strength_drop) triggers on active deficit + >=2 regressing lifts + negative TSB');

  // Rule 4: weight_plateau_adaptive_tdee (21 days flat trend weight despite cut goal & adherence >= 80%)
  const flatHistory = [];
  for (let i = 0; i < 21; i++) {
    flatHistory.push({
      date: addDaysStr('2026-03-01', i),
      trendWeight: 80.0,
      intakeKcal: 2100,
      intakeComplete: 'yes'
    });
  }
  const r4 = evaluateCrossRules({
    energyOutput: {
      goalType: 'cut',
      trendWeight: 80.0,
      tdeeEstimate: 2150,
      recommendedKcal: 1750,
      adherence14Pct: 88,
      history: flatHistory
    },
    trainingOutput: { lifts: [] }
  });
  assert(r4.some(i => i.id === 'weight_plateau_adaptive_tdee'), 'Rule 4 (weight_plateau_adaptive_tdee) triggers on 21-day weight plateau with good adherence');

  // Rule 5: high_acwr_spike (ACWR > 1.5)
  const r5 = evaluateCrossRules({
    energyOutput: { trendWeight: 80, history: [] },
    trainingOutput: { acwr: 1.65, ctl: 45, atl: 74, tsb: -29, lifts: [] }
  });
  assert(r5.some(i => i.id === 'high_acwr_spike'), 'Rule 5 (high_acwr_spike) triggers when EWMA ACWR > 1.5');

  // Rule 6: low_diary_adherence (< 70%)
  const r6 = evaluateCrossRules({
    energyOutput: {
      trendWeight: 80,
      adherence14Pct: 52,
      confidence: 38,
      tdeeCI: [2100, 2700],
      history: new Array(10).fill({ date: '2026-03-01', trendWeight: 80 })
    },
    trainingOutput: { lifts: [] }
  });
  assert(r6.some(i => i.id === 'low_diary_adherence'), 'Rule 6 (low_diary_adherence) triggers when diary adherence < 70%');

  // Rule 7: strength_plateau_detected (lift in plateau)
  const r7 = evaluateCrossRules({
    energyOutput: { trendWeight: 80, adherence14Pct: 85, history: [] },
    trainingOutput: {
      lifts: [
        { exerciseId: 'Panca Piana', e1rm: 105, status: 'plateau', sessionsCount: 6, trendSlopePctWeek: 0.02 }
      ]
    }
  });
  assert(r7.some(i => i.id === 'strength_plateau_detected'), 'Rule 7 (strength_plateau_detected) triggers when a lift plateaus for >=3 weeks');

  // Rule 8: insufficient_sleep_recovery (avg sleep < 6.0h over 7 days)
  const r8 = evaluateCrossRules({
    energyOutput: { trendWeight: 80, history: [] },
    trainingOutput: { tsb: -12, readiness: 62, lifts: [] },
    context: { avgSleep7d: 5.4 }
  });
  assert(r8.some(i => i.id === 'insufficient_sleep_recovery'), 'Rule 8 (insufficient_sleep_recovery) triggers when 7-day average sleep < 6.0h');

  // Test deterministic coach fallback schema
  const fallback = buildDeterministicCoachFallback({
    energyOutput: { trendWeight: 78, weeklyRateKg: -0.45, tdeeEstimate: 2450, recommendedKcal: 1950 },
    trainingOutput: { acwr: 1.05, readiness: 78 },
    insights: r3
  });
  assert(
    fallback.status === 'off_track' && Array.isArray(fallback.corrections) && fallback.corrections.length > 0,
    `Deterministic coach fallback produces valid schema (status=${fallback.status}, corrections=${fallback.corrections.length})`
  );
}

console.log(`\n========================================`);
console.log(`MODEL TESTS SUMMARY: ${passed} passed, ${failed} failed`);
console.log(`========================================\n`);

if (failed > 0) {
  process.exit(1);
}
