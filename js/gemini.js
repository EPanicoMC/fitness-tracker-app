import { db, USER_ID } from './firebase-config.js';
import { doc, getDoc } from './firebase-config.js';

let cachedKey = null;
let isCallInProgress = false;

async function getGeminiKey() {
  if (cachedKey) return cachedKey;
  try {
    const snap = await getDoc(doc(db, 'users', USER_ID, 'settings', 'gemini'));
    if (snap.exists() && snap.data().api_key) {
      cachedKey = snap.data().api_key;
    }
  } catch (e) {
    console.error('Key error:', e);
  }
  return cachedKey;
}

function extractJSON(text) {
  let s = text.indexOf('{');
  let e = text.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('No JSON');
  return JSON.parse(text.slice(s, e + 1));
}

export async function calcMacrosFromText(text) {
  if (isCallInProgress) {
    return { success: false, error: 'Calcolo in corso, attendi...' };
  }
  isCallInProgress = true;

  try {
    const key = await getGeminiKey();
    if (!key) {
      return { success: false, error: 'API key mancante. Vai in Impostazioni.' };
    }

    const body = {
      contents: [{
        role: "user",
        parts: [{
          text: "Calcola i valori nutrizionali totali per: " + text + "\n\nRispondi SOLO con JSON: {\"kcal\":0,\"protein\":0,\"carbs\":0,\"fats\":0,\"items\":[{\"name\":\"\",\"grams\":0,\"kcal\":0,\"protein\":0,\"carbs\":0,\"fats\":0}]}"
        }]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1024
      }
    };

    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + key;

    console.log("Calling Gemini...");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    console.log("Status:", res.status);

    if (res.status === 429) {
      return { success: false, error: 'Troppe richieste. Aspetta 30 secondi e riprova.' };
    }

    if (!res.ok) {
      const errBody = await res.text();
      console.error("Errore API:", errBody);
      return { success: false, error: 'Errore API: ' + res.status };
    }

    const data = await res.json();
    console.log("Response OK");

    const parts = data.candidates?.[0]?.content?.parts || [];
    let raw = "";
    for (const p of parts) {
      if (p.text) raw += p.text;
    }

    console.log("Raw:", raw.slice(0, 200));

    if (!raw) {
      return { success: false, error: 'Risposta vuota' };
    }

    const result = extractJSON(raw);

    return {
      success: true,
      kcal: Math.round(result.kcal || 0),
      protein: parseFloat((result.protein || 0).toFixed(1)),
      carbs: parseFloat((result.carbs || 0).toFixed(1)),
      fats: parseFloat((result.fats || 0).toFixed(1)),
      items: result.items || []
    };

  } catch (e) {
    console.error("Gemini error:", e);
    return { success: false, error: e.message };
  } finally {
    isCallInProgress = false;
  }
}
