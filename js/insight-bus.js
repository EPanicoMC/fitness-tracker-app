/**
 * insight-bus.js — Motore Unificato degli Insight con Deduplicazione, Cooldown e Risoluzione Conflitti (Fase 3.2)
 *
 * Schema canonico di ogni insight:
 *   {
 *     id: string,
 *     topic: string,
 *     source: 'coach-rules' | 'insights-engine' | 'phase-config' | 'nutrition' | 'correlations',
 *     severity: 'high' | 'medium' | 'low',
 *     confidence: number, // in [0, 1]
 *     evidence: Object,
 *     action: string,
 *     message: string,
 *     title: string,
 *     area: 'diet' | 'training' | 'recovery',
 *     actionPolarity: string | null,
 *     createdAt: string,
 *     cooldownDays: number
 *   }
 */

const COOLDOWN_STORAGE_KEY = 'kova_insight_cooldowns_v1';

const TOPIC_MAP = {
  // Coach rules
  weight_plateau_adaptive_tdee: 'weight_stall',
  rapid_weight_loss: 'rapid_weight_loss',
  low_protein_intake: 'low_protein',
  deficit_fatigue_strength_drop: 'high_fatigue',
  high_acwr_spike: 'high_fatigue',
  low_diary_adherence: 'diary_adherence',
  strength_plateau_detected: 'strength_plateau',
  insufficient_sleep_recovery: 'sleep_recovery',
  diet_break_suggested: 'diet_break',
  // Insights engine
  weight_stall_cut: 'weight_stall',
  protein_deficit: 'low_protein',
  workout_skip: 'training_adherence',
  workout_plateau: 'strength_plateau',
  calorie_inconsistency: 'diary_adherence',
  calorie_deficit_excess: 'calorie_balance',
  calorie_surplus_excess: 'calorie_balance',
  steps_low: 'daily_steps',
  // Phase config
  stallo: 'weight_stall',
  stallo_bassa_aderenza: 'weight_stall',
  calo_rapido: 'rapid_weight_loss',
  perdita_forza: 'high_fatigue',
  sonno: 'sleep_recovery',
  sintomi: 'joint_symptoms',
  aderenza_bassa: 'diary_adherence',
  // Nutrition & Correlations
  meal_protein_distribution: 'protein_distribution',
  low_fiber_intake: 'fiber_intake',
  high_saturated_fat: 'saturated_fat',
  weekly_alcohol_excess: 'alcohol_intake'
};

const SEVERITY_RANK = { high: 3, critical: 3, medium: 2, warning: 2, low: 1, info: 1 };
const SOURCE_RANK = { 'coach-rules': 4, 'nutrition': 3, 'insights-engine': 2, 'phase-config': 1, 'correlations': 1 };

function normalizeSeverity(sev) {
  if (typeof sev === 'number') {
    if (sev >= 4) return 'high';
    if (sev >= 3) return 'medium';
    return 'low';
  }
  const s = String(sev || 'low').toLowerCase();
  if (s === 'high' || s === 'critical') return 'high';
  if (s === 'medium' || s === 'warning') return 'medium';
  return 'low';
}

function normalizeConfidence(conf, defaultVal = 0.75) {
  if (conf == null || isNaN(Number(conf))) return defaultVal;
  const n = Number(conf);
  if (n <= 1 && n >= 0) return Number(n.toFixed(2));
  if (n <= 5 && n > 1) return Number(Math.min(1, n / 5).toFixed(2));
  return Number(Math.min(1, Math.max(0.05, n / 100)).toFixed(2));
}

function inferActionPolarity(actionText = '', id = '') {
  const txt = `${id} ${actionText}`.toLowerCase();
  if (/riduci.*kcal|taglia.*kcal|abbassa.*kcal|scendi a/i.test(txt)) return 'kcal_down';
  if (/aumenta.*kcal|\+\d+\s*kcal|mantieni.*kcal|calorie invariate|refeed|diet break/i.test(txt)) return 'kcal_up_or_hold';
  if (/riduci.*volume|riduci.*serie|scarico|deload|-30%/i.test(txt)) return 'volume_down';
  if (/aumenta.*carico|aumenta.*peso|\+2\.5%/i.test(txt)) return 'load_up';
  return null;
}

export function adaptCoachRuleInsight(raw, nowIso = new Date().toISOString()) {
  if (!raw) return null;
  const confFromEvidence = raw.evidence?.confidence;
  const severity = normalizeSeverity(raw.severity);
  const baseConf = confFromEvidence != null
    ? normalizeConfidence(confFromEvidence, 0.85)
    : (severity === 'high' ? 0.9 : severity === 'medium' ? 0.82 : 0.75);

  return {
    id: raw.id || 'coach_rule',
    topic: TOPIC_MAP[raw.id] || raw.topic || raw.id || 'general',
    source: 'coach-rules',
    severity,
    confidence: baseConf,
    evidence: raw.evidence || {},
    action: raw.action || '',
    message: raw.message || '',
    title: raw.title || raw.message?.split(':')[0] || 'Indicazione del Coach',
    area: raw.area || 'diet',
    actionPolarity: inferActionPolarity(raw.action, raw.id),
    createdAt: raw.createdAt || nowIso,
    cooldownDays: severity === 'high' ? 3 : 5
  };
}

export function adaptWeeklyEngineInsight(raw, nowIso = new Date().toISOString()) {
  if (!raw) return null;
  const id = raw.type || raw.id || 'weekly_insight';
  const severity = normalizeSeverity(raw.severity);
  const conf = normalizeConfidence(raw.confidence, 0.72);
  const area = raw.category === 'training' ? 'training' : raw.category === 'recovery' ? 'recovery' : 'diet';

  return {
    id,
    topic: TOPIC_MAP[id] || raw.topic || id,
    source: 'insights-engine',
    severity,
    confidence: conf,
    evidence: {
      metric: raw.metric || null,
      persistence: raw.persistence || null,
      priorityScore: raw.priorityScore || null
    },
    action: raw.suggestion || raw.action || '',
    message: raw.explanation || raw.message || '',
    title: raw.title || 'Osservazione settimanale',
    area,
    actionPolarity: inferActionPolarity(raw.suggestion || raw.action, id),
    createdAt: raw.createdAt || nowIso,
    cooldownDays: severity === 'high' ? 4 : 7
  };
}

export function adaptPhaseConfigRule(raw, nowIso = new Date().toISOString()) {
  if (!raw) return null;
  const id = raw.id || 'phase_rule';
  return {
    id,
    topic: TOPIC_MAP[id] || id,
    source: 'phase-config',
    severity: normalizeSeverity(raw.severity || 'medium'),
    confidence: normalizeConfidence(raw.confidence, 0.68),
    evidence: raw.params || raw.evidence || {},
    action: raw.consequence || raw.action || '',
    message: raw.condition || raw.message || '',
    title: raw.label || raw.title || 'Regola di Fase',
    area: raw.area || 'diet',
    actionPolarity: inferActionPolarity(raw.consequence || raw.action, id),
    createdAt: nowIso,
    cooldownDays: 5
  };
}

export function adaptCustomInsight(raw, nowIso = new Date().toISOString()) {
  if (!raw) return null;
  const id = raw.id || 'custom_insight';
  const severity = normalizeSeverity(raw.severity || 'low');
  return {
    id,
    topic: TOPIC_MAP[id] || raw.topic || id,
    source: raw.source || 'nutrition',
    severity,
    confidence: normalizeConfidence(raw.confidence, 0.78),
    evidence: raw.evidence || {},
    action: raw.action || '',
    message: raw.message || '',
    title: raw.title || 'Consiglio',
    area: raw.area || 'diet',
    actionPolarity: inferActionPolarity(raw.action, id),
    createdAt: raw.createdAt || nowIso,
    cooldownDays: raw.cooldownDays || (severity === 'high' ? 3 : 6)
  };
}

function readCooldownMap() {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(COOLDOWN_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function writeCooldownMap(map) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(COOLDOWN_STORAGE_KEY, JSON.stringify(map));
  } catch (_) {}
}

export function clearInsightCooldowns() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(COOLDOWN_STORAGE_KEY);
  } catch (_) {}
}

function isBetterCandidate(cand, existing) {
  if (cand.confidence !== existing.confidence) {
    return cand.confidence > existing.confidence;
  }
  const sevA = SEVERITY_RANK[cand.severity] || 1;
  const sevB = SEVERITY_RANK[existing.severity] || 1;
  if (sevA !== sevB) return sevA > sevB;
  return (SOURCE_RANK[cand.source] || 0) > (SOURCE_RANK[existing.source] || 0);
}

/**
 * Unifica, deduplica per topic, risolve i conflitti tra fonti e limita a maxPerView (default 3).
 *
 * @param {Object} sources
 * @param {Array} [sources.coachRules=[]] output di evaluateCrossRules
 * @param {Array} [sources.weeklyInsights=[]] output di analyzeWeeklyData().insights
 * @param {Array} [sources.phaseRules=[]] eventuali regole attive da phase-config
 * @param {Array} [sources.customInsights=[]] insight da nutrition-core / correlations
 * @param {Object} [options]
 * @param {number} [options.maxPerView=3]
 * @param {boolean} [options.respectCooldown=false]
 * @param {boolean} [options.recordCooldown=false]
 * @param {string} [options.nowDate] YYYY-MM-DD
 * @returns {{ insights: Array, suppressed: Array, totalCandidates: number }}
 */
export function unifyInsights({
  coachRules = [],
  weeklyInsights = [],
  phaseRules = [],
  customInsights = []
} = {}, options = {}) {
  const {
    maxPerView = 3,
    respectCooldown = false,
    recordCooldown = false,
    nowDate = new Date().toISOString().split('T')[0]
  } = options;

  const nowIso = new Date(nowDate + 'T12:00:00Z').toISOString();
  const candidates = [
    ...(coachRules || []).map(r => adaptCoachRuleInsight(r, nowIso)),
    ...(customInsights || []).map(r => adaptCustomInsight(r, nowIso)),
    ...(weeklyInsights || []).map(r => adaptWeeklyEngineInsight(r, nowIso)),
    ...(phaseRules || []).map(r => adaptPhaseConfigRule(r, nowIso))
  ].filter(Boolean);

  const cooldownMap = respectCooldown ? readCooldownMap() : {};
  const nowMs = new Date(nowDate + 'T00:00:00Z').getTime();

  const byTopic = new Map();
  const suppressed = [];

  for (const cand of candidates) {
    // Filtro cooldown (solo per severità low/medium; high passa sempre se urgente)
    if (respectCooldown && cand.severity !== 'high' && cooldownMap[cand.topic]) {
      const lastShownMs = new Date(cooldownMap[cand.topic] + 'T00:00:00Z').getTime();
      const elapsedDays = Math.round((nowMs - lastShownMs) / 86400000);
      if (!isNaN(elapsedDays) && elapsedDays >= 0 && elapsedDays < (cand.cooldownDays || 5)) {
        suppressed.push({
          insight: cand,
          reason: 'cooldown_active',
          detail: `Mostrato ${elapsedDays}g fa (cooldown ${cand.cooldownDays}g)`
        });
        continue;
      }
    }

    const existing = byTopic.get(cand.topic);
    if (!existing) {
      byTopic.set(cand.topic, cand);
      continue;
    }

    const isConflict =
      existing.actionPolarity &&
      cand.actionPolarity &&
      existing.actionPolarity !== cand.actionPolarity;

    if (isBetterCandidate(cand, existing)) {
      suppressed.push({
        insight: existing,
        winnerId: cand.id,
        winnerSource: cand.source,
        reason: isConflict ? 'conflict_lower_confidence' : 'duplicate_topic',
        detail: isConflict
          ? `Conflitto su topic "${cand.topic}" (${existing.actionPolarity} vs ${cand.actionPolarity}): vince ${cand.source} (conf ${cand.confidence} >= ${existing.confidence})`
          : `Deduplicato topic "${cand.topic}" a favore di ${cand.source}`
      });
      byTopic.set(cand.topic, cand);
    } else {
      suppressed.push({
        insight: cand,
        winnerId: existing.id,
        winnerSource: existing.source,
        reason: isConflict ? 'conflict_lower_confidence' : 'duplicate_topic',
        detail: isConflict
          ? `Conflitto su topic "${cand.topic}" (${cand.actionPolarity} vs ${existing.actionPolarity}): vince ${existing.source} (conf ${existing.confidence} >= ${cand.confidence})`
          : `Deduplicato topic "${cand.topic}" a favore di ${existing.source}`
      });
    }
  }

  const ordered = [...byTopic.values()].sort((a, b) => {
    const sevDiff = (SEVERITY_RANK[b.severity] || 1) - (SEVERITY_RANK[a.severity] || 1);
    if (sevDiff !== 0) return sevDiff;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return (SOURCE_RANK[b.source] || 0) - (SOURCE_RANK[a.source] || 0);
  });

  const selected = ordered.slice(0, maxPerView);
  const overflow = ordered.slice(maxPerView);
  for (const ov of overflow) {
    suppressed.push({
      insight: ov,
      reason: 'max_per_view_cap',
      detail: `Superato limite massimo di ${maxPerView} insight per vista`
    });
  }

  if (recordCooldown && selected.length > 0) {
    const updatedMap = { ...readCooldownMap() };
    for (const s of selected) {
      updatedMap[s.topic] = nowDate;
    }
    writeCooldownMap(updatedMap);
  }

  return {
    insights: selected,
    suppressed,
    totalCandidates: candidates.length
  };
}
