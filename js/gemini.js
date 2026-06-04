import { db, getUserId } from './firebase-config.js';
import { doc, getDoc } from './firebase-config.js';

let cachedKey = null;
let busy = false;

async function getKey() {
  if (cachedKey) return cachedKey;
  try {
    const s = await getDoc(doc(db, 'users', getUserId(), 'settings', 'gemini'));
    if (s.exists()) cachedKey = s.data().api_key;
  } catch(e) {}
  return cachedKey;
}

// ── Model list ──────────────────────────────────────────────
const MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash'
];

async function callGemini(key, prompt, opts = {}) {
  const { temperature = 0.7, maxOutputTokens = 1024, parts } = opts;
  const contentParts = parts || [{ text: prompt }];

  for (const model of MODELS) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: contentParts }],
            generationConfig: { temperature, maxOutputTokens }
          })
        }
      );
      if (r.status === 429) { console.warn(model, '429'); continue; }
      if (!r.ok) { console.warn(model, 'error', r.status); continue; }
      const d = await r.json();
      const text = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
      if (!text) continue;
      return { success: true, text: text.trim(), model };
    } catch(e) { console.warn(model, 'failed:', e.message); continue; }
  }
  return { success: false, error: 'Tutti i modelli occupati. Riprova tra 1 minuto.' };
}

// ── Validazione coerenza macro ↔ kcal ───────────────────────
function validateAndFixMacros(parsed) {
  let protein = Math.max(0, Number(parsed.protein) || 0);
  let carbs   = Math.max(0, Number(parsed.carbs)   || 0);
  let fats    = Math.max(0, Number(parsed.fats)    || 0);
  let items   = parsed.items || [];
  const declaredKcal = Math.max(0, Number(parsed.kcal) || 0);

  // 1. Cross-check items breakdown vs totali (se la somma items è più affidabile)
  if (items.length > 0) {
    const iSum = items.reduce((a, i) => ({
      kcal: a.kcal + (Number(i.kcal) || 0),
      protein: a.protein + (Number(i.protein) || 0),
      carbs: a.carbs + (Number(i.carbs) || 0),
      fats: a.fats + (Number(i.fats) || 0)
    }), { kcal: 0, protein: 0, carbs: 0, fats: 0 });

    if (iSum.kcal > 0 && Math.abs(iSum.kcal - declaredKcal) > declaredKcal * 0.15) {
      protein = Math.max(0, iSum.protein);
      carbs   = Math.max(0, iSum.carbs);
      fats    = Math.max(0, iSum.fats);
    }
  }

  // 2. Calcola kcal dalla formula canonica
  const computedKcal = (protein * 4) + (carbs * 4) + (fats * 9);

  // 3. Se differenza > 8%, usa il calcolato
  const diff = Math.abs(computedKcal - declaredKcal);
  const threshold = Math.max(declaredKcal, computedKcal, 1) * 0.08;
  const corrected = diff > threshold;
  const finalKcal = Math.round(corrected ? computedKcal : declaredKcal);

  return {
    kcal: finalKcal,
    protein: parseFloat(protein.toFixed(1)),
    carbs: parseFloat(carbs.toFixed(1)),
    fats: parseFloat(fats.toFixed(1)),
    items,
    _corrected: corrected
  };
}

// ── Tabella riferimenti nutrizionali (per 100g) ─────────────
const REFERENCE_TABLE = `Valori nutrizionali di riferimento per 100g di prodotto (CRUDO se non diversamente specificato):
   CEREALI E PANE:
   - Pasta (cruda): ~350 kcal, 75g Carb, 10g Pro, 1g Fat → COTTA: ~130 kcal, 26g Carb, 5g Pro, 0.5g Fat
   - Riso (crudo): ~350 kcal, 78g Carb, 7g Pro, 1g Fat → COTTO: ~130 kcal, 28g Carb, 3g Pro, 0.3g Fat
   - Riso Basmati (crudo): ~350 kcal, 78g Carb, 8g Pro, 1g Fat
   - Pane comune: ~260 kcal, 55g Carb, 8g Pro, 1g Fat
   - Avena/Fiocchi d'avena: ~370 kcal, 60g Carb, 13g Pro, 7g Fat
   - Fette biscottate: ~410 kcal, 75g Carb, 11g Pro, 7g Fat
   PROTEINE ANIMALI:
   - Petto di Pollo/Tacchino (crudo): ~110 kcal, 0g Carb, 23g Pro, 2g Fat → COTTO: ~165 kcal, 0g Carb, 31g Pro, 4g Fat
   - Manzo magro (crudo): ~140 kcal, 0g Carb, 22g Pro, 5g Fat → COTTO: ~175 kcal, 0g Carb, 26g Pro, 7g Fat
   - Salmone (fresco, crudo): ~180 kcal, 0g Carb, 20g Pro, 11g Fat
   - Tonno in scatola (sgocciolato): ~110 kcal, 0g Carb, 25g Pro, 1g Fat
   - Uovo intero (~60g): ~65 kcal → per 100g: ~155 kcal, 1g Carb, 13g Pro, 11g Fat
   - Albume d'uovo: ~50 kcal, 1g Carb, 11g Pro, 0g Fat
   LATTICINI:
   - Latte intero: ~65 kcal, 5g Carb, 3g Pro, 4g Fat
   - Yogurt greco 0%: ~55 kcal, 4g Carb, 10g Pro, 0g Fat
   - Yogurt greco intero: ~95 kcal, 4g Carb, 9g Pro, 5g Fat
   - Ricotta vaccina: ~140 kcal, 3g Carb, 11g Pro, 10g Fat
   - Mozzarella: ~250 kcal, 1g Carb, 18g Pro, 19g Fat
   - Parmigiano: ~390 kcal, 0g Carb, 33g Pro, 28g Fat
   GRASSI E FRUTTA SECCA:
   - Olio Extravergine: ~880 kcal, 0g Carb, 0g Pro, 100g Fat
   - Burro: ~715 kcal, 0g Carb, 1g Pro, 81g Fat
   - Noci/Mandorle/Nocciole: ~610 kcal, 12g Carb, 20g Pro, 52g Fat
   - Burro d'arachidi: ~590 kcal, 22g Carb, 25g Pro, 50g Fat
   FRUTTA E VERDURA:
   - Banana: ~90 kcal, 23g Carb, 1g Pro, 0g Fat
   - Mela/Pera: ~52 kcal, 14g Carb, 0g Pro, 0g Fat
   - Verdure miste (zucchine, broccoli, spinaci): ~25 kcal, 3g Carb, 2g Pro, 0g Fat
   - Patate (crude): ~77 kcal, 17g Carb, 2g Pro, 0g Fat → COTTE/bollite: ~85 kcal, 20g Carb, 2g Pro, 0g Fat
   LEGUMI:
   - Ceci (secchi/crudi): ~330 kcal, 50g Carb, 20g Pro, 6g Fat → COTTI: ~120 kcal, 20g Carb, 8g Pro, 2g Fat
   - Lenticchie (secche/crude): ~290 kcal, 46g Carb, 24g Pro, 2g Fat → COTTE: ~120 kcal, 20g Carb, 8g Pro, 2g Fat
   - Fagioli (secchi/crudi): ~280 kcal, 45g Carb, 22g Pro, 2g Fat → COTTI: ~100 kcal, 17g Carb, 7g Pro, 1g Fat`;

const COOKING_RULE = `REGOLA COTTURA (FONDAMENTALE):
DEFAULT = CRUDO. Se l'utente scrive una quantità in grammi SENZA specificare "cotto/bollito/lessato/al vapore", usa SEMPRE i valori del prodotto CRUDO.
Usa i valori COTTO solo quando l'utente ESPLICITAMENTE scrive: "cotto", "bollito", "lessato", "al vapore", "grigliato" o "già cotto".
Esempi: "80g riso" = CRUDO. "80g riso bollito" = COTTO. "150g pollo" = CRUDO. "150g pollo grigliato" = COTTO.`;

// ── Food Library Cache ──────────────────────────────────────
let _foodLibCache = null;
let _foodLibLoaded = false;

async function loadFoodLibrary() {
  if (_foodLibLoaded && _foodLibCache) return _foodLibCache;
  try {
    const { getDocs, collection } = await import('./firebase-config.js');
    const snap = await getDocs(collection(db, 'users', getUserId(), 'food_library'));
    _foodLibCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _foodLibLoaded = true;
  } catch(e) {
    console.warn('loadFoodLibrary error:', e.message);
    _foodLibCache = [];
    _foodLibLoaded = true;
  }
  return _foodLibCache;
}

async function saveToFoodLibrary(name, per100g) {
  try {
    const { setDoc } = await import('./firebase-config.js');
    const id = name.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_àèéìòù]/g,'');
    if (!id) return;
    await setDoc(doc(db, 'users', getUserId(), 'food_library', id), {
      name,
      kcal_per_100g: Math.round(per100g.kcal),
      protein_per_100g: parseFloat((per100g.protein || 0).toFixed(1)),
      carbs_per_100g: parseFloat((per100g.carbs || 0).toFixed(1)),
      fats_per_100g: parseFloat((per100g.fats || 0).toFixed(1)),
      last_used: new Date().toISOString().split('T')[0],
      source: 'ai_auto'
    }, { merge: true });
    // Invalidate cache
    _foodLibLoaded = false;
  } catch(e) {
    console.warn('saveToFoodLibrary error:', e.message);
  }
}

// ── AI Corrections System ───────────────────────────────────
let _correctionsCache = null;
let _correctionsLoaded = false;

async function loadCorrections() {
  if (_correctionsLoaded && _correctionsCache) return _correctionsCache;
  try {
    const { getDocs, collection } = await import('./firebase-config.js');
    const snap = await getDocs(collection(db, 'users', getUserId(), 'ai_corrections'));
    _correctionsCache = {};
    snap.docs.forEach(d => {
      const data = d.data();
      if (data.count >= 2) _correctionsCache[d.id] = data;
    });
    _correctionsLoaded = true;
  } catch(e) {
    _correctionsCache = {};
    _correctionsLoaded = true;
  }
  return _correctionsCache;
}

export async function saveAICorrection(foodName, aiValues, userValues) {
  if (!foodName || !aiValues || !userValues) return;
  const normalized = foodName.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_àèéìòù]/g,'');
  if (!normalized) return;
  try {
    const { setDoc } = await import('./firebase-config.js');
    const ref = doc(db, 'users', getUserId(), 'ai_corrections', normalized);
    const existing = await getDoc(ref);
    const prev = existing.exists() ? existing.data() : { food_name: foodName, corrections: [], count: 0 };

    prev.corrections.push({
      date: new Date().toISOString().split('T')[0],
      ai: { kcal: aiValues.kcal, protein: aiValues.protein, carbs: aiValues.carbs, fats: aiValues.fats },
      user: { kcal: userValues.kcal, protein: userValues.protein, carbs: userValues.carbs, fats: userValues.fats }
    });
    // Keep last 10 corrections max
    if (prev.corrections.length > 10) prev.corrections = prev.corrections.slice(-10);
    prev.count = prev.corrections.length;

    // Calculate average delta
    const deltas = prev.corrections.map(c => ({
      kcal: c.ai.kcal > 0 ? ((c.user.kcal - c.ai.kcal) / c.ai.kcal) * 100 : 0,
      protein: c.ai.protein > 0 ? ((c.user.protein - c.ai.protein) / c.ai.protein) * 100 : 0
    }));
    prev.avg_delta = {
      kcal_pct: Math.round(deltas.reduce((s, d) => s + d.kcal, 0) / deltas.length),
      protein_pct: Math.round(deltas.reduce((s, d) => s + d.protein, 0) / deltas.length)
    };

    await setDoc(ref, prev, { merge: false });
    _correctionsLoaded = false; // invalidate cache

    // Auto-correct food library if user consistently corrects same food (count >= 3)
    if (prev.count >= 3 && userValues.kcal > 0) {
      // Assume last user correction has the most accurate per-item info
      // We need grams to calculate per-100g; if unavailable, skip
      const lastCorrection = prev.corrections[prev.corrections.length - 1];
      if (lastCorrection?.user?.kcal > 0) {
        // Try to find this food in library and update its values
        const lib = await loadFoodLibrary();
        const match = lib.find(f => f.name.toLowerCase().includes(foodName.toLowerCase()) ||
                                    foodName.toLowerCase().includes(f.name.toLowerCase()));
        if (match && match.source === 'ai_auto') {
          // Apply average correction to library values
          const corrFactor = 1 + (prev.avg_delta.kcal_pct / 100);
          await saveToFoodLibrary(match.name, {
            kcal: match.kcal_per_100g * corrFactor,
            protein: match.protein_per_100g * (1 + (prev.avg_delta.protein_pct / 100)),
            carbs: match.carbs_per_100g,
            fats: match.fats_per_100g
          });
        }
      }
    }
  } catch(e) {
    console.warn('saveAICorrection error:', e.message);
  }
}

// ── Input Parser & Food Library Matching ────────────────────
function parseStructuredInput(text) {
  // Match patterns: "150g pollo", "pollo 150g", "150 g riso", "2 uova", "1 cucchiaio olio"
  const patterns = [
    /(\d+(?:[.,]\d+)?)\s*g\s+(?:di\s+)?([a-zàèéìòùA-Z\s]+?)(?=[,;\n]|$)/gi,
    /([a-zàèéìòùA-Z\s]+?)\s+(\d+(?:[.,]\d+)?)\s*g(?=[,;\n]|$)/gi,
  ];

  const items = [];
  const seen = new Set();

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      let qty, name;
      if (/^\d/.test(match[1])) {
        qty = parseFloat(match[1].replace(',', '.'));
        name = match[2].trim();
      } else {
        name = match[1].trim();
        qty = parseFloat(match[2].replace(',', '.'));
      }
      if (qty > 0 && name.length > 1 && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        items.push({ qty, name: name.trim() });
      }
    }
  }

  return items;
}

function normalize(str) {
  return str.toLowerCase()
    .replace(/[àá]/g, 'a').replace(/[èé]/g, 'e')
    .replace(/[ìí]/g, 'i').replace(/[òó]/g, 'o').replace(/[ùú]/g, 'u')
    .replace(/[^a-z0-9\s]/g, '').trim();
}

function fuzzyMatch(inputName, library) {
  const norm = normalize(inputName);
  const words = norm.split(/\s+/);

  // Exact name match
  let best = library.find(f => normalize(f.name) === norm);
  if (best) return best;

  // All input words contained in library name (or vice versa)
  best = library.find(f => {
    const fn = normalize(f.name);
    return words.every(w => fn.includes(w)) || fn.split(/\s+/).every(w => norm.includes(w));
  });
  if (best) return best;

  // Primary word match (first word of input in library name)
  if (words[0]?.length >= 3) {
    best = library.find(f => normalize(f.name).includes(words[0]));
    if (best) return best;
  }

  return null;
}

function calcDeterministic(parsedItems, library) {
  const results = [];
  const unmatched = [];

  for (const item of parsedItems) {
    const match = fuzzyMatch(item.name, library);
    if (match && match.kcal_per_100g > 0) {
      const factor = item.qty / 100;
      results.push({
        name: `${match.name} (${item.qty}g)`,
        grams: item.qty,
        kcal: Math.round(match.kcal_per_100g * factor),
        protein: parseFloat((match.protein_per_100g * factor).toFixed(1)),
        carbs: parseFloat((match.carbs_per_100g * factor).toFixed(1)),
        fats: parseFloat((match.fats_per_100g * factor).toFixed(1)),
        _source: 'library',
        _libraryName: match.name
      });
    } else {
      unmatched.push(item);
    }
  }

  return { matched: results, unmatched };
}

// ── Double-pass AI verification ─────────────────────────────
async function verifyMacrosAI(items, key) {
  if (!items || items.length < 2) return null;
  const totalKcal = items.reduce((s, i) => s + (Number(i.kcal) || 0), 0);
  if (totalKcal < 300) return null;

  const itemsText = items.map(i =>
    `- ${i.name}: ${i.grams}g → ${i.kcal} kcal, P:${i.protein}g, C:${i.carbs}g, F:${i.fats}g`
  ).join('\n');

  const prompt = `Verifica RAPIDAMENTE questi valori nutrizionali. Per ogni ingrediente, controlla che i valori per-100g siano plausibili.
${COOKING_RULE}

${itemsText}

Se trovi errori evidenti (>15% di scostamento dai valori reali), correggi SOLO quelli e ricalcola il totale.
Se tutto è corretto, rispondi con lo stesso JSON invariato.
Rispondi SOLO con un JSON valido (includi SEMPRE il campo grams per ogni item):
{"kcal":0,"protein":0,"carbs":0,"fats":0,"items":[{"name":"...","grams":0,"kcal":0,"protein":0,"carbs":0,"fats":0}]}`;

  try {
    const res = await callGemini(key, prompt, { temperature: 0.05, maxOutputTokens: 768 });
    if (!res.success) return null;
    const raw = res.text;
    const s1 = raw.indexOf('{');
    const s2 = raw.lastIndexOf('}');
    if (s1 === -1 || s2 === -1) return null;
    return JSON.parse(raw.slice(s1, s2 + 1));
  } catch(e) {
    return null;
  }
}

// ── Calcola macros da testo (ibrido: deterministico + AI) ───
export async function calcMacrosFromText(text) {
  if (busy) return { success: false, error: 'Calcolo in corso...' };
  busy = true;
  try {
    const key = await getKey();
    if (!key) return { success: false, error: 'API key mancante.' };

    // 1. Load food library and corrections
    const [library, corrections] = await Promise.all([
      loadFoodLibrary(),
      loadCorrections()
    ]);

    // 2. Parse structured input
    const parsedItems = parseStructuredInput(text);
    const { matched, unmatched } = parsedItems.length > 0
      ? calcDeterministic(parsedItems, library)
      : { matched: [], unmatched: [] };

    // 3. Build correction hints for the prompt
    let correctionHints = '';
    if (Object.keys(corrections).length > 0) {
      const relevantCorrs = [];
      for (const [foodId, data] of Object.entries(corrections)) {
        if (text.toLowerCase().includes(data.food_name?.toLowerCase())) {
          relevantCorrs.push(`- "${data.food_name}": l'utente ha corretto le stime AI in media di ${data.avg_delta.kcal_pct > 0 ? '+' : ''}${data.avg_delta.kcal_pct}% sulle kcal e ${data.avg_delta.protein_pct > 0 ? '+' : ''}${data.avg_delta.protein_pct}% sulle proteine. Adatta le tue stime di conseguenza.`);
        }
      }
      if (relevantCorrs.length > 0) {
        correctionHints = `\nCORREZIONI UTENTE PRECEDENTI (tieni conto!):\n${relevantCorrs.join('\n')}`;
      }
    }

    // 4. Build library hints for the prompt
    let libraryHints = '';
    if (matched.length > 0) {
      libraryHints = `\nVALORI VERIFICATI dalla food library dell'utente (usa QUESTI come riferimento prioritario, sono più precisi):\n` +
        matched.map(m => `- ${m.name}: ${m.kcal} kcal, P:${m.protein}g, C:${m.carbs}g, F:${m.fats}g (calcolato da ${m._libraryName}: ${library.find(f => f.name === m._libraryName)?.kcal_per_100g} kcal/100g)`).join('\n');
    }

    // 5. Call AI — always, with library hints as anchors
    const prompt = `Analizza la seguente descrizione di un pasto e stima accuratamente i macronutrienti.
Pasto: "${text}"

Regole fondamentali e VINCOLANTI:
1. kcal = (Proteine * 4) + (Carboidrati * 4) + (Grassi * 9). PRIMA calcola i macro, POI le kcal dalla formula.
2. ${COOKING_RULE}
3. Porzioni standard se non specificate: piatto di pasta = 80g crudo, petto di pollo = 150g crudo, 1 cucchiaio d'olio = 10g, uovo medio = 60g, 1 frutto = 150g, bicchiere di latte = 200ml.
4. ${REFERENCE_TABLE}
5. SANITY CHECK: ingrediente < 200g NON può avere > 900 kcal (eccezione: olio/burro/frutta secca). Proteine/100g mai > 35g (eccezione: whey).
6. Output SOLO JSON valido, no markdown.
${libraryHints}${correctionHints}

JSON richiesto:
{
  "kcal": 0, "protein": 0, "carbs": 0, "fats": 0,
  "items": [{ "name": "Alimento (XXXg)", "grams": 0, "kcal": 0, "protein": 0, "carbs": 0, "fats": 0 }]
}`;

    const res = await callGemini(key, prompt, { temperature: 0.1, maxOutputTokens: 1024 });
    if (!res.success) return { success: false, error: res.error };

    const raw = res.text;
    const s1 = raw.indexOf('{');
    const s2 = raw.lastIndexOf('}');
    if (s1 === -1 || s2 === -1) return { success: false, error: 'Risposta AI non valida.' };

    let parsed = JSON.parse(raw.slice(s1, s2 + 1));

    // 6. If library had matches, prefer library values for those items
    if (matched.length > 0 && parsed.items?.length > 0) {
      for (const libItem of matched) {
        // Find corresponding AI item and replace with library-calculated values
        const aiItem = parsed.items.find(ai => {
          const aiNorm = normalize(ai.name || '');
          const libNorm = normalize(libItem._libraryName || '');
          return aiNorm.includes(libNorm) || libNorm.split(/\s+/).some(w => w.length >= 3 && aiNorm.includes(w));
        });
        if (aiItem) {
          aiItem.kcal = libItem.kcal;
          aiItem.protein = libItem.protein;
          aiItem.carbs = libItem.carbs;
          aiItem.fats = libItem.fats;
          aiItem.grams = libItem.grams;
          aiItem._source = 'library';
        }
      }
      // Recalc totals from items
      const totals = parsed.items.reduce((a, i) => ({
        kcal: a.kcal + (Number(i.kcal) || 0),
        protein: a.protein + (Number(i.protein) || 0),
        carbs: a.carbs + (Number(i.carbs) || 0),
        fats: a.fats + (Number(i.fats) || 0)
      }), { kcal: 0, protein: 0, carbs: 0, fats: 0 });
      parsed.kcal = totals.kcal;
      parsed.protein = totals.protein;
      parsed.carbs = totals.carbs;
      parsed.fats = totals.fats;
    }

    // 7. Double-pass verification for complex meals
    if (parsed.items?.length >= 2 && (parsed.kcal || 0) > 300) {
      const verified = await verifyMacrosAI(parsed.items, key);
      if (verified) {
        // Merge: keep library items untouched, use verified for AI-only items
        if (verified.items?.length > 0) {
          for (let i = 0; i < verified.items.length; i++) {
            const origItem = parsed.items[i];
            if (origItem?._source === 'library') continue; // don't override library
            if (verified.items[i]) {
              // Preserve grams and _source from original if verified doesn't have them
              parsed.items[i] = {
                grams: origItem?.grams,
                _source: origItem?._source,
                ...verified.items[i]
              };
            }
          }
          // Recalc totals
          const vTotals = parsed.items.reduce((a, it) => ({
            kcal: a.kcal + (Number(it.kcal) || 0),
            protein: a.protein + (Number(it.protein) || 0),
            carbs: a.carbs + (Number(it.carbs) || 0),
            fats: a.fats + (Number(it.fats) || 0)
          }), { kcal: 0, protein: 0, carbs: 0, fats: 0 });
          parsed.kcal = vTotals.kcal;
          parsed.protein = vTotals.protein;
          parsed.carbs = vTotals.carbs;
          parsed.fats = vTotals.fats;
        }
      }
    }

    // 8. Final validation
    const validated = validateAndFixMacros(parsed);

    // 9. Auto-save new foods to library (fire-and-forget)
    if (parsed.items?.length > 0) {
      for (const item of parsed.items) {
        if (item._source === 'library') continue; // already in library
        const grams = Number(item.grams) || 0;
        if (grams >= 10 && (Number(item.kcal) || 0) > 0) {
          const per100g = {
            kcal: (item.kcal / grams) * 100,
            protein: (item.protein / grams) * 100,
            carbs: (item.carbs / grams) * 100,
            fats: (item.fats / grams) * 100
          };
          // Clean the name (remove grams info)
          const cleanName = (item.name || '').replace(/\s*\(\d+g?\)/g, '').replace(/\d+g\s*/g, '').trim();
          if (cleanName.length >= 2) {
            saveToFoodLibrary(cleanName, per100g); // fire-and-forget
          }
        }
      }
    }

    return {
      success: true,
      ...validated
    };
  } catch(e) {
    console.error('calcMacrosFromText error:', e);
    return { success: false, error: 'Errore parsing risposta AI.' };
  } finally {
    busy = false;
  }
}

// ── Analizza progressione check ─────────────────────────────
export async function analyzeCheckProgress({ prevCheck, newCheck }) {
  const key = await getKey();
  if (!key) return { success: false, error: 'API key mancante' };

  const getMs = (ms, key) => {
    if (ms[key] != null) return ms[key];
    if (key === 'bicep') { const v = [ms.bicep_l, ms.bicep_r].filter(x => x != null); return v.length ? v.reduce((a,b)=>a+b)/v.length : null; }
    if (key === 'thigh') { const v = [ms.thigh_l, ms.thigh_r].filter(x => x != null); return v.length ? v.reduce((a,b)=>a+b)/v.length : null; }
    return null;
  };

  const fmtMeasures = (check) => {
    const ms = check.measurements || {};
    const parts = [];
    if (check.weight) parts.push(`Peso: ${check.weight}kg`);
    if (ms.shoulders) parts.push(`Spalle: ${ms.shoulders}cm`);
    if (ms.chest) parts.push(`Petto: ${ms.chest}cm`);
    if (ms.waist) parts.push(`Vita: ${ms.waist}cm`);
    const arm = getMs(ms, 'bicep'); if (arm != null) parts.push(`Braccia: ${arm.toFixed(1)}cm`);
    const leg = getMs(ms, 'thigh'); if (leg != null) parts.push(`Gambe: ${leg.toFixed(1)}cm`);
    return parts.join(', ') || 'nessuna misura';
  };

  let promptText = `Sei un coach personale esperto. Analizza la progressione corporea in italiano, sii diretto e motivante.`;
  if (prevCheck) {
    promptText += `\n\nCheck PRECEDENTE (${prevCheck.date}): ${fmtMeasures(prevCheck)}`;
  }
  promptText += `\n\nCheck ATTUALE (${newCheck.date}): ${fmtMeasures(newCheck)}`;
  promptText += `\n\nRispondi in max 120 parole con: 1) cosa è migliorato 2) cosa tenere d'occhio 3) un consiglio concreto. Usa un tono positivo e professionale.`;

  const parts = [{ text: promptText }];

  if (newCheck.photos?.length) {
    for (const photo of newCheck.photos.slice(0, 3)) {
      const u = typeof photo === 'string' ? photo : photo?.url;
      const v = typeof photo === 'object' ? photo?.view : null;
      if (!u) continue;
      try {
        const resp = await fetch(u);
        if (resp.ok) {
          const blob = await resp.blob();
          const base64 = await new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.readAsDataURL(blob);
          });
          if (v) parts.push({ text: `[Foto: ${v}]` });
          parts.push({ inlineData: { mimeType: blob.type || 'image/jpeg', data: base64 } });
        }
      } catch(e) { console.warn('Photo fetch for AI failed:', e); }
    }
  }

  const res = await callGemini(key, null, { temperature: 0.7, maxOutputTokens: 512, parts });
  if (!res.success) return { success: false, error: 'Analisi non disponibile' };
  return { success: true, analysis: res.text };
}

// ── Report settimanale AI (con dati ricchi per giorno) ──────
export async function generateWeeklyCoachReportAI(data) {
  const key = await getKey();
  if (!key) return { success: false, error: 'API key mancante.' };

  // Costruisci il breakdown giornaliero
  const dayBreakdownText = (data.dailyBreakdown || []).map(d => {
    const parts = [`  ${d.date} (${d.dayLabel})`];
    if (d.kcal > 0) parts.push(`    Kcal: ${d.kcal}${d.kcalTarget > 0 ? ` / ${d.kcalTarget} target (${Math.round(d.kcal/d.kcalTarget*100)}%)` : ''}`);
    if (d.protein > 0) parts.push(`    Proteine: ${d.protein}g${d.proteinTarget > 0 ? ` / ${d.proteinTarget}g target` : ''}`);
    if (d.isTraining !== null) parts.push(`    Allenamento: ${d.workoutDone ? `✅ ${d.workoutName || 'Completato'}` : (d.isTraining ? '❌ Saltato' : '😴 Riposo')}`);
    if (d.steps > 0) parts.push(`    Passi: ${d.steps.toLocaleString('it-IT')}`);
    if (d.note) parts.push(`    Nota: "${d.note}"`);
    return parts.join('\n');
  }).join('\n');

  const promptText = `Sei l'AI Weekly Coach dell'app di fitness KOVA. Analizza i dati degli ultimi 7 giorni dell'utente e genera un report di feedback settimanale in italiano.
Sii estremamente professionale, motivante e orientato al risultato, rispecchiando i valori di eccellenza di KOVA.

PROFILO UTENTE:
- Nome: ${data.userName || 'Atleta'}
- Obiettivo peso: ${data.weightTarget ? data.weightTarget + ' kg' : 'Non specificato'}
- Peso attuale: ${data.currentWeight ? data.currentWeight + ' kg' : 'Non misurato di recente'}
- Scheda attiva: ${data.programName || 'Nessuna'}
- Piano dieta: ${data.dietName || 'Nessuno'}

DATI SETTIMANALI AGGREGATI:
- Aderenza calorica media: ${data.avgCalorieAdherence}%
- Calorie consumate medie: ${data.avgCalories} kcal / giorno (vs target ${data.targetCalories} kcal)
- Proteine medie: ${data.avgProtein}g / giorno (target: ${data.targetProtein || '?'}g)
- Carboidrati medi: ${data.avgCarbs}g / giorno
- Grassi medi: ${data.avgFats}g / giorno
- Passi totali settimanali: ${data.totalSteps} (media giornaliera: ${data.avgSteps})
- Sessioni completate: ${data.completedWorkouts} su ${data.totalWorkoutsPlanned} pianificate
- Giorni con dati loggati: ${data.loggedDays} su 7
- Smart Score Settimanale: ${data.weeklyScore}/100

BREAKDOWN GIORNALIERO DETTAGLIATO:
${dayBreakdownText || '  (nessun dato)'}

Struttura il report con le seguenti sezioni in markdown italiano pulito (usa emoji adatte):
1. **Analisi della Settimana**: Una panoramica critica del comportamento nutrizionale e motorio. Fai riferimento ai giorni specifici dove utile.
2. **I Tuoi Punti di Forza**: Cosa ha funzionato davvero bene (es. costanza, aderenza macro, passi).
3. **Aree di Miglioramento**: Cosa tenere d'occhio per ottimizzare la composizione corporea e le performance. Sii specifico con i numeri.
4. **Action Plan per la Prossima Settimana**: 2-3 indicazioni ultra-pratiche e numeriche su cui focalizzarsi.

Mantieni il report compatto ed efficace (circa 220-280 parole). Non aggiungere note esterne, rispondi solo in markdown.`;

  const res = await callGemini(key, promptText, { temperature: 0.7, maxOutputTokens: 1200 });
  if (!res.success) return { success: false, error: 'AI weekly report non disponibile al momento. Riprova più tardi.' };
  return { success: true, report: res.text };
}

// ── Analisi immagine cibo ───────────────────────────────────
export async function analyzeFoodImageAI(base64Image, mimeType = 'image/jpeg') {
  const key = await getKey();
  if (!key) return { success: false, error: 'API key mancante.' };

  const promptText = `Analizza l'immagine di questo cibo e stima accuratamente i macronutrienti (Proteine, Carboidrati, Grassi) e le Calorie (kcal).
Identifica ogni ingrediente visibile, stima le quantità in grammi e calcola i macro per ciascuno.

Regole fondamentali e VINCOLANTI:
1. kcal = (Proteine * 4) + (Carboidrati * 4) + (Grassi * 9). PRIMA calcola i macro di ogni ingrediente, POI somma, POI calcola le kcal dalla formula.
2. Stima le porzioni in modo realistico basandoti sulle dimensioni visive del piatto/contenitore.
3. IMPORTANTE: il cibo visibile in foto è COTTO/preparato. Usa i valori nutrizionali per il prodotto COTTO (pasta cotta, riso cotto, pollo cotto, ecc.), NON i valori a crudo.
4. ${REFERENCE_TABLE}
5. SANITY CHECK: ingrediente < 200g NON può avere > 900 kcal (eccezione: olio/burro/frutta secca). Proteine/100g mai > 35g.
6. Rispondi esclusivamente con un oggetto JSON valido, no markdown.

Struttura JSON richiesta:
{
  "name": "Nome sintetico del piatto",
  "kcal": 0, "protein": 0, "carbs": 0, "fats": 0,
  "ingredients": "150g riso cotto, 100g salmone grigliato, 1 cucchiaio olio EVO",
  "items": [{ "name": "Riso cotto (150g)", "grams": 150, "kcal": 195, "protein": 4, "carbs": 43, "fats": 0.5 }]
}`;

  const parts = [
    { text: promptText },
    { inlineData: { mimeType, data: base64Image } }
  ];

  const res = await callGemini(key, null, { temperature: 0.1, maxOutputTokens: 768, parts });
  if (!res.success) return { success: false, error: 'Errore analisi immagine food scanner' };

  const raw = res.text;
  const s1 = raw.indexOf('{');
  const s2 = raw.lastIndexOf('}');
  if (s1 === -1 || s2 === -1) return { success: false, error: 'Risposta AI non valida.' };

  try {
    const parsed = JSON.parse(raw.slice(s1, s2 + 1));
    const validated = validateAndFixMacros(parsed);

    // Auto-save scanned items to food library (fire-and-forget)
    if (parsed.items?.length > 0) {
      for (const item of parsed.items) {
        const grams = Number(item.grams) || 0;
        if (grams >= 10 && (Number(item.kcal) || 0) > 0) {
          const per100g = {
            kcal: (item.kcal / grams) * 100,
            protein: ((item.protein || 0) / grams) * 100,
            carbs: ((item.carbs || 0) / grams) * 100,
            fats: ((item.fats || 0) / grams) * 100
          };
          const cleanName = (item.name || '').replace(/\s*\(\d+g?\)/g, '').replace(/\d+g\s*/g, '').trim();
          if (cleanName.length >= 2) {
            saveToFoodLibrary(cleanName, per100g);
          }
        }
      }
    }

    return {
      success: true,
      name: parsed.name || 'Pasto Scansionato',
      kcal: validated.kcal,
      protein: validated.protein,
      carbs: validated.carbs,
      fats: validated.fats,
      ingredients: parsed.ingredients || ''
    };
  } catch(e) {
    return { success: false, error: 'Errore parsing risposta AI.' };
  }
}

// ── Smart Advisor (per parte del giorno, passi solo sera) ───
export async function generateSmartAdviceAI({ profile, currentWeight, activeDiet, activeProgram, dailyState, partOfDay }) {
  const key = await getKey();
  if (!key) return { success: false, error: 'API key mancante.' };

  const p = profile || {};
  const sexStr = p.sex === 'M' ? 'Uomo' : (p.sex === 'F' ? 'Donna' : '');
  let age = '';
  if (p.dob) {
    const dob = new Date(p.dob);
    const now = new Date();
    age = now.getFullYear() - dob.getFullYear();
    const m = now.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  }

  const dietTargetKcal = dailyState.isTrainingDay ? activeDiet?.day_on?.kcal : activeDiet?.day_off?.kcal;
  const dietTargetPro = dailyState.isTrainingDay ? activeDiet?.day_on?.protein : activeDiet?.day_off?.protein;

  // Solo la sera include i passi
  const includeSteps = partOfDay === 'sera';

  // Dati comuni
  const baseContext = `Sei KOVA Smart Advisor, un assistente AI d'élite integrato in una app di fitness premium.
Il tuo compito è generare un consiglio ultra-personalizzato, breve e motivante in italiano per guidare l'utente nel momento attuale della giornata: ${partOfDay.toUpperCase()}.

Dati utente:
- Profilo: ${p.name || 'Utente'} (${sexStr ? sexStr + ', ' : ''}${age ? age + ' anni, ' : ''}${p.height ? p.height + 'cm' : ''})
- Peso attuale: ${currentWeight ? currentWeight + ' kg' : 'Non registrato'} (Target: ${p.weight_target || '?'} kg)
- Dieta attiva: ${activeDiet ? activeDiet.name + ' (Target: ' + (dietTargetKcal || '?') + ' kcal, Pro: ' + (dietTargetPro || '?') + 'g)' : 'Nessuna'}
- Scheda attiva: ${activeProgram ? activeProgram.name : 'Nessuna'}
- Giorno di oggi: ${dailyState.isTrainingDay ? 'Allenamento (ON)' : 'Riposo (OFF)'}
${dailyState.weeklyScore != null ? `- SmartScore settimanale: ${dailyState.weeklyScore}/100` : ''}

Stato odierno (fino ad ora):
- Calorie consumate: ${dailyState.kcal || 0} kcal ${dietTargetKcal ? '/ ' + dietTargetKcal + ' target' : ''}
- Macro: P:${dailyState.protein || 0}g${dietTargetPro ? ' / ' + dietTargetPro + 'g target' : ''}, C:${dailyState.carbs || 0}g, F:${dailyState.fats || 0}g
- Pasti: ${dailyState.eatenMealsStr || 'Nessuno'}
${dailyState.workoutDone ? '- Allenamento: ✅ COMPLETATO' : (dailyState.isTrainingDay ? '- Allenamento: ❌ Non ancora completato' : '')}
${includeSteps ? `- Passi: ${dailyState.steps || 0} / ${p.steps_goal || 10000} obiettivo` : ''}`;

  let specificInstructions = '';
  if (partOfDay === 'mattina') {
    specificInstructions = `È mattina presto. Motiva l'utente per la giornata, ricordagli il tipo di giorno (allenamento o riposo) e cosa mangiare per iniziare bene. NON menzionare i passi. Focusizza su: piano alimentare della mattina, allenamento se previsto oggi, carica di energia.`;
  } else if (partOfDay === 'pomeriggio') {
    specificInstructions = `È pomeriggio. Valuta i pasti fatti finora vs il piano, dai indicazioni su cosa ancora mangiare, ricordagli dell'allenamento se non fatto. NON menzionare i passi. Sii preciso sui macro/kcal mancanti se rilevante.`;
  } else {
    specificInstructions = `È sera. Valuta l'intera giornata: kcal totali, proteine, passi e allenamento. Dai feedback precisi e numerici su come è andata, cosa recuperare domani se qualcosa è mancato.`;
  }

  const promptText = `${baseContext}

Momento: ${partOfDay.toUpperCase()}
${specificInstructions}

Regole fondamentali per la risposta:
1. Sii estremamente diretto, pratico, motivante e conciso (massimo 45-55 parole).
2. No introduzioni inutili ("Certo!", "Ecco il consiglio" ecc.), parti subito col contenuto.
3. Usa numeri precisi quando disponibili (es. "ti mancano 48g di proteine").
4. Tono premium, d'élite, tecnico ed incoraggiante.
5. Usa grassetti **così** ed emoji adatte. No markdown elaborato.`;

  const res = await callGemini(key, promptText, { temperature: 0.75, maxOutputTokens: 256 });
  if (!res.success) return { success: false, error: 'AI occupata. Usa fallback locale.' };
  return { success: true, advice: res.text };
}

// ── Chat with Coach (multi-turno) ───────────────────────────
export async function chatWithCoach(messages, userContext) {
  const key = await getKey();
  if (!key) return { success: false, error: 'API key mancante. Configurala nelle Impostazioni.' };

  const systemPrompt = `Sei KOVA Coach, l'assistente AI personale integrato nell'app di fitness KOVA.
Sei un coach d'élite, esperto di nutrizione sportiva, allenamento e composizione corporea.
Rispondi sempre in italiano, con tono professionale ma diretto e motivante.
Hai accesso completo al profilo e ai dati dell'atleta — usali per dare consigli ultra-personalizzati.
Rispondi in modo conciso ma completo. Usa emoji con moderazione. Puoi usare grassetti **parola** per enfasi.

PROFILO ATLETA:
${userContext || 'Dati non disponibili in questo momento.'}`;

  // Costruisci i turns della conversazione
  const contents = [
    { role: 'user', parts: [{ text: systemPrompt + '\n\n---\nINIZIA LA CONVERSAZIONE. Il coach è pronto.' }] },
    { role: 'model', parts: [{ text: 'Ciao! Sono KOVA Coach, il tuo assistente personale. Ho accesso a tutti i tuoi dati — chiedimi pure quello che vuoi: nutrizione, allenamento, progressi, strategie. Come posso aiutarti? 💪' }] },
    ...messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }]
    }))
  ];

  for (const model of MODELS) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            generationConfig: { temperature: 0.7, maxOutputTokens: 512 }
          })
        }
      );
      if (r.status === 429) continue;
      if (!r.ok) continue;
      const d = await r.json();
      const text = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
      if (!text) continue;
      return { success: true, reply: text.trim() };
    } catch(e) { continue; }
  }
  return { success: false, error: 'Coach non disponibile al momento. Riprova tra qualche secondo.' };
}

/**
 * generateRecoveryAdviceAI — genera consigli e un messaggio di recupero via Gemini
 */
export async function generateRecoveryAdviceAI({ profile, currentWeight, activeDiet, activeProgram, recoveryPlan, partOfDay }) {
  const key = await getKey();
  if (!key) return { success: false, error: 'Configura la chiave Gemini nelle impostazioni per usare il Coach.' };

  const p = profile || {};
  const weight = currentWeight || p.weight || null;

  // Build concise context about what TODAY looks like vs weekly trend
  const todayType = recoveryPlan.todayBaseKcal ? 'allenamento/riposo pianificato' : 'N/D';

  const prompt = `Sei KOVA Coach, un assistente AI di fitness e nutrizione personale.
Devi dare un consiglio BREVE, CONCRETO e REALISTICO per oggi basandoti sullo stato settimanale dell'utente.

PROFILO:
- Nome: ${p.name || 'Atleta'}
- Peso: ${weight ? weight + ' kg' : 'N/D'}
- Obiettivo: ${p.target || 'miglioramento composizione corporea'}

PIANO GIORNALIERO DI RIFERIMENTO (oggi):
- Calorie target base: ${recoveryPlan.todayBaseKcal || 'N/D'} kcal/giorno
- Proteine target base: ${recoveryPlan.todayBaseProtein || 'N/D'}g/giorno
- Calorie consigliate oggi (con leggero recupero): ${recoveryPlan.todayAdjustedKcal || 'N/D'} kcal
- Proteine consigliate oggi (con leggero recupero): ${recoveryPlan.todayAdjustedProtein || 'N/D'}g

TREND SETTIMANALE (ultimi 7 giorni):
- Stato: ${recoveryPlan.recoveryStatus}
- Delta kcal settimanale: ${recoveryPlan.kcalWeeklyDelta} kcal (negativo = sotto target)
- Delta proteine settimanale: ${recoveryPlan.proteinWeeklyDelta}g
- Allenamenti: ${recoveryPlan.workoutsCompleted}/${recoveryPlan.workoutsPlanned} completati (${recoveryPlan.workoutsMissed} saltati)
- Passi medi giornalieri: ${recoveryPlan.avgDailySteps}

MOMENTO: ${partOfDay}

⚠️ REGOLE FONDAMENTALI — DEVI RISPETTARLE TASSATIVAMENTE:
1. NON suggerire MAI più di 30-40g di proteine extra al giorno. Il target base è già ${recoveryPlan.todayBaseProtein || '~160'}g — un aumento di 20-30g è già significativo.
2. NON suggerire MAI aggiustamenti calorici superiori a +300-400 kcal rispetto al piano base giornaliero.
3. NON cercare di "recuperare" l'intero deficit settimanale in un solo giorno. Il corpo non funziona così.
4. Ragiona in termini di AZIONI PRATICHE: "aggiungi uno yogurt greco a merenda" è meglio di "integra 200g di proteine".
5. Se il deficit è grande, suggerisci piccoli aggiustamenti graduali su più giorni, non soluzioni estreme.
6. Se il momento è "mattina" o "pomeriggio", NON menzionare i passi.
7. Sii motivante ma REALISTICO. Mai allarmista per deficit gestibili.
8. Usa il grassetto **parola** per enfasi sui numeri chiave.

FORMATO: Max 55-70 parole. Inizia direttamente col contenuto (no "Certo!", no "Ecco il consiglio"). Tono premium, coaching d'élite. Usa emoji con moderazione.

ESEMPIO DI CONSIGLIO BUONO:
"${p.name || 'Enrico'}, questa settimana sei leggermente sotto target calorico. Oggi punta a **${recoveryPlan.todayAdjustedKcal || 2100}** kcal aggiungendo uno spuntino proteico extra nel pomeriggio (es. yogurt greco + frutta secca, ~200 kcal). Proteine a **${recoveryPlan.todayAdjustedProtein || 180}g** — sei sulla buona strada. 💪"

ESEMPIO DI CONSIGLIO SBAGLIATO (da NON fare):
"Devi integrare 372g di proteine extra e 3500 kcal per compensare il deficit settimanale." ← QUESTO È ASSURDO E PERICOLOSO.`;

  try {
    const result = await callGemini(key, prompt, { temperature: 0.7, maxOutputTokens: 350 });
    if (result.success) {
      return {
        success: true,
        advice: result.text,
        actions: recoveryPlan.actions || []
      };
    } else {
      return { success: false, error: result.error || 'Errore nella generazione dei consigli AI.' };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

