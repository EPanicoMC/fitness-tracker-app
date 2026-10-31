/**
 * correlations.js — Motore di Correlazioni Personali Laggate (Fase 4F)
 *
 * Calcola la correlazione per ranghi di Spearman (ρ) con lag 0–2 giorni sulle serie storiche
 * personali dell'utente. Emette un'osservazione (al massimo 1 a settimana tramite `insight-bus.js`)
 * solo quando:
 *   • n >= 20 osservazioni accoppiate valide
 *   • |ρ| >= 0.35
 *
 * Formulazione rigorosamente non-causale ("Dai tuoi dati sembra che quando…").
 */

export const CORRELATIONS_VERSION = 'correlations@2.0';

/**
 * Converte un array numerico nei suoi ranghi medi (gestendo i pareggi / ties).
 */
function toRanks(arr) {
  const indexed = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  let k = 0;
  while (k < indexed.length) {
    let end = k;
    while (end + 1 < indexed.length && indexed[end + 1].v === indexed[k].v) {
      end++;
    }
    const avgRank = (k + end) / 2 + 1;
    for (let m = k; m <= end; m++) {
      ranks[indexed[m].i] = avgRank;
    }
    k = end + 1;
  }
  return ranks;
}

/**
 * Calcola il coefficiente di correlazione per ranghi di Spearman ρ ∈ [-1, 1] su una lista di coppie `{ x, y }`.
 */
export function computeSpearmanRho(pairs = []) {
  const valid = (pairs || []).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = valid.length;
  if (n < 5) return { rho: 0, n };

  const rx = toRanks(valid.map(p => p.x));
  const ry = toRanks(valid.map(p => p.y));

  const meanX = rx.reduce((a, b) => a + b, 0) / n;
  const meanY = ry.reduce((a, b) => a + b, 0) / n;

  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - meanX;
    const dy = ry[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  if (varX <= 1e-9 || varY <= 1e-9) return { rho: 0, n };
  const rho = cov / Math.sqrt(varX * varY);
  return {
    rho: Number(Math.max(-1, Math.min(1, rho)).toFixed(3)),
    n
  };
}

/**
 * Analizza le correlazioni personali laggate (lag 0–2 giorni) su:
 *   1. Sonno (t) -> RPE sessione / fatica percepita (t o t+1)
 *   2. Alcol / Pasti fuori (t) -> Spike peso sulla bilancia rispetto al trend (t+1 o t+2)
 *   3. Pasti fuori (t) -> Scostamento calorico rispetto alla media (t)
 *
 * Restituisce `{ correlations, topInsight }` dove `topInsight` è al massimo 1 osservazione
 * pronta per `insight-bus.js` con cooldown di 7 giorni.
 */
export function computePersonalCorrelations({
  days = [],
  energyHistory = [],
  minSamples = 20,
  minAbsRho = 0.35
} = {}) {
  const sortedDays = [...(days || [])].sort((a, b) => a.date.localeCompare(b.date));
  const snapByDate = new Map((energyHistory || []).map(s => [s.date, s]));
  const correlations = [];

  // 1. Sonno -> RPE sessione (lag 0 e lag 1)
  for (const lag of [0, 1]) {
    const pairs = [];
    for (let i = 0; i + lag < sortedDays.length; i++) {
      const dSleep = sortedDays[i];
      const dWork = sortedDays[i + lag];
      if (dSleep.sleepHours == null || Number(dSleep.sleepHours) <= 0) continue;
      if (!dWork.workout?.completed) continue;

      let rpe = dWork.workout.session_rpe != null ? Number(dWork.workout.session_rpe) : null;
      if (rpe == null && Array.isArray(dWork.workout.exercises)) {
        const exRpes = dWork.workout.exercises.map(e => Number(e.rpe)).filter(r => r > 0);
        if (exRpes.length) rpe = exRpes.reduce((a, b) => a + b, 0) / exRpes.length;
      }
      if (rpe != null && rpe > 0) {
        pairs.push({ x: Number(dSleep.sleepHours), y: rpe });
      }
    }
    const { rho, n } = computeSpearmanRho(pairs);
    if (n >= minSamples && Math.abs(rho) >= minAbsRho) {
      correlations.push({
        id: `corr_sleep_rpe_lag${lag}`,
        type: 'sleep_to_rpe',
        lagDays: lag,
        rho,
        n,
        title: 'Pattern personale: Sonno e Fatica in allenamento',
        message: rho < 0
          ? `Dai tuoi dati (${n} sessioni) sembra che quando dormi meno ore la sera prima, gli allenamenti risultino sensibilmente più faticosi a parità di carichi (correlazione ρ = ${rho}).`
          : `Dai tuoi dati (${n} sessioni) emerge un legame tra le ore di sonno registrate e l'intensità percepita in palestra (ρ = ${rho}).`,
        action: 'Nelle giornate dopo una notte corta (<6.5h), gestisci il buffer (RIR) senza forzare il cedimento.'
      });
    }
  }

  // 2. Drink / Pasti fuori (t) -> Spike peso bilancia vs trend (t+1 e t+2)
  for (const lag of [1, 2]) {
    const pairs = [];
    for (let i = 0; i + lag < sortedDays.length; i++) {
      const dEvent = sortedDays[i];
      const dNext = sortedDays[i + lag];
      const snapNext = snapByDate.get(dNext.date);
      const rawW = dNext.weightKg ?? snapNext?.rawWeight ?? null;
      const trendW = snapNext?.trendWeight ?? null;
      if (rawW == null || trendW == null) continue;

      const socialScore = (Number(dEvent.drinks) || 0) + (Number(dEvent.mealsOut) || 0);
      const weightSpikeKg = Number(rawW) - Number(trendW);
      pairs.push({ x: socialScore, y: weightSpikeKg });
    }
    const { rho, n } = computeSpearmanRho(pairs);
    if (n >= minSamples && rho >= minAbsRho) {
      correlations.push({
        id: `corr_social_water_spike_lag${lag}`,
        type: 'social_to_weight_spike',
        lagDays: lag,
        rho,
        n,
        title: `Pattern personale: Ritenzione idrica a +${lag * 24}h`,
        message: `Dai tuoi dati (${n} giorni analizzati) sembra che dopo pasti fuori o drink serali la bilancia segni un rialzo temporaneo a +${lag}g/gg rispetto al tuo peso reale di tendenza (ρ = +${rho}).`,
        action: 'Non tagliare le calorie il giorno dopo un pasto libero: è solo ritenzione idrica transitoria.'
      });
    }
  }

  // 3. Pasti fuori (t) -> Aderenza / Surplus calorico giornaliero (lag 0)
  {
    const pairs = [];
    const validIntakes = sortedDays.filter(d => d.intakeKcal != null && d.intakeComplete !== 'no').map(d => Number(d.intakeKcal));
    const meanIntake = validIntakes.length > 0 ? validIntakes.reduce((a, b) => a + b, 0) / validIntakes.length : 2000;

    for (const d of sortedDays) {
      if (d.intakeKcal == null || d.intakeComplete === 'no') continue;
      const mealsOut = Number(d.mealsOut) || 0;
      const kcalDelta = Number(d.intakeKcal) - meanIntake;
      pairs.push({ x: mealsOut, y: kcalDelta });
    }
    const { rho, n } = computeSpearmanRho(pairs);
    if (n >= minSamples && Math.abs(rho) >= minAbsRho) {
      correlations.push({
        id: 'corr_meals_out_kcal_lag0',
        type: 'meals_out_to_kcal',
        lagDays: 0,
        rho,
        n,
        title: 'Pattern personale: Pasti fuori casa e bilancio calorico',
        message: `Dai tuoi dati (${n} giorni) sembra che nei giorni con pasti fuori casa l'apporto calorico tenda a salire rispetto alla tua media abituale (ρ = +${rho}).`,
        action: 'Quando prevedi una cena fuori, privilegia proteine magre e verdure a pranzo per mantenere il bilancio settimanale.'
      });
    }
  }

  correlations.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
  const best = correlations[0] || null;

  const topInsight = best
    ? {
        id: best.id,
        topic: 'correlation',
        severity: 'info',
        confidence: Number(Math.min(0.95, Math.abs(best.rho) + 0.25).toFixed(2)),
        title: best.title,
        message: best.message,
        action: best.action,
        cooldownDays: 7
      }
    : null;

  return {
    model_version: CORRELATIONS_VERSION,
    correlations,
    topInsight
  };
}
