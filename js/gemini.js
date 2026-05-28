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

// ── Model list ──────────────────────────────────────────────
const MODELS = [
  'gemini-3.1-flash-lite-preview',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3-flash',
  'gemini-2.5-flash-lite',
  'gemini-1.5-flash'
];

async function callGemini(key, prompt, opts = {}) {
  const { temperature = 0.7, maxOutputTokens = 1024, parts } = opts;
  const contentParts = parts || [{ text: prompt }];

  for (const model of MODELS) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: contentParts }],
            generationConfig: { temperature, maxOutputTokens }
          })
        }
      );
      if (r.status === 429) { console.warn(model, '429'); continue; }
      if (!r.ok) { console.warn(model, 'error', r.status); continue; }
      const d = await r.json();
      const text = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
      if (!text) continue;
      return { success: true, text: text.trim(), model };
    } catch(e) { console.warn(model, 'failed:', e.message); continue; }
  }
  return { success: false, error: 'Tutti i modelli occupati. Riprova tra 1 minuto.' };
}

// ── Calcola macros da testo ─────────────────────────────────
export async function calcMacrosFromText(text) {
  if (busy) return { success: false, error: 'Calcolo in corso...' };
  busy = true;
  try {
    const key = await getKey();
    if (!key) return { success: false, error: 'API key mancante.' };

    const prompt = `Analizza la seguente descrizione di un pasto e stima accuratamente i macronutrienti (Proteine, Carboidrati, Grassi) e le Calorie (kcal).
Pasto: "${text}"

Regole fondamentali e VINCOLANTI di attendibilità:
1. Le calorie totali (kcal) DEVONO essere LA SOMMA MATEMATICA ESATTA dei macronutrienti calcolati usando questa formula: (Proteine * 4) + (Carboidrati * 4) + (Grassi * 9). Fai sempre un doppio check prima di rispondere. Se la somma non combacia, correggi i macronutrienti o le calorie.
2. Se le quantità non sono specificate, ipotizza porzioni standard medie e ragionevoli (es. piatto di pasta = 80g a crudo, petto di pollo = 150g, 1 cucchiaio d'olio = 10g, uovo medio = 50g, 1 frutto = 150g).
3. Valori nutrizionali di riferimento per 100g:
   - Pasta/Riso (crudo): ~350 kcal, 75g Carb, 10g Pro, 1g Fat
   - Petto di Pollo (crudo): ~110 kcal, 0g Carb, 23g Pro, 2g Fat
   - Olio Extravergine: ~880 kcal, 0g Carb, 0g Pro, 100g Fat
   - Salmone (fresco): ~180 kcal, 0g Carb, 20g Pro, 11g Fat
   - Pane comune: ~260 kcal, 55g Carb, 8g Pro, 1g Fat
4. L'output deve essere SOLO un JSON valido, niente markup markdown.

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

    const res = await callGemini(key, prompt, { temperature: 0.1, maxOutputTokens: 1024 });
    if (!res.success) return { success: false, error: res.error };

    const raw = res.text;
    const s1 = raw.indexOf('{');
    const s2 = raw.lastIndexOf('}');
    if (s1 === -1 || s2 === -1) return { success: false, error: 'Risposta AI non valida.' };

    const parsed = JSON.parse(raw.slice(s1, s2 + 1));
    return {
      success: true,
      kcal: Math.round(parsed.kcal || 0),
      protein: parseFloat((parsed.protein || 0).toFixed(1)),
      carbs: parseFloat((parsed.carbs || 0).toFixed(1)),
      fats: parseFloat((parsed.fats || 0).toFixed(1)),
      items: parsed.items || []
    };
  } catch(e) {
    return { success: false, error: 'Errore parsing risposta AI.' };
  } finally {
    busy = false;
  }
}

// ── Analizza progressione check ─────────────────────────────
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

  const res = await callGemini(key, null, { temperature: 0.7, maxOutputTokens: 512, parts });
  if (!res.success) return { success: false, error: 'Analisi non disponibile' };
  return { success: true, analysis: res.text };
}

// ── Report settimanale AI (con dati ricchi per giorno) ──────
export async function generateWeeklyCoachReportAI(data) {
  const key = await getKey();
  if (!key) return { success: false, error: 'API key mancante.' };

  // Costruisci il breakdown giornaliero
  const dayBreakdownText = (data.dailyBreakdown || []).map(d => {
    const parts = [`  ${d.date} (${d.dayLabel})`];
    if (d.kcal > 0) parts.push(`    Kcal: ${d.kcal}${d.kcalTarget > 0 ? ` / ${d.kcalTarget} target (${Math.round(d.kcal/d.kcalTarget*100)}%)` : ''}`);
    if (d.protein > 0) parts.push(`    Proteine: ${d.protein}g${d.proteinTarget > 0 ? ` / ${d.proteinTarget}g target` : ''}`);
    if (d.isTraining !== null) parts.push(`    Allenamento: ${d.workoutDone ? `✅ ${d.workoutName || 'Completato'}` : (d.isTraining ? '❌ Saltato' : '😴 Riposo')}`);
    if (d.steps > 0) parts.push(`    Passi: ${d.steps.toLocaleString('it-IT')}`);
    if (d.note) parts.push(`    Nota: "${d.note}"`);
    return parts.join('\n');
  }).join('\n');

  const promptText = `Sei l'AI Weekly Coach dell'app di fitness KOVA. Analizza i dati degli ultimi 7 giorni dell'utente e genera un report di feedback settimanale in italiano.
Sii estremamente professionale, motivante e orientato al risultato, rispecchiando i valori di eccellenza di KOVA.

PROFILO UTENTE:
- Nome: ${data.userName || 'Atleta'}
- Obiettivo peso: ${data.weightTarget ? data.weightTarget + ' kg' : 'Non specificato'}
- Peso attuale: ${data.currentWeight ? data.currentWeight + ' kg' : 'Non misurato di recente'}
- Scheda attiva: ${data.programName || 'Nessuna'}
- Piano dieta: ${data.dietName || 'Nessuno'}

DATI SETTIMANALI AGGREGATI:
- Aderenza calorica media: ${data.avgCalorieAdherence}%
- Calorie consumate medie: ${data.avgCalories} kcal / giorno (vs target ${data.targetCalories} kcal)
- Proteine medie: ${data.avgProtein}g / giorno (target: ${data.targetProtein || '?'}g)
- Carboidrati medi: ${data.avgCarbs}g / giorno
- Grassi medi: ${data.avgFats}g / giorno
- Passi totali settimanali: ${data.totalSteps} (media giornaliera: ${data.avgSteps})
- Sessioni completate: ${data.completedWorkouts} su ${data.totalWorkoutsPlanned} pianificate
- Giorni con dati loggati: ${data.loggedDays} su 7
- Smart Score Settimanale: ${data.weeklyScore}/100

BREAKDOWN GIORNALIERO DETTAGLIATO:
${dayBreakdownText || '  (nessun dato)'}

Struttura il report con le seguenti sezioni in markdown italiano pulito (usa emoji adatte):
1. **Analisi della Settimana**: Una panoramica critica del comportamento nutrizionale e motorio. Fai riferimento ai giorni specifici dove utile.
2. **I Tuoi Punti di Forza**: Cosa ha funzionato davvero bene (es. costanza, aderenza macro, passi).
3. **Aree di Miglioramento**: Cosa tenere d'occhio per ottimizzare la composizione corporea e le performance. Sii specifico con i numeri.
4. **Action Plan per la Prossima Settimana**: 2-3 indicazioni ultra-pratiche e numeriche su cui focalizzarsi.

Mantieni il report compatto ed efficace (circa 220-280 parole). Non aggiungere note esterne, rispondi solo in markdown.`;

  const res = await callGemini(key, promptText, { temperature: 0.7, maxOutputTokens: 1200 });
  if (!res.success) return { success: false, error: 'AI weekly report non disponibile al momento. Riprova più tardi.' };
  return { success: true, report: res.text };
}

// ── Analisi immagine cibo ───────────────────────────────────
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

  const res = await callGemini(key, null, { temperature: 0.1, maxOutputTokens: 512, parts });
  if (!res.success) return { success: false, error: 'Errore analisi immagine food scanner' };

  const raw = res.text;
  const s1 = raw.indexOf('{');
  const s2 = raw.lastIndexOf('}');
  if (s1 === -1 || s2 === -1) return { success: false, error: 'Risposta AI non valida.' };

  try {
    const parsed = JSON.parse(raw.slice(s1, s2 + 1));
    return {
      success: true,
      name: parsed.name || 'Pasto Scansionato',
      kcal: Math.round(parsed.kcal || 0),
      protein: parseFloat((parsed.protein || 0).toFixed(1)),
      carbs: parseFloat((parsed.carbs || 0).toFixed(1)),
      fats: parseFloat((parsed.fats || 0).toFixed(1)),
      ingredients: parsed.ingredients || ''
    };
  } catch(e) {
    return { success: false, error: 'Errore parsing risposta AI.' };
  }
}

// ── Smart Advisor (per parte del giorno, passi solo sera) ───
export async function generateSmartAdviceAI({ profile, currentWeight, activeDiet, activeProgram, dailyState, partOfDay }) {
  const key = await getKey();
  if (!key) return { success: false, error: 'API key mancante.' };

  const p = profile || {};
  const sexStr = p.sex === 'M' ? 'Uomo' : (p.sex === 'F' ? 'Donna' : '');
  let age = '';
  if (p.dob) {
    const dob = new Date(p.dob);
    const now = new Date();
    age = now.getFullYear() - dob.getFullYear();
    const m = now.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  }

  const dietTargetKcal = dailyState.isTrainingDay ? activeDiet?.day_on?.kcal : activeDiet?.day_off?.kcal;
  const dietTargetPro = dailyState.isTrainingDay ? activeDiet?.day_on?.protein : activeDiet?.day_off?.protein;

  // Solo la sera include i passi
  const includeSteps = partOfDay === 'sera';

  // Dati comuni
  const baseContext = `Sei KOVA Smart Advisor, un assistente AI d'élite integrato in una app di fitness premium.
Il tuo compito è generare un consiglio ultra-personalizzato, breve e motivante in italiano per guidare l'utente nel momento attuale della giornata: ${partOfDay.toUpperCase()}.

Dati utente:
- Profilo: ${p.name || 'Utente'} (${sexStr ? sexStr + ', ' : ''}${age ? age + ' anni, ' : ''}${p.height ? p.height + 'cm' : ''})
- Peso attuale: ${currentWeight ? currentWeight + ' kg' : 'Non registrato'} (Target: ${p.weight_target || '?'} kg)
- Dieta attiva: ${activeDiet ? activeDiet.name + ' (Target: ' + (dietTargetKcal || '?') + ' kcal, Pro: ' + (dietTargetPro || '?') + 'g)' : 'Nessuna'}
- Scheda attiva: ${activeProgram ? activeProgram.name : 'Nessuna'}
- Giorno di oggi: ${dailyState.isTrainingDay ? 'Allenamento (ON)' : 'Riposo (OFF)'}
${dailyState.weeklyScore != null ? `- SmartScore settimanale: ${dailyState.weeklyScore}/100` : ''}

Stato odierno (fino ad ora):
- Calorie consumate: ${dailyState.kcal || 0} kcal ${dietTargetKcal ? '/ ' + dietTargetKcal + ' target' : ''}
- Macro: P:${dailyState.protein || 0}g${dietTargetPro ? ' / ' + dietTargetPro + 'g target' : ''}, C:${dailyState.carbs || 0}g, F:${dailyState.fats || 0}g
- Pasti: ${dailyState.eatenMealsStr || 'Nessuno'}
${dailyState.workoutDone ? '- Allenamento: ✅ COMPLETATO' : (dailyState.isTrainingDay ? '- Allenamento: ❌ Non ancora completato' : '')}
${includeSteps ? `- Passi: ${dailyState.steps || 0} / ${p.steps_goal || 10000} obiettivo` : ''}`;

  let specificInstructions = '';
  if (partOfDay === 'mattina') {
    specificInstructions = `È mattina presto. Motiva l'utente per la giornata, ricordagli il tipo di giorno (allenamento o riposo) e cosa mangiare per iniziare bene. NON menzionare i passi. Focusizza su: piano alimentare della mattina, allenamento se previsto oggi, carica di energia.`;
  } else if (partOfDay === 'pomeriggio') {
    specificInstructions = `È pomeriggio. Valuta i pasti fatti finora vs il piano, dai indicazioni su cosa ancora mangiare, ricordagli dell'allenamento se non fatto. NON menzionare i passi. Sii preciso sui macro/kcal mancanti se rilevante.`;
  } else {
    specificInstructions = `È sera. Valuta l'intera giornata: kcal totali, proteine, passi e allenamento. Dai feedback precisi e numerici su come è andata, cosa recuperare domani se qualcosa è mancato.`;
  }

  const promptText = `${baseContext}

Momento: ${partOfDay.toUpperCase()}
${specificInstructions}

Regole fondamentali per la risposta:
1. Sii estremamente diretto, pratico, motivante e conciso (massimo 45-55 parole).
2. No introduzioni inutili ("Certo!", "Ecco il consiglio" ecc.), parti subito col contenuto.
3. Usa numeri precisi quando disponibili (es. "ti mancano 48g di proteine").
4. Tono premium, d'élite, tecnico ed incoraggiante.
5. Usa grassetti **così** ed emoji adatte. No markdown elaborato.`;

  const res = await callGemini(key, promptText, { temperature: 0.75, maxOutputTokens: 256 });
  if (!res.success) return { success: false, error: 'AI occupata. Usa fallback locale.' };
  return { success: true, advice: res.text };
}

// ── Chat with Coach (multi-turno) ───────────────────────────
export async function chatWithCoach(messages, userContext) {
  const key = await getKey();
  if (!key) return { success: false, error: 'API key mancante. Configurala nelle Impostazioni.' };

  const systemPrompt = `Sei KOVA Coach, l'assistente AI personale integrato nell'app di fitness KOVA.
Sei un coach d'élite, esperto di nutrizione sportiva, allenamento e composizione corporea.
Rispondi sempre in italiano, con tono professionale ma diretto e motivante.
Hai accesso completo al profilo e ai dati dell'atleta — usali per dare consigli ultra-personalizzati.
Rispondi in modo conciso ma completo. Usa emoji con moderazione. Puoi usare grassetti **parola** per enfasi.

PROFILO ATLETA:
${userContext || 'Dati non disponibili in questo momento.'}`;

  // Costruisci i turns della conversazione
  const contents = [
    { role: 'user', parts: [{ text: systemPrompt + '\n\n---\nINIZIA LA CONVERSAZIONE. Il coach è pronto.' }] },
    { role: 'model', parts: [{ text: 'Ciao! Sono KOVA Coach, il tuo assistente personale. Ho accesso a tutti i tuoi dati — chiedimi pure quello che vuoi: nutrizione, allenamento, progressi, strategie. Come posso aiutarti? 💪' }] },
    ...messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }]
    }))
  ];

  for (const model of MODELS) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            generationConfig: { temperature: 0.7, maxOutputTokens: 512 }
          })
        }
      );
      if (r.status === 429) continue;
      if (!r.ok) continue;
      const d = await r.json();
      const text = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
      if (!text) continue;
      return { success: true, reply: text.trim() };
    } catch(e) { continue; }
  }
  return { success: false, error: 'Coach non disponibile al momento. Riprova tra qualche secondo.' };
}
