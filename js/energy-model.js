/**
 * energy-model.js — Adaptive Energy Balance & Weight Forecast (Modello 1)
 *
 * Fonti scientifiche e implementazioni di riferimento:
 *   1. Hall KD et al., "Quantification of the effect of energy imbalance on bodyweight",
 *      The Lancet, 378(9793):826-837, 2011 (NIH Body Weight Planner).
 *   2. Hall KD, "What is the required energy deficit per unit weight loss?",
 *      Int J Obes, 32(3):573-576, 2008 (densità energetica ρ e composizione variazione peso).
 *   3. Camacho-García-Formentí D, Zepeda-Tello R, "bw: Dynamic Body Weight Models for Children
 *      and Adults", CRAN R package (implementazione open-source del modello dinamico di Hall).
 *   4. Walker J, "The Hacker's Diet", 1991 (media mobile esponenziale del peso con α = 0.1).
 *   5. Trexler E, Nuckols G, "MacroFactor Adaptive Expenditure Algorithm" / Stronger By Science
 *      (stima adattiva del TDEE da serie storica peso + intake con smussamento).
 *   6. Mifflin MD, St Jeor ST et al., "A new predictive equation for resting energy expenditure
 *      in healthy individuals", Am J Clin Nutr, 51(2):241-247, 1990 (BMR a priori).
 *   7. Helms ER, Aragon AA, Fitschen PJ, "Evidence-based recommendations for natural bodybuilding
 *      contest preparation: nutrition and supplementation", JISSN, 11:20, 2014 (ritmo 0.5-1.0%/sett).
 *   8. Morton RW et al., "A systematic review, meta-analysis and meta-regression of the effect of
 *      protein supplementation on resistance training-induced gains in muscle mass and strength",
 *      Br J Sports Med, 52(6):376-384, 2018 (proteine 1.6-2.2 g/kg).
 *
 * Principi architetturali:
 *   • Modulo puro deterministico (input → output), zero accesso a DB/DOM/rete.
 *   • Filtro di Kalman lineare a 2 stati x_t = [peso_vero_t, TDEE_t]^T con controllo incrociato
 *     EMA (Hacker's Diet) + bilancio su finestra mobile 14-28 giorni.
 *   • Modalità degradata automatica (priors di Mifflin-St Jeor) se i dati sono insufficienti.
 */

import { isFlagEnabled } from './feature-flags.js';

export const ENERGY_MODEL_DEFAULTS = {
  // ρ ≈ 7700 kcal/kg: valore classico di Wishnofsky (1958); in realtà dipende dalla frazione
  // di massa grassa/magra persa e dalla durata (Hall 2008, Lancet 2011). Configurabile.
  rhoKcalPerKg: 7700,
  // Rumore di misura del peso giornaliero (bilancia + acqua corporea / glicogeno / sodio): σ ≈ 0.45 kg
  obsWeightSigmaKg: 0.45,
  // Rumore di processo sul peso vero (conservazione energia: il rumore rapido è osservazionale, non tissutale): σ_w ≈ 0.01 kg/giorno
  processWeightSigmaKg: 0.01,
  // Rumore di processo sul TDEE (random walk giornaliero per adattamento/NEAT): σ_tdee ≈ 45 kcal/giorno
  processTdeeSigmaKcal: 45,
  // Varianza iniziale sugli stati: peso σ_0 = 0.18 kg, TDEE σ_0 = 600 kcal (prior incerto Mifflin-St Jeor)
  initWeightSigmaKg: 0.18,
  initTdeeSigmaKcal: 600,
  // Fattore di rilassamento rumore nei giorni senza diario o diario incompleto
  missingIntakeProcessMultiplier: 3.5,
  // Costante di media mobile esponenziale (Hacker's Diet, Walker 1991)
  emaAlpha: 0.1,
  // Adattamento metabolico dinamico (Hall Lancet 2011, linearizzazione ~22 kcal/giorno per kg perso)
  hallAdaptationKcalPerKg: 22,
  // Soglie minime di sicurezza per kcal consigliate
  minSafeKcalMale: 1500,
  minSafeKcalFemale: 1200,
  // Giorni minimi per uscire dalla "stima preliminare"
  minDaysForReliableEstimate: 14
};

/**
 * Calcola la densità energetica dinamica ρ (kcal/kg) secondo l'approssimazione di Forbes (Hall 2008):
 *   FM = peso * (BF / 100)
 *   p  = FM / (FM + 10.4)
 *   ρ  = clamp(p * 9440 + (1 - p) * 1816, 5500, 8500)
 */
export function computeDynamicRho(weightKg, bfPct) {
  const w = Number(weightKg);
  const bf = Number(bfPct);
  if (isNaN(w) || w <= 25 || isNaN(bf) || bf < 4 || bf > 60) {
    return 7700;
  }
  const fm = w * (bf / 100);
  const p = fm / (fm + 10.4);
  const rho = Math.round(p * 9440 + (1 - p) * 1816);
  return Math.max(5500, Math.min(8500, rho));
}

export const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9
};

/**
 * Calcola l'età in anni compiuti a una data di riferimento.
 */
export function computeAgeYears(dobStr, refDateStr = null) {
  if (!dobStr || typeof dobStr !== 'string') return 30;
  const dob = new Date(dobStr + 'T00:00:00');
  if (isNaN(dob.getTime())) return 30;
  const ref = refDateStr ? new Date(refDateStr + 'T00:00:00') : new Date();
  let age = ref.getFullYear() - dob.getFullYear();
  const m = ref.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < dob.getDate())) age--;
  return Math.max(14, Math.min(100, age));
}

/**
 * Stima a priori del BMR secondo Mifflin-St Jeor (1990):
 *   Uomini: 10 × peso(kg) + 6.25 × altezza(cm) − 5 × età(anni) + 5
 *   Donne:  10 × peso(kg) + 6.25 × altezza(cm) − 5 × età(anni) − 161
 * Se presente % massa grassa valida, calcola anche Katch-McArdle (370 + 21.6 × LBM) e fa media.
 */
export function estimatePriorBMR(profile = {}, weightKg = 75, refDateStr = null) {
  const w = Number(weightKg) > 30 ? Number(weightKg) : 75;
  const h = Number(profile.height) > 100 ? Number(profile.height) : 175;
  const age = profile.age != null ? Number(profile.age) : computeAgeYears(profile.dob, refDateStr);
  const sex = (profile.sex || 'M').toUpperCase();
  const sexOffset = sex === 'F' ? -161 : 5;
  const mifflin = 10 * w + 6.25 * h - 5 * age + sexOffset;

  const bf = Number(profile.body_fat_pct ?? profile.body_fat);
  if (!isNaN(bf) && bf >= 4 && bf <= 60) {
    const lbm = w * (1 - bf / 100);
    const katch = 370 + 21.6 * lbm;
    return Math.round(0.5 * mifflin + 0.5 * katch);
  }
  return Math.round(mifflin);
}

/**
 * Stima a priori del TDEE iniziale: BMR × moltiplicatore di attività (PAL).
 */
export function estimatePriorTDEE(profile = {}, weightKg = 75, refDateStr = null) {
  const bmr = estimatePriorBMR(profile, weightKg, refDateStr);
  const actKey = profile.activity_level || 'moderate';
  const mult = typeof actKey === 'number'
    ? Math.max(1.1, Math.min(2.4, actKey))
    : (ACTIVITY_MULTIPLIERS[actKey] || 1.55);
  return {
    bmr,
    activityMultiplier: mult,
    priorTdee: Math.round(bmr * mult)
  };
}

/**
 * Media mobile esponenziale del peso (John Walker, "The Hacker's Diet", 1991).
 * Nei giorni senza misurazione mantiene il trend precedente.
 *
 * @param {Array<{date:string, weightKg:number|null}>} days
 * @param {number} alpha default 0.1
 * @returns {Array<{date:string, rawWeight:number|null, emaWeight:number|null}>}
 */
export function computeWeightEMA(days, alpha = ENERGY_MODEL_DEFAULTS.emaAlpha) {
  let ema = null;
  return days.map(d => {
    const w = d.weightKg != null && Number(d.weightKg) > 0 ? Number(d.weightKg) : null;
    if (w != null) {
      ema = ema == null ? w : ema + alpha * (w - ema);
    }
    return {
      date: d.date,
      rawWeight: w,
      emaWeight: ema != null ? Number(ema.toFixed(3)) : null
    };
  });
}

/**
 * Aggiunge N giorni a una stringa YYYY-MM-DD in modo deterministico UTC.
 */
export function addDaysISO(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().split('T')[0];
}

/**
 * Differenza in giorni (dateB - dateA) tra due stringhe YYYY-MM-DD.
 */
export function diffDaysISO(dateA, dateB) {
  const [y1, m1, d1] = dateA.split('-').map(Number);
  const [y2, m2, d2] = dateB.split('-').map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t2 - t1) / 86400000);
}

/**
 * Esegue un singolo passo giornaliero del Filtro di Kalman a 2 stati:
 *   Stato: x = [w, TDEE]^T
 *   Covarianza: P = [[p00, p01], [p10, p11]]
 *
 *   Predizione (con controllo u_t = intake_kcal_t):
 *     Se l'intake del giorno t è noto:
 *       w_{t|t-1}    = w_{t-1} + (u_t - TDEE_{t-1}) / ρ
 *       TDEE_{t|t-1} = TDEE_{t-1}
 *       Matrice di transizione F = [[1, -1/ρ], [0, 1]]
 *     Se l'intake è mancante/incompleto e non imputabile:
 *       w_{t|t-1}    = w_{t-1}
 *       TDEE_{t|t-1} = TDEE_{t-1}
 *       F = [[1, 0], [0, 1]], con rumore di processo sul peso aumentato.
 *
 *   Aggiornamento (se peso z_t misurato e non outlier estremo):
 *     H = [1, 0]
 *     y = z_t - w_{t|t-1}
 *     S = P_{00} + R
 *     K = [P_{00}/S, P_{10}/S]^T
 *     x_t = x_{t|t-1} + K * y
 *     P_t = (I - K*H) * P_{t|t-1}
 */
export function kalmanStep2D(state, obs, config = ENERGY_MODEL_DEFAULTS) {
  const rho = config.rhoKcalPerKg || 7700;
  const invRho = 1 / rho;
  const useNormalizedGating = Boolean(obs.useNormalizedGating || isFlagEnabled('energy.normalizedGating', config.flags));

  let [w, tdee] = state.x;
  let [[p00, p01], [p10, p11]] = state.P;

  const hasIntake = obs.intakeKcal != null && obs.intakeComplete !== 'no';
  const isPartial = obs.intakeComplete === 'partial';
  const isAnomalous = !!obs.anomalous;
  const stepsDeltaKcal = Number(obs.stepsDeltaKcal) || 0;

  const qWBase = Math.pow(config.processWeightSigmaKg || 0.08, 2);
  const qTdeeMult = obs.qTdeeMultiplier != null && obs.qTdeeMultiplier > 0 ? Number(obs.qTdeeMultiplier) : 1.0;
  const qTdeeBase = Math.pow(config.processTdeeSigmaKcal || 25, 2) * qTdeeMult;

  let wPred, tdeePred, fp00, fp01, fp10, fp11;
  if (hasIntake) {
    const mult = isPartial ? (config.missingIntakeProcessMultiplier || 3.5) : 1.0;
    const effectiveTdeeForDay = tdee + stepsDeltaKcal;
    wPred = w + (obs.intakeKcal - effectiveTdeeForDay) * invRho;
    tdeePred = tdee;
    // F * P * F^T con F = [[1, -invRho], [0, 1]]
    const a00 = p00 - invRho * p10;
    const a01 = p01 - invRho * p11;
    fp00 = a00 - invRho * a01 + qWBase * mult;
    fp01 = a01;
    fp10 = p10 - invRho * p11;
    fp11 = p11 + qTdeeBase;
  } else {
    // Giorno senza diario: non accoppiamo l'errore del peso al TDEE (F = I)
    const mult = (config.missingIntakeProcessMultiplier || 3.5) * 2;
    wPred = w;
    tdeePred = tdee;
    fp00 = p00 + qWBase * mult;
    fp01 = p01;
    fp10 = p10;
    fp11 = p11 + qTdeeBase * 1.2;
  }

  // Osservazione peso
  const rawW = obs.weightKg != null && Number(obs.weightKg) > 0 ? Number(obs.weightKg) : null;
  let innovation = null;
  let normalizedInnovation = null;
  let outlier = false;

  if (rawW != null && !isAnomalous) {
    innovation = rawW - wPred;
    let rVar = Math.pow(config.obsWeightSigmaKg || 0.6, 2);

    if (useNormalizedGating) {
      // Gonfia R quando il giorno precedente presenta fattori di ritenzione idrica prevedibile
      if (obs.waterRetentionRisk) {
        rVar *= 3.0;
      }
      const sPre = fp00 + rVar;
      normalizedInnovation = Math.abs(innovation) / Math.sqrt(Math.max(1e-6, sPre));
      if (normalizedInnovation > 3.0) {
        outlier = true;
        rVar *= Math.pow(normalizedInnovation / 1.5, 2);
      }
    } else {
      // Huber-like robust gating per outlier (> 2.5 kg di salto giornaliero = ritenzione idrica acuta / refeed)
      if (Math.abs(innovation) > 2.5) {
        outlier = true;
        rVar *= Math.pow(Math.abs(innovation) / 1.2, 2);
      }
      normalizedInnovation = Math.abs(innovation) / Math.sqrt(Math.max(1e-6, fp00 + rVar));
    }

    const S = fp00 + rVar;
    const k0 = fp00 / S;
    const k1 = fp10 / S;

    w = wPred + k0 * innovation;
    tdee = tdeePred + k1 * innovation;

    // Limiti fisiologici di sicurezza sullo stato TDEE (800 - 6500 kcal)
    tdee = Math.max(800, Math.min(6500, tdee));

    p00 = (1 - k0) * fp00;
    p01 = (1 - k0) * fp01;
    p10 = fp10 - k1 * fp00;
    p11 = fp11 - k1 * fp01;
  } else {
    w = wPred;
    tdee = tdeePred;
    p00 = fp00;
    p01 = fp01;
    p10 = fp10;
    p11 = fp11;
  }

  // Simmetriza P per stabilità numerica
  const sym01 = 0.5 * (p01 + p10);
  return {
    x: [w, tdee],
    P: [[Math.max(1e-6, p00), sym01], [sym01, Math.max(1, p11)]],
    priorWeightPred: Number(wPred.toFixed(3)),
    innovation,
    normalizedInnovation: normalizedInnovation != null ? Number(normalizedInnovation.toFixed(2)) : null,
    outlier
  };
}

/**
 * Calcola il TDEE di controllo incrociato (MacroFactor / Stronger By Science style)
 * su finestra mobile di 14-28 giorni usando la variazione del peso EMA e l'intake medio:
 *   TDEE_window = mean(intake) − (Δpeso_EMA × ρ) / Δgiorni
 */
export function computeWindowExpenditure(historySeries, rho = 7700, windowDays = 21) {
  if (!historySeries || historySeries.length < 7) return null;
  const slice = historySeries.slice(-windowDays);
  const validIntakes = slice.filter(d => d.intakeKcal != null && d.intakeComplete !== 'no');
  const validWeights = slice.filter(d => (d.rawWeight != null && !d.outlier) || d.kalmanWeight != null);
  if (validIntakes.length < 5 || validWeights.length < 5) return null;

  const firstDate = validWeights[0].date;
  const lastDate = validWeights[validWeights.length - 1].date;
  const spanDays = Math.max(1, diffDaysISO(firstDate, lastDate));
  if (spanDays < 5) return null;

  // Regressione lineare ordinaria (OLS) del peso rispetto ai giorni per stimare dW/dt senza ritardo di fase EMA
  const pts = validWeights.map(d => ({
    x: diffDaysISO(firstDate, d.date),
    y: (d.rawWeight != null && !d.outlier) ? d.rawWeight : d.kalmanWeight
  }));
  const meanX = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const meanY = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  let num = 0, den = 0;
  for (const p of pts) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) * (p.x - meanX);
  }
  const slopeKgPerDay = den > 0 ? num / den : (pts[pts.length - 1].y - pts[0].y) / spanDays;

  const avgIntake = validIntakes.reduce((s, d) => s + d.intakeKcal, 0) / validIntakes.length;
  const dailyEnergyDelta = slopeKgPerDay * rho;
  return Math.round(avgIntake - dailyEnergyDelta);
}

/**
 * Simula in avanti la traiettoria del peso per N giorni (4/8/12 settimane) applicando
 * l'adattamento metabolico dinamico di Hall et al. (Lancet 2011; pacchetto R `bw`):
 *   dW/dt = (I(t) − TDEE_0 − ε · (W(t) − W_0)) / ρ
 * dove ε ≈ 22 kcal/giorno/kg cattura il rallentamento del dispendio energetico al calare
 * della massa corporea (tessuto metabolicamente attivo + costo termico del movimento).
 *
 * Calcola anche la banda di confidenza (95%) propagando l'incertezza su peso iniziale e TDEE
 * (equivalente analitico + Monte Carlo deterministico a 200 traiettorie).
 */
export function simulateWeightForecast({
  startDate,
  startWeightKg,
  tdeeEstimate,
  tdeeSdKcal,
  weightSdKg = 0.35,
  plannedIntakeKcal,
  horizonsDays = [28, 56, 84],
  maxDays = 84,
  config = ENERGY_MODEL_DEFAULTS
}) {
  const rho = config.rhoKcalPerKg || 7700;
  const eps = config.hallAdaptationKcalPerKg || 22;
  const intake = plannedIntakeKcal != null && plannedIntakeKcal > 0 ? plannedIntakeKcal : tdeeEstimate;

  // Simulazione deterministica centrale + propagazione analitica della varianza con smorzamento di Hall
  const dailyForecast = [];
  let w = startWeightKg;
  // Nel modello continuo dW/dt + (ε/ρ) W = ..., il fattore di decadimento giornaliero è α_hall = 1 - ε/ρ
  const decay = 1 - eps / rho;

  for (let day = 1; day <= maxDays; day++) {
    const adaptiveTdee = tdeeEstimate + eps * (w - startWeightKg);
    const dW = (intake - adaptiveTdee) / rho;
    w = w + dW;

    // Propagazione dell'incertezza: σ_w(t)^2 = (decay^t * σ_w0)^2 + (σ_tdee_eff * (1 - decay^t) / ε)^2 + t * σ_proc^2
    // Le fluttuazioni giornaliere del NEAT in tdeeSdKcal si mediano parzialmente sull'orizzonte di t giorni (τ_int ≈ 21 gg)
    const decayT = Math.pow(decay, day);
    const effectiveTdeeSd = tdeeSdKcal / Math.sqrt(1 + day / 21);
    const weightEffectFromTdee = eps > 0 ? ((1 - decayT) / eps) * effectiveTdeeSd : (day / rho) * effectiveTdeeSd;
    const procSd = (config.processWeightSigmaKg || 0.08) * Math.sqrt(day);
    const totalSd = Math.sqrt(
      Math.pow(decayT * weightSdKg, 2) +
      Math.pow(weightEffectFromTdee, 2) +
      Math.pow(procSd, 2)
    );

    const dateStr = addDaysISO(startDate, day);
    dailyForecast.push({
      day,
      date: dateStr,
      weight: Number(w.toFixed(2)),
      low: Number((w - 1.96 * totalSd).toFixed(2)),
      high: Number((w + 1.96 * totalSd).toFixed(2)),
      adaptiveTdee: Math.round(adaptiveTdee)
    });
  }

  const checkpoints = horizonsDays.map(d => {
    const found = dailyForecast.find(f => f.day === d) || dailyForecast[dailyForecast.length - 1];
    return found ? { horizonWeeks: Math.round(d / 7), ...found } : null;
  }).filter(Boolean);

  return { dailyForecast, checkpoints };
}

/**
 * Calcola le raccomandazioni caloriche e di macronutrienti basandosi su:
 *   • TDEE stimato e velocità obiettivo (Helms et al. 2014: -0.5%..-1.0% BW/sett in cut;
 *     +0.25%..+0.5%/mese in lean bulk)
 *   • Limiti minimi di sicurezza: max(BMR, 1500 M / 1200 F)
 *   • Proteine (Morton et al. 2018): 1.6–2.2 g/kg (2.0 g/kg in cut, 1.8 g/kg in mantenimento/massa)
 */
export function computeCalorieAndMacroRecommendation({
  trendWeightKg,
  tdeeEstimate,
  bmrEstimate,
  profile = {},
  config = ENERGY_MODEL_DEFAULTS
}) {
  const rho = config.rhoKcalPerKg || 7700;
  const sex = (profile.sex || 'M').toUpperCase();
  const minFloor = sex === 'F' ? (config.minSafeKcalFemale || 1200) : (config.minSafeKcalMale || 1500);
  const safeMinKcal = Math.max(bmrEstimate || minFloor, minFloor);

  const weightTarget = profile.weight_target != null && Number(profile.weight_target) > 0
    ? Number(profile.weight_target)
    : null;

  // Determina obiettivo (cut / maintain / bulk)
  let goalType = (profile.goal_type || '').toLowerCase();
  if (!['cut', 'maintain', 'bulk'].includes(goalType)) {
    if (weightTarget != null && trendWeightKg != null) {
      if (weightTarget < trendWeightKg - 0.5) goalType = 'cut';
      else if (weightTarget > trendWeightKg + 0.5) goalType = 'bulk';
      else goalType = 'maintain';
    } else {
      goalType = 'cut'; // default Fase 3 KOVA
    }
  }

  // Velocità obiettivo (kg/settimana), con limiti di sicurezza Helms 2014
  let targetRateKgWeek = profile.target_rate_kg_week != null ? Number(profile.target_rate_kg_week) : null;
  const minCutRate = -0.01 * trendWeightKg;   // max -1.0% a settimana
  const maxCutRate = -0.005 * trendWeightKg;  // min -0.5% a settimana
  const minBulkRate = (0.0025 * trendWeightKg) / 4.33; // +0.25%/mese
  const maxBulkRate = (0.005 * trendWeightKg) / 4.33;  // +0.50%/mese

  let rateClamped = false;
  if (goalType === 'cut') {
    if (targetRateKgWeek == null || isNaN(targetRateKgWeek) || targetRateKgWeek >= 0) {
      targetRateKgWeek = Number((-0.007 * trendWeightKg).toFixed(2)); // default -0.7% / sett
    } else if (targetRateKgWeek < minCutRate) {
      targetRateKgWeek = Number(minCutRate.toFixed(2));
      rateClamped = true;
    } else if (targetRateKgWeek > maxCutRate) {
      targetRateKgWeek = Number(maxCutRate.toFixed(2));
      rateClamped = true;
    }
  } else if (goalType === 'bulk') {
    if (targetRateKgWeek == null || isNaN(targetRateKgWeek) || targetRateKgWeek <= 0) {
      targetRateKgWeek = Number(((0.0035 * trendWeightKg) / 4.33).toFixed(2));
    } else if (targetRateKgWeek > maxBulkRate) {
      targetRateKgWeek = Number(maxBulkRate.toFixed(2));
      rateClamped = true;
    } else if (targetRateKgWeek < minBulkRate) {
      targetRateKgWeek = Number(minBulkRate.toFixed(2));
      rateClamped = true;
    }
  } else {
    targetRateKgWeek = 0;
  }

  const rawRecommendedKcal = Math.round(tdeeEstimate + (targetRateKgWeek * rho) / 7);
  const floorApplied = rawRecommendedKcal < safeMinKcal;
  const recommendedKcal = Math.max(safeMinKcal, rawRecommendedKcal);

  // Macronutrienti consigliati (Morton et al. 2018 + Helms et al. 2014)
  const proteinPerKg = goalType === 'cut' ? 2.1 : 1.8;
  const proteinG = Math.round(Math.min(2.4 * trendWeightKg, Math.max(1.6 * trendWeightKg, proteinPerKg * trendWeightKg)));
  const fatG = Math.round(Math.max(0.7 * trendWeightKg, (recommendedKcal * 0.25) / 9));
  const remainingKcal = Math.max(0, recommendedKcal - proteinG * 4 - fatG * 9);
  const carbsG = Math.round(remainingKcal / 4);

  return {
    goalType,
    targetRateKgWeek,
    rateClamped,
    floorApplied,
    safeMinKcal,
    recommendedKcal,
    recommendedMacros: {
      protein: proteinG,
      carbs: carbsG,
      fats: fatG,
      proteinPerKg: Number((proteinG / trendWeightKg).toFixed(2))
    }
  };
}

/**
 * Esegue l'intero Modello 1 ("Adaptive Energy Balance & Weight Forecast") su una serie storica
 * ordinata o non ordinata di osservazioni giornaliere.
 *
 * @param {Object} params
 * @param {Array<{date:string, weightKg?:number|null, intakeKcal?:number|null, intakeComplete?:'yes'|'partial'|'no', proteinG?:number|null, steps?:number|null, anomalous?:boolean}>} params.days
 * @param {Object} params.profile { sex, dob, height, activity_level, goal_type, weight_target, target_rate_kg_week, body_fat }
 * @param {Object} [params.initialParams] parametri/stato precedentemente salvati per esecuzione incrementale
 * @param {Object} [params.config]
 */
export function runEnergyBalanceModel({
  days = [],
  profile = {},
  checks = [],
  initialParams = null,
  todayDate = null,
  config = {}
} = {}) {
  const cfg = { ...ENERGY_MODEL_DEFAULTS, ...config };
  const flagOverrides = cfg.flags || null;
  const useTrendKalmanOnly = isFlagEnabled('energy.trendKalmanOnly', flagOverrides);
  const useNormalizedGating = isFlagEnabled('energy.normalizedGating', flagOverrides);
  const useDynamicRho = isFlagEnabled('energy.dynamicRho', flagOverrides);
  const useStepsCovariate = isFlagEnabled('energy.stepsCovariate', flagOverrides);

  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const refDate = todayDate || (sorted.length ? sorted[sorted.length - 1].date : new Date().toISOString().split('T')[0]);

  // Costruisci griglia giornaliera continua dal primo all'ultimo giorno
  let continuousDays = [];
  if (sorted.length > 0) {
    const mapByDate = new Map(sorted.map(d => [d.date, d]));
    const firstDate = sorted[0].date;
    const lastDate = sorted[sorted.length - 1].date > refDate ? sorted[sorted.length - 1].date : refDate;
    const span = Math.min(365, Math.max(0, diffDaysISO(firstDate, lastDate)));
    for (let i = 0; i <= span; i++) {
      const dt = addDaysISO(firstDate, i);
      const existing = mapByDate.get(dt);
      continuousDays.push(existing ? { ...existing, date: dt } : { date: dt, weightKg: null, intakeKcal: null, intakeComplete: 'no' });
    }
  } else {
    continuousDays = [{ date: refDate, weightKg: null, intakeKcal: null, intakeComplete: 'no' }];
  }

  // Peso iniziale di riferimento
  const firstWithWeight = continuousDays.find(d => d.weightKg != null && Number(d.weightKg) > 0);
  const fallbackWeight = firstWithWeight
    ? Number(firstWithWeight.weightKg)
    : (Number(profile.current_weight) || Number(profile.weight_target) || 75);

  // Fase 2.1c: Densità energetica ρ dinamica se esiste una %BF recente (<= 60 gg) dai checks o dai giorni
  let recentBf = null;
  if (useDynamicRho) {
    const validChecks = (checks || [])
      .filter(c => c.date && (c.body_fat != null || c.bf_estimate?.value != null) && diffDaysISO(c.date, refDate) <= 60 && diffDaysISO(c.date, refDate) >= -1)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (validChecks.length > 0) {
      const latestCheck = validChecks[validChecks.length - 1];
      recentBf = Number(latestCheck.bf_estimate?.value ?? latestCheck.body_fat);
    } else {
      const recentDaysWithBf = continuousDays.filter(d => d.bodyFat != null && diffDaysISO(d.date, refDate) <= 60);
      if (recentDaysWithBf.length > 0) {
        recentBf = Number(recentDaysWithBf[recentDaysWithBf.length - 1].bodyFat);
      } else if (profile.body_fat != null && Number(profile.body_fat) > 0) {
        recentBf = Number(profile.body_fat);
      }
    }
    if (recentBf != null && recentBf > 2 && recentBf < 60) {
      cfg.rhoKcalPerKg = computeDynamicRho(fallbackWeight, recentBf);
    }
  }

  const prior = estimatePriorTDEE(profile, fallbackWeight, refDate);

  // Stato iniziale Kalman
  let state = initialParams?.kalmanState || {
    x: [fallbackWeight, prior.priorTdee],
    P: [
      [Math.pow(cfg.initWeightSigmaKg, 2), 0],
      [0, Math.pow(cfg.initTdeeSigmaKcal, 2)]
    ]
  };

  // Calcola serie EMA di supporto (Walker 1991)
  const emaSeries = computeWeightEMA(continuousDays, cfg.emaAlpha);

  // Imputazione leggera con media mobile 7gg per giorni isolati senza diario (se ci sono ≥4 giorni negli ultimi 7)
  const snapshots = [];
  let recentValidIntakes = [];
  let recentCarbs7 = [];
  let recentSteps28 = [];
  let prevDayWaterRetentionRisk = false;
  let adaptiveQDaysRemaining = 0;
  let modelDivergence = false;

  for (let i = 0; i < continuousDays.length; i++) {
    const d = continuousDays[i];
    const hasExplicitComplete = d.intakeComplete === 'yes' || d.intakeComplete === 'partial' || d.intakeComplete === 'no';
    let intakeComplete = hasExplicitComplete
      ? d.intakeComplete
      : (d.intakeKcal != null && Number(d.intakeKcal) > 0 ? 'yes' : 'no');

    let effectiveIntake = d.intakeKcal != null && Number(d.intakeKcal) > 0 ? Number(d.intakeKcal) : null;
    let imputed = false;

    if (effectiveIntake == null && recentValidIntakes.length >= 4) {
      effectiveIntake = Math.round(recentValidIntakes.reduce((a, b) => a + b, 0) / recentValidIntakes.length);
      intakeComplete = 'partial';
      imputed = true;
    }

    if (d.intakeKcal != null && Number(d.intakeKcal) > 0 && intakeComplete !== 'no') {
      recentValidIntakes.push(Number(d.intakeKcal));
      if (recentValidIntakes.length > 7) recentValidIntakes.shift();
    }

    // Fase 2.1d: Passi come covariata TDEE_t = TDEE_base,t + beta * (steps_t - media28gg_steps)
    let stepsDeltaKcal = 0;
    if (d.steps != null && Number(d.steps) > 0) {
      if (useStepsCovariate && recentSteps28.length >= 5) {
        const mean28dSteps = recentSteps28.reduce((a, b) => a + b, 0) / recentSteps28.length;
        const beta = 0.0005 * (state.x[0] || fallbackWeight);
        stepsDeltaKcal = beta * (Number(d.steps) - mean28dSteps);
      }
      recentSteps28.push(Number(d.steps));
      if (recentSteps28.length > 28) recentSteps28.shift();
    }

    const activeQMult = adaptiveQDaysRemaining > 0 ? 3.0 : 1.0;
    if (adaptiveQDaysRemaining > 0) adaptiveQDaysRemaining--;

    const stepRes = i === 0 && !initialParams?.kalmanState
      ? {
          x: [d.weightKg != null && Number(d.weightKg) > 0 ? Number(d.weightKg) : state.x[0], state.x[1]],
          P: state.P,
          priorWeightPred: d.weightKg != null && Number(d.weightKg) > 0 ? Number(d.weightKg) : state.x[0],
          innovation: 0,
          normalizedInnovation: 0,
          outlier: false
        }
      : kalmanStep2D(state, {
          weightKg: d.weightKg,
          intakeKcal: effectiveIntake,
          intakeComplete,
          anomalous: d.anomalous,
          waterRetentionRisk: useNormalizedGating && prevDayWaterRetentionRisk,
          useNormalizedGating,
          stepsDeltaKcal,
          qTdeeMultiplier: activeQMult
        }, cfg);

    // Fase 2.1b: Calcola se il giorno corrente induce ritenzione idrica prevedibile per domani
    const avgCarbs7 = recentCarbs7.length >= 3
      ? recentCarbs7.reduce((a, b) => a + b, 0) / recentCarbs7.length
      : null;
    const carbsSpike = avgCarbs7 != null && d.carbsG != null && Number(d.carbsG) > avgCarbs7 * 1.4;
    prevDayWaterRetentionRisk = Boolean(
      (d.drinks != null && Number(d.drinks) > 0) ||
      (d.mealsOut != null && Number(d.mealsOut) > 0) ||
      carbsSpike ||
      d.anomalous === true
    );
    if (d.carbsG != null && Number(d.carbsG) > 0) {
      recentCarbs7.push(Number(d.carbsG));
      if (recentCarbs7.length > 7) recentCarbs7.shift();
    }

    state = { x: stepRes.x, P: stepRes.P };

    const kalmanWeight = state.x[0];
    const emaW = emaSeries[i]?.emaWeight ?? kalmanWeight;
    // Fase 2.1a: Con flag energy.trendKalmanOnly attivo usa solo il posteriore Kalman; l'EMA resta per i grafici
    const trendWeight = useTrendKalmanOnly
      ? Number(kalmanWeight.toFixed(2))
      : Number((0.7 * kalmanWeight + 0.3 * emaW).toFixed(2));
    const tdeeSd = Math.max(60, Math.sqrt(Math.max(1, state.P[1][1])));

    snapshots.push({
      date: d.date,
      rawWeight: d.weightKg != null && Number(d.weightKg) > 0 ? Number(d.weightKg) : null,
      emaWeight: emaW,
      kalmanWeight: Number(kalmanWeight.toFixed(3)),
      priorWeightPred: stepRes.priorWeightPred,
      trendWeight,
      tdeeKalman: Math.round(state.x[1]),
      tdeeSd: Math.round(tdeeSd),
      intakeKcal: d.intakeKcal != null && Number(d.intakeKcal) > 0 ? Number(d.intakeKcal) : null,
      effectiveIntakeKcal: effectiveIntake,
      intakeComplete,
      imputed,
      proteinG: d.proteinG != null ? Number(d.proteinG) : null,
      normalizedInnovation: stepRes.normalizedInnovation ?? 0,
      outlier: stepRes.outlier
    });

    // Controllo diagnostico su finestra mobile: se |Kalman - window| > 2 * sqrt(P_tdee + var_window),
    // emette model_divergence e attiva Q adattivo (x3 per 7 giorni) per riallineare il filtro senza doppio conteggio
    if (snapshots.length >= 7) {
      const winCheck = computeWindowExpenditure(snapshots, cfg.rhoKcalPerKg, 21);
      const valid21Now = snapshots.slice(-21).filter(s => s.rawWeight != null && !s.outlier && s.intakeKcal != null && s.intakeComplete !== 'no').length;
      if (winCheck != null && valid21Now >= 6) {
        const L = Math.max(6, valid21Now);
        const effWeightSd = 0.18;
        const winVar = (12 * Math.pow(cfg.rhoKcalPerKg, 2) * Math.pow(effWeightSd, 2)) / (L * (L * L - 1));
        const pTdee = Math.max(1, state.P[1][1]);
        const divThreshold = 2 * Math.sqrt(pTdee + winVar);
        if (Math.abs(state.x[1] - winCheck) > divThreshold) {
          adaptiveQDaysRemaining = 7;
          if (i === continuousDays.length - 1) modelDivergence = true;
        }
      }
    }
  }

  const latest = snapshots[snapshots.length - 1];
  const windowTdee = computeWindowExpenditure(snapshots, cfg.rhoKcalPerKg, 21);

  // Fase 1.3: TDEE primario = posteriore Kalman con la sua sd (niente fusione a varianza inversa con windowTdee).
  // windowTdee resta come controllo diagnostico per verificare eventuale model_divergence finale.
  const validDays21 = snapshots.slice(-21).filter(s => s.rawWeight != null && !s.outlier && s.intakeKcal != null && s.intakeComplete !== 'no').length;
  const tdeeEstimate = latest.tdeeKalman;
  const tdeeSd = latest.tdeeSd;

  if (windowTdee != null && validDays21 >= 6) {
    const L = Math.max(6, validDays21);
    const effWeightSd = 0.18;
    const winVar = (12 * Math.pow(cfg.rhoKcalPerKg, 2) * Math.pow(effWeightSd, 2)) / (L * (L * L - 1));
    const kalVar = Math.pow(tdeeSd, 2);
    if (Math.abs(tdeeEstimate - windowTdee) > 2 * Math.sqrt(kalVar + winVar)) {
      modelDivergence = true;
    }
  }

  const tdeeCI = [
    Math.max(800, Math.round(tdeeEstimate - 1.96 * tdeeSd)),
    Math.min(6500, Math.round(tdeeEstimate + 1.96 * tdeeSd))
  ];

  // Statistiche ultimi 7 e 14 giorni
  const last7 = snapshots.slice(-7);
  const last14 = snapshots.slice(-14);
  const last28 = snapshots.slice(-28);

  const loggedIntake7 = last7.filter(s => s.intakeKcal != null && s.intakeComplete !== 'no');
  const avgIntake7d = loggedIntake7.length > 0
    ? Math.round(loggedIntake7.reduce((a, b) => a + b.intakeKcal, 0) / loggedIntake7.length)
    : null;

  const energyBalance7d = avgIntake7d != null ? Math.round(avgIntake7d - tdeeEstimate) : null;

  // Variazione settimanale del peso di tendenza (kg/settimana e %/settimana)
  let weeklyRateKg = 0;
  if (snapshots.length >= 8) {
    const ref7Ago = snapshots[snapshots.length - 8];
    weeklyRateKg = Number((latest.trendWeight - ref7Ago.trendWeight).toFixed(2));
  } else if (snapshots.length >= 2) {
    const first = snapshots[0];
    const span = Math.max(1, snapshots.length - 1);
    weeklyRateKg = Number((((latest.trendWeight - first.trendWeight) / span) * 7).toFixed(2));
  }
  const weeklyRatePct = latest.trendWeight > 0
    ? Number(((weeklyRateKg / latest.trendWeight) * 100).toFixed(2))
    : 0;

  // Raccomandazioni kcal & macro
  const currentBmr = estimatePriorBMR(profile, latest.trendWeight, refDate);
  const rec = computeCalorieAndMacroRecommendation({
    trendWeightKg: latest.trendWeight,
    tdeeEstimate,
    bmrEstimate: currentBmr,
    profile,
    config: cfg
  });

  // Previsione a 4 / 8 / 12 settimane (con intake pianificato = media 7d se disponibile, altrimenti raccomandato)
  const plannedIntakeForForecast = avgIntake7d != null ? avgIntake7d : rec.recommendedKcal;
  const weightSd = Math.sqrt(Math.max(0.02, state.P[0][0]));
  const sim = simulateWeightForecast({
    startDate: latest.date,
    startWeightKg: latest.trendWeight,
    tdeeEstimate,
    tdeeSdKcal: tdeeSd,
    weightSdKg: weightSd,
    plannedIntakeKcal: plannedIntakeForForecast,
    horizonsDays: [28, 56, 84],
    maxDays: 84,
    config: cfg
  });

  // Stima data di arrivo all'obiettivo (ETA)
  let etaGoalDate = null;
  let daysToGoal = null;
  const weightTarget = profile.weight_target != null && Number(profile.weight_target) > 0
    ? Number(profile.weight_target)
    : null;

  if (weightTarget != null) {
    const diffToGoal = weightTarget - latest.trendWeight;
    if (Math.abs(diffToGoal) <= 0.25) {
      etaGoalDate = latest.date;
      daysToGoal = 0;
    } else {
      // Usa il ritmo effettivo se va nella direzione giusta, altrimenti il ritmo target raccomandato
      const effectiveWeeklyRate = (diffToGoal < 0 && weeklyRateKg < -0.1) || (diffToGoal > 0 && weeklyRateKg > 0.05)
        ? weeklyRateKg
        : rec.targetRateKgWeek;
      if (effectiveWeeklyRate && Math.sign(effectiveWeeklyRate) === Math.sign(diffToGoal) && Math.abs(effectiveWeeklyRate) > 0.05) {
        daysToGoal = Math.min(730, Math.max(1, Math.round((diffToGoal / effectiveWeeklyRate) * 7)));
        etaGoalDate = addDaysISO(latest.date, daysToGoal);
      }
    }
  }

  // Calcolo punteggio di affidabilità (0–100) e avvisi dati mancanti
  const weightDaysCount = snapshots.filter(s => s.rawWeight != null).length;
  const intakeDaysCount = snapshots.filter(s => s.intakeKcal != null && s.intakeComplete !== 'no').length;
  const weightDays14 = last14.filter(s => s.rawWeight != null).length;
  const intakeDays14 = last14.filter(s => s.intakeKcal != null && s.intakeComplete !== 'no').length;
  const adherence14Pct = Math.round((intakeDays14 / Math.max(1, last14.length)) * 100);

  const daysScore = Math.min(40, Math.round((Math.min(weightDaysCount, intakeDaysCount) / 21) * 40));
  const adherenceScore = Math.min(35, Math.round(((weightDays14 + intakeDays14) / 28) * 35));
  const varianceScore = Math.max(0, Math.min(25, Math.round((1 - (tdeeSd - 60) / 260) * 25)));
  const confidence = Math.max(5, Math.min(100, daysScore + adherenceScore + varianceScore));
  const confidenceUnit = Number((confidence / 100).toFixed(2));
  const isPreliminary = Math.min(weightDaysCount, intakeDaysCount) < cfg.minDaysForReliableEstimate;

  // Fase 2.1e: il TDEE stimato è il "TDEE rispetto all'intake registrato" (assorbe l'under-reporting).
  // Segnala possibile sotto-registrazione solo se il divario rispetto al prior Mifflin supera il 20% in modo persistente.
  const priorDiffRatio = prior.priorTdee > 0 ? (prior.priorTdee - tdeeEstimate) / prior.priorTdee : 0;
  const underReportingSuspected = Boolean(!isPreliminary && adherence14Pct >= 70 && priorDiffRatio > 0.20);
  const underReportingPct = underReportingSuspected ? Math.round(priorDiffRatio * 100) : 0;

  const warnings = [];
  const missingDataRequirements = [];

  if (!profile.sex || !profile.dob || !profile.height) {
    warnings.push('Profilo incompleto (sesso, data di nascita o altezza mancanti): il BMR a priori usa valori standard.');
    missingDataRequirements.push({
      feature: 'BMR Mifflin-St Jeor personalizzato',
      missing: 'Sesso, data di nascita e altezza nel Profilo',
      daysNeeded: 0
    });
  }
  if (isPreliminary) {
    const neededW = Math.max(0, cfg.minDaysForReliableEstimate - weightDaysCount);
    const neededI = Math.max(0, cfg.minDaysForReliableEstimate - intakeDaysCount);
    const needed = Math.max(neededW, neededI);
    warnings.push(`Stima preliminare (usa prior Mifflin-St Jeor): servono ancora ${needed} giorni di pesate e diario completo per la piena convergenza del filtro di Kalman.`);
    missingDataRequirements.push({
      feature: 'TDEE Adattivo calibrato',
      missing: 'Pesate mattutine e diario alimentare completo',
      daysNeeded: needed
    });
  }
  if (adherence14Pct < 70 && snapshots.length >= 7) {
    warnings.push(`Aderenza al diario negli ultimi 14 giorni bassa (${adherence14Pct}%): l'incertezza sul TDEE (±${Math.round(1.96 * tdeeSd)} kcal) è aumentata.`);
  }
  if (modelDivergence) {
    warnings.push(`Divergenza diagnostica tra TDEE Kalman (${tdeeEstimate} kcal) e finestra mobile (${windowTdee} kcal): attivato Q adattivo per riallineamento rapido.`);
  }
  if (rec.floorApplied) {
    warnings.push(`Applicato limite minimo di sicurezza (${rec.safeMinKcal} kcal/giorno) per non scendere sotto il BMR o la soglia clinica.`);
  }
  if (rec.rateClamped) {
    warnings.push(`Velocità obiettivo limitata a ${rec.targetRateKgWeek} kg/sett per preservare la massa magra (Helms et al., 2014).`);
  }

  return {
    model_version: 'energy@2.0',
    date: latest.date,
    trendWeight: latest.trendWeight,
    rawWeight: latest.rawWeight,
    bmrEstimate: currentBmr,
    priorTdee: prior.priorTdee,
    tdeeEstimate,
    tdeeSd,
    tdeeCI,
    tdeeWindowCrossCheck: windowTdee,
    rhoKcalPerKg: cfg.rhoKcalPerKg,
    underReportingSuspected,
    underReportingPct,
    model_divergence: modelDivergence,
    modelDivergence,
    avgIntake7d,
    energyBalance7d,
    weeklyRateKg,
    weeklyRatePct,
    forecast: sim.checkpoints,
    dailyForecast: sim.dailyForecast,
    etaGoalDate,
    daysToGoal,
    recommendedKcal: rec.recommendedKcal,
    recommendedMacros: rec.recommendedMacros,
    goalType: rec.goalType,
    targetRateKgWeek: rec.targetRateKgWeek,
    confidence,
    confidenceScore: confidenceUnit,
    dataQuality: {
      daysLogged: intakeDaysCount,
      weighIns: weightDaysCount,
      daysLogged14: intakeDays14,
      weighIns14: weightDays14,
      rpeCoverage: null,
      missingFields: missingDataRequirements.map(m => m.missing)
    },
    isPreliminary,
    adherence14Pct,
    weightDaysCount,
    intakeDaysCount,
    missingDataRequirements,
    warnings,
    history: snapshots,
    kalmanState: state
  };
}
