import { getDayOfWeek } from './app.js';

/**
 * Thresholds for deterministic pattern detection and alerts.
 */
export const THRESHOLDS = {
  KCAL_ABOVE_PCT: 1.15,       // >15% above target → flag
  KCAL_BELOW_PCT: 0.85,       // <85% of target → flag  
  KCAL_ERRATIC_CV: 0.20,      // coefficient of variation >20% → "erratic"
  PROTEIN_LOW_PCT: 0.80,      // <80% protein target → alert
  FAT_HIGH_PCT: 1.20,         // >120% fat target → flag
  PATTERN_MIN_DAYS: 2,        // minimum days to detect a pattern
  WORKOUT_ALERT_DAYS: 3,      // 3+ days since last workout → alert
  DATA_INSUFFICIENT_DAYS: 2,  // <2 days with data → insufficient
  MINOR_DEVIATION_PCT: 0.05,  // <5% deviation → not worth flagging
};

// Helper: safe division
const safeDiv = (num, denom) => denom ? num / denom : 0;

// Helper: mean
const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

// Helper: standard deviation
const stdDev = (arr) => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((acc, val) => acc + Math.pow(val - m, 2), 0) / (arr.length - 1);
  return Math.sqrt(variance);
};

// Helper: coefficient of variation
const calcCV = (arr) => {
  const m = mean(arr);
  return m ? stdDev(arr) / m : 0;
};

// Helper: find log for date
const getLogForDate = (logs, date) => {
  if (!logs) return null;
  if (Array.isArray(logs)) return logs.find(l => l.date === date) || null;
  return logs[date] || null;
};

// Helper: determine if day is a training day
const isTrainingDay = (date, log, programData) => {
  if (log && log.is_training_day !== undefined) return log.is_training_day;
  const dayOfWeek = getDayOfWeek(date);
  return programData?.schedule?.[dayOfWeek] ? true : false;
};

// Helper: get target nutrition for a day
const getTargetForDay = (date, log, programData, dietPlan) => {
  if (!dietPlan) return { kcal: 0, protein: 0, carbs: 0, fats: 0 };
  const training = isTrainingDay(date, log, programData);
  return training ? (dietPlan.day_on || dietPlan.day_off) : (dietPlan.day_off || dietPlan.day_on);
};

// Helper: check if a value deviates significantly
const isSignificantDeviation = (value, target, pctAllowed = THRESHOLDS.MINOR_DEVIATION_PCT) => {
  if (!target) return false;
  const ratio = value / target;
  return Math.abs(1 - ratio) > pctAllowed;
};

/**
 * Analyzes weekly data and returns a structured InsightReport.
 * 
 * @param {string[]} dates - Array of date strings (YYYY-MM-DD) to analyze.
 * @param {Object|Array} logs - Logs keyed by date, or array of log objects.
 * @param {Object} programData - Program schedule data.
 * @param {Object} dietPlan - Diet plan targets.
 * @param {Object} settings - User settings (e.g., steps_goal).
 * @param {string} todayString - Today's date string.
 * @returns {Object} InsightReport object.
 */
export function analyzeWeeklyData(dates, logs, programData, dietPlan, settings, todayString) {
  if (!dates || dates.length === 0) return createEmptyReport();

  const validDays = [];
  const kcalRatios = [];
  let daysWithData = 0;

  let sumKcalActual = 0;
  let sumKcalTarget = 0;
  let daysAboveKcal = 0;
  let daysBelowKcal = 0;
  let daysOnTargetKcal = 0;
  let maxExcessKcal = 0;
  let maxDeficitKcal = 999;

  let sumProteinActual = 0, sumProteinTarget = 0, daysBelowProtein = 0, sumProteinDeficit = 0;
  let sumCarbsActual = 0, sumCarbsTarget = 0, daysAboveCarbs = 0, daysBelowCarbs = 0;
  let sumFatActual = 0, sumFatTarget = 0, daysAboveFat = 0, sumFatExcess = 0;

  let workoutsCompleted = 0;
  let workoutsPlanned = 0;
  let workoutsMissed = 0;
  let workoutsRecovered = 0;
  let lastWorkoutDate = null;

  // Track daily stats for pattern detection
  dates.forEach(date => {
    const log = getLogForDate(logs, date);
    const target = getTargetForDay(date, log, programData, dietPlan);
    const plannedTraining = programData?.schedule?.[getDayOfWeek(date)] ? true : false;
    
    if (plannedTraining) workoutsPlanned++;

    // Workout tracking (even if no nutrition data)
    let workedOut = false;
    if (log?.workout?.completed) {
      workedOut = true;
      workoutsCompleted++;
      if (!lastWorkoutDate || date > lastWorkoutDate) {
        lastWorkoutDate = date;
      }
      if (!plannedTraining && log.workout.recovered) {
        workoutsRecovered++;
      }
    } else if (plannedTraining && date <= todayString) {
      workoutsMissed++;
    }

    if (!log || !log.nutrition || !log.nutrition.totals || !log.nutrition.totals.kcal) {
      return; // No nutrition data for this day
    }

    daysWithData++;
    const nut = log.nutrition.totals;
    validDays.push({ date, log, target, nut });

    // Kcal stats
    sumKcalActual += nut.kcal;
    sumKcalTarget += target.kcal;
    
    if (target.kcal > 0) {
      const ratio = nut.kcal / target.kcal;
      kcalRatios.push(ratio);
      
      if (ratio > THRESHOLDS.KCAL_ABOVE_PCT) daysAboveKcal++;
      else if (ratio < THRESHOLDS.KCAL_BELOW_PCT) daysBelowKcal++;
      else if (!isSignificantDeviation(nut.kcal, target.kcal)) daysOnTargetKcal++;
      
      if (ratio > maxExcessKcal) maxExcessKcal = ratio;
      if (ratio < maxDeficitKcal) maxDeficitKcal = ratio;
    }

    // Protein stats
    sumProteinActual += (nut.protein || 0);
    sumProteinTarget += (target.protein || 0);
    if (target.protein > 0) {
      if ((nut.protein || 0) < target.protein * THRESHOLDS.PROTEIN_LOW_PCT) {
        daysBelowProtein++;
        sumProteinDeficit += (target.protein - (nut.protein || 0));
      }
    }

    // Carbs stats
    sumCarbsActual += (nut.carbs || 0);
    sumCarbsTarget += (target.carbs || 0);
    if (target.carbs > 0) {
      if ((nut.carbs || 0) > target.carbs * 1.1) daysAboveCarbs++;
      if ((nut.carbs || 0) < target.carbs * 0.9) daysBelowCarbs++;
    }

    // Fat stats
    sumFatActual += (nut.fats || 0);
    sumFatTarget += (target.fats || 0);
    if (target.fats > 0) {
      if ((nut.fats || 0) > target.fats * THRESHOLDS.FAT_HIGH_PCT) {
        daysAboveFat++;
        sumFatExcess += ((nut.fats || 0) - target.fats);
      }
    }
  });

  if (maxDeficitKcal === 999) maxDeficitKcal = 0;

  // Calculated Averages
  const avgKcalActual = safeDiv(sumKcalActual, daysWithData);
  const avgKcalTarget = safeDiv(sumKcalTarget, daysWithData);
  
  const cvKcal = calcCV(kcalRatios);
  let variability = 'stable';
  if (cvKcal > THRESHOLDS.KCAL_ERRATIC_CV) variability = 'erratic';
  else if (cvKcal > 0.10) variability = 'moderate';

  // Workout consistency
  const daysSinceLastWorkout = lastWorkoutDate 
    ? Math.floor((new Date(todayString) - new Date(lastWorkoutDate)) / (1000 * 60 * 60 * 24))
    : null;

  let consistency = 'fair';
  if (workoutsCompleted >= workoutsPlanned && workoutsPlanned > 0) consistency = 'excellent';
  else if (workoutsMissed === 0) consistency = 'good';
  else if (workoutsMissed > 1) consistency = 'poor';

  const report = {
    period: { start: dates[0], end: dates[dates.length - 1], daysAnalyzed: dates.length, daysWithData },
    calories: {
      avgActual: avgKcalActual,
      avgTarget: avgKcalTarget,
      daysAbove: daysAboveKcal,
      daysBelow: daysBelowKcal,
      daysOnTarget: daysOnTargetKcal,
      variability,
      trend: (avgKcalActual > avgKcalTarget * 1.05) ? 'worsening' : 'stable',
      maxExcess: maxExcessKcal,
      maxDeficit: maxDeficitKcal,
    },
    macros: {
      protein: {
        avg: safeDiv(sumProteinActual, daysWithData),
        target: safeDiv(sumProteinTarget, daysWithData),
        daysBelow80pct: daysBelowProtein,
        avgDeficitG: safeDiv(sumProteinDeficit, daysBelowProtein),
        trend: 'stable'
      },
      carbs: {
        avg: safeDiv(sumCarbsActual, daysWithData),
        target: safeDiv(sumCarbsTarget, daysWithData),
        daysAbove: daysAboveCarbs,
        daysBelow: daysBelowCarbs,
        trend: 'stable'
      },
      fat: {
        avg: safeDiv(sumFatActual, daysWithData),
        target: safeDiv(sumFatTarget, daysWithData),
        daysAbove120pct: daysAboveFat,
        avgExcessG: safeDiv(sumFatExcess, daysAboveFat),
        trend: 'stable'
      }
    },
    training: {
      completed: workoutsCompleted,
      planned: workoutsPlanned,
      missed: workoutsMissed,
      recovered: workoutsRecovered,
      daysSinceLastWorkout,
      consistency
    },
    detectedPatterns: [],
    focusInsights: [],
    actionPlan: [],
    trendOverview: {}
  };

  generatePatterns(report, validDays);
  generateTrendOverview(report, daysWithData, dates.length);
  generateActionPlan(report);

  // Focus insights: take top 3 alerts/warnings
  report.focusInsights = [...report.detectedPatterns]
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 3)
    .map((insight, index) => ({ ...insight, priority: index + 1 }));

  return report;
}

/**
 * Helper to generate empty report if no data
 */
function createEmptyReport() {
  return {
    period: { start: null, end: null, daysAnalyzed: 0, daysWithData: 0 },
    calories: { avgActual: 0, avgTarget: 0, daysAbove: 0, daysBelow: 0, daysOnTarget: 0, variability: 'stable', trend: 'stable', maxExcess: 0, maxDeficit: 0 },
    macros: {
      protein: { avg: 0, target: 0, daysBelow80pct: 0, avgDeficitG: 0, trend: 'stable' },
      carbs: { avg: 0, target: 0, daysAbove: 0, daysBelow: 0, trend: 'stable' },
      fat: { avg: 0, target: 0, daysAbove120pct: 0, avgExcessG: 0, trend: 'stable' }
    },
    training: { completed: 0, planned: 0, missed: 0, recovered: 0, daysSinceLastWorkout: null, consistency: 'fair' },
    detectedPatterns: [], focusInsights: [], actionPlan: [], trendOverview: {}
  };
}

/**
 * Generate specific patterns based on thresholds and report data
 */
function generatePatterns(report, validDays) {
  const { calories, macros, training } = report;

  if (calories.daysAbove >= THRESHOLDS.PATTERN_MIN_DAYS) {
    report.detectedPatterns.push({
      id: 'high_calories',
      type: 'warning',
      severity: 3,
      title: 'Eccesso Calorico Frequente',
      evidence: `Hai superato il target calorico per ${calories.daysAbove} giorni.`,
      timeframe: 'Negli ultimi giorni',
      action: 'Cerca di ridurre le porzioni o aggiungere una sessione di cardio.',
      explanation: 'Superare frequentemente l\'obiettivo calorico rallenta il raggiungimento del traguardo.'
    });
  }

  if (macros.protein.daysBelow80pct >= THRESHOLDS.PATTERN_MIN_DAYS) {
    report.detectedPatterns.push({
      id: 'low_protein',
      type: 'alert',
      severity: 4,
      title: 'Proteine Insufficienti',
      evidence: `Assunzione di proteine sotto l'80% per ${macros.protein.daysBelow80pct} giorni.`,
      timeframe: 'Recente',
      action: 'Aggiungi fonti proteiche magre ai tuoi pasti.',
      explanation: 'Le proteine sono fondamentali per il mantenimento e la crescita muscolare.'
    });
  }

  if (macros.protein.daysBelow80pct >= 2 && macros.fat.daysAbove120pct >= 2) {
    report.detectedPatterns.push({
      id: 'protein_fat_imbalance',
      type: 'alert',
      severity: 5,
      title: 'Sbilanciamento Macronutrienti',
      evidence: 'Basso apporto proteico combinato con alto apporto di grassi.',
      timeframe: 'Recente',
      action: 'Sostituisci snack ricchi di grassi con opzioni ad alto contenuto proteico.',
      explanation: 'Questo sbilanciamento può compromettere la composizione corporea.'
    });
  }

  if (calories.variability === 'erratic') {
    report.detectedPatterns.push({
      id: 'erratic_calories',
      type: 'warning',
      severity: 3,
      title: 'Oscillazioni Caloriche',
      evidence: 'Forte variabilità nell\'apporto calorico quotidiano.',
      timeframe: 'Questa settimana',
      action: 'Cerca di mantenere un apporto calorico più costante.',
      explanation: 'Un apporto incostante rende difficile tracciare i progressi reali.'
    });
  }

  if (training.daysSinceLastWorkout !== null && training.daysSinceLastWorkout >= THRESHOLDS.WORKOUT_ALERT_DAYS) {
    report.detectedPatterns.push({
      id: 'missing_workouts',
      type: 'alert',
      severity: 4,
      title: 'Assenza di Allenamenti',
      evidence: `Nessun allenamento da ${training.daysSinceLastWorkout} giorni.`,
      timeframe: 'Attuale',
      action: 'Pianifica un allenamento il prima possibile per riprendere il ritmo.',
      explanation: 'La costanza è il fattore più importante per ottenere risultati.'
    });
  }

  if (training.completed > 0 && training.consistency === 'excellent') {
    report.detectedPatterns.push({
      id: 'consistent_training',
      type: 'positive',
      severity: 1,
      title: 'Ottima Costanza',
      evidence: 'Hai completato tutti gli allenamenti previsti.',
      timeframe: 'Questa settimana',
      action: 'Continua così!',
      explanation: 'Stai mantenendo una regolarità eccellente.'
    });
  }
}

/**
 * Populates the trendOverview object with formatted Italian summaries
 */
function generateTrendOverview(report, daysWithData, totalDays) {
  const c = report.calories;
  const p = report.macros.protein;
  const f = report.macros.fat;
  const cb = report.macros.carbs;

  report.trendOverview = {
    calories: {
      label: 'Calorie',
      value: Math.round(c.avgActual),
      target: Math.round(c.avgTarget),
      pct: c.avgTarget ? Math.round((c.avgActual / c.avgTarget) * 100) : 0,
      status: c.avgActual > c.avgTarget * 1.05 ? 'warning' : c.avgActual < c.avgTarget * 0.95 ? 'alert' : 'ok',
      detail: `${c.daysOnTarget} giorni in target`
    },
    protein: {
      label: 'Proteine',
      value: Math.round(p.avg),
      target: Math.round(p.target),
      pct: p.target ? Math.round((p.avg / p.target) * 100) : 0,
      status: p.avg < p.target * 0.9 ? 'alert' : 'ok',
      detail: `Media ${Math.round(p.avg)}g / giorno`
    },
    fat: {
      label: 'Grassi',
      value: Math.round(f.avg),
      target: Math.round(f.target),
      pct: f.target ? Math.round((f.avg / f.target) * 100) : 0,
      status: f.avg > f.target * 1.1 ? 'warning' : 'ok',
      detail: `Media ${Math.round(f.avg)}g / giorno`
    },
    carbs: {
      label: 'Carboidrati',
      value: Math.round(cb.avg),
      target: Math.round(cb.target),
      pct: cb.target ? Math.round((cb.avg / cb.target) * 100) : 0,
      status: cb.avg > cb.target * 1.1 || cb.avg < cb.target * 0.9 ? 'warning' : 'ok',
      detail: `Media ${Math.round(cb.avg)}g / giorno`
    },
    workouts: {
      label: 'Allenamenti',
      completed: report.training.completed,
      planned: report.training.planned,
      daysSinceLast: report.training.daysSinceLastWorkout,
      status: report.training.missed > 0 ? 'warning' : 'ok',
      detail: report.training.daysSinceLastWorkout !== null ? `${report.training.daysSinceLastWorkout} gg dall'ultimo` : 'Nessun dato'
    },
    consistency: {
      label: 'Tracciamento',
      daysLogged: daysWithData,
      totalDays: totalDays,
      pct: totalDays ? Math.round((daysWithData / totalDays) * 100) : 0,
      status: daysWithData >= Math.ceil(totalDays * 0.7) ? 'ok' : 'warning'
    }
  };
}

/**
 * Creates short-term action plan in Italian based on the report
 */
function generateActionPlan(report) {
  const actionsToday = [];
  
  if (report.macros.protein.daysBelow80pct > 0) {
    actionsToday.push({
      text: 'Aumenta le proteine magre',
      rationale: 'Sei stato sotto l\'obiettivo proteico di recente.'
    });
  }

  if (report.training.daysSinceLastWorkout !== null && report.training.daysSinceLastWorkout >= 2) {
    actionsToday.push({
      text: 'Programma un allenamento',
      rationale: 'Sono passati alcuni giorni dalla tua ultima sessione.'
    });
  }

  if (actionsToday.length > 0) {
    report.actionPlan.push({ day: 'oggi', actions: actionsToday });
  } else {
    report.actionPlan.push({ day: 'oggi', actions: [{ text: 'Mantieni la costanza', rationale: 'I tuoi valori sono in linea.' }] });
  }
}

/**
 * Minimizes InsightReport to a summary format for external AI services.
 * 
 * @param {Object} report - The full InsightReport object.
 * @returns {Object} Minimized object for AI.
 */
export function buildAISummary(report) {
  if (!report || !report.period) return {};
  return {
    period: {
      start: report.period.start,
      end: report.period.end,
      daysWithData: report.period.daysWithData
    },
    calories: {
      avgActual: Math.round(report.calories.avgActual),
      avgTarget: Math.round(report.calories.avgTarget),
      daysAbove: report.calories.daysAbove,
      daysBelow: report.calories.daysBelow,
      variability: report.calories.variability
    },
    macros: {
      protein: {
        avg: Math.round(report.macros.protein.avg),
        target: Math.round(report.macros.protein.target),
        daysBelow80pct: report.macros.protein.daysBelow80pct
      },
      carbs: {
        avg: Math.round(report.macros.carbs.avg),
        target: Math.round(report.macros.carbs.target)
      },
      fat: {
        avg: Math.round(report.macros.fat.avg),
        target: Math.round(report.macros.fat.target),
        daysAbove120pct: report.macros.fat.daysAbove120pct
      }
    },
    training: {
      completed: report.training.completed,
      planned: report.training.planned,
      missed: report.training.missed,
      daysSinceLastWorkout: report.training.daysSinceLastWorkout
    },
    detectedPatterns: report.detectedPatterns.map(p => ({
      id: p.id,
      title: p.title
    }))
  };
}

/**
 * Generates a local, plain Italian text fallback summary from the report.
 * Used when Gemini or external AI is unavailable.
 * 
 * @param {Object} report - The full InsightReport object.
 * @returns {string} 2-4 sentences summary in Italian.
 */
export function generateLocalFallback(report) {
  if (report.period.daysWithData === 0) {
    return 'Dati insufficienti per generare un riepilogo. Assicurati di tracciare le tue giornate.';
  }

  const sentences = [];
  
  // High priority issue
  const alerts = report.focusInsights.filter(i => i.type === 'alert' || i.type === 'warning');
  if (alerts.length > 0) {
    sentences.push(alerts[0].evidence + ' ' + alerts[0].action);
    if (alerts.length > 1) {
      sentences.push(alerts[1].action);
    }
  } else {
    sentences.push('I tuoi macronutrienti e calorie sono generalmente in linea con gli obiettivi.');
  }

  // Positive reinforcement
  const positives = report.focusInsights.filter(i => i.type === 'positive');
  if (positives.length > 0) {
    sentences.push(positives[0].title + ': ' + positives[0].evidence);
  } else if (report.training.completed > 0) {
    sentences.push(`Ottimo lavoro nell'aver completato ${report.training.completed} allenamenti in questo periodo.`);
  }

  return sentences.join(' ');
}
