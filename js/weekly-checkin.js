/**
 * weekly-checkin.js — Motore di Check-in Settimanale Adattivo (Fase 4A)
 *
 * Calcola l'aggiustamento calorico settimanale basato sul TDEE Kalman e sul ritmo obiettivo:
 *   • Richiede >= 5/7 giorni di diario completo e >= 8/14 pesate valide.
 *   • Formula: new_target = TDEE_Kalman + (rate_target * rho / 7)
 *   • Vincoli di sicurezza: variazione max ±150 kcal/settimana rispetto al target attuale,
 *     mai sotto la soglia minima clinica (max(BMR, 1500 uomo / 1200 donna)).
 *   • NON modifica mai automaticamente `diet_plans`: salva la proposta in
 *     `users/{uid}/weekly_checkins/{YYYY-Www}` con `model_version: "checkin@2.0"` e applica
 *     il target solo dopo conferma esplicita dell'utente (Accetta / Modifica / Rifiuta).
 */

import { db, doc, setDoc, getDoc, getUserId } from './firebase-config.js';
import { getIsoWeekKey } from './targets.js';

export const WEEKLY_CHECKIN_VERSION = 'checkin@2.0';
const LOCAL_CHECKIN_CACHE_KEY = 'kova_weekly_checkins_v1';

/**
 * Legge la mappa dei check-in settimanali salvati in localStorage (offline-first).
 */
export function loadLocalWeeklyCheckins() {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(LOCAL_CHECKIN_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

/**
 * Salva un check-in nella mappa locale in localStorage.
 */
export function saveLocalWeeklyCheckin(weekId, checkinDoc) {
  if (typeof localStorage === 'undefined' || !weekId || !checkinDoc) return;
  try {
    const all = loadLocalWeeklyCheckins();
    all[weekId] = checkinDoc;
    localStorage.setItem(LOCAL_CHECKIN_CACHE_KEY, JSON.stringify(all));
  } catch (_) {}
}

/**
 * Calcola la proposta deterministica di Check-in Settimanale.
 *
 * @param {Object} params
 * @param {Object} params.energyOutput output di runEnergyBalanceModel
 * @param {Object} [params.profile] profilo utente
 * @param {Object} [params.activeDiet] piano dieta attivo (con day_on / day_off)
 * @param {string} [params.todayDate] data ISO YYYY-MM-DD
 * @param {Object} [params.existingCheckin] eventuale documento già salvato per la settimana corrente
 */
export function computeWeeklyCheckinProposal({
  energyOutput = {},
  profile = {},
  activeDiet = null,
  todayDate = null,
  existingCheckin = null
} = {}) {
  const refDate = todayDate || energyOutput.date || new Date().toISOString().split('T')[0];
  const weekId = getIsoWeekKey(refDate);

  const history = Array.isArray(energyOutput.history) ? energyOutput.history : [];
  const last7 = history.slice(-7);
  const last14 = history.slice(-14);

  const completeDiaryDays7 = last7.filter(s => s.intakeKcal != null && s.intakeComplete !== 'no').length;
  const weighIns14 = last14.filter(s => s.rawWeight != null).length;

  const eligible = completeDiaryDays7 >= 5 && weighIns14 >= 8 && !energyOutput.isPreliminary;

  // Determina target attuale medio e spread ON/OFF dalla dieta attiva
  const onKcal = Number(activeDiet?.day_on?.kcal) || 0;
  const offKcal = Number(activeDiet?.day_off?.kcal) || 0;
  const currentAvgTargetKcal = (onKcal > 0 && offKcal > 0)
    ? Math.round((onKcal * 4 + offKcal * 3) / 7)
    : (onKcal || offKcal || energyOutput.recommendedKcal || 2000);
  const onOffSpread = (onKcal > 0 && offKcal > 0) ? (onKcal - offKcal) : 250;

  const tdeeKalman = Number(energyOutput.tdeeEstimate) || 2200;
  const rho = Number(energyOutput.rhoKcalPerKg) || 7700;
  const rateTargetKgWeek = Number(energyOutput.targetRateKgWeek ?? profile.target_rate_kg_week ?? -0.45);
  const bmr = Number(energyOutput.bmrEstimate) || 1500;
  const sex = String(profile.sex || 'M').toUpperCase();
  const clinicalMin = sex === 'F' ? 1200 : 1500;
  const safeFloorKcal = Math.max(bmr, clinicalMin);

  if (!eligible) {
    const missingReasons = [];
    if (completeDiaryDays7 < 5) {
      missingReasons.push(`Servono almeno 5 giorni di diario completo negli ultimi 7 (attuali: ${completeDiaryDays7}/7).`);
    }
    if (weighIns14 < 8) {
      missingReasons.push(`Servono almeno 8 pesate negli ultimi 14 giorni (attuali: ${weighIns14}/14).`);
    }
    if (energyOutput.isPreliminary) {
      missingReasons.push('La stima del metabolismo è ancora in fase di calibrazione iniziale.');
    }

    return {
      model_version: WEEKLY_CHECKIN_VERSION,
      weekId,
      date: refDate,
      eligible: false,
      status: existingCheckin?.status || 'insufficient_data',
      completeDiaryDays7,
      weighIns14,
      missingReasons,
      currentTargetKcal: currentAvgTargetKcal,
      proposedTargetKcal: currentAvgTargetKcal,
      deltaKcal: 0,
      explanationIt: missingReasons.join(' ')
    };
  }

  // Formula: new_target = TDEE_Kalman + (rate_target * rho / 7)
  const rawFormulaTarget = Math.round(tdeeKalman + (rateTargetKgWeek * rho) / 7);

  // Clamp variazione a max ±150 kcal/settimana rispetto al target attuale
  const rawDelta = rawFormulaTarget - currentAvgTargetKcal;
  const clampedDelta = Math.max(-150, Math.min(150, rawDelta));
  // Arrotonda a multipli di 10 kcal per pulizia visiva
  const roundedDelta = Math.round(clampedDelta / 10) * 10;

  const unclampedProposed = currentAvgTargetKcal + roundedDelta;
  const floorApplied = unclampedProposed < safeFloorKcal;
  const proposedTargetKcal = Math.max(safeFloorKcal, unclampedProposed);
  const finalDeltaKcal = proposedTargetKcal - currentAvgTargetKcal;

  // Calcola anche i target ON e OFF mantenendo lo spread proporzionale della dieta
  const proposedDayOnKcal = Math.max(safeFloorKcal, Math.round(proposedTargetKcal + (onOffSpread * 3) / 7));
  const proposedDayOffKcal = Math.max(safeFloorKcal, Math.round(proposedTargetKcal - (onOffSpread * 4) / 7));

  const trendWeight = Number(energyOutput.trendWeight) || Number(profile.current_weight) || 75;
  const goalType = energyOutput.goalType || profile.goal_type || 'cut';
  const proPerKg = goalType === 'cut' ? 2.1 : 1.8;
  const proteinG = Math.round(Math.min(2.4 * trendWeight, Math.max(1.6 * trendWeight, proPerKg * trendWeight)));
  const fatsG = Math.round(Math.max(0.7 * trendWeight, (proposedTargetKcal * 0.25) / 9));
  const carbsG = Math.max(0, Math.round((proposedTargetKcal - proteinG * 4 - fatsG * 9) / 4));

  const actualRate = Number(energyOutput.weeklyRateKg) || 0;
  let explanationIt = '';
  if (Math.abs(finalDeltaKcal) <= 20) {
    explanationIt = `Il tuo ritmo attuale (${actualRate > 0 ? '+' : ''}${actualRate} kg/sett) è già allineato all'obiettivo (${rateTargetKgWeek} kg/sett). Mantieni invariato il tuo piano attuale di ${currentAvgTargetKcal} kcal/giorno.`;
  } else if (finalDeltaKcal < 0) {
    explanationIt = `In base al tuo consumo reale stimato (${tdeeKalman} kcal/gg) e al ritmo dell'ultima settimana (${actualRate > 0 ? '+' : ''}${actualRate} kg/sett), ti proponiamo un piccolo ritocco di ${finalDeltaKcal} kcal/giorno (${proposedTargetKcal} kcal medie) per centrare il ritmo obiettivo di ${rateTargetKgWeek} kg/sett senza tagli drastici.`;
  } else {
    explanationIt = `Stai scendendo più velocemente del previsto (${actualRate} kg/sett vs obiettivo ${rateTargetKgWeek} kg/sett). Ti proponiamo di alzare il target di +${finalDeltaKcal} kcal/giorno (${proposedTargetKcal} kcal medie) per proteggere massa muscolare ed energie.`;
  }

  return {
    model_version: WEEKLY_CHECKIN_VERSION,
    weekId,
    date: refDate,
    eligible: true,
    status: existingCheckin?.status || 'pending',
    completeDiaryDays7,
    weighIns14,
    tdeeKalman,
    rhoKcalPerKg: rho,
    actualRateKgWeek: actualRate,
    targetRateKgWeek: rateTargetKgWeek,
    currentTargetKcal: currentAvgTargetKcal,
    rawFormulaTargetKcal: rawFormulaTarget,
    proposedTargetKcal,
    proposedDayOnKcal,
    proposedDayOffKcal,
    deltaKcal: finalDeltaKcal,
    floorApplied,
    safeFloorKcal,
    macros: {
      protein: proteinG,
      carbs: carbsG,
      fats: fatsG
    },
    confirmedTarget: existingCheckin?.confirmedTarget || null,
    explanationIt
  };
}

/**
 * Salva la decisione esplicita dell'utente sul Check-in Settimanale (`accepted` | `modified` | `rejected`)
 * su `users/{uid}/weekly_checkins/{YYYY-Www}` e in cache locale `localStorage`.
 */
export async function confirmWeeklyCheckinDecision(proposal, decision = 'accepted', customKcal = null) {
  if (!proposal || !proposal.weekId) return null;
  const uid = getUserId() || 'default_user';
  const status = ['accepted', 'modified', 'rejected'].includes(decision) ? decision : 'accepted';

  const chosenKcal = status === 'modified' && customKcal != null && Number(customKcal) > 1000
    ? Math.max(proposal.safeFloorKcal || 1200, Math.round(Number(customKcal)))
    : status === 'accepted'
      ? proposal.proposedTargetKcal
      : proposal.currentTargetKcal;

  const spreadDiff = (proposal.proposedDayOnKcal || chosenKcal) - (proposal.proposedTargetKcal || chosenKcal);
  const offDiff = (proposal.proposedTargetKcal || chosenKcal) - (proposal.proposedDayOffKcal || chosenKcal);

  const confirmedTarget = status === 'rejected'
    ? null
    : {
        kcal: chosenKcal,
        dayOnKcal: Math.round(chosenKcal + spreadDiff),
        dayOffKcal: Math.max(proposal.safeFloorKcal || 1200, Math.round(chosenKcal - offDiff)),
        protein: proposal.macros?.protein ?? null,
        carbs: proposal.macros?.carbs ?? null,
        fats: proposal.macros?.fats ?? null
      };

  const docData = {
    ...proposal,
    model_version: WEEKLY_CHECKIN_VERSION,
    status,
    confirmedTarget,
    decidedAt: new Date().toISOString()
  };

  saveLocalWeeklyCheckin(proposal.weekId, docData);

  try {
    await setDoc(doc(db, 'users', uid, 'weekly_checkins', proposal.weekId), docData, { merge: true });
  } catch (err) {
    console.warn('[WeeklyCheckin] Salvataggio Firestore rimandato (offline):', err?.message);
  }

  return docData;
}
