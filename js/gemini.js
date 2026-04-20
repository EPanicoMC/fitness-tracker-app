import { db, USER_ID } from './firebase-config.js';
import { doc, getDoc } from './firebase-config.js';

let cachedKey = null;

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

function extractJSON(text) {
  if (!text) throw new Error('Risposta vuota');

  // Rimuovi blocchi di codice markdown
  let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');

  // Trova il primo { e l'ultimo }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Nessun JSON trovato');
  }

  const jsonStr = cleaned.slice(start, end + 1);
  return JSON.parse(jsonStr);
}

export async function calcMacrosFromText(text) {
  const key = await getGeminiKey();
  if (!key) {
    return {
      success: false,
      error: 'API key non configurata. Vai su Impostazioni per aggiungerla.'
    };
  }

  const prompt = `Calcola i valori nutrizionali totali per questi alimenti.
Usa i valori nutrizionali standard per 100g e calcola in proporzione ai grammi indicati.

Alimenti: ${text}

IMPORTANTE: Rispondi SOLO con JSON valido. Nessun testo prima o dopo.
{"kcal":0,"protein":0,"carbs":0,"fats":0,"items":[{"name":"","grams":0,"kcal":0,"protein":0,"carbs":0,"fats":0}]}`;

  // Usa SOLO gemini-2.0-flash (stabile, no thinking, veloce)
  const models = ['gemini-2.0-flash', 'gemini-2.0-flash-lite'];

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
          console.warn(`${model} rate limited, aspetto...`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }

        if (!res.ok) {
          const errText = await res.text();
          console.warn(`${model} errore ${res.status}:`, errText);
          break;
        }

        const data = await res.json();
        console.log('Risposta Gemini:', JSON.stringify(data).slice(0, 500));

        // Prendi il testo dalla risposta
        const parts = data.candidates?.[0]?.content?.parts || [];
        let rawText = '';
        for (const part of parts) {
          if (part.text) rawText += part.text;
        }

        console.log('Testo raw:', rawText.slice(0, 300));

        if (!rawText) {
          console.warn(`${model}: risposta senza testo`);
          break;
        }

        const result = extractJSON(rawText);
        console.log('JSON parsed:', result);

        return {
          success: true,
          kcal: Math.round(result.kcal || 0),
          protein: parseFloat((result.protein || 0).toFixed(1)),
          carbs: parseFloat((result.carbs || 0).toFixed(1)),
          fats: parseFloat((result.fats || 0).toFixed(1)),
          items: result.items || []
        };

      } catch (e) {
        console.error(`${model} attempt ${attempt} errore:`, e.message);
        if (attempt < 1) await new Promise(r => setTimeout(r, 1500));
      }
    }
  }

  return {
    success: false,
    error: 'AI non disponibile. Riprova tra qualche secondo.'
  };
}
