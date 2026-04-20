import { db, USER_ID } from './firebase-config.js';
import { doc, getDoc } from './firebase-config.js';

let cachedKey = null;

async function getGeminiKey() {
  if (cachedKey) return cachedKey;
  try {
    const snap = await getDoc(doc(db, 'users', USER_ID, 'settings', 'gemini'));
    if (snap.exists()) {
      cachedKey = snap.data().api_key;
      return cachedKey;
    }
  } catch(e) {
    console.error('Errore lettura Gemini key:', e);
  }
  return null;
}

const MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.5-flash-lite'
];

export async function calcMacrosFromText(text) {
  const key = await getGeminiKey();

  if (!key) {
    return {
      success: false,
      error: 'API key non configurata. Vai su Impostazioni per aggiungerla.'
    };
  }

  const prompt = `Sei un database nutrizionale. Fornisci SOLO valori
nutrizionali standard per 100g come da tabelle USDA FoodData Central.

VALORI DI RIFERIMENTO ESATTI (usali sempre):
- Petto di pollo crudo: kcal 165, proteine 31g, carbo 0g, grassi 3.6g
- Petto di tacchino crudo: kcal 157, proteine 29g, carbo 0g, grassi 3g
- Riso bianco crudo: kcal 360, proteine 6.7g, carbo 79g, grassi 0.6g
- Riso basmati crudo: kcal 350, proteine 7g, carbo 78g, grassi 0.5g
- Pasta cruda: kcal 371, proteine 13g, carbo 74g, grassi 1.5g
- Uova intere: kcal 155, proteine 13g, carbo 1g, grassi 11g
- Salmone: kcal 208, proteine 20g, carbo 0g, grassi 13g
- Tonno al naturale: kcal 116, proteine 26g, carbo 0g, grassi 1g
- Olio EVO: kcal 884, proteine 0g, carbo 0g, grassi 100g
- Banana: kcal 89, proteine 1.1g, carbo 23g, grassi 0.3g
- Yogurt greco 0%: kcal 59, proteine 10g, carbo 3.6g, grassi 0.4g
- Avena: kcal 389, proteine 17g, carbo 66g, grassi 7g
- Patate: kcal 77, proteine 2g, carbo 17g, grassi 0.1g

CALCOLO:
1. Identifica ogni alimento e quantità in grammi
2. Calcola: valore = (valore_per_100g × grammi) / 100
3. Somma tutti gli alimenti per il totale
4. Verifica: kcal_totale ≈ (proteine×4) + (carbo×4) + (grassi×9)

Rispondi SOLO con questo JSON, zero testo extra:
{"kcal":NUMERO_INTERO,"protein":NUMERO_1_DECIMALE,"carbs":NUMERO_1_DECIMALE,"fats":NUMERO_1_DECIMALE,"items":[{"name":"nome","grams":NUMERO,"kcal":NUMERO,"protein":NUMERO,"carbs":NUMERO,"fats":NUMERO}]}

Alimenti: ${text}`;

  for (const model of MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
        })
      });

      if (res.status === 429) {
        console.warn(`${model} rate limited, trying next...`);
        continue;
      }
      if (!res.ok) {
        console.warn(`${model} error ${res.status}`);
        continue;
      }

      const data = await res.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const result = JSON.parse(jsonStr);

      return {
        success: true,
        model: model,
        kcal:    Math.round(result.kcal    || 0),
        protein: Math.round(result.protein || 0),
        carbs:   Math.round(result.carbs   || 0),
        fats:    Math.round(result.fats    || 0),
        items:   result.items || []
      };
    } catch(e) {
      console.warn(`${model} failed:`, e.message);
      continue;
    }
  }

  return {
    success: false,
    error: 'Tutti i modelli non disponibili. Riprova tra qualche secondo.'
  };
}
