import { GEMINI_KEY, GEMINI_URL } from './firebase-config.js';

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

  try {
    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
      })
    });

    if (!res.ok) throw new Error(`API error: ${res.status}`);

    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonStr = raw.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    const result = JSON.parse(jsonStr);

    return {
      success: true,
      kcal: Math.round(result.kcal || 0),
      protein: Math.round(result.protein || 0),
      carbs: Math.round(result.carbs || 0),
      fats: Math.round(result.fats || 0),
      items: result.items || []
    };
  } catch(e) {
    console.error('Gemini error:', e);
    return { success: false, error: e.message };
  }
}
