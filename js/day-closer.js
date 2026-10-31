/**
 * day-closer.js — Ottimizzatore Deterministico "Chiudi la giornata" (Fase 4C)
 *
 * Dati i macro e le calorie rimanenti della giornata (`remKcal`, `remProtein`, `remCarbs`, `remFats`),
 * propone fino a 3 combinazioni discrete di 1–2 alimenti scelti dalla `fridge` (dispensa piatti pronti)
 * e dalla `food_library` dell'utente che minimizzano:
 *
 *   costo = |Δprotein| * 3 + |Δkcal| / 50   con vincolo   kcal <= remKcal + 100
 *
 * Modulo 100% deterministico, sincrono e offline-first.
 */

export const DAY_CLOSER_VERSION = 'daycloser@2.0';

const DEFAULT_STAPLES = [
  { name: 'Yogurt Greco 0%', kcal100: 57, pro100: 10.3, carbs100: 4.0, fats100: 0.1, portionsG: [150, 170, 200] },
  { name: 'Skyr Bianco', kcal100: 63, pro100: 11.0, carbs100: 4.0, fats100: 0.2, portionsG: [150, 200] },
  { name: 'Fiocchi di latte Light', kcal100: 82, pro100: 13.0, carbs100: 3.0, fats100: 2.0, portionsG: [150, 200] },
  { name: 'Tonno al naturale sgocciolato', kcal100: 103, pro100: 24.0, carbs100: 0.0, fats100: 0.8, portionsG: [80, 112, 160] },
  { name: 'Affettato di tacchino/pollo', kcal100: 105, pro100: 22.0, carbs100: 1.0, fats100: 1.2, portionsG: [80, 100, 120] },
  { name: 'Albume d\'uovo cotto', kcal100: 48, pro100: 10.8, carbs100: 0.7, fats100: 0.1, portionsG: [150, 200, 250] },
  { name: 'Proteine Whey in polvere', kcal100: 380, pro100: 78.0, carbs100: 6.0, fats100: 5.0, portionsG: [25, 30, 40] },
  { name: 'Gallette di riso', kcal100: 381, pro100: 8.0, carbs100: 81.0, fats100: 2.5, portionsG: [24, 32, 40] },
  { name: 'Banana media', kcal100: 89, pro100: 1.1, carbs100: 22.8, fats100: 0.3, portionsG: [120] },
  { name: 'Mandorle / Frutta secca', kcal100: 590, pro100: 21.0, carbs100: 9.0, fats100: 52.0, portionsG: [15, 20, 30] }
];

function buildCandidatePortions(fridgeItems = [], foodLibrary = []) {
  const candidates = [];

  // 1. Porzioni pronte dalla Dispensa (priorità alta: bonus sul costo)
  for (const f of (fridgeItems || [])) {
    if (!f || !f.name) continue;
    const remSlices = f.slices_remaining != null ? Number(f.slices_remaining) : 1;
    if (remSlices <= 0) continue;

    // In KOVA, i piatti in dispensa possono avere valori per fetta o totali
    const totalSlices = Math.max(1, Number(f.total_slices || f.portions || 1));
    const perSliceKcal = Number(f.kcal_per_slice ?? (f.kcal && totalSlices > 1 ? f.kcal / totalSlices : f.kcal)) || 0;
    const perSlicePro = Number(f.protein_per_slice ?? (f.protein && totalSlices > 1 ? f.protein / totalSlices : f.protein)) || 0;
    const perSliceCarbs = Number(f.carbs_per_slice ?? (f.carbs && totalSlices > 1 ? f.carbs / totalSlices : f.carbs)) || 0;
    const perSliceFats = Number(f.fats_per_slice ?? (f.fats && totalSlices > 1 ? f.fats / totalSlices : f.fats)) || 0;

    if (perSliceKcal <= 0 && perSlicePro <= 0) continue;

    for (const n of [1, 2]) {
      if (n > remSlices) continue;
      candidates.push({
        baseName: f.name,
        displayLabel: `${n} porz. ${f.name} (Dispensa)`,
        source: 'fridge',
        gramsOrUnits: `${n} porz.`,
        kcal: Math.round(perSliceKcal * n),
        protein: Number((perSlicePro * n).toFixed(1)),
        carbs: Number((perSliceCarbs * n).toFixed(1)),
        fats: Number((perSliceFats * n).toFixed(1)),
        fridgeBonus: 1.5
      });
    }
  }

  // 2. Alimenti dalla food_library personale dell'utente (top 18 ordinati per uso/proteine)
  const libSorted = [...(foodLibrary || [])]
    .filter(it => it && it.name && (Number(it.kcal) > 0 || Number(it.per100g?.kcal) > 0))
    .sort((a, b) => (Number(b.use_count || 0) - Number(a.use_count || 0)) || (Number(b.protein || 0) - Number(a.protein || 0)))
    .slice(0, 18);

  for (const item of libSorted) {
    const p100 = item.per100g || item;
    const kcal100 = Number(p100.kcal) || 0;
    const pro100 = Number(p100.protein) || 0;
    const carbs100 = Number(p100.carbs) || 0;
    const fats100 = Number(p100.fats) || 0;
    if (kcal100 <= 0) continue;

    const defaultPortion = Number(item.default_grams || item.grams) || 100;
    const sizes = Array.from(new Set([
      Math.max(30, Math.round(defaultPortion * 0.5 / 10) * 10),
      Math.max(30, Math.round(defaultPortion / 10) * 10),
      100,
      150,
      200
    ])).filter(g => g >= 20 && g <= 300);

    for (const g of sizes) {
      const mult = g / 100;
      candidates.push({
        baseName: item.name,
        displayLabel: `${g}g ${item.name}`,
        source: 'food_library',
        gramsOrUnits: `${g}g`,
        kcal: Math.round(kcal100 * mult),
        protein: Number((pro100 * mult).toFixed(1)),
        carbs: Number((carbs100 * mult).toFixed(1)),
        fats: Number((fats100 * mult).toFixed(1)),
        fridgeBonus: 0.3
      });
    }
  }

  // 3. Alimenti base (staples) sempre disponibili per completare le combinazioni
  for (const st of DEFAULT_STAPLES) {
    if (candidates.some(c => c.baseName.toLowerCase() === st.name.toLowerCase())) continue;
    for (const g of st.portionsG) {
      const mult = g / 100;
      candidates.push({
        baseName: st.name,
        displayLabel: `${g}g ${st.name}`,
        source: 'staple',
        gramsOrUnits: `${g}g`,
        kcal: Math.round(st.kcal100 * mult),
        protein: Number((st.pro100 * mult).toFixed(1)),
        carbs: Number((st.carbs100 * mult).toFixed(1)),
        fats: Number((st.fats100 * mult).toFixed(1)),
        fridgeBonus: 0
      });
    }
  }

  return candidates;
}

/**
 * Calcola fino a 3 proposte ottimali per chiudere i macro rimanenti della giornata.
 *
 * @param {Object} params
 * @param {number} params.remKcal kcal mancanti al target di oggi
 * @param {number} params.remProtein grammi di proteine mancanti al target di oggi
 * @param {number} [params.remCarbs] grammi di carboidrati mancanti
 * @param {number} [params.remFats] grammi di grassi mancanti
 * @param {Array} [params.fridgeItems] piatti pronti in dispensa
 * @param {Array} [params.foodLibrary] libreria alimenti dell'utente
 * @param {number} [params.maxSuggestions=3]
 */
export function suggestDayCloser({
  remKcal = 0,
  remProtein = 0,
  remCarbs = 0,
  remFats = 0,
  fridgeItems = [],
  foodLibrary = [],
  maxSuggestions = 3
} = {}) {
  const targetKcal = Math.max(0, Number(remKcal) || 0);
  const targetPro = Math.max(0, Number(remProtein) || 0);

  if (targetKcal < 60 && targetPro < 8) {
    return {
      model_version: DAY_CLOSER_VERSION,
      needed: false,
      reason: 'Target giornaliero già raggiunto.',
      suggestions: []
    };
  }

  const maxAllowedKcal = Math.max(150, targetKcal + 100);
  const candidates = buildCandidatePortions(fridgeItems, foodLibrary)
    .filter(c => c.kcal > 0 && c.kcal <= maxAllowedKcal);

  const scoredCombos = [];

  const evaluateCombo = (items) => {
    const kcal = items.reduce((s, x) => s + x.kcal, 0);
    if (kcal > maxAllowedKcal) return;
    const protein = Number(items.reduce((s, x) => s + x.protein, 0).toFixed(1));
    const carbs = Number(items.reduce((s, x) => s + x.carbs, 0).toFixed(1));
    const fats = Number(items.reduce((s, x) => s + x.fats, 0).toFixed(1));
    const bonus = items.reduce((s, x) => s + (x.fridgeBonus || 0), 0);

    // Funzione obiettivo Fase 4C: minimizza |Δprotein|*3 + |Δkcal|/50
    const deltaPro = protein - targetPro;
    const deltaKcal = kcal - targetKcal;
    const rawCost = Math.abs(deltaPro) * 3 + Math.abs(deltaKcal) / 50;
    const effectiveCost = Math.max(0, rawCost - bonus);

    scoredCombos.push({
      label: items.map(x => x.displayLabel).join(' + '),
      items: items.map(x => ({
        name: x.baseName,
        portion: x.gramsOrUnits,
        source: x.source,
        kcal: x.kcal,
        protein: x.protein,
        carbs: x.carbs,
        fats: x.fats
      })),
      hasFridgeItem: items.some(x => x.source === 'fridge'),
      kcal,
      protein,
      carbs,
      fats,
      deltaProtein: Number(deltaPro.toFixed(1)),
      deltaKcal: Math.round(deltaKcal),
      cost: Number(rawCost.toFixed(2)),
      _sortScore: effectiveCost
    });
  };

  // 1. Singoli alimenti
  for (let i = 0; i < candidates.length; i++) {
    evaluateCombo([candidates[i]]);
  }

  // 2. Coppie di alimenti distinti
  const topForPairs = candidates.slice(0, 36);
  for (let i = 0; i < topForPairs.length; i++) {
    for (let j = i + 1; j < topForPairs.length; j++) {
      if (topForPairs[i].baseName === topForPairs[j].baseName) continue;
      evaluateCombo([topForPairs[i], topForPairs[j]]);
    }
  }

  scoredCombos.sort((a, b) => a._sortScore - b._sortScore);

  // Deduplica per alimenti base così le 3 opzioni sono diverse tra loro
  const uniqueSuggestions = [];
  const usedSignatures = new Set();

  for (const combo of scoredCombos) {
    const sig = combo.items.map(i => i.name.toLowerCase()).sort().join('|');
    if (usedSignatures.has(sig)) continue;
    usedSignatures.add(sig);
    const { _sortScore, ...cleanCombo } = combo;
    uniqueSuggestions.push(cleanCombo);
    if (uniqueSuggestions.length >= maxSuggestions) break;
  }

  return {
    model_version: DAY_CLOSER_VERSION,
    needed: uniqueSuggestions.length > 0,
    remKcal: Math.round(targetKcal),
    remProtein: Math.round(targetPro),
    remCarbs: Math.round(Math.max(0, Number(remCarbs) || 0)),
    remFats: Math.round(Math.max(0, Number(remFats) || 0)),
    suggestions: uniqueSuggestions
  };
}
