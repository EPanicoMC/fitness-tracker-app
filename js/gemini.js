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

  const prompt = `Sei un nutrizionista sportivo certificato con database
nutrizionale PRECISO. Calcola i valori nutrizionali ESATTI per 100g
di ogni alimento usando i valori standard USDA/INRAN.

REGOLE:
- Usa valori nutrizionali standard italiani/europei
- Per alimenti cotti considera il peso COTTO indicato
- Per alimenti crudi considera il peso CRUDO indicato
- Arrotonda kcal all'intero, macro a 1 decimale
- Le kcal devono corrispondere ESATTAMENTE a (proteine×4 + carboidrati×4 + grassi×9)

Rispondi SOLO con JSON valido, zero testo extra, zero markdown.
Formato ESATTO:
{"kcal":numero,"protein":numero,"carbs":numero,"fats":numero,"items":[{"name":"nome alimento","grams":numero,"kcal":numero,"protein":numero,"carbs":numero,"fats":numero}]}

Alimenti da calcolare: ${text}`;

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
