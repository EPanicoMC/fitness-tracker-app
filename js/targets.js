/**
 * targets.js — Unica Fonte di Verità per i Target Giornalieri (Fase 3.1)
 *
 * Esporta:
 *   getDailyTargets(date, context) → {
 *     kcal, protein, carbs, fats, saturatedFat, steps,
 *     isTrainingDay, dayKey, source: 'plan' | 'checkin' | 'adaptive', reason
 *   }
 *
 * Ordine di priorità:
 *   1. Target confermato nell'ultimo check-in settimanale (weeklyCheckin confermato dall'utente)
 *   2. Piano dieta attivo (day_on / day_off)
 *   3. Configurazione di fase (getPhaseConfig fallback)
 *   (Nota: la raccomandazione Kalman NON si applica mai da sola, ma passa sempre dal check-in settimanale).
 */

import { getPhaseConfig } from './phase-config.js';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Calcola la chiave settimana ISO YYYY-Www per una data YYYY-MM-DD.
 */
export function getIsoWeekKey(dateStr) {
  const d = dateStr ? new Date(dateStr + 'T12:00:00Z') : new Date();
  if (isNaN(d.getTime())) return '2026-W01';
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function getDayKeyFromDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') {
    return DAY_KEYS[new Date().getDay()];
  }
  const d = new Date(dateStr + 'T12:00:00');
  if (isNaN(d.getTime())) return DAY_KEYS[new Date().getDay()];
  return DAY_KEYS[d.getDay()];
}

export function resolveIsTrainingDay(dateStr, {
  isTrainingDay = null,
  logEntry = null,
  activeProgram = null
} = {}) {
  if (typeof isTrainingDay === 'boolean') return isTrainingDay;
  if (logEntry && typeof logEntry.is_training_day === 'boolean') return logEntry.is_training_day;
  if (logEntry && typeof logEntry.day_override === 'boolean') return logEntry.day_override;
  const dow = getDayKeyFromDate(dateStr);
  const sched = activeProgram?.schedule?.[dow];
  return Boolean(sched && sched !== 'off' && sched !== 'rest');
}

function resolveCheckinFromContext(date, weeklyCheckin, weeklyCheckinsMap) {
  if (weeklyCheckin) return weeklyCheckin;
  const weekKey = getIsoWeekKey(date);
  if (weeklyCheckinsMap && typeof weeklyCheckinsMap === 'object' && weeklyCheckinsMap[weekKey]) {
    return weeklyCheckinsMap[weekKey];
  }
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem('kova_weekly_checkins_v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed[weekKey]) return parsed[weekKey];
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Restituisce i target giornalieri unificati per una specifica data.
 */
export function getDailyTargets(date, context = {}) {
  const {
    activeDiet = null,
    activeProgram = null,
    appSettings = null,
    profile = null,
    logEntry = null,
    isTrainingDay: explicitTrainingDay = null,
    weeklyCheckin: rawWeeklyCheckin = null,
    weeklyCheckins = null,
    energyOutput = null,
    allowAdaptiveFallback = false
  } = context;

  const weeklyCheckin = resolveCheckinFromContext(date, rawWeeklyCheckin, weeklyCheckins);

  const isTrainingDay = resolveIsTrainingDay(date, {
    isTrainingDay: explicitTrainingDay,
    logEntry,
    activeProgram
  });
  const dayKey = isTrainingDay ? 'day_on' : 'day_off';
  const phaseCfg = getPhaseConfig({ program: activeProgram, settings: appSettings });

  const stepsGoal = Number(
    appSettings?.steps_goal ||
    profile?.steps_goal ||
    appSettings?.profile?.steps_goal ||
    phaseCfg?.steps_daily ||
    10000
  );

  // 1. Check-in settimanale esplicitamente confermato dall'utente ('accepted' | 'modified')
  if (
    weeklyCheckin &&
    (weeklyCheckin.status === 'accepted' || weeklyCheckin.status === 'modified') &&
    (weeklyCheckin.confirmedTarget != null || weeklyCheckin.confirmedKcal != null || weeklyCheckin.day_on != null || weeklyCheckin.deltaKcal != null)
  ) {
    const basePlan = activeDiet?.[dayKey] || null;
    const ct = weeklyCheckin.confirmedTarget;

    if (ct && Number(ct.kcal) > 0) {
      const chosenKcal = isTrainingDay
        ? Number(ct.dayOnKcal ?? ct.kcal)
        : Number(ct.dayOffKcal ?? ct.kcal);
      return {
        kcal: Math.round(chosenKcal),
        protein: Math.round(Number(ct.protein ?? basePlan?.protein ?? 170)),
        carbs: Math.round(Number(ct.carbs ?? basePlan?.carbs ?? 180)),
        fats: Math.round(Number(ct.fats ?? basePlan?.fats ?? 55)),
        saturatedFat: Number(basePlan?.saturatedFat ?? phaseCfg?.saturatedFatMax ?? 20),
        steps: stepsGoal,
        isTrainingDay,
        dayKey,
        source: 'checkin',
        reason: `Check-in settimanale confermato (${weeklyCheckin.weekId || weeklyCheckin.isoWeek || 'attivo'})`
      };
    }

    const checkDayPlan = weeklyCheckin[dayKey] || null;
    if (checkDayPlan && Number(checkDayPlan.kcal) > 0) {
      return {
        kcal: Math.round(Number(checkDayPlan.kcal)),
        protein: Math.round(Number(checkDayPlan.protein ?? basePlan?.protein ?? 0)),
        carbs: Math.round(Number(checkDayPlan.carbs ?? basePlan?.carbs ?? 0)),
        fats: Math.round(Number(checkDayPlan.fats ?? basePlan?.fats ?? 0)),
        saturatedFat: Number(checkDayPlan.saturatedFat ?? basePlan?.saturatedFat ?? phaseCfg?.saturatedFatMax ?? 20),
        steps: stepsGoal,
        isTrainingDay,
        dayKey,
        source: 'checkin',
        reason: `Check-in settimanale confermato (${weeklyCheckin.isoWeek || 'attivo'})`
      };
    }

    if (basePlan && Number(basePlan.kcal) > 0 && weeklyCheckin.deltaKcal != null) {
      const delta = Math.round(Number(weeklyCheckin.deltaKcal) || 0);
      const adjKcal = Math.max(1200, Math.round(Number(basePlan.kcal) + delta));
      const adjCarbs = Math.max(0, Math.round(Number(basePlan.carbs || 0) + delta / 4));
      return {
        kcal: adjKcal,
        protein: Math.round(Number(weeklyCheckin.confirmedProtein ?? basePlan.protein ?? 0)),
        carbs: adjCarbs,
        fats: Math.round(Number(basePlan.fats ?? 0)),
        saturatedFat: Number(basePlan.saturatedFat ?? phaseCfg?.saturatedFatMax ?? 20),
        steps: stepsGoal,
        isTrainingDay,
        dayKey,
        source: 'checkin',
        reason: `Piano dieta + variazione confermata al check-in (${delta >= 0 ? '+' : ''}${delta} kcal)`
      };
    }

    if (Number(weeklyCheckin.confirmedKcal) > 0) {
      const kcal = Math.round(Number(weeklyCheckin.confirmedKcal));
      const macros = weeklyCheckin.confirmedMacros || {};
      return {
        kcal,
        protein: Math.round(Number(macros.protein ?? basePlan?.protein ?? phaseCfg?.macro?.avg?.protein ?? 160)),
        carbs: Math.round(Number(macros.carbs ?? basePlan?.carbs ?? phaseCfg?.macro?.avg?.carbs ?? 180)),
        fats: Math.round(Number(macros.fats ?? basePlan?.fats ?? phaseCfg?.macro?.avg?.fats ?? 55)),
        saturatedFat: Number(basePlan?.saturatedFat ?? phaseCfg?.saturatedFatMax ?? 20),
        steps: stepsGoal,
        isTrainingDay,
        dayKey,
        source: 'checkin',
        reason: `Target confermato al check-in settimanale (${weeklyCheckin.isoWeek || 'attivo'})`
      };
    }
  }

  // 2. Piano dieta attivo (day_on / day_off)
  const dietSlot = activeDiet?.[dayKey] || null;
  if (dietSlot && (Number(dietSlot.kcal) > 0 || Number(dietSlot.protein) > 0)) {
    return {
      kcal: Math.round(Number(dietSlot.kcal) || 0),
      protein: Math.round(Number(dietSlot.protein) || 0),
      carbs: Math.round(Number(dietSlot.carbs) || 0),
      fats: Math.round(Number(dietSlot.fats) || 0),
      saturatedFat: Number(dietSlot.saturatedFat ?? phaseCfg?.saturatedFatMax ?? 20),
      steps: stepsGoal,
      isTrainingDay,
      dayKey,
      source: 'plan',
      reason: `Piano dieta attivo (${activeDiet?.name || (isTrainingDay ? 'Giorno ON' : 'Giorno OFF')})`
    };
  }

  // 3. Fallback adattivo (solo se esplicitamente richiesto e non esiste piano dieta)
  if (allowAdaptiveFallback && energyOutput && Number(energyOutput.recommendedKcal) > 0) {
    const recM = energyOutput.recommendedMacros || {};
    return {
      kcal: Math.round(Number(energyOutput.recommendedKcal)),
      protein: Math.round(Number(recM.protein) || 160),
      carbs: Math.round(Number(recM.carbs) || 180),
      fats: Math.round(Number(recM.fats) || 55),
      saturatedFat: Number(phaseCfg?.saturatedFatMax ?? 20),
      steps: stepsGoal,
      isTrainingDay,
      dayKey,
      source: 'adaptive',
      reason: 'Stima adattiva TDEE Kalman (nessun piano dieta attivo)'
    };
  }

  // 4. Configurazione di fase (PHASE_CONFIG / override utente)
  const phaseKcal = isTrainingDay
    ? (phaseCfg?.kcal?.training ?? 2140)
    : (phaseCfg?.kcal?.rest ?? 1800);
  const phaseMacro = isTrainingDay
    ? (phaseCfg?.macro?.training || { protein: 189, carbs: 219, fats: 53, saturatedFat: 18 })
    : (phaseCfg?.macro?.rest || { protein: 173, carbs: 139, fats: 58, saturatedFat: 20 });

  return {
    kcal: Math.round(Number(phaseKcal) || 2000),
    protein: Math.round(Number(phaseMacro.protein) || 175),
    carbs: Math.round(Number(phaseMacro.carbs) || 180),
    fats: Math.round(Number(phaseMacro.fats) || 55),
    saturatedFat: Number(phaseMacro.saturatedFat ?? phaseCfg?.saturatedFatMax ?? 20),
    steps: stepsGoal,
    isTrainingDay,
    dayKey,
    source: 'plan',
    reason: `Configurazione di fase (${phaseCfg?.name || 'Default'})`
  };
}
