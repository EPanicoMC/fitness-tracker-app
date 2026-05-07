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

  const models = ['gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash'];
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
