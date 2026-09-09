// Configurazione Fase 3 — Cut 12 settimane
// Tutte le soglie e i parametri di fase centralizzati qui.
// I widget leggono da questo file — nessun valore hardcoded nei componenti.

export const PHASE_CONFIG = {
  name: 'Fase 3 - Cut',
  start_date: '2026-09-14',
  end_date: '2026-12-06',
  weeks: 12,

  // Rotazione sedute
  rotation: ['L1', 'U1', 'L2', 'U2'],
  max_session_minutes: 75,
  min_gap_same_type_hours: 72,

  // Blocchi settimanali
  blocks: [
    { weeks: [1, 2], label: 'Rientro', rpe_fond: 7, rpe_iso: 8, intensification: false,
      note: 'Carichi fissi 85-90%. Focus tecnica, nessun aumento.' },
    { weeks: [3], label: 'Baseline forza', rpe_fond: 8, rpe_iso: 9, intensification: true,
      note: 'Settimana di baseline. RPE sale. Myo-reps e drop set partono.' },
    { weeks: [4, 5, 6], label: 'Pieno', rpe_fond: 8, rpe_iso: 9, intensification: true,
      note: 'Regola avanzamento attiva: tetto range raggiunto → +incremento.' },
    { weeks: [7], label: 'Scarico', rpe_fond: 6, rpe_iso: 7, intensification: false,
      note: 'SCARICO — 2 serie, RPE 6, niente intensificazione.' },
    { weeks: [8, 9, 10, 11, 12], label: 'Pieno', rpe_fond: 8, rpe_iso: 9, intensification: true,
      note: 'Ripresa dai pesi sett. 6. Stessa regola avanzamento.' },
  ],

  // Baseline forza — settimana 3
  baseline_week_start: '2026-09-28',
  baseline_week_end: '2026-10-04',

  // 5 esercizi di riferimento
  reference_exercises: [
    'Trazioni alla sbarra',
    'Row machine appoggio pettorale',
    'Hack squat',
    'Pressa 45 gradi',
    'Lat machine presa neutra media',
  ],

  // Corridoio peso
  weight: {
    baseline_date: '2026-09-21',
    target_min: 68.5,
    target_max: 69.5,
    drop_min_per_week: 0.5,
    drop_max_per_week: 0.8,
    corridor_band: 0.5,
  },

  // Vita
  waist: {
    start: 93.0,
    target: 85.0,
  },

  // Target calorici e macro
  kcal: {
    training: 2140,
    rest: 1800,
    weekly_avg: 1995,
    tolerance: 100,
  },
  macro: {
    training: { protein: 189, carbs: 219, fats: 53 },
    rest: { protein: 173, carbs: 139, fats: 58 },
    avg: { protein: 182, carbs: 185, fats: 55 },
  },
  protein_band: { min: 170, max: 195 },

  // Soglie giornaliere
  steps_daily: 11000,
  sleep: { warning: 5.5, critical: 5.0 },
  symptoms: { session_stop: 3, rest_critical: 5 },

  // Cancello fine fase
  gate: {
    date: '2026-12-07',
    waist_target: 85.0,
    force_max_drop_pct: -5,
  },

  // Uscita anticipata
  early_exit: {
    force_critical_pct: -10,
    force_min_exercises: 2,
    sleep_critical_nights: 5,
    sleep_critical_hours: 5.0,
    adherence_critical_weeks: 2,
    adherence_critical_pct: 70,
  },

  // 7 regole armate
  rules: [
    {
      id: 'stallo',
      label: 'Stallo',
      condition: 'media 7gg varia < 0.2 kg e vita invariata, aderenza >= 90%',
      window_days: 14,
      consequence: 'passi da 11.000 a 12.000',
      params: { weight_delta_max: 0.2, adherence_min: 0.9 },
    },
    {
      id: 'stallo_bassa_aderenza',
      label: 'Stallo bassa aderenza',
      condition: 'come sopra ma aderenza < 90%',
      window_days: 14,
      consequence: 'calorie invariate, si rivede la struttura',
      params: { weight_delta_max: 0.2, adherence_max: 0.9 },
    },
    {
      id: 'calo_rapido',
      label: 'Calo rapido',
      condition: '-0.9 kg/sett, escluse sett 1-2',
      window_weeks: 2,
      consequence: '+100 kcal di carboidrati nei giorni di allenamento',
      params: { threshold_per_week: -0.9, excluded_weeks: [1, 2] },
    },
    {
      id: 'perdita_forza',
      label: 'Perdita di forza',
      condition: 'e1RM -5/-10% su 2+ esercizi di riferimento',
      window_sessions: 2,
      consequence: 'serie -30% sui fondamentali per una settimana',
      params: { threshold_pct: -5, critical_pct: -10, min_exercises: 2 },
    },
    {
      id: 'sonno',
      label: 'Sonno insufficiente',
      condition: 'media < 5.5h',
      window_days: 7,
      consequence: 'S5 disattivata, -1 serie isolamenti (tranne delt laterale)',
      params: { avg_threshold: 5.5 },
    },
    {
      id: 'sintomi',
      label: 'Sintomi persistenti',
      condition: 'cervicale o coccige > 5/10 in seduta',
      window_days: 3,
      consequence: 'sospensione spinte e trazioni verticali',
      params: { threshold: 5 },
    },
    {
      id: 'aderenza_bassa',
      label: 'Aderenza bassa',
      condition: '< 80%',
      window_weeks: 1,
      consequence: 'solo opzione A di ogni pasto',
      params: { threshold_pct: 80 },
    },
  ],

  // Condizioni S5
  s5: {
    adherence_min_pct: 90,
    adherence_window_weeks: 2,
    sleep_min: 6.0,
    symptoms_max: 3,
    no_force_drop: true,
  },

  // Serate e drink
  drinks: {
    max_per_night: 4,
    expected_nights_per_month: 3.5,
  },

  // Pasti fuori
  meals_out: {
    expected_per_week: 2.5,
  },

  // Incrementi per tipo attrezzo
  increments: {
    macchine_piastre: 'una piastra',
    manubri: 2,
    cavi: 2.5,
    hack_pressa: 5,
    trazioni: { reps_first_until: 10, then_kg: 2.5 },
  },
};

// Mapping esercizio → gruppo muscolare
export const MUSCLE_GROUPS = {
  'Hack squat': 'quadricipiti',
  'Leg extension': 'quadricipiti',
  'Bulgarian split squat manubri': 'quadricipiti',
  'Pressa 45 gradi': 'quadricipiti',
  'Leg curl seduto': 'femorali',
  'Leg curl sdraiato': 'femorali',
  'Stacco rumeno manubri': 'femorali',
  'Trazioni alla sbarra': 'dorso_verticale',
  'Lat machine presa neutra media': 'dorso_verticale',
  'Row machine appoggio pettorale': 'dorso_orizzontale',
  'Rematore singolo manubrio': 'dorso_orizzontale',
  'Panca piana manubri': 'petto',
  'Chest press machine': 'petto',
  'Alzate laterali ai cavi': 'deltoide_laterale',
  'Alzate laterali manubri seduto schienale 80 gradi': 'deltoide_laterale',
  'Incline side-lying lateral raise': 'deltoide_laterale',
  'Face pull ai cavi': 'delt_posteriore',
  'Reverse pec deck': 'delt_posteriore',
  'Calf in piedi': 'polpacci',
  'Calf alla pressa': 'polpacci',
};

// Superset: ogni componente conta per il suo gruppo
export const SUPERSET_GROUPS = {
  'Superset: Curl EZ + French press ai cavi': { a: 'bicipiti', b: 'tricipiti' },
  'Superset: Spider curl + Pushdown corda': { a: 'bicipiti', b: 'tricipiti' },
};

// Gruppi esclusi dal rapporto dorso (tirate vert vs oriz)
export const DORSO_EXCLUDED = ['delt_posteriore'];

// Volume target settimanale (serie dirette) per gruppo — ordine priorita'
export const VOLUME_TARGETS = [
  { group: 'deltoide_laterale', label: 'Delt laterale', target: 16, with_s5: 23, priority: 1 },
  { group: 'dorso_verticale', label: 'Dorso verticale', target: 8, priority: 2 },
  { group: 'dorso_orizzontale', label: 'Dorso orizzontale', target: 8, priority: 2 },
  { group: 'delt_posteriore', label: 'Delt post / centro schiena', target: 6, with_s5: 12, priority: 3 },
  { group: 'quadricipiti', label: 'Quadricipiti', target: 12, priority: 4 },
  { group: 'femorali', label: 'Femorali', target: 9, priority: 5 },
  { group: 'petto', label: 'Petto', target: 6, priority: 7 },
  { group: 'bicipiti', label: 'Bicipiti', target: 4, priority: 8 },
  { group: 'tricipiti', label: 'Tricipiti', target: 4, priority: 8 },
  { group: 'polpacci', label: 'Polpacci', target: 6, priority: 9 },
];

// Helper: settimana corrente della fase
export function getCurrentPhaseWeek(today) {
  const start = new Date(PHASE_CONFIG.start_date + 'T00:00:00');
  const now = new Date(today + 'T00:00:00');
  const diff = Math.floor((now - start) / 86400000);
  if (diff < 0) return 0;
  return Math.min(Math.floor(diff / 7) + 1, PHASE_CONFIG.weeks);
}

// Helper: blocco corrente per numero settimana
export function getCurrentBlock(weekNum) {
  return PHASE_CONFIG.blocks.find(b => b.weeks.includes(weekNum)) || null;
}

// Helper: e1RM Epley — usato internamente per confronto, mai mostrato a schermo
export function calcE1RM(weight, reps) {
  if (!weight || !reps || reps <= 0) return 0;
  if (reps === 1) return weight;
  return weight * (1 + reps / 30);
}

// Helper: gruppo muscolare per esercizio (incluso superset)
export function getMuscleGroup(exerciseName) {
  if (MUSCLE_GROUPS[exerciseName]) return MUSCLE_GROUPS[exerciseName];
  for (const [key, groups] of Object.entries(SUPERSET_GROUPS)) {
    if (exerciseName.includes(key) || key.includes(exerciseName)) {
      return [groups.a, groups.b];
    }
  }
  return null;
}
