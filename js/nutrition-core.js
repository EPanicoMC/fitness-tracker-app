/**
 * nutrition-core.js — Centralised nutritional arithmetic
 *
 * Design principles:
 *   • null = unknown, 0 = known-zero
 *   • Internal precision kept as floats; rounding only at display
 *   • Atwater formula (4/4/9) used as diagnostic, never authoritative override
 *   • saturatedFat ≤ fats enforced via validation, not silent correction
 */

// ── Schema ──────────────────────────────────────────────────
export const MACRO_FIELDS = ['kcal', 'protein', 'carbs', 'fats', 'saturatedFat', 'alcohol', 'alcoholDrinks'];

// ── Zero-kcal allowlist (exact match, not substring) ────────
const KNOWN_ZERO_KCAL = new Set([
  'acqua', 'acqua naturale', 'acqua frizzante', 'acqua gasata',
  'water', 'sparkling water',
  'caffè nero', 'caffe nero', 'caffè', 'caffe', 'espresso',
  'tè senza zucchero', 'te senza zucchero',
  'tè verde', 'te verde', 'tè verde senza zucchero',
  'sale', 'pepe', 'peperoncino secco',
  'coca cola zero', 'pepsi zero', 'sprite zero',
  'aceto', 'aceto di mele', 'aceto balsamico'
]);

/**
 * Check if a food name is legitimately zero-kcal.
 * Uses exact match after normalisation, NOT substring.
 */
export function isZeroKcalFood(name) {
  if (!name) return false;
  const n = name.toLowerCase()
    .replace(/\s*\(\d+g?\)/g, '')       // strip "(200g)"
    .replace(/\s*-\s*\d+\s*(ml|cl|l)\s*/gi, '')  // strip "- 500ml"
    .replace(/[àá]/g, 'a').replace(/[èé]/g, 'e')
    .replace(/[ìí]/g, 'i').replace(/[òó]/g, 'o').replace(/[ùú]/g, 'u')
    .trim();
  return KNOWN_ZERO_KCAL.has(n);
}

// ── Factory ─────────────────────────────────────────────────

/**
 * Create a normalised nutrient object from raw data.
 * Missing fields stay null; explicit 0 stays 0.
 */
export function createNutrients(raw) {
  if (!raw) return { kcal: null, protein: null, carbs: null, fats: null, saturatedFat: null, alcohol: null, alcoholDrinks: null };
  return {
    kcal:          raw.kcal          != null ? Math.max(0, Number(raw.kcal)          || 0) : null,
    protein:       raw.protein       != null ? Math.max(0, Number(raw.protein)       || 0) : null,
    carbs:         raw.carbs         != null ? Math.max(0, Number(raw.carbs)         || 0) : null,
    fats:          raw.fats          != null ? Math.max(0, Number(raw.fats)          || 0) : null,
    saturatedFat:  raw.saturatedFat  != null ? Math.max(0, Number(raw.saturatedFat)  || 0) : null,
    alcohol:       raw.alcohol       != null ? Math.max(0, Number(raw.alcohol)       || 0) : null,
    alcoholDrinks: raw.alcoholDrinks != null ? Math.max(0, Number(raw.alcoholDrinks) || 0) : null,
  };
}

// ── Arithmetic ──────────────────────────────────────────────

/**
 * Sum an array of nutrient objects.
 * Tracks completeness per field: { total: N, complete: bool, knownCount, totalCount }.
 */
export function sumNutrients(items) {
  const result = { kcal: 0, protein: 0, carbs: 0, fats: 0, saturatedFat: 0 };
  const known  = { kcal: 0, protein: 0, carbs: 0, fats: 0, saturatedFat: 0 };
  const count  = items.length;

  for (const item of items) {
    for (const f of MACRO_FIELDS) {
      if (item[f] != null) {
        result[f] += Number(item[f]) || 0;
        known[f]++;
      }
    }
  }

  const meta = {};
  for (const f of MACRO_FIELDS) {
    meta[f] = {
      total:      result[f],
      complete:   known[f] === count,
      knownCount: known[f],
      totalCount: count
    };
  }

  return { totals: result, meta };
}

/**
 * Scale nutrients by a factor (e.g. grams / 100).
 */
export function scaleNutrients(nutrients, factor) {
  const out = {};
  for (const f of MACRO_FIELDS) {
    out[f] = nutrients[f] != null ? nutrients[f] * factor : null;
  }
  return out;
}

// ── Diagnostic Atwater ──────────────────────────────────────

/**
 * Compute Atwater kcal estimate.
 * Used for DIAGNOSTICS only — never to silently overwrite declared kcal.
 *
 * Standard: P×4 + C×4 + F×9
 * Extended: + fiber×2 + alcohol×7 (when available)
 */
export function computeAtwater(nutrients) {
  const p = Number(nutrients.protein) || 0;
  const c = Number(nutrients.carbs)   || 0;
  const f = Number(nutrients.fats)    || 0;
  const fiber   = Number(nutrients.fiber)   || 0;
  const alcohol = Number(nutrients.alcohol) || 0;
  return (p * 4) + (c * 4) + (f * 9) + (fiber * 2) + (alcohol * 7);
}

/**
 * Compare declared kcal against Atwater and return diagnostic.
 * Returns { computed, declared, divergencePct, level }
 *   level: 'ok' | 'warning' | 'error'
 */
export function diagnoseAtwater(nutrients) {
  const declared = Number(nutrients.kcal) || 0;
  const computed = computeAtwater(nutrients);
  if (declared === 0 && computed === 0) {
    return { computed: 0, declared: 0, divergencePct: 0, level: 'ok' };
  }
  const base = Math.max(declared, computed, 1);
  const divergencePct = Math.round(Math.abs(computed - declared) / base * 100);
  let level = 'ok';
  if (divergencePct > 30) level = 'error';
  else if (divergencePct > 15) level = 'warning';
  return { computed: Math.round(computed), declared, divergencePct, level };
}

// ── Validation ──────────────────────────────────────────────

/**
 * Validate a nutrient response from AI or user input.
 * Returns { nutrients, warnings[], errors[], status }
 *   status: 'ok' | 'needs_review' | 'suspect'
 *
 * This function NEVER silently overwrites kcal.
 */
export function validateNutrients(raw, opts = {}) {
  const n = createNutrients(raw);
  const warnings = [];
  const errors   = [];
  let zeroSuspect = false;

  // 1. Zero-kcal check for real foods
  const items = raw.items || [];
  if (n.kcal === 0 && n.protein === 0 && n.carbs === 0 && n.fats === 0) {
    const hasRealItems = items.some(i => i.name && !isZeroKcalFood(i.name));
    if (hasRealItems) {
      zeroSuspect = true;
      errors.push('Tutti i valori sono 0 ma ci sono alimenti reali — probabile errore AI.');
    }
  }
  // Per-item zero check
  for (const item of items) {
    if ((Number(item.grams) || 0) > 0 && (Number(item.kcal) || 0) === 0 && !isZeroKcalFood(item.name)) {
      zeroSuspect = true;
      warnings.push(`"${item.name}" ha 0 kcal con ${item.grams}g — sospetto.`);
    }
  }

  // 2. Atwater diagnostic (does NOT overwrite kcal)
  if (n.kcal != null && n.kcal > 0) {
    const diag = diagnoseAtwater(n);
    if (diag.level === 'error') {
      warnings.push(`Atwater divergence ${diag.divergencePct}%: declared ${diag.declared} vs computed ${diag.computed} kcal. Possibile fibre/alcol/arrotondamento etichetta.`);
    } else if (diag.level === 'warning') {
      warnings.push(`Atwater divergence ${diag.divergencePct}%: declared ${diag.declared} vs computed ${diag.computed} kcal.`);
    }
  }

  // 3. Cross-check item sum vs declared totals
  if (items.length > 0) {
    const iSum = items.reduce((a, i) => ({
      kcal: a.kcal + (Number(i.kcal) || 0),
      protein: a.protein + (Number(i.protein) || 0),
      carbs: a.carbs + (Number(i.carbs) || 0),
      fats: a.fats + (Number(i.fats) || 0)
    }), { kcal: 0, protein: 0, carbs: 0, fats: 0 });

    if (iSum.kcal > 0 && n.kcal != null && n.kcal > 0) {
      const diff = Math.abs(iSum.kcal - n.kcal);
      if (diff > n.kcal * 0.15) {
        warnings.push(`Totale dichiarato (${Math.round(n.kcal)}) diverge dalla somma items (${Math.round(iSum.kcal)}) di ${Math.round(diff)} kcal. Usata somma items.`);
        // Use item sums as they're more granular
        n.kcal = iSum.kcal;
        n.protein = iSum.protein;
        n.carbs = iSum.carbs;
        n.fats = iSum.fats;
      }
    }
  }

  // 4. Saturated fat consistency check (do not silently clamp)
  if (n.saturatedFat != null && n.fats != null && n.saturatedFat > n.fats) {
    const itemSatSum = items.reduce((s, i) => s + (i.saturatedFat != null ? Number(i.saturatedFat) || 0 : 0), 0);
    const hasItemSats = items.some(i => i.saturatedFat != null);
    if (hasItemSats && itemSatSum <= n.fats) {
      n.saturatedFat = parseFloat(itemSatSum.toFixed(1));
      warnings.push(`Ricalcolati grassi saturi dai singoli ingredienti (${n.saturatedFat}g).`);
    } else {
      warnings.push(`Grassi saturi (${n.saturatedFat}g) superiori ai grassi totali (${n.fats}g). Dato segnato come non verificato.`);
      n.saturatedFat = null;
    }
  }

  // 5. Sanity checks per 100g (for library saves)
  if (opts.per100g) {
    if (n.kcal != null && (n.kcal <= 0 || n.kcal > 950)) {
      errors.push(`Kcal per 100g fuori range: ${n.kcal}.`);
    }
    // Allow protein up to 100g/100g (whey isolate can be 90-95)
    if ((n.protein || 0) > 100) {
      errors.push(`Proteine per 100g impossibili: ${n.protein}g.`);
    }
  }

  const status = errors.length > 0 ? 'suspect'
               : zeroSuspect ? 'suspect'
               : warnings.length > 0 ? 'needs_review'
               : 'ok';

  return {
    nutrients: n,
    items: items.map(i => ({
      ...i,
      saturatedFat: i.saturatedFat != null ? Math.max(0, Number(i.saturatedFat) || 0) : null
    })),
    warnings,
    errors,
    status,
    _zeroSuspect: zeroSuspect
  };
}

// ── Display helpers ─────────────────────────────────────────

/**
 * Round nutrients for display purposes only.
 */
export function roundForDisplay(nutrients) {
  return {
    kcal:          nutrients.kcal          != null ? Math.round(nutrients.kcal)                    : null,
    protein:       nutrients.protein       != null ? parseFloat(nutrients.protein.toFixed(1))       : null,
    carbs:         nutrients.carbs         != null ? parseFloat(nutrients.carbs.toFixed(1))         : null,
    fats:          nutrients.fats          != null ? parseFloat(nutrients.fats.toFixed(1))          : null,
    saturatedFat:  nutrients.saturatedFat  != null ? parseFloat(nutrients.saturatedFat.toFixed(1))  : null,
    alcohol:       nutrients.alcohol       != null ? parseFloat(nutrients.alcohol.toFixed(1))       : null,
    alcoholDrinks: nutrients.alcoholDrinks != null ? parseFloat(nutrients.alcoholDrinks.toFixed(1)) : null,
  };
}

/**
 * Format a nutrient value for display, handling null.
 * Returns the formatted string or '—' for unknown.
 */
export function formatNutrient(value, unit = 'g', fallback = '—') {
  if (value == null) return fallback;
  const rounded = typeof value === 'number' ? Math.round(value) : value;
  return `${rounded}${unit}`;
}

// ── Per 100g Conversions ───────────────────────────────────

export function per100gFrom(nutrients, grams) {
  const g = Math.max(1, Number(grams) || 100);
  const factor = 100 / g;
  return scaleNutrients(nutrients, factor);
}

export function fromPer100g(per100Nutrients, grams) {
  const g = Math.max(0, Number(grams) || 0);
  const factor = g / 100;
  return scaleNutrients(per100Nutrients, factor);
}

// ── Alcohol Detection & Estimation ─────────────────────────

export function estimateAlcoholGrams(ml, abv) {
  return Math.round((Number(ml) || 0) * (Number(abv) || 0) * 0.00789 * 10) / 10;
}

const ALCOHOLIC_DICTIONARY = [
  { keywords: ['spritz', 'aperol spritz', 'campari spritz', 'hugo'], ml: 150, abv: 8, drinks: 1 },
  { keywords: ['calice di vino', 'bicchiere di vino', 'vino rosso', 'vino bianco', 'prosecco', 'champagne', 'spumante', 'calice'], ml: 125, abv: 12, drinks: 1 },
  { keywords: ['birra piccol', 'birra 33', 'lattina di birra'], ml: 330, abv: 5, drinks: 1 },
  { keywords: ['birra medi', 'birra alla spina', 'pinta di birra', 'birra 40', 'birra 50', 'birra 66'], ml: 400, abv: 5, drinks: 1.3 },
  { keywords: ['birra', 'beer'], ml: 330, abv: 5, drinks: 1 },
  { keywords: ['gin tonic', 'negroni', 'mojito', 'moscow mule', 'americani', 'americana', 'cuba libre', 'vodka tonic', 'cocktail', 'aperitivo alcolico'], ml: 180, abv: 14, drinks: 1.5 },
  { keywords: ['amaro', 'limoncello', 'grappa', 'whisky', 'rum', 'vodka', 'tequila', 'shot', 'chupito', 'liquore'], ml: 40, abv: 30, drinks: 1 },
  { keywords: ['sangria'], ml: 200, abv: 9, drinks: 1 }
];

const NON_ALCOHOLIC_EXCLUSIONS = ['aceto', 'aceto di vino', 'aceto balsamico', 'risotto al vino', 'strotto', 'tiramisu', 'tiramisù', 'senza alcol', 'analcolico', 'zero alcol'];

export function detectAlcoholicDrink(name) {
  if (!name) return null;
  const norm = name.toLowerCase().trim();
  if (NON_ALCOHOLIC_EXCLUSIONS.some(ex => norm.includes(ex))) return null;
  for (const item of ALCOHOLIC_DICTIONARY) {
    if (item.keywords.some(kw => norm.includes(kw))) {
      const alcoholGrams = Math.round(item.ml * (item.abv / 100) * 0.789 * 10) / 10;
      return {
        isAlcohol: true,
        ml: item.ml,
        abv: item.abv,
        alcoholGrams,
        drinks: item.drinks
      };
    }
  }
  return null;
}

// ── Legacy compat helpers ───────────────────────────────────

/**
 * Convert legacy data (without saturatedFat or alcohol) to current schema.
 * Does NOT invent data — sets missing fields to null.
 */
export function fromLegacy(data) {
  if (!data) return createNutrients(null);
  return createNutrients({
    kcal:          data.kcal,
    protein:       data.protein,
    carbs:         data.carbs,
    fats:          data.fats,
    saturatedFat:  data.saturatedFat  ?? null,
    alcohol:       data.alcohol       ?? null,
    alcoholDrinks: data.alcoholDrinks ?? null
  });
}

/**
 * Prepare nutrients for Firestore persistence.
 * Strips null values to avoid Firestore complaints, but preserves 0.
 */
export function forFirestore(nutrients) {
  const out = {};
  for (const f of MACRO_FIELDS) {
    if (nutrients[f] != null) {
      out[f] = typeof nutrients[f] === 'number'
        ? parseFloat(nutrients[f].toFixed(f === 'kcal' ? 0 : 1))
        : nutrients[f];
    }
  }
  return out;
}
