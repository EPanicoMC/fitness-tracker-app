import { getDayOfWeek } from './app.js';

/**
 * Standard thresholds for deterministic pattern detection.
 */
export const THRESHOLDS = {
  KCAL_ABOVE_PCT: 1.05,       // >5% above target → flag
  KCAL_BELOW_PCT: 0.95,       // <5% below target → flag  
  PROTEIN_LOW_PCT: 0.90,      // <90% protein target → alert
  FAT_HIGH_PCT: 1.10,         // >110% fat target → flag
  CARBS_HIGH_PCT: 1.10,       // >110% carbs target → flag
  CARBS_LOW_PCT: 0.90,        // <90% carbs target → flag
  PATTERN_MIN_DAYS: 2,        // minimum days to detect a pattern
  WORKOUT_ALERT_DAYS: 3,      // 3+ days since last workout → alert
  DATA_INSUFFICIENT_DAYS: 2,  // <2 days with data → insufficient
};

// Helper: safe division
const safeDiv = (num, denom) => denom ? num / denom : 0;

/**
 * Normalizes daily logs into a clean, structured array of valid days and metadata.
 * Does NOT treat missing days as 0 kcal.
 */
export function normalizeDiaryAnalyticsData(dates, logs, programData, dietPlan, settings, todayStr) {
  if (!dates || dates.length === 0) return { validDays: [], allDays: [] };

  const allDays = dates.map(dateStr => {
    const isToday = dateStr === todayStr;
    const isFuture = dateStr > todayStr;
    const dow = getDayOfWeek(dateStr);

    // Find log entry
    let log = null;
    if (logs) {
      if (Array.isArray(logs)) log = logs.find(l => l.date === dateStr) || null;
      else log = logs[dateStr] || null;
    }

    // Planned workout
    const plannedSession = programData?.schedule?.[dow] || null;
    let isTrainingDay = !!plannedSession;
    if (log && log.is_training_day !== undefined) {
      isTrainingDay = log.is_training_day;
    }

    // Determine target nutrition
    let target = { kcal: 0, protein: 0, carbs: 0, fats: 0 };
    if (dietPlan) {
      const plan = isTrainingDay ? (dietPlan.day_on || dietPlan.day_off) : (dietPlan.day_off || dietPlan.day_on);
      if (plan) {
        target = {
          kcal: plan.kcal || 0,
          protein: plan.protein || 0,
          carbs: plan.carbs || 0,
          fats: plan.fats || 0,
        };
      }
    }

    // Actual nutrition
    const hasNut = log && log.nutrition && log.nutrition.totals && log.nutrition.totals.kcal > 0;
    const nut = hasNut ? {
      kcal: log.nutrition.totals.kcal || 0,
      protein: log.nutrition.totals.protein || 0,
      carbs: log.nutrition.totals.carbs || 0,
      fats: log.nutrition.totals.fats || 0,
    } : null;

    // Workout completed
    const workoutDone = !!(log?.workout?.completed);

    // Incomplete today flag
    const isIncomplete = isToday && (!hasNut || (log.meals_state && Object.values(log.meals_state).filter(Boolean).length < 3));

    return {
      date: dateStr,
      isToday,
      isFuture,
      isLogged: hasNut,
      isIncomplete,
      isTrainingDay,
      plannedSession,
      workoutDone,
      workoutName: log?.workout?.session_name || plannedSession?.name || null,
      nut,
      target,
      log
    };
  });

  // Valid days for historical analytics: logged days excluding incomplete today or future
  const validDays = allDays.filter(d => d.isLogged && !d.isFuture);

  return { validDays, allDays };
}

/**
 * Calculates aggregate period metrics based on weighted sums of valid days only.
 */
export function calculatePeriodMetrics(validDays, dates, todayStr) {
  const daysLogged = validDays.length;
  const totalDays = dates ? dates.length : 0;

  if (daysLogged === 0) {
    return {
      daysLogged: 0,
      totalDays,
      insufficientData: true,
      calories: { periodActual: 0, periodTarget: 0, periodDelta: 0, averageActual: 0, averageTarget: 0, averageDelta: 0, adherence: 0 },
      protein: { avgActual: 0, avgTarget: 0, avgDelta: 0 },
      fat: { avgActual: 0, avgTarget: 0, avgDelta: 0 },
      carbs: { avgActual: 0, avgTarget: 0, avgDelta: 0 },
      training: { plannedCount: 0, completedCount: 0, missedCount: 0, completionRate: 0, daysSinceLastWorkout: null }
    };
  }

  // Energy sums
  const periodKcalActual = validDays.reduce((acc, d) => acc + d.nut.kcal, 0);
  const periodKcalTarget = validDays.reduce((acc, d) => acc + d.target.kcal, 0);
  const periodKcalDelta = periodKcalActual - periodKcalTarget;
  const avgKcalActual = periodKcalActual / daysLogged;
  const avgKcalTarget = periodKcalTarget / daysLogged;
  const avgKcalDelta = avgKcalActual - avgKcalTarget;

  // Macros
  const periodProteinActual = validDays.reduce((acc, d) => acc + d.nut.protein, 0);
  const periodProteinTarget = validDays.reduce((acc, d) => acc + d.target.protein, 0);
  const avgProteinActual = periodProteinActual / daysLogged;
  const avgProteinTarget = periodProteinTarget / daysLogged;
  const avgProteinDelta = avgProteinActual - avgProteinTarget;

  const periodFatActual = validDays.reduce((acc, d) => acc + d.nut.fats, 0);
  const periodFatTarget = validDays.reduce((acc, d) => acc + d.target.fats, 0);
  const avgFatActual = periodFatActual / daysLogged;
  const avgFatTarget = periodFatTarget / daysLogged;
  const avgFatDelta = avgFatActual - avgFatTarget;

  const periodCarbsActual = validDays.reduce((acc, d) => acc + d.nut.carbs, 0);
  const periodCarbsTarget = validDays.reduce((acc, d) => acc + d.target.carbs, 0);
  const avgCarbsActual = periodCarbsActual / daysLogged;
  const avgCarbsTarget = periodCarbsTarget / daysLogged;
  const avgCarbsDelta = avgCarbsActual - avgCarbsTarget;

  // Training metrics
  let plannedCount = 0;
  let completedCount = 0;
  let missedCount = 0;
  let lastWorkoutDate = null;

  validDays.forEach(d => {
    if (d.isTrainingDay) plannedCount++;
    if (d.workoutDone) {
      completedCount++;
      if (!lastWorkoutDate || d.date > lastWorkoutDate) lastWorkoutDate = d.date;
    } else if (d.isTrainingDay && d.date <= todayStr) {
      missedCount++;
    }
  });

  const daysSinceLastWorkout = lastWorkoutDate
    ? Math.floor((new Date(todayStr) - new Date(lastWorkoutDate)) / (1000 * 60 * 60 * 24))
    : null;

  return {
    daysLogged,
    totalDays,
    insufficientData: daysLogged < THRESHOLDS.DATA_INSUFFICIENT_DAYS,
    calories: {
      periodActual: periodKcalActual,
      periodTarget: periodKcalTarget,
      periodDelta: periodKcalDelta,
      averageActual: Math.round(avgKcalActual),
      averageTarget: Math.round(avgKcalTarget),
      averageDelta: Math.round(avgKcalDelta),
      adherence: safeDiv(periodKcalActual, periodKcalTarget)
    },
    protein: {
      avgActual: Math.round(avgProteinActual),
      avgTarget: Math.round(avgProteinTarget),
      avgDelta: Math.round(avgProteinDelta)
    },
    fat: {
      avgActual: Math.round(avgFatActual),
      avgTarget: Math.round(avgFatTarget),
      avgDelta: Math.round(avgFatDelta)
    },
    carbs: {
      avgActual: Math.round(avgCarbsActual),
      avgTarget: Math.round(avgCarbsTarget),
      avgDelta: Math.round(avgCarbsDelta)
    },
    training: {
      plannedCount,
      completedCount,
      missedCount,
      completionRate: safeDiv(completedCount, plannedCount),
      daysSinceLastWorkout
    }
  };
}

/**
 * Detects domain patterns based on calculated metrics and daily observations.
 */
export function detectPatterns(metrics, validDays) {
  const patterns = [];
  if (metrics.insufficientData) return patterns;

  const { calories, protein, fat, carbs, training, daysLogged } = metrics;

  // Energy pattern
  if (calories.averageDelta > 50) {
    patterns.push({
      id: 'high_calories',
      domain: 'energy',
      severity: calories.averageDelta > 200 ? 4 : 3,
      persistence: daysLogged >= 3 ? 4 : 2,
      confidence: 5,
      actionability: 4,
      title: 'Eccesso Calorico',
      evidence: `Media di ${calories.averageActual} kcal/giorno (${calories.averageDelta > 0 ? '+' : ''}${calories.averageDelta} kcal rispetto al target).`,
      actual: calories.averageActual,
      target: calories.averageTarget,
      delta: calories.averageDelta,
      recommendedAction: 'Torna al target calorico previsto mantenendo le porzioni controllate.'
    });
  } else if (calories.averageDelta < -150) {
    patterns.push({
      id: 'low_calories',
      domain: 'energy',
      severity: 3,
      persistence: daysLogged >= 3 ? 4 : 2,
      confidence: 5,
      actionability: 4,
      title: 'Apporto Calorico Basso',
      evidence: `Media di ${calories.averageActual} kcal/giorno (${calories.averageDelta} kcal rispetto al target).`,
      actual: calories.averageActual,
      target: calories.averageTarget,
      delta: calories.averageDelta,
      recommendedAction: 'Aggiungi uno spuntino nutriente per evitare cali energetici e sostenere il recupero.'
    });
  }

  // Fat pattern
  if (fat.avgDelta > 8) {
    patterns.push({
      id: 'high_fat',
      domain: 'fat',
      severity: fat.avgDelta > 20 ? 4 : 3,
      persistence: daysLogged >= 3 ? 4 : 2,
      confidence: 5,
      actionability: 5,
      title: 'Grassi Sopra Target',
      evidence: `Grassi a ${fat.avgActual} g/giorno in media (+${fat.avgDelta} g rispetto all'obiettivo).`,
      actual: fat.avgActual,
      target: fat.avgTarget,
      delta: fat.avgDelta,
      recommendedAction: 'Riduci l\'uso di condimenti grassi e snack ad elevata densità lipidica.'
    });
  }

  // Protein pattern
  if (protein.avgDelta < -5) {
    patterns.push({
      id: 'low_protein',
      domain: 'protein',
      severity: protein.avgDelta < -15 ? 4 : 3,
      persistence: daysLogged >= 3 ? 4 : 2,
      confidence: 5,
      actionability: 5,
      title: 'Proteine Sotto Target',
      evidence: `Proteine a ${protein.avgActual} g/giorno in media (${protein.avgDelta} g rispetto all'obiettivo).`,
      actual: protein.avgActual,
      target: protein.avgTarget,
      delta: protein.avgDelta,
      recommendedAction: 'Aggiungi fonti proteiche magre ai tuoi pasti principali.'
    });
  }

  // Carbs pattern
  if (carbs.avgDelta > 20) {
    patterns.push({
      id: 'high_carbs',
      domain: 'carbs',
      severity: 2,
      persistence: 3,
      confidence: 4,
      actionability: 3,
      title: 'Carboidrati Moderatamente Alti',
      evidence: `Carboidrati a ${carbs.avgActual} g/giorno in media (+${carbs.avgDelta} g rispetto al target).`,
      actual: carbs.avgActual,
      target: carbs.avgTarget,
      delta: carbs.avgDelta,
      recommendedAction: 'Modera le porzioni di amidi nei giorni di riposo.'
    });
  }

  // Training pattern (Positive)
  if (training.completedCount > 0) {
    patterns.push({
      id: 'training_success',
      domain: 'training',
      severity: 1, // Positive secondary
      persistence: 4,
      confidence: 5,
      actionability: 2,
      title: 'Allenamenti Regolari',
      evidence: `Completati ${training.completedCount} allenamenti nel periodo analizzato.`,
      actual: training.completedCount,
      target: training.plannedCount,
      delta: training.completedCount - training.plannedCount,
      recommendedAction: 'Mantieni questa regolarità nelle sessioni programmate.'
    });
  }

  return patterns;
}

/**
 * Merges correlated patterns into a single unified story to prevent duplication.
 */
export function mergeRelatedPatterns(patterns, metrics) {
  if (!patterns || patterns.length === 0) return [];

  const hasHighKcal = patterns.some(p => p.id === 'high_calories');
  const hasHighFat = patterns.some(p => p.id === 'high_fat');
  const hasLowProtein = patterns.some(p => p.id === 'low_protein');

  // Unified story: High kcal + High fat + Low protein
  if (hasHighKcal && hasHighFat && hasLowProtein) {
    const filtered = patterns.filter(p => !['high_calories', 'high_fat', 'low_protein'].includes(p.id));
    const merged = {
      id: 'nutritional_imbalance_primary',
      domain: 'nutrition',
      severity: 5,
      persistence: 4,
      confidence: 5,
      actionability: 5,
      title: 'Alimentazione da Riequilibrare',
      evidence: `Negli ultimi ${metrics.daysLogged} giorni registrati hai assunto in media ${metrics.calories.averageActual} kcal/giorno (+${metrics.calories.averageDelta} kcal rispetto al target). Lo scostamento è legato soprattutto ai grassi (+${metrics.fat.avgDelta} g/giorno), mentre le proteine rimangono sotto target (${metrics.protein.avgDelta} g/giorno).`,
      explanation: 'Sostituire parte delle fonti alimentari più ricche di grassi con alternative proteiche più magre ti permette di aumentare l\'apporto proteico senza incrementare ulteriormente le calorie complessive.',
      recommendedAction: 'Non aggiungere semplicemente cibo: mantieni il target calorico e sostituisci le fonti più grasse con opzioni proteiche magre (petto di pollo, merluzzo, albumi, yogurt greco magro).'
    };
    return [merged, ...filtered];
  }

  // Unified story: High kcal + High fat
  if (hasHighKcal && hasHighFat) {
    const filtered = patterns.filter(p => !['high_calories', 'high_fat'].includes(p.id));
    const merged = {
      id: 'high_kcal_fat_primary',
      domain: 'nutrition',
      severity: 4,
      persistence: 4,
      confidence: 5,
      actionability: 4,
      title: 'Eccesso Calorico da Grassi',
      evidence: `Eccesso medio di ${metrics.calories.averageDelta} kcal/giorno guidato da un apporto di grassi di +${metrics.fat.avgDelta} g/giorno oltre il target.`,
      explanation: 'I grassi hanno un\'elevata densità calorica (9 kcal/g). Una leggera riduzione dei condimenti riporta rapidamente le calorie in target.',
      recommendedAction: 'Ripristina il target normale nei prossimi pasti controllando i condimenti, senza ricorrere a digiuni di compensazione.'
    };
    return [merged, ...filtered];
  }

  return patterns;
}

/**
 * Ranks insights using formula: priorityScore = severity * persistence * confidence * actionability.
 */
export function rankInsights(patterns) {
  if (!patterns || patterns.length === 0) {
    return { primary: null, secondary: [], positive: null };
  }

  const scored = patterns.map(p => ({
    ...p,
    priorityScore: (p.severity || 1) * (p.persistence || 1) * (p.confidence || 1) * (p.actionability || 1)
  })).sort((a, b) => b.priorityScore - a.priorityScore);

  const primary = scored.find(p => p.severity >= 3) || scored[0];
  const positive = scored.find(p => p.domain === 'training' || p.severity === 1) || null;
  const secondary = scored.filter(p => p !== primary && p !== positive).slice(0, 2);

  return { primary, secondary, positive };
}

/**
 * Builds a 3-step contextual action plan.
 */
export function buildActionPlan(rankedInsights, metrics) {
  const steps = [];

  if (metrics.insufficientData) {
    return [
      { timeframe: 'Oggi', text: 'Registra i tuoi pasti ed allenamenti per sbloccare l\'analisi del coach.' }
    ];
  }

  // Step 1: Oggi
  if (rankedInsights.primary && rankedInsights.primary.domain === 'nutrition') {
    steps.push({
      timeframe: 'Oggi',
      text: 'Torna al target calorico previsto mantenendo le porzioni bilanciate senza digiuni compensativi.'
    });
  } else {
    steps.push({
      timeframe: 'Oggi',
      text: 'Mantieni l\'aderenza ai tuoi target nutrizionali e di allenamento.'
    });
  }

  // Step 2: Prossimi pasti
  if (rankedInsights.primary && rankedInsights.primary.id === 'nutritional_imbalance_primary') {
    steps.push({
      timeframe: 'Prossimi pasti',
      text: 'Privilegia fonti proteiche magre (pollo, albumi, yogurt greco) e riduci l\'olio da condimento.'
    });
  } else if (metrics.protein.avgDelta < 0) {
    steps.push({
      timeframe: 'Prossimi pasti',
      text: 'Inserisci una porzione proteica magra a pranzo e cena.'
    });
  } else {
    steps.push({
      timeframe: 'Prossimi pasti',
      text: 'Bevi almeno 2 litri d\'acqua e consuma verdura per supportare la sazietà.'
    });
  }

  // Step 3: Questa settimana
  if (metrics.training.completedCount > 0) {
    steps.push({
      timeframe: 'Questa settimana',
      text: `Mantieni la regolarità degli allenamenti (${metrics.training.completedCount} completati finora).`
    });
  } else {
    steps.push({
      timeframe: 'Questa settimana',
      text: 'Pianifica le tue prossime sessioni di allenamento nel diario.'
    });
  }

  return steps;
}

/**
 * Builds a clean, structured context payload for Gemini AI.
 */
export function buildAIContext(metrics, rankedInsights, actionPlan) {
  return {
    period: {
      daysLogged: metrics.daysLogged,
      totalDays: metrics.totalDays,
    },
    calories: {
      avgActual: metrics.calories.averageActual,
      avgTarget: metrics.calories.averageTarget,
      avgDelta: metrics.calories.averageDelta,
    },
    macros: {
      protein: metrics.protein,
      fat: metrics.fat,
      carbs: metrics.carbs,
    },
    training: {
      completedCount: metrics.training.completedCount,
      plannedCount: metrics.training.plannedCount,
    },
    primaryInsight: rankedInsights.primary ? {
      title: rankedInsights.primary.title,
      evidence: rankedInsights.primary.evidence,
      recommendedAction: rankedInsights.primary.recommendedAction
    } : null,
    actionPlan: actionPlan.map(a => `${a.timeframe}: ${a.text}`)
  };
}

/**
 * Context summary builder for AI coach prompt payload (alias / wrapper).
 */
export function buildAISummary(report) {
  if (!report) return {};
  if (report.metrics && report.rankedInsights) {
    return buildAIContext(report.metrics, report.rankedInsights, report.actionPlan || []);
  }
  return report;
}

/**
 * Validates Gemini response to prevent contradictory statements.
 */
export function validateAIResponse(aiText, metrics, rankedInsights) {
  if (!aiText || typeof aiText !== 'string') {
    return { valid: false, reason: 'Testo non valido o vuoto' };
  }

  const lower = aiText.toLowerCase();

  // Anti-contradiction check 1: "Valori in linea" or "tutto bene" when primary is critical
  if (rankedInsights.primary && rankedInsights.primary.severity >= 3) {
    if (lower.includes('valori in linea') || lower.includes('tutto bene') || lower.includes('continua così')) {
      return { valid: false, reason: 'Incoerenza: dichiara valori in linea nonostante criticità nutrizionali' };
    }
  }

  // Anti-contradiction check 2: Fasting or extreme compensations
  if (lower.includes('digiuna') || lower.includes('salta i pasti') || lower.includes('taglio drastico')) {
    return { valid: false, reason: 'Incoerenza: suggerisce compensazioni estreme non ammesse' };
  }

  return { valid: true, sanitizedReport: aiText };
}

/**
 * Builds shared export model for PDF / CSV.
 */
export function buildExportModel(metrics, rankedInsights, actionPlan, validDays, dates, dateFrom, dateTo, options = {}) {
  const checksInput = options.checks || [];

  // Filter checks in period, or fallback to latest check if none in exact period
  let periodChecks = checksInput
    .filter(c => c && c.date && c.date >= dateFrom && c.date <= dateTo)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (periodChecks.length === 0 && checksInput.length > 0) {
    const priorChecks = checksInput
      .filter(c => c && c.date && c.date <= dateTo)
      .sort((a, b) => b.date.localeCompare(a.date));
    if (priorChecks.length > 0) {
      periodChecks = [priorChecks[0]];
    }
  }

  const checks = periodChecks.map((c, idx, arr) => {
    const prev = idx > 0 ? arr[idx - 1] : null;
    const weightDelta = prev && c.weight != null && prev.weight != null
      ? Number((c.weight - prev.weight).toFixed(1))
      : null;

    const photos = (c.photos || []).map(p => {
      if (typeof p === 'string') return { url: p, view: 'foto' };
      if (typeof p === 'object' && p) return { url: p.url || '', view: p.view || 'foto' };
      return null;
    }).filter(p => p && p.url);

    return {
      id: c.id,
      date: c.date,
      weight: c.weight || null,
      weightDelta,
      bodyFat: c.body_fat || null,
      muscleMass: c.muscle_mass || null,
      measurements: c.measurements || {},
      notes: c.notes || '',
      photos
    };
  });

  return {
    meta: {
      title: 'Andamento Fitness KOVA',
      dateFrom,
      dateTo,
      generatedAt: new Date().toLocaleString('it-IT'),
      daysLogged: metrics.daysLogged,
      totalDays: metrics.totalDays,
    },
    metrics,
    insights: rankedInsights,
    actionPlan,
    dailyTable: validDays.map(d => ({
      date: d.date,
      status: d.isIncomplete ? 'In corso' : 'Completo',
      kcalActual: d.nut.kcal,
      kcalTarget: d.target.kcal,
      kcalDelta: d.nut.kcal - d.target.kcal,
      proteinActual: d.nut.protein,
      proteinTarget: d.target.protein,
      fatActual: d.nut.fats,
      fatTarget: d.target.fats,
      carbsActual: d.nut.carbs,
      carbsTarget: d.target.carbs,
      workout: d.workoutDone ? (d.workoutName || 'Completato') : (d.isTrainingDay ? 'Saltato' : 'Riposo')
    })),
    checks
  };
}

/**
 * Main pure analysis entry point.
 */
export function analyzeWeeklyData(dates, logs, programData, dietPlan, settings, todayStr) {
  const { validDays, allDays } = normalizeDiaryAnalyticsData(dates, logs, programData, dietPlan, settings, todayStr);
  const metrics = calculatePeriodMetrics(validDays, dates, todayStr);
  const rawPatterns = detectPatterns(metrics, validDays);
  const mergedPatterns = mergeRelatedPatterns(rawPatterns, metrics);
  const rankedInsights = rankInsights(mergedPatterns);
  const actionPlan = buildActionPlan(rankedInsights, metrics);

  return {
    period: { start: dates[0], end: dates[dates.length - 1], daysAnalyzed: dates.length, daysWithData: metrics.daysLogged },
    metrics,
    allDays,
    validDays,
    detectedPatterns: mergedPatterns,
    focusInsights: [
      ...(rankedInsights.primary ? [rankedInsights.primary] : []),
      ...rankedInsights.secondary,
      ...(rankedInsights.positive ? [rankedInsights.positive] : [])
    ],
    rankedInsights,
    actionPlan
  };
}

/**
 * Generates local text fallback summary when Gemini is unavailable.
 */
export function generateLocalFallback(report) {
  if (!report || report.metrics?.insufficientData) {
    return 'Dati insufficienti per generare un riepilogo. Assicurati di tracciare le tue giornate nel diario.';
  }

  const { primary, positive } = report.rankedInsights;
  const parts = [];

  if (primary) {
    parts.push(`📌 ${primary.title}: ${primary.evidence} ${primary.recommendedAction}`);
  } else {
    parts.push('I tuoi macronutrienti e calorie sono generalmente in linea con gli obiettivi previsti.');
  }

  if (positive) {
    parts.push(`💪 ${positive.title}: ${positive.evidence}`);
  }

  return parts.join(' ');
}
