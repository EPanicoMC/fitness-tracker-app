/**
 * coach-rules.js — Motore deterministico di regole incrociate (Dieta × Allenamento × Recupero)
 *
 * Fonti scientifiche di riferimento per le soglie:
 *   • Helms ER et al., JISSN 2014: perdita peso in definizione > 1.0% BW/settimana aumenta il
 *     rischio di perdita di massa magra → alzare l'apporto calorico.
 *   • Morton RW et al., BJSM 2018: apporto proteico < 1.6 g/kg/giorno sub-ottimale per preservare
 *     e costruire massa contrattile durante l'allenamento contro resistenza.
 *   • Banister et al. 1975 / Meeusen et al. 2013 (ECSS/ACSM Overtraining Position Stand):
 *     deficit energetico + calo di performance (e1RM in regressione su ≥ 2 esercizi) + fatica
 *     accumulata (TSB molto negativo) → indicato scarico (deload) o refeed/diet break.
 *   • Hall KD et al., Lancet 2011 / Trexler et al., JISSN 2014: stallo del peso di tendenza per
 *     ≥ 3 settimane con aderenza verificata ≥ 80% indica adattamento del TDEE → ricalcolare
 *     target calorico dal TDEE adattivo o incrementare il NEAT (passi).
 *   • Williams S et al., BJSM 2017: ACWR (EWMA 7/28) > 1.5 segnala uno spike rapido di carico
 *     rispetto alla base cronica → modulare il volume della settimana successiva.
 *
 * Principi architetturali:
 *   • Funzione pura deterministica `evaluateCrossRules({ energyOutput, trainingOutput, context })`.
 *   • Ogni insight restituito rispetta lo schema fisso:
 *     `{ id, area: 'diet'|'training'|'recovery', severity: 'high'|'medium'|'low'|'info', message, evidence, action }`.
 */

import { isFlagEnabled } from './feature-flags.js';

export const RULE_THRESHOLDS = {
  maxWeeklyLossPct: -1.0,        // perdita > 1.0% del peso a settimana
  minProteinGPerKg: 1.6,         // soglia minima Morton et al. 2018
  deloadTsbThreshold: -15,       // TSB molto negativo in presenza di regressione forza
  weightPlateauWeeks: 3,         // 21 giorni di stallo trendWeight
  weightPlateauDeltaKg: 0.25,    // variazione < 0.25 kg in 3 settimane
  acwrHighThreshold: 1.5,        // spike ACWR (EWMA 7/28)
  lowAdherencePct: 70,           // aderenza diario < 70%
  goodAdherencePct: 80,          // aderenza ok per confermare un vero plateau
  lowSleepHours: 6.0,            // media sonno 7gg sotto 6 ore
  dietBreakMinDaysInCut: 56      // >= 8 settimane di deficit per proporre diet break
};

/**
 * Valuta tutte le regole incrociate deterministiche sugli output del Modello 1 e del Modello 2.
 *
 * @param {Object} params
 * @param {Object} params.energyOutput output di `runEnergyBalanceModel`
 * @param {Object} params.trainingOutput output di `runTrainingModel`
 * @param {Object} [params.context] { avgSleep7d, avgSteps7d, stepsGoal, flags, enableDietBreakRule }
 * @returns {Array<{id:string, area:'diet'|'training'|'recovery', severity:'high'|'medium'|'low'|'info', message:string, evidence:Object, action:string}>}
 */
export function evaluateCrossRules({
  energyOutput = {},
  trainingOutput = {},
  context = {}
} = {}) {
  const insights = [];
  const history = Array.isArray(energyOutput.history) ? energyOutput.history : [];
  const trendWeight = Number(energyOutput.trendWeight) || 75;
  const rho = 7700;

  // ── REGOLA 1: Velocità di perdita > 1%/settimana per 2 settimane ─────────────
  let rapidLoss2Weeks = false;
  let rateWeek1Pct = energyOutput.weeklyRatePct ?? 0;
  let rateWeek2Pct = null;

  if (history.length >= 15) {
    const wNow = history[history.length - 1].trendWeight;
    const w7 = history[history.length - 8].trendWeight;
    const w14 = history[history.length - 15].trendWeight;
    if (w7 > 0 && w14 > 0) {
      rateWeek1Pct = Number((((wNow - w7) / w7) * 100).toFixed(2));
      rateWeek2Pct = Number((((w7 - w14) / w14) * 100).toFixed(2));
      if (rateWeek1Pct < RULE_THRESHOLDS.maxWeeklyLossPct && rateWeek2Pct < RULE_THRESHOLDS.maxWeeklyLossPct) {
        rapidLoss2Weeks = true;
      }
    }
  } else if ((energyOutput.weeklyRatePct ?? 0) < -1.2) {
    rapidLoss2Weeks = true;
  }

  if (rapidLoss2Weeks && energyOutput.goalType === 'cut') {
    const targetRateKg = -0.0075 * trendWeight; // riporta verso -0.75%/sett
    const excessKgWeek = Math.abs((energyOutput.weeklyRateKg || -1) - targetRateKg);
    const addKcal = Math.max(100, Math.min(450, Math.round(((excessKgWeek * rho) / 7) / 25) * 25));
    insights.push({
      id: 'rapid_weight_loss',
      area: 'diet',
      severity: 'high',
      message: `Perdita di peso troppo rapida (${rateWeek1Pct}% nell'ultima settimana${rateWeek2Pct != null ? `, ${rateWeek2Pct}% nella precedente` : ''}), oltre il limite consigliato dell'1%/settimana.`,
      evidence: {
        weeklyRatePct: rateWeek1Pct,
        prevWeeklyRatePct: rateWeek2Pct,
        weeklyRateKg: energyOutput.weeklyRateKg,
        recommendedKcal: energyOutput.recommendedKcal
      },
      action: `Alza l'apporto giornaliero di +${addKcal} kcal/giorno (preferibilmente da carboidrati peri-workout) per proteggere la massa magra e la performance.`
    });
  }

  // ── REGOLA 2: Proteine < 1.6 g/kg in media su 7 giorni ──────────────────────
  const last7 = history.slice(-7);
  const proDays = last7.filter(d => d.proteinG != null && d.proteinG > 0);
  const avgProtein7d = context.avgProtein7d != null
    ? Number(context.avgProtein7d)
    : (proDays.length > 0 ? proDays.reduce((s, d) => s + d.proteinG, 0) / proDays.length : null);

  if (avgProtein7d != null && trendWeight > 0) {
    const proPerKg = Number((avgProtein7d / trendWeight).toFixed(2));
    if (proPerKg < RULE_THRESHOLDS.minProteinGPerKg) {
      const targetProG = Math.round(1.8 * trendWeight);
      const deficitProG = Math.max(10, Math.round(targetProG - avgProtein7d));
      insights.push({
        id: 'low_protein_intake',
        area: 'diet',
        severity: proPerKg < 1.3 ? 'high' : 'medium',
        message: `Apporto proteico medio sugli ultimi 7 giorni pari a ${proPerKg} g/kg (${Math.round(avgProtein7d)} g/gg), sotto la soglia minima di ${RULE_THRESHOLDS.minProteinGPerKg} g/kg (Morton et al., 2018).`,
        evidence: {
          avgProtein7d: Math.round(avgProtein7d),
          proteinPerKg: proPerKg,
          targetProteinG: targetProG,
          trendWeight
        },
        action: `Aggiungi circa +${deficitProG} g/giorno di proteine magre per raggiungere almeno ${targetProG} g/giorno (1.8 g/kg).`
      });
    }
  }

  // ── REGOLA 3: Deficit attivo + e1RM in calo su ≥ 2 esercizi + TSB molto negativo ──
  const lifts = Array.isArray(trainingOutput.lifts) ? trainingOutput.lifts : [];
  const regressingLifts = lifts.filter(l => l.status === 'regress');
  const inDeficit = (energyOutput.energyBalance7d != null && energyOutput.energyBalance7d < -150) ||
                    (energyOutput.weeklyRateKg != null && energyOutput.weeklyRateKg < -0.2);
  const tsb = trainingOutput.tsb ?? 0;

  if (inDeficit && regressingLifts.length >= 2 && tsb <= RULE_THRESHOLDS.deloadTsbThreshold) {
    insights.push({
      id: 'deficit_fatigue_strength_drop',
      area: 'recovery',
      severity: 'high',
      message: `Fatica elevata in deficit calorico: TSB a ${tsb} con calo dell'e1RM su ${regressingLifts.length} esercizi (${regressingLifts.slice(0, 3).map(l => l.exerciseId).join(', ')}).`,
      evidence: {
        tsb,
        energyBalance7d: energyOutput.energyBalance7d,
        regressingExercises: regressingLifts.map(l => ({ id: l.exerciseId, slopePctWeek: l.trendSlopePctWeek })),
        tdeeEstimate: energyOutput.tdeeEstimate
      },
      action: `Programma 5-7 giorni di scarico (deload: -35% serie, RIR ≥ 3) oppure un diet break a mantenimento (${energyOutput.tdeeEstimate || 2100} kcal/gg) per dissipare la fatica accumulata.`
    });
  }

  // ── REGOLA 4: Plateau di peso ≥ 3 settimane con aderenza ok ──────────────────
  const adherencePct = energyOutput.adherence14Pct ?? 100;
  let isWeightPlateau = false;
  let delta21dKg = null;

  if (history.length >= 21) {
    const wNow = history[history.length - 1].trendWeight;
    const w21 = history[history.length - 21].trendWeight;
    delta21dKg = Number((wNow - w21).toFixed(2));
    if (energyOutput.goalType === 'cut' && delta21dKg > -RULE_THRESHOLDS.weightPlateauDeltaKg && adherencePct >= RULE_THRESHOLDS.goodAdherencePct) {
      isWeightPlateau = true;
    } else if (energyOutput.goalType === 'bulk' && delta21dKg < 0.15 && adherencePct >= RULE_THRESHOLDS.goodAdherencePct) {
      isWeightPlateau = true;
    }
  }

  if (isWeightPlateau) {
    insights.push({
      id: 'weight_plateau_adaptive_tdee',
      area: 'diet',
      severity: 'medium',
      message: `Stallo del peso di tendenza da 3 settimane (${delta21dKg >= 0 ? '+' : ''}${delta21dKg} kg in 21 giorni) con buona aderenza al diario (${adherencePct}%).`,
      evidence: {
        delta21dKg,
        adherence14Pct: adherencePct,
        tdeeEstimate: energyOutput.tdeeEstimate,
        recommendedKcal: energyOutput.recommendedKcal
      },
      action: `Aggiorna il target giornaliero a ${energyOutput.recommendedKcal} kcal/giorno (calcolato sul TDEE adattivo di ${energyOutput.tdeeEstimate} kcal) o aumenta la media passi di +1.500 passi/giorno.`
    });
  }

  // ── REGOLA 5: ACWR > 1.5 → riduci il volume della settimana successiva ───────
  const acwr = trainingOutput.acwr;
  if (acwr != null && acwr > RULE_THRESHOLDS.acwrHighThreshold) {
    insights.push({
      id: 'high_acwr_spike',
      area: 'training',
      severity: acwr > 1.75 ? 'high' : 'medium',
      message: `Rapporto carico acuto/cronico elevato (ACWR EWMA = ${acwr}, sopra la soglia di attenzione 1.5).`,
      evidence: {
        acwr,
        ctl: trainingOutput.ctl,
        atl: trainingOutput.atl,
        tsb: trainingOutput.tsb
      },
      action: `Riduci il volume della prossima settimana del 20-25% (1 serie in meno per esercizio o evita tecniche di intensificazione) per riportare l'ACWR nella fascia 0.8–1.3.`
    });
  }

  // ── REGOLA 6: Aderenza al diario < 70% → avvisa che le stime sono poco affidabili ──
  if (adherencePct < RULE_THRESHOLDS.lowAdherencePct && history.length >= 5) {
    insights.push({
      id: 'low_diary_adherence',
      area: 'diet',
      severity: 'medium',
      message: `Aderenza alla registrazione del diario al ${adherencePct}% negli ultimi 14 giorni (sotto la soglia del 70%).`,
      evidence: {
        adherence14Pct: adherencePct,
        confidence: energyOutput.confidence,
        tdeeCI: energyOutput.tdeeCI
      },
      action: `Registra tutti i pasti e segna il flag "Giornata registrata completamente" per almeno 10 giorni consecutivi così da restringere l'intervallo di confidenza del TDEE (${energyOutput.tdeeCI?.[0]}–${energyOutput.tdeeCI?.[1]} kcal).`
    });
  }

  // ── REGOLA 7: Plateau di forza su esercizi chiave (≥ 3 settimane) ────────────
  const plateauLifts = lifts.filter(l => l.status === 'plateau');
  if (plateauLifts.length > 0 && !insights.some(i => i.id === 'deficit_fatigue_strength_drop')) {
    insights.push({
      id: 'strength_plateau_detected',
      area: 'training',
      severity: 'low',
      message: `Stallo dell'e1RM rilevato su ${plateauLifts.length} esercizi${plateauLifts.length === 1 ? 'o' : ''}: ${plateauLifts.slice(0, 3).map(l => l.exerciseId).join(', ')}.`,
      evidence: {
        plateauExercises: plateauLifts.map(l => ({ id: l.exerciseId, e1rm: l.e1rm, slopePctWeek: l.trendSlopePctWeek }))
      },
      action: `Varia lo stimolo sull'esercizio in stallo (progressione a doppia leva su ripetizioni prima del carico, micro-carichi o rotazione della variante dopo lo scarico).`
    });
  }

  // ── REGOLA 8: Recupero / Sonno basso (se disponibile nel contesto) ───────────
  if (context.avgSleep7d != null && Number(context.avgSleep7d) > 0 && Number(context.avgSleep7d) < RULE_THRESHOLDS.lowSleepHours) {
    const sleepVal = Number(Number(context.avgSleep7d).toFixed(1));
    insights.push({
      id: 'insufficient_sleep_recovery',
      area: 'recovery',
      severity: sleepVal < 5.5 ? 'high' : 'medium',
      message: `Media del sonno negli ultimi 7 giorni bassa (${sleepVal} ore/notte): penalizza il recupero neuromuscolare e la partizione calorica in definizione.`,
      evidence: {
        avgSleep7d: sleepVal,
        readiness: trainingOutput.readiness
      },
      action: `Punta ad almeno 7 ore di sonno e sospendi serie a cedimento (RIR 0 / myo-reps) finché la media settimanale non risale sopra 6.0 ore.`
    });
  }

  // ── REGOLA 9 (4G): Diet Break / Refeed consigliato in deficit prolungato ─────
  const enableDietBreak = Boolean(context.enableDietBreakRule) || isFlagEnabled('coach.dietBreakRule', context.flags);
  if (enableDietBreak && energyOutput.goalType === 'cut') {
    const daysInCut = Number(context.daysInCut ?? history.length);
    const readiness = Number(trainingOutput.readiness ?? 75);
    const hasProlongedCut = daysInCut >= RULE_THRESHOLDS.dietBreakMinDaysInCut;
    const hasFatigueOrStall = isWeightPlateau || readiness < 45 || regressingLifts.length >= 2;

    if (hasProlongedCut && hasFatigueOrStall) {
      const maintKcal = energyOutput.tdeeEstimate || 2200;
      const maintCarbsG = Math.max(200, Math.round((maintKcal - (trendWeight * 1.8 * 4) - (trendWeight * 0.8 * 9)) / 4));
      insights.push({
        id: 'diet_break_suggested',
        area: 'diet',
        severity: readiness < 40 || regressingLifts.length >= 2 ? 'high' : 'medium',
        message: `Sei in definizione da oltre ${Math.floor(daysInCut / 7)} settimane con segni di adattamento o fatica (${isWeightPlateau ? 'stallo del peso' : `prontezza ${readiness}/100`}).`,
        evidence: {
          daysInCut,
          isWeightPlateau,
          readiness,
          regressingLiftsCount: regressingLifts.length,
          maintenanceKcal: maintKcal
        },
        action: `Valuta 7–14 giorni di Diet Break a mantenimento (${maintKcal} kcal/giorno, circa ${maintCarbsG}g di carboidrati) per ripristinare il glicogeno muscolare e la performance.`
      });
    }
  }

  // Ordina per severità decrescente
  const sevRank = { high: 4, medium: 3, low: 2, info: 1 };
  insights.sort((a, b) => (sevRank[b.severity] || 0) - (sevRank[a.severity] || 0));

  return insights;
}

/**
 * Costruisce un report Coach deterministico completo (stesso identico schema JSON di Gemini)
 * da usare come fallback immediato offline o in caso di errore/timeout di rete.
 */
export function buildDeterministicCoachFallback({
  energyOutput = {},
  trainingOutput = {},
  insights = []
} = {}) {
  const highCount = insights.filter(i => i.severity === 'high').length;
  const medCount = insights.filter(i => i.severity === 'medium').length;

  let status = 'on_track';
  if (highCount > 0 || trainingOutput.deloadSuggested) {
    status = 'off_track';
  } else if (medCount > 0) {
    status = 'attention';
  }

  const trendW = energyOutput.trendWeight != null ? `${energyOutput.trendWeight} kg` : 'N/D';
  const rateW = energyOutput.weeklyRateKg != null
    ? `${energyOutput.weeklyRateKg >= 0 ? '+' : ''}${energyOutput.weeklyRateKg} kg/sett`
    : 'N/D';
  const tdee = energyOutput.tdeeEstimate ? `${energyOutput.tdeeEstimate} kcal` : 'N/D';
  const recKcal = energyOutput.recommendedKcal ? `${energyOutput.recommendedKcal} kcal` : 'N/D';

  const headline = status === 'on_track'
    ? `Percorso in linea: trend ${trendW} (${rateW}), TDEE stimato ${tdee}`
    : status === 'attention'
    ? `Attenzione a ${insights.length} parametr${insights.length === 1 ? 'o' : 'i'}: TDEE ${tdee}, target ${recKcal}`
    : `Intervento consigliato: priorità a recupero e calibrazione calorica (${recKcal})`;

  const summary = insights.length > 0
    ? `Peso di tendenza a ${trendW} (${rateW}) con TDEE adattivo stimato a ${tdee} e readiness allenamento a ${trainingOutput.readiness ?? 75}/100. ${insights[0].message}`
    : `Ottima continuità: peso di tendenza a ${trendW} (${rateW}), TDEE adattivo stimato a ${tdee} e carico allenante bilanciato (ACWR ${trainingOutput.acwr ?? 'N/D'}). Mantieni il target di ${recKcal}/giorno.`;

  const corrections = insights.slice(0, 3).map(ins => ({
    area: ins.area || 'diet',
    action: ins.action,
    why: ins.message
  }));

  if (corrections.length === 0) {
    corrections.push({
      area: 'diet',
      action: `Continua con ${recKcal}/giorno e ${energyOutput.recommendedMacros?.protein || 150}g di proteine.`,
      why: `Il ritmo attuale (${rateW}) e il carico di lavoro sono nella fascia ottimale.`
    });
  }

  const focusNextWeek = trainingOutput.deloadSuggested
    ? `Esegui 5-7 giorni di scarico attivo (-35% serie, RIR 3) e mantieni l'apporto proteico.`
    : `Mantieni un'aderenza al diario ≥ 85% centrando ${recKcal}/giorno e progressione graduale sui fondamentali.`;

  return {
    status,
    headline,
    summary,
    corrections,
    focusNextWeek,
    motivationalNote: 'La costanza sui dati giornalieri batte qualsiasi aggiustamento impulsivo: un giorno alla volta.',
    source: 'deterministic_rules'
  };
}

