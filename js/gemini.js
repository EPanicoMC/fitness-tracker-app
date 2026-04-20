import { db, USER_ID } from './firebase-config.js';
import { doc, getDoc } from './firebase-config.js';

let cachedKey = null;

async function getGeminiKey() {
  if (cachedKey) return cachedKey;
  try {
    const snap = await getDoc(doc(db, 'users', USER_ID, 'settings', 'gemini'));
    if (snap.exists()) { cachedKey = snap.data().api_key; return cachedKey; }
  } catch(e) { console.error('Gemini key error:', e); }
  return null;
}

const MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractJSON(text) {
  const jsonBlock = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlock) {
    try { return JSON.parse(jsonBlock[1]); } catch(e) {}
  }
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch(e) {}
  }
  const cleaned = text.replace(/^[\s\S]*?(?={)/, '').trim();
  try { return JSON.parse(cleaned); } catch(e) {}
  throw new Error('Nessun JSON valido trovato nella risposta');
}

export async function calcMacrosFromText(text) {
  const key = await getGeminiKey();
  if (!key) return {
    success: false,
    error: 'API key non configurata. Vai su Impostazioni → Gemini AI.'
  };

  const prompt = `Calcola i valori nutrizionali totali per questi alimenti.
Usa il tuo knowledge base nutrizionale aggiornato.
Considera i pesi indicati (g = grammi).

Alimenti: ${text}

Rispondi ESCLUSIVAMENTE con questo JSON (zero testo prima o dopo):
{"kcal":NUMERO_INTERO,"protein":NUMERO,"carbs":NUMERO,"fats":NUMERO,"items":[{"name":"nome alimento","grams":NUMERO,"kcal":NUMERO,"protein":NUMERO,"carbs":NUMERO,"fats":NUMERO}]}`;

  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 1024,
                thinkingConfig: { thinkingBudget: 0 }
              }
            })
          }
        );

        if (res.status === 429) { await sleep((attempt + 1) * 3000); continue; }
        if (!res.ok) { break; }

        const data = await res.json();
        const raw = data.candidates?.[0]?.content?.parts
          ?.filter(p => p.text && !p.thought)
          ?.map(p => p.text)
          ?.join('') || '';

        if (!raw) { break; }

        const result = extractJSON(raw);
        return {
          success: true,
          kcal:    Math.round(result.kcal    || 0),
          protein: parseFloat((result.protein || 0).toFixed(1)),
          carbs:   parseFloat((result.carbs   || 0).toFixed(1)),
          fats:    parseFloat((result.fats    || 0).toFixed(1)),
          items:   result.items || []
        };

      } catch(e) {
        console.warn(`${model} attempt ${attempt}:`, e.message);
        if (attempt < 2) await sleep(1000);
      }
    }
  }

  return {
    success: false,
    error: 'AI temporaneamente non disponibile. Riprova tra qualche secondo.'
  };
}
