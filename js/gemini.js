import { db, USER_ID } from './firebase-config.js';
import { doc, getDoc } from './firebase-config.js';

let cachedKey = null;
let lastCallTime = 0;
const MIN_INTERVAL = 4000;

async function getGeminiKey() {
  if (cachedKey) return cachedKey;
  try {
    const snap = await getDoc(doc(db, 'users', USER_ID, 'settings', 'gemini'));
    if (snap.exists() && snap.data().api_key) {
      cachedKey = snap.data().api_key;
    }
  } catch (e) {
    console.error('Errore lettura Gemini key:', e);
  }
  return cachedKey;
}

export async function calcMacrosFromText(text) {
  const key = await getGeminiKey();
  if (!key) {
    return {
      success: false,
      error: 'API key non configurata. Vai su Impostazioni per aggiungerla.'
    };
  }

  // Rate limiter
  const now = Date.now();
  const timeSinceLastCall = now - lastCallTime;
  if (timeSinceLastCall < MIN_INTERVAL) {
    const waitTime = MIN_INTERVAL - timeSinceLastCall;
    console.log(`Rate limiter: aspetto ${waitTime}ms`);
    await new Promise(r => setTimeout(r, waitTime));
  }
  lastCallTime = Date.now();

  const prompt = `Calcola i valori nutrizionali totali per questi alimenti.
Usa i valori nutrizionali standard per 100g e calcola in proporzione ai grammi indicati.

Alimenti: ${text}

IMPORTANTE: Rispondi SOLO con JSON valido. Nessun testo prima o dopo.
{"kcal":0,"protein":0,"carbs":0,"fats":0,"items":[{"name":"","grams":0,"kcal":0,"protein":0,"carbs":0,"fats":0}]}`;

  const models = ['gemini-2.0-flash'];

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        console.log(`Tentativo: ${model}, attempt ${attempt}`);

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 1024
            }
          })
        });

        console.log(`${model} status: ${res.status}`);

        if (res.status === 429) {
          console.warn('Rate limited, aspetto 10 secondi...');
          await new Promise(r => setTimeout(r, 10000));
          continue;
        }

        if (!res.ok) {
          console.warn(`Errore ${res.status}`);
          return { success: false, error: `Errore API: ${res.status}` };
        }

        const data = await res.json();
        console.log('Risposta Gemini:', JSON.stringify(data).slice(0, 500));

        const parts = data.candidates?.[0]?.content?.parts || [];
        let rawText = '';
        for (const p of parts) { if (p.text) rawText += p.text; }

        console.log('Testo raw:', rawText.slice(0, 300));

        if (!rawText) {
          return { success: false, error: 'Risposta vuota da AI' };
        }

        let jsonStr = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '');
        const s = jsonStr.indexOf('{');
        const e = jsonStr.lastIndexOf('}');
        if (s === -1 || e === -1) {
          return { success: false, error: 'Formato risposta non valido' };
        }
        jsonStr = jsonStr.slice(s, e + 1);
        const result = JSON.parse(jsonStr);
        console.log('JSON parsed:', result);

        return {
          success: true,
          kcal: Math.round(result.kcal || 0),
          protein: parseFloat((result.protein || 0).toFixed(1)),
          carbs: parseFloat((result.carbs || 0).toFixed(1)),
          fats: parseFloat((result.fats || 0).toFixed(1)),
          items: result.items || []
        };

      } catch (err) {
        console.error(`${model} attempt ${attempt} errore:`, err.message);
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }
  }

  return {
    success: false,
    error: 'AI non disponibile. Riprova tra qualche secondo.'
  };
}
