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
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite'
];

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callGemini(prompt, retries = 2) {
  const key = await getGeminiKey();
  if (!key) return null;

  for (const model of MODELS) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.05,
              maxOutputTokens: 2048,
              topP: 0.8,
              topK: 10
            }
          })
        });

        if (res.status === 429) {
          const wait = (attempt + 1) * 2000;
          console.warn(`${model} rate limited, aspetto ${wait}ms...`);
          await sleep(wait);
          continue;
        }
        if (res.status === 503 || res.status === 500) {
          console.warn(`${model} occupato (${res.status}), provo prossimo...`);
          break;
        }
        if (!res.ok) {
          console.warn(`${model} errore ${res.status}`);
          break;
        }

        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || '';

      } catch(e) {
        console.warn(`${model} attempt ${attempt} failed:`, e.message);
        if (attempt < retries) await sleep(1000);
      }
    }
  }
  return null;
}

export async function calcMacrosFromText(text) {
  const key = await getGeminiKey();
  if (!key) {
    return {
      success: false,
      error: 'API key non configurata. Vai su Impostazioni per aggiungerla.'
    };
  }

  const prompt = `Sei un database nutrizionale certificato USDA/INRAN.
Calcola i macronutrienti PRECISI per questi alimenti.

TABELLA VALORI USDA (per 100g):
Petto pollo crudo: 165kcal P:31g C:0g F:3.6g
Petto tacchino crudo: 157kcal P:29g C:0g F:3g
Manzo magro crudo: 250kcal P:26g C:0g F:15g
Salmone crudo: 208kcal P:20g C:0g F:13g
Tonno al naturale: 116kcal P:26g C:0g F:1g
Merluzzo crudo: 82kcal P:18g C:0g F:0.7g
Uova intere: 155kcal P:13g C:1g F:11g
Albumi uovo: 52kcal P:11g C:0.7g F:0.2g
Riso bianco crudo: 360kcal P:6.7g C:79g F:0.6g
Riso basmati crudo: 350kcal P:7g C:78g F:0.5g
Pasta secca: 371kcal P:13g C:74g F:1.5g
Avena: 389kcal P:17g C:66g F:7g
Pane integrale: 247kcal P:9g C:46g F:3g
Patate crude: 77kcal P:2g C:17g F:0.1g
Banana: 89kcal P:1.1g C:23g F:0.3g
Mela: 52kcal P:0.3g C:14g F:0.2g
Yogurt greco 0%: 59kcal P:10g C:3.6g F:0.4g
Latte scremato: 35kcal P:3.4g C:5g F:0.1g
Olio EVO: 884kcal P:0g C:0g F:100g
Burro arachidi: 588kcal P:25g C:20g F:50g
Noci: 654kcal P:15g C:14g F:65g
Mandorle: 579kcal P:21g C:22g F:50g
Whey protein: 380kcal P:75g C:10g F:5g
Mozzarella: 280kcal P:17g C:2g F:22g
Fiocchi di latte: 103kcal P:11g C:4g F:4g

METODO CALCOLO OBBLIGATORIO:
Per ogni alimento:
  kcal_alimento = (kcal_per_100g × grammi) / 100
  protein_alimento = (protein_per_100g × grammi) / 100
  (stesso per carbs e fats)
Totali = somma di tutti gli alimenti.

VERIFICA OBBLIGATORIA:
kcal_calcolate = (protein_totale × 4) + (carbs_totale × 4) + (fats_totale × 9)
Se differenza > 5% → ricalcola.

FORMATO RISPOSTA (SOLO JSON, ZERO TESTO):
{"kcal":INTERO,"protein":UN_DECIMALE,"carbs":UN_DECIMALE,"fats":UN_DECIMALE,"items":[{"name":"nome","grams":NUMERO,"kcal":INTERO,"protein":UN_DECIMALE,"carbs":UN_DECIMALE,"fats":UN_DECIMALE}]}

ALIMENTI: ${text}`;

  const raw = await callGemini(prompt);

  if (!raw) {
    return {
      success: false,
      error: 'Servizio AI temporaneamente occupato. Riprova tra 10 secondi.'
    };
  }

  try {
    const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result = JSON.parse(jsonStr);
    return {
      success: true,
      kcal:    Math.round(result.kcal    || 0),
      protein: Math.round((result.protein || 0) * 10) / 10,
      carbs:   Math.round((result.carbs   || 0) * 10) / 10,
      fats:    Math.round((result.fats    || 0) * 10) / 10,
      items:   result.items || []
    };
  } catch(e) {
    return { success: false, error: 'Errore nel parsing risposta AI.' };
  }
}
