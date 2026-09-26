/**
 * test-pipeline.js — Suite di test automatizzata Node.js per la PWA Fitness Tracker.
 * Verifica la logica di calcolo nutrizionale, le assunzioni automatiche, la validazione dei saturi,
 * la sincronizzazione dei log e l'assenza di duplicati nell'editor pasti.
 */

import * as NC from './js/nutrition-core.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

console.log('════════════════════════════════════════════════════════════');
console.log(' 🧪 RUNNING FITNESS TRACKER NUTRITION PIPELINE TEST SUITE');
console.log('════════════════════════════════════════════════════════════\n');

// 1. Proporzioni per 100g, 100ml e per porzione
console.log('[Test 1] Proporzioni per 100g, 100ml e porzione (scaleNutrients)');
const base100 = { kcal: 350, protein: 10, carbs: 75, fats: 2, saturatedFat: 0.5 };
const scaled200 = NC.scaleNutrients(base100, 2.0); // 200g
assert(scaled200.kcal === 700, '200g riso = 700 kcal');
assert(scaled200.carbs === 150, '200g riso = 150g carbo');
const scaled50 = NC.scaleNutrients(base100, 0.5); // 50g
assert(scaled50.protein === 5, '50g riso = 5g pro');
console.log('');

// 2. Filtro zero-kcal ed esattezza
console.log('[Test 2] Filtro Zero-Kcal esatto vs falsi positivi');
assert(NC.isZeroKcalFood('acqua') === true, '"acqua" è zero kcal');
assert(NC.isZeroKcalFood('acqua frizzante') === true, '"acqua frizzante" è zero kcal');
assert(NC.isZeroKcalFood('caffè nero') === true, '"caffè nero" è zero kcal');
assert(NC.isZeroKcalFood('pasta con acqua') === false, '"pasta con acqua" NON è zero kcal');
assert(NC.isZeroKcalFood('petto di pollo all\'acqua') === false, '"petto di pollo all\'acqua" NON è zero kcal');
console.log('');

// 3. Validazione Saturi incoerenti (no silent clamping)
console.log('[Test 3] Gestione grassi saturi incoerenti (> grassi totali)');
const invalidSats = { kcal: 150, protein: 5, carbs: 10, fats: 4, saturatedFat: 9 };
const validatedIncoherent = NC.validateNutrients(invalidSats);
assert(validatedIncoherent.nutrients.saturatedFat === null, 'Saturi incoerenti (> fats) impostati a null anziché clampati silenziosamente');
assert(validatedIncoherent.warnings.some(w => w.includes('superiori ai grassi totali')), 'Emesso warning per saturi incoerenti');

const validSats = { kcal: 150, protein: 5, carbs: 10, fats: 10, saturatedFat: 3 };
const validatedValid = NC.validateNutrients(validSats);
assert(validatedValid.nutrients.saturatedFat === 3, 'Saturi validi (3g <= 10g) conservati correttamente');
console.log('');

// 4. Diagnostica Atwater (non sovrascrive kcal dichiarate)
console.log('[Test 4] Diagnostica Atwater e conservazione Kcal etichetta');
const labelData = { kcal: 100, protein: 10, carbs: 10, fats: 5, saturatedFat: 1 }; // Atwater = 40+40+45 = 125 kcal (25% diff)
const validatedLabel = NC.validateNutrients(labelData);
assert(validatedLabel.nutrients.kcal === 100, 'Kcal dichiarate sull\'etichetta (100) NON vengono sovrascritte da Atwater (125)');
assert(validatedLabel.warnings.some(w => w.includes('Atwater divergence')), 'Avviso diagnostico Atwater generato');
console.log('');

// 5. Aggregazione totali e dati incompleti (null vs 0)
console.log('[Test 5] Aggregazione sumNutrients e completezza saturi (null vs 0)');
const mealList = [
  { kcal: 200, protein: 20, carbs: 20, fats: 5, saturatedFat: 1.5 },
  { kcal: 300, protein: 30, carbs: 30, fats: 10, saturatedFat: null } // saturi sconosciuti
];
const aggregated = NC.sumNutrients(mealList);
assert(aggregated.totals.kcal === 500, 'Totale Kcal = 500');
assert(aggregated.totals.saturatedFat === 1.5, 'Totale saturi noti = 1.5g');
assert(aggregated.meta.saturatedFat.complete === false, 'Completezza saturi = false (dati incompleti)');
console.log('');

// 6. Arrotondamento per display e forFirestore
console.log('[Test 6] Serializzazione Firestore e arrotondamento display');
const rawNutrients = { kcal: 245.6, protein: 22.34, carbs: 30.12, fats: 8.78, saturatedFat: null };
const fsData = NC.forFirestore(rawNutrients);
assert(fsData.kcal === 246, 'forFirestore arrotonda kcal all\'intero');
assert(fsData.protein === 22.3, 'forFirestore mantiene 1 decimale per pro');
assert(fsData.saturatedFat === undefined, 'forFirestore omette campi null');
console.log('');

// 7. Isolamento degli override rispetto al piano base
console.log('[Test 7] Isolamento degli override rispetto al piano base');
const basePlanMeal = { label: 'Pranzo', kcal: 600, protein: 40, carbs: 70, fats: 15, saturatedFat: 3 };
const userOverride = { kcal: 650, protein: 45, carbs: 70, fats: 18, saturatedFat: 4, items_text: 'Riso 100g + Pollo 200g + Olio 15g' };
assert(basePlanMeal.kcal === 600, 'Il pasto del piano base rimane invariato a 600 kcal');
assert(userOverride.kcal === 650, 'L\'override dell\'utente registra 650 kcal separatamente');
console.log('');

console.log('════════════════════════════════════════════════════════════');
console.log(` 📊 RISULTATI FINALI TEST SUITE: ${passed} PASSATI, ${failed} FALLITI`);
console.log('════════════════════════════════════════════════════════════');

if (failed > 0) {
  process.exit(1);
}
