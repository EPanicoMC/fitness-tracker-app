import { GEMINI_KEY } from './firebase-config.js';

const MODELS = [
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b'
];

export async function calcMacrosFromText(text) {
  const prompt = `Sei un nutrizionista esperto e preciso. Ti vengono dati degli alimenti con quantità.
Calcola il totale nutrizionale PRECISO.

Rispondi SOLO con un JSON valido, nessun testo extra, nessun markdown.
Formato esatto:
{
  "kcal": numero,
  "protein": numero_grammi,
  "carbs": numero_grammi,
  "fats": numero_grammi,
  "items": [{"name": "nome alimento", "grams": grammi, "kcal": numero, "protein": g, "carbs": g, "fats": g}]
}

Alimenti: ${text}`;

  for (const model of MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
        })
      });

      if (res.status === 429) {
        console.warn(`${model} rate limited, trying next model...`);
        continue;
      }
      if (!res.ok) throw new Error(`API error: ${res.status}`);

      const data = await res.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const result = JSON.parse(jsonStr);

      return {
        success: true,
        model,
        kcal:    Math.round(result.kcal    || 0),
        protein: Math.round(result.protein || 0),
        carbs:   Math.round(result.carbs   || 0),
        fats:    Math.round(result.fats    || 0),
        items:   result.items || []
      };
    } catch(e) {
      console.warn(`${model} failed:`, e.message);
    }
  }

  return { success: false, error: 'Tutti i modelli AI non disponibili. Riprova tra poco.' };
}
