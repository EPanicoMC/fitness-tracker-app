/**
 * feature-flags.js — Gestione centralizzata dei Feature Flag per i modelli KOVA v2
 *
 * Principi (Vincolo 4):
 *   • Ogni modifica che altera i numeri mostrati all'utente (Fase 2, Fase 3, Fase 4) è protetta da un flag.
 *   • Tutti i flag che alterano i modelli esistenti sono OFF (`false`) di default finché il backtest
 *     nell'harness (`js/model-eval.js`) non ne giustifica l'attivazione.
 *   • Override persistente lato client in `localStorage` (`kova_flags`) o override in-memory per backtest.
 */

const STORAGE_KEY = 'kova_flags';

export const DEFAULT_FLAGS = {
  // Fase 2 — Modello 1 (Energia)
  'energy.trendKalmanOnly': false,
  'energy.normalizedGating': false,
  'energy.dynamicRho': false,
  'energy.stepsCovariate': false,

  // Fase 2 — Modello 2 (Allenamento)
  'training.homogeneousLoad': false,
  'training.e1rmV2': false,
  'training.banisterValidation': false,
  'training.readinessV2': false,
  'training.volumeTargets': false,
  'training.doubleProgression': false,

  // Fase 3 — Unificazione
  'targets.unified': false,
  'recovery.v2': false,
  'insightBus': true,

  // Fase 4 — Nuovi Modelli & Funzionalità Additive (attivi di default, 0 regressioni)
  'weeklyCheckin': true,
  'bodyComp': true,
  'dayCloser': true,
  'aiMealCalibration': true,
  'nutritionQuality': true,
  'correlations': true,
  'personalCorrelations': true,
  'dietBreak': false,
  'coach.dietBreakRule': false
};

let _memoryOverrides = {};

/**
 * Legge tutti gli override salvati in localStorage (`kova_flags`).
 */
export function getStoredFlagOverrides() {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * Restituisce true se il feature flag specificato è attivo.
 * Priorità:
 *   1. `explicitFlags[flagName]` (passato via config/options al modello per backtest)
 *   2. `_memoryOverrides[flagName]` (impostato in-memory nei test)
 *   3. `localStorage` (`kova_flags`)
 *   4. `DEFAULT_FLAGS[flagName]` (default `false`)
 */
export function isFlagEnabled(flagName, explicitFlags = null) {
  if (explicitFlags && typeof explicitFlags === 'object' && flagName in explicitFlags) {
    return !!explicitFlags[flagName];
  }
  if (flagName in _memoryOverrides) {
    return !!_memoryOverrides[flagName];
  }
  const stored = getStoredFlagOverrides();
  if (flagName in stored) {
    return !!stored[flagName];
  }
  return !!DEFAULT_FLAGS[flagName];
}

/**
 * Restituisce la mappa completa di tutti i flag con il loro stato effettivo attuale.
 */
export function getAllFlags(explicitFlags = null) {
  const out = {};
  for (const k of Object.keys(DEFAULT_FLAGS)) {
    out[k] = isFlagEnabled(k, explicitFlags);
  }
  return out;
}

/**
 * Imposta un override persistente in localStorage (usato da model-eval.html o da console).
 */
export function setFlag(flagName, enabled) {
  _memoryOverrides[flagName] = !!enabled;
  if (typeof localStorage !== 'undefined') {
    try {
      const current = getStoredFlagOverrides();
      current[flagName] = !!enabled;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch (_) {}
  }
}

/**
 * Imposta override temporanei solo in memoria (utile per l'harness `model-eval.js` e i test).
 */
export function setMemoryFlagOverrides(overrides = {}) {
  _memoryOverrides = { ...overrides };
}

/**
 * Ripristina tutti i flag ai valori di default.
 */
export function resetAllFlags() {
  _memoryOverrides = {};
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }
}

if (typeof window !== 'undefined') {
  window.KOVA_FLAGS = {
    isEnabled: isFlagEnabled,
    getAll: getAllFlags,
    set: setFlag,
    reset: resetAllFlags
  };
}
