import { db, USER_ID } from './firebase-config.js';
import { doc, getDoc } from './firebase-config.js';

let cachedKey = null;
let busy = false;

async function getKey() {
  if (cachedKey) return cachedKey;
  try {
    const s = await getDoc(doc(db, 'users', USER_ID, 'settings', 'gemini'));
    if (s.exists()) cachedKey = s.data().api_key;
  } catch(e) {}
  return cachedKey;
}

export async function calcMacrosFromText(text) {
  if (busy) return { success: false, error: 'Calcolo in corso...' };
  busy = true;
  try {
    const key = await getKey();
    if (!key) return { success: false, error: 'API key mancante.' };

    const prompt = 'Calcola i valori nutrizionali totali per: ' + text +
      '\n\nRispondi SOLO con JSON:\n{"kcal":0,"protein":0,"carbs":0,"fats":0,"items":[{"name":"","grams":0,"kcal":0,"protein":0,"carbs":0,"fats":0}]}';

    const models = [
      'gemini-3.1-flash-lite-preview',
      'gemini-3-flash-preview',
      'gemini-2.5-flash'
    ];

    for (const model of models) {
      try {
        console.log('Trying:', model);
        const r = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/' +
          model + ':generateContent?key=' + key,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
            })
          }
        );

        console.log(model, 'status:', r.status);

        if (r.status === 429) {
          console.warn(model, '429, next model...');
          continue;
        }

        if (!r.ok) {
          console.warn(model, 'error', r.status);
          continue;
        }

        const d = await r.json();
        const parts = d.candidates?.[0]?.content?.parts || [];
        let raw = '';
        for (const p of parts) { if (p.text) raw += p.text; }

        console.log('Raw:', raw.slice(0, 200));
        if (!raw) continue;

        const s1 = raw.indexOf('{');
        const s2 = raw.lastIndexOf('}');
        if (s1 === -1 || s2 === -1) continue;

        const res = JSON.parse(raw.slice(s1, s2 + 1));
        return {
          success: true,
          kcal: Math.round(res.kcal || 0),
          protein: parseFloat((res.protein || 0).toFixed(1)),
          carbs: parseFloat((res.carbs || 0).toFixed(1)),
          fats: parseFloat((res.fats || 0).toFixed(1)),
          items: res.items || []
        };

      } catch(e) {
        console.warn(model, 'failed:', e.message);
        continue;
      }
    }

    return { success: false, error: 'Tutti i modelli occupati. Riprova tra 1 minuto.' };
  } finally {
    busy = false;
  }
}
