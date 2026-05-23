import { db, getUserId } from './firebase-config.js';
import { doc, getDoc } from './firebase-config.js';

let cachedKey = null;
let busy = false;

async function getKey() {
  if (cachedKey) return cachedKey;
  try {
    const s = await getDoc(doc(db, 'users', getUserId(), 'settings', 'gemini'));
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

    const prompt = `Analizza la seguente descrizione di un pasto e stima accuratamente i macronutrienti (Proteine, Carboidrati, Grassi) e le Calorie (kcal).
Pasto: "${text}"

Regole fondamentali di attendibilità:
1. Se le quantità non sono specificate, ipotizza porzioni standard medie e ragionevoli (es. piatto di pasta = 80g a crudo, petto di pollo = 150g, 1 cucchiaio d'olio = 10g, uovo medio = 50g, 1 frutto = 150g).
2. Valori nutrizionali di riferimento per 100g:
   - Pasta/Riso (crudo): ~350 kcal, 75g Carb, 10g Pro, 1g Fat
   - Petto di Pollo (crudo): ~110 kcal, 0g Carb, 23g Pro, 2g Fat
   - Olio Extravergine: ~880 kcal, 0g Carb, 0g Pro, 100g Fat
   - Salmone (fresco): ~180 kcal, 0g Carb, 20g Pro, 11g Fat
   - Uovo intero: ~140 kcal, 1g Carb, 12g Pro, 10g Fat
   - Pane comune: ~260 kcal, 55g Carb, 8g Pro, 1g Fat
3. Formula di controllo: le calorie totali (kcal) DEVONO essere matematicamente coerenti con i macronutrienti calcolati: (Proteine * 4) + (Carboidrati * 4) + (Grassi * 9) con una tolleranza massima del 10%.
4. Rispondi esclusivamente con un oggetto JSON valido e nient'altro. Non includere blocchi di codice markdown (tipo \`\`\`json) o testo aggiuntivo.

Struttura JSON richiesta:
{
  "kcal": 0,
  "protein": 0,
  "carbs": 0,
  "fats": 0,
  "items": [
    {
      "name": "Nome alimento (con quantità stimata)",
      "grams": 0,
      "kcal": 0,
      "protein": 0,
      "carbs": 0,
      "fats": 0
    }
  ]
}`;

    const models = [
      'gemini-2.5-flash',
      'gemini-1.5-flash',
      'gemini-1.5-pro'
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

export async function analyzeCheckProgress({ prevCheck, newCheck }) {
  const key = await getKey();
  if (!key) return { success: false, error: 'API key mancante' };

  const getMs = (ms, key) => {
    if (ms[key] != null) return ms[key];
    if (key === 'bicep') { const v = [ms.bicep_l, ms.bicep_r].filter(x => x != null); return v.length ? v.reduce((a,b)=>a+b)/v.length : null; }
    if (key === 'thigh') { const v = [ms.thigh_l, ms.thigh_r].filter(x => x != null); return v.length ? v.reduce((a,b)=>a+b)/v.length : null; }
    return null;
  };

  const fmtMeasures = (check) => {
    const ms = check.measurements || {};
    const parts = [];
    if (check.weight) parts.push(`Peso: ${check.weight}kg`);
    if (ms.shoulders) parts.push(`Spalle: ${ms.shoulders}cm`);
    if (ms.chest) parts.push(`Petto: ${ms.chest}cm`);
    if (ms.waist) parts.push(`Vita: ${ms.waist}cm`);
    const arm = getMs(ms, 'bicep'); if (arm != null) parts.push(`Braccia: ${arm.toFixed(1)}cm`);
    const leg = getMs(ms, 'thigh'); if (leg != null) parts.push(`Gambe: ${leg.toFixed(1)}cm`);
    return parts.join(', ') || 'nessuna misura';
  };

  let promptText = `Sei un coach personale esperto. Analizza la progressione corporea in italiano, sii diretto e motivante.`;
  if (prevCheck) {
    promptText += `\n\nCheck PRECEDENTE (${prevCheck.date}): ${fmtMeasures(prevCheck)}`;
  }
  promptText += `\n\nCheck ATTUALE (${newCheck.date}): ${fmtMeasures(newCheck)}`;
  promptText += `\n\nRispondi in max 120 parole con: 1) cosa è migliorato 2) cosa tenere d'occhio 3) un consiglio concreto. Usa un tono positivo e professionale.`;

  const parts = [{ text: promptText }];

  if (newCheck.photos?.length) {
    for (const photo of newCheck.photos.slice(0, 3)) {
      const u = typeof photo === 'string' ? photo : photo?.url;
      const v = typeof photo === 'object' ? photo?.view : null;
      if (!u) continue;
      try {
        const resp = await fetch(u);
        if (resp.ok) {
          const blob = await resp.blob();
          const base64 = await new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.readAsDataURL(blob);
          });
          if (v) parts.push({ text: `[Foto: ${v}]` });
          parts.push({ inlineData: { mimeType: blob.type || 'image/jpeg', data: base64 } });
        }
      } catch(e) { console.warn('Photo fetch for AI failed:', e); }
    }
  }

  const models = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
  for (const model of models) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 512 }
          })
        }
      );
      if (r.status === 429) continue;
      if (!r.ok) continue;
      const d = await r.json();
      const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) continue;
      return { success: true, analysis: text.trim() };
    } catch(e) { continue; }
  }
  return { success: false, error: 'Analisi non disponibile' };
}

export async function generateWeeklyCoachReportAI(data) {
  const key = await getKey();
  if (!key) return { success: false, error: 'API key mancante.' };

  const promptText = `Sei l'AI Weekly Coach dell'app di fitness KOVA. Analizza i dati degli ultimi 7 giorni dell'utente e genera un report di feedback settimanale in italiano.
Sii estremamente professionale, motivante e orientato al risultato, rispecchiando i valori di eccellenza di KOVA.

Dati settimanali dell'utente:
- Aderenza calorica media: ${data.avgCalorieAdherence}%
- Calorie consumate medie: ${data.avgCalories} kcal / giorno (vs target ${data.targetCalories} kcal)
- Proteine medie: ${data.avgProtein}g / giorno
- Carboidrati medi: ${data.avgCarbs}g / giorno
- Grassi medi: ${data.avgFats}g / giorno
- Passi totali settimanali: ${data.totalSteps} (media giornaliera: ${data.avgSteps})
- Sessioni completate: ${data.completedWorkouts} su ${data.totalWorkoutsPlanned} pianificate
- Smart Score Settimanale: ${data.weeklyScore}/100

Struttura il report con le seguenti sezioni in markdown italiano pulito (usa emoji adatte):
1. **Analisi della Settimana**: Una panoramica critica del comportamento nutrizionale e motorio.
2. **I Tuoi Punti di Forza**: Cosa ha funzionato davvero bene (es. costanza, aderenza macro, passi).
3. **Aree di Miglioramento**: Cosa tenere d'occhio per ottimizzare la composizione corporea e le performance.
4. **Action Plan per la Prossima Settimana**: 2-3 indicazioni ultra-pratiche e numeriche su cui focalizzarsi.

Mantieni il report compatto ed efficace (circa 200-250 parole). Non aggiungere note esterne, rispondi solo in markdown.`;

  const models = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
  for (const model of models) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: promptText }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
          })
        }
      );
      if (r.status === 429) continue;
      if (!r.ok) continue;
      const d = await r.json();
      const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) continue;
      return { success: true, report: text.trim() };
    } catch(e) { continue; }
  }
  return { success: false, error: 'AI weekly report non disponibile al momento. Riprova più tardi.' };
}

export async function analyzeFoodImageAI(base64Image, mimeType = 'image/jpeg') {
  const key = await getKey();
  if (!key) return { success: false, error: 'API key mancante.' };

  const promptText = `Analizza l'immagine di questo cibo e stima accuratamente i macronutrienti (Proteine, Carboidrati, Grassi) e le Calorie (kcal).
Fornisci anche una descrizione sintetica degli ingredienti individuati e delle loro quantità stimate (es. 150g riso bollito, 100g salmone grigliato, 1 cucchiaio d'olio).

Regole di calcolo:
1. Sii il più preciso e realistico possibile in base all'aspetto visivo.
2. Rispondi esclusivamente con un oggetto JSON valido e nient'altro. Non includere blocchi di codice markdown (tipo \`\`\`json) o testo aggiuntivo.

Struttura JSON richiesta:
{
  "name": "Nome sintetico del piatto (es. Riso e Salmone)",
  "kcal": 0,
  "protein": 0,
  "carbs": 0,
  "fats": 0,
  "ingredients": "Ingrediente 1, Ingrediente 2, ecc."
}`;

  const parts = [
    { text: promptText },
    { inlineData: { mimeType, data: base64Image } }
  ];

  const models = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
  for (const model of models) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 512 }
          })
        }
      );
      if (r.status === 429) continue;
      if (!r.ok) continue;
      const d = await r.json();
      const rawText = d.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) continue;

      const s1 = rawText.indexOf('{');
      const s2 = rawText.lastIndexOf('}');
      if (s1 === -1 || s2 === -1) continue;

      const res = JSON.parse(rawText.slice(s1, s2 + 1));
      return {
        success: true,
        name: res.name || 'Pasto Scansionato',
        kcal: Math.round(res.kcal || 0),
        protein: parseFloat((res.protein || 0).toFixed(1)),
        carbs: parseFloat((res.carbs || 0).toFixed(1)),
        fats: parseFloat((res.fats || 0).toFixed(1)),
        ingredients: res.ingredients || ''
      };
    } catch(e) { continue; }
  }
  return { success: false, error: 'Errore analisi immagine food scanner' };
}
