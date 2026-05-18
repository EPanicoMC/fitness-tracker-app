import { db, getUserId, collection, doc, getDoc, getDocs, addDoc, query, orderBy, limit } from './firebase-config.js';
import { showToast } from './app.js';

// ── State ──────────────────────────────────────────────────
let session = null; // { type, messages, context, plan, busy, systemPrompt }

// ── Gemini API ─────────────────────────────────────────────
let _cachedKey = null;
async function getApiKey() {
  if (_cachedKey) return _cachedKey;
  try {
    const s = await getDoc(doc(db, 'users', getUserId(), 'settings', 'gemini'));
    if (s.exists()) _cachedKey = s.data().api_key;
  } catch(e) {}
  return _cachedKey;
}

const MODELS = [
  'gemini-2.5-pro-preview-05-06',
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview'
];

async function callGemini(messages, systemPrompt) {
  const key = await getApiKey();
  if (!key) return { success: false, error: 'API key mancante nelle impostazioni.' };

  for (const model of MODELS) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: messages,
            generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
          })
        }
      );
      if (r.status === 429) { console.warn('[Coach]', model, '→ 429, next model...'); continue; }
      if (r.status === 404) { console.warn('[Coach]', model, '→ 404, not found'); continue; }
      if (!r.ok) { console.warn('[Coach]', model, '→', r.status); continue; }
      const d = await r.json();
      const text = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      if (!text) { console.warn('[Coach]', model, '→ empty'); continue; }
      console.log('[Coach]', model, '→ OK', text.length, 'chars');
      return { success: true, text, model };
    } catch(e) { console.warn('[Coach]', model, '→', e.message); continue; }
  }
  return { success: false, error: 'Tutti i modelli occupati. Riprova tra 1 minuto.' };
}

// ── Build API messages (strip binary data from history) ────
function buildApiMessages(messages) {
  return messages
    .filter(m => !m._isError)  // never send error bubbles to API
    .map((m, idx) => {
      const role = m.role;
      let parts = m.parts || [];
      // Keep inlineData only in the first user message (reference image)
      // — subsequent calls strip it to avoid huge payloads
      if (idx > 0 && role === 'user') {
        parts = parts.filter(p => p.text !== undefined);
        if (!parts.length) parts = [{ text: '...' }];
      }
      return { role, parts };
    });
}

// ── Context loader ─────────────────────────────────────────
async function loadContext() {
  const ctx = {};
  try {
    const snap = await getDocs(query(collection(db, 'users', getUserId(), 'checks'), orderBy('date', 'desc'), limit(1)));
    if (!snap.empty) ctx.lastCheck = snap.docs[0].data();
  } catch(e) {}
  try {
    const snap = await getDocs(collection(db, 'users', getUserId(), 'programs'));
    const active = snap.docs.find(d => d.data().active);
    if (active) ctx.activeProgram = { id: active.id, ...active.data() };
    else if (!snap.empty) ctx.activeProgram = { id: snap.docs[0].id, ...snap.docs[0].data() };
  } catch(e) {}
  try {
    const snap = await getDocs(collection(db, 'users', getUserId(), 'diet_plans'));
    const active = snap.docs.find(d => d.data().active);
    if (active) ctx.activeDiet = { id: active.id, ...active.data() };
    else if (!snap.empty) ctx.activeDiet = { id: snap.docs[0].id, ...snap.docs[0].data() };
  } catch(e) {}
  try {
    const snap = await getDoc(doc(db, 'users', getUserId(), 'settings', 'app'));
    if (snap.exists()) ctx.profile = snap.data().profile;
  } catch(e) {}
  return ctx;
}

// ── System prompts ─────────────────────────────────────────
function fmtCheck(c) {
  if (!c) return 'nessuno';
  const ms = c.measurements || {};
  const parts = [];
  if (c.weight) parts.push(`Peso: ${c.weight}kg`);
  if (ms.shoulders) parts.push(`Spalle: ${ms.shoulders}cm`);
  if (ms.chest) parts.push(`Petto: ${ms.chest}cm`);
  if (ms.waist) parts.push(`Vita: ${ms.waist}cm`);
  const bicep = ms.bicep ?? ((ms.bicep_l != null && ms.bicep_r != null) ? (ms.bicep_l + ms.bicep_r) / 2 : null);
  if (bicep != null) parts.push(`Braccia: ${parseFloat(bicep).toFixed(1)}cm`);
  const thigh = ms.thigh ?? ((ms.thigh_l != null && ms.thigh_r != null) ? (ms.thigh_l + ms.thigh_r) / 2 : null);
  if (thigh != null) parts.push(`Gambe: ${parseFloat(thigh).toFixed(1)}cm`);
  return parts.join(', ') || 'nessuna misura';
}

function fmtProgram(p) {
  if (!p) return 'nessuna scheda';
  const days = Object.keys(p.schedule || {});
  const exCount = days.reduce((t, d) => t + (p.schedule[d]?.exercises?.length || 0), 0);
  const since = p.created_at ? `· in uso da: ${new Date(p.created_at).toLocaleDateString('it-IT')}` : '';
  return `"${p.name}" — ${days.length} giorni/sett. (${days.join(', ')}), ${exCount} esercizi ${since}`;
}

function fmtDiet(d) {
  if (!d) return 'nessuna dieta';
  const on = d.day_on || {}, off = d.day_off || {};
  const since = d.updated_at ? `· aggiornata: ${new Date(d.updated_at).toLocaleDateString('it-IT')}` : '';
  return `"${d.name}" — ON: ${on.kcal||0}kcal P${on.protein||0}g C${on.carbs||0}g F${on.fats||0}g | OFF: ${off.kcal||0}kcal ${since}`;
}

function buildSystemPrompt(type, ctx, goal) {
  const todayFmt = new Date().toLocaleDateString('it-IT', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const p = ctx.profile || {};
  let pStr = '';
  if (p.name) pStr += `Nome: ${p.name}. `;
  if (p.sex) pStr += `Sesso: ${p.sex === 'M' ? 'Uomo' : 'Donna'}. `;
  if (p.dob) {
    let age = new Date().getFullYear() - new Date(p.dob).getFullYear();
    const m = new Date().getMonth() - new Date(p.dob).getMonth();
    if (m < 0 || (m === 0 && new Date().getDate() < new Date(p.dob).getDate())) age--;
    pStr += `Età: ${age} anni. `;
  }
  if (p.height) pStr += `Altezza: ${p.height}cm. `;
  if (p.weight_target) pStr += `Obiettivo peso: ${p.weight_target}kg. `;

  const ctxBlock = `
📅 DATA ODIERNA: ${todayFmt}
📊 DATI ATLETA:
• Profilo: ${pStr || 'Non specificato'}
• Ultimo check (${ctx.lastCheck?.date || 'n/d'}): ${fmtCheck(ctx.lastCheck)}
• Scheda attuale: ${fmtProgram(ctx.activeProgram)}
• Dieta attuale: ${fmtDiet(ctx.activeDiet)}
• Obiettivo dichiarato: ${goal}
`;

  const jsonNote = `
FORMATO JSON OBBLIGATORIO:
Ogni volta che proponi o aggiorni il piano, DEVI includere sempre il JSON strutturato in fondo al messaggio, dentro i tag appropriati. Questo genera automaticamente una preview visiva per l'utente. Aggiorna il JSON ad ogni modifica.
L'utente userà i bottoni "Salva" quando è soddisfatto — tu includi sempre il JSON aggiornato.`;

  if (type === 'workout') {
    return `Sei KOVA Coach, un personal trainer d'élite. Parli SEMPRE in italiano. Sei diretto, tecnico e motivante.
${ctxBlock}
Il tuo compito è progettare un programma di allenamento personalizzato tramite conversazione.

LINEE GUIDA:
• Proponi subito un piano COMPLETO: giorni, esercizi, serie, ripetizioni, recuperi, note tecniche
• Considera la data odierna per stabilire una data di inizio realistica (es. prossimo lunedì)
• Tieni conto di quanto tempo l'atleta è sulla scheda attuale (se disponibile) per calibrare la difficoltà
• Usa periodizzazione e sovraccarico progressivo
• Dopo la proposta, ascolta il feedback e aggiorna il piano
• Se l'utente invia un'immagine di riferimento fisico, analizzala
${jsonNote}

<SCHEDA_JSON>
{
  "name": "Nome del Piano",
  "schedule": {
    "monday": {
      "name": "Nome Sessione",
      "time": "18:00",
      "exercises": [
        { "name": "Nome Esercizio", "sets": 4, "reps": "8-10", "rest_seconds": 90, "notes": "" }
      ],
      "cardio": null
    }
  }
}
</SCHEDA_JSON>

Giorni validi come chiavi (in inglese minuscolo): monday, tuesday, wednesday, thursday, friday, saturday, sunday.
"cardio" è null oppure stringa (es. "20 min LISS 130bpm").
"reps" è sempre stringa (es. "8-10", "12", "30 sec").`;

  } else {
    return `Sei KOVA Coach, un nutrizionista sportivo d'élite. Parli SEMPRE in italiano. Sei preciso, scientifico e motivante.
${ctxBlock}
Il tuo compito è progettare un piano alimentare personalizzato tramite conversazione.

LINEE GUIDA:
• Proponi subito un piano COMPLETO con macro ON/OFF e tutti i pasti con alimenti e grammature specifiche
• Considera la data odierna per suggerire quando iniziare il piano
• Calcola i macro partendo da peso corporeo (se disponibile) e obiettivo
• Timing proteico, carbo peri-workout, grassi sani — sii scientifico
• Proponi varianti pratiche per ogni pasto
• Dopo la proposta, ascolta il feedback e aggiorna
${jsonNote}

<DIETA_JSON>
{
  "name": "Nome del Piano",
  "day_on": {
    "kcal": 0, "protein": 0, "carbs": 0, "fats": 0,
    "meals": [
      { "type": "colazione", "label": "Colazione", "time": "07:30",
        "items": "Descrizione ingredienti con grammature", "kcal": 0, "protein": 0, "carbs": 0, "fats": 0, "variants": null }
    ]
  },
  "day_off": {
    "kcal": 0, "protein": 0, "carbs": 0, "fats": 0, "meals": []
  }
}
</DIETA_JSON>

Tipi pasto validi: colazione, pre_workout, post_workout, spuntino, pranzo, merenda, cena.
I macro totali (kcal/protein/carbs/fats) DEVONO essere la somma esatta dei singoli pasti.
"items" è una stringa descrittiva (es. "200g petto di pollo, 80g riso basmati, olio evo 10g").`;
  }
}

// ── Plan extraction ────────────────────────────────────────
function extractPlan(text, type) {
  const tag = type === 'workout' ? 'SCHEDA_JSON' : 'DIETA_JSON';
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const m = text.match(re);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch(e) {
    console.warn('[Coach] Plan JSON parse error:', e.message);
    return null;
  }
}

function cleanDisplayText(text, type) {
  const tag = type === 'workout' ? 'SCHEDA_JSON' : 'DIETA_JSON';
  return text.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'g'), '').trim();
}

// ── Plan preview card ──────────────────────────────────────
function renderPlanCard(plan, type) {
  if (!plan) return '';

  if (type === 'workout') {
    const days = Object.keys(plan.schedule || {});
    const totalEx = days.reduce((t, d) => t + (plan.schedule[d]?.exercises?.length || 0), 0);
    const dayCols = days.map(d => {
      const s = plan.schedule[d] || {};
      return `<div style="background:rgba(255,255,255,0.05);padding:8px;border-radius:10px;min-width:0;flex:1">
        <div style="font-size:11px;font-weight:800;color:var(--t1);text-transform:capitalize;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${d}</div>
        <div style="font-size:10px;color:var(--t3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.name || ''}</div>
        <div style="font-size:11px;color:var(--accent);margin-top:4px;font-weight:700">${(s.exercises||[]).length} es.</div>
        ${s.time ? `<div style="font-size:10px;color:var(--t3)">⏰ ${s.time}</div>` : ''}
      </div>`;
    }).join('');
    return `
      <div style="border:1px solid rgba(124,111,255,0.35);border-radius:14px;padding:14px;background:rgba(124,111,255,0.07);margin-top:4px">
        <div style="font-size:10px;font-weight:800;color:var(--accent);letter-spacing:1px;margin-bottom:8px">📋 PIANO PROPOSTO</div>
        <div style="font-size:15px;font-weight:900;color:var(--t1);margin-bottom:10px">${plan.name}</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap">${dayCols}</div>
        <div style="font-size:11px;color:var(--t3);margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06)">
          ${days.length} giorni/sett. · ${totalEx} esercizi totali
        </div>
      </div>`;

  } else {
    const on = plan.day_on || {}, off = plan.day_off || {};
    const mealRows = (on.meals || []).map(m =>
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:11px">
        <span style="color:var(--t2)">${m.label || m.type}${m.time ? ` · ${m.time}` : ''}</span>
        <span style="color:var(--green);font-weight:700">${m.kcal} kcal</span>
      </div>`
    ).join('');
    return `
      <div style="border:1px solid rgba(124,111,255,0.35);border-radius:14px;padding:14px;background:rgba(124,111,255,0.07);margin-top:4px">
        <div style="font-size:10px;font-weight:800;color:var(--accent);letter-spacing:1px;margin-bottom:8px">📋 PIANO PROPOSTO</div>
        <div style="font-size:15px;font-weight:900;color:var(--t1);margin-bottom:12px">${plan.name}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
          <div style="background:rgba(255,255,255,0.05);padding:10px;border-radius:10px;text-align:center">
            <div style="font-size:10px;color:var(--accent);font-weight:800;margin-bottom:6px">💪 GIORNO ON</div>
            <div style="font-size:22px;font-weight:900;color:var(--t1);line-height:1">${on.kcal||0}</div>
            <div style="font-size:10px;color:var(--t3);margin-bottom:6px">kcal</div>
            <div style="font-size:11px;color:var(--t2)">P <b>${on.protein||0}g</b></div>
            <div style="font-size:11px;color:var(--t2)">C <b>${on.carbs||0}g</b> · F <b>${on.fats||0}g</b></div>
          </div>
          <div style="background:rgba(255,255,255,0.05);padding:10px;border-radius:10px;text-align:center">
            <div style="font-size:10px;color:#60a5fa;font-weight:800;margin-bottom:6px">😴 GIORNO OFF</div>
            <div style="font-size:22px;font-weight:900;color:var(--t1);line-height:1">${off.kcal||0}</div>
            <div style="font-size:10px;color:var(--t3);margin-bottom:6px">kcal</div>
            <div style="font-size:11px;color:var(--t2)">P <b>${off.protein||0}g</b></div>
            <div style="font-size:11px;color:var(--t2)">C <b>${off.carbs||0}g</b> · F <b>${off.fats||0}g</b></div>
          </div>
        </div>
        ${mealRows ? `<div style="font-size:11px;font-weight:800;color:var(--t3);margin-bottom:4px">Pasti giorno ON:</div>${mealRows}` : ''}
      </div>`;
  }
}

// ── Apply plan to Firestore ────────────────────────────────
async function applyPlanToFirestore(plan, type, isDraft) {
  const prefix = isDraft ? '🔬 Bozza AI — ' : '';
  try {
    if (type === 'workout') {
      await addDoc(collection(db, 'users', getUserId(), 'programs'), {
        ...plan,
        name: prefix + plan.name,
        active: false,
        created_at: new Date().toISOString()
      });
    } else {
      const fixDay = (day) => {
        if (!day) return { kcal: 0, protein: 0, carbs: 0, fats: 0, meals: [] };
        const meals = (day.meals || []).map(m => ({
          type: m.type || 'pranzo', label: m.label || '', time: m.time || '',
          items: m.items || '',
          kcal: Number(m.kcal) || 0, protein: Number(m.protein) || 0,
          carbs: Number(m.carbs) || 0, fats: Number(m.fats) || 0,
          variants: Array.isArray(m.variants) ? m.variants
            : (typeof m.variants === 'string' && m.variants ? [m.variants] : null)
        }));
        const sum = meals.reduce((a, m) => ({
          kcal: a.kcal + m.kcal, protein: a.protein + m.protein,
          carbs: a.carbs + m.carbs, fats: a.fats + m.fats
        }), { kcal: 0, protein: 0, carbs: 0, fats: 0 });
        return { ...sum, meals };
      };
      await addDoc(collection(db, 'users', getUserId(), 'diet_plans'), {
        name: prefix + plan.name,
        active: false,
        updated_at: new Date().toISOString(),
        day_on: fixDay(plan.day_on),
        day_off: fixDay(plan.day_off)
      });
    }
    return true;
  } catch(e) { console.error('[Coach] Apply plan error:', e); return false; }
}

// ── Styles ─────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById('coach-style')) return;
  const s = document.createElement('style');
  s.id = 'coach-style';
  s.textContent = `
    @keyframes coachSlideUp { from { transform:translateY(100%);opacity:0 } to { transform:translateY(0);opacity:1 } }
    @keyframes coachFadeIn  { from { opacity:0;transform:translateY(6px) } to { opacity:1;transform:translateY(0) } }
    @keyframes coachPulse   { 0%,100% { opacity:0.3;transform:scale(0.8) } 50% { opacity:1;transform:scale(1) } }
    .coach-overlay  { position:fixed;inset:0;background:var(--bg);z-index:9999;display:flex;flex-direction:column;animation:coachSlideUp 0.3s ease-out }
    .coach-msg      { animation:coachFadeIn 0.25s ease-out }
    .coach-dots span { display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent);margin:0 2px;animation:coachPulse 1.2s infinite }
    .coach-dots span:nth-child(2) { animation-delay:.2s }
    .coach-dots span:nth-child(3) { animation-delay:.4s }
    .coach-dots span:nth-child(3) { animation-delay:.4s }
    .coach-bubble-u { background:var(--accent);color:#fff;border-radius:18px 18px 4px 18px;max-width:85%;padding:11px 14px;font-size:13px;line-height:1.6;word-break:break-word;overflow-wrap:break-word }
    .coach-bubble-a { background:var(--card);color:var(--t1);border-radius:4px 18px 18px 18px;max-width:92%;padding:11px 14px;font-size:13px;line-height:1.6;word-break:break-word;overflow-wrap:break-word }
    .coach-bubble-e { background:rgba(255,59,59,0.1);border:1px solid rgba(255,59,59,0.2);color:var(--red,#ff4444);border-radius:4px 14px 14px 14px;max-width:88%;padding:10px 14px;font-size:13px;line-height:1.5 }
    .coach-input-area { display:flex;gap:8px;align-items:flex-end;padding:12px 16px;border-top:1px solid var(--border);background:var(--bg);flex-shrink:0 }
    .coach-send-btn { width:44px;height:44px;border-radius:12px;border:none;background:var(--accent);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:16px;transition:opacity .2s }
    .coach-send-btn:disabled { opacity:0.35;cursor:default }
    .coach-plan-banner { padding:14px 16px;border-top:1px solid rgba(124,111,255,0.4);background:linear-gradient(135deg,rgba(124,111,255,0.18),rgba(124,111,255,0.05));flex-shrink:0 }
  `;
  document.head.appendChild(s);
}

// ── Open panel ─────────────────────────────────────────────
export function openCoachPanel(type) {
  injectStyles();
  session = { type, messages: [], context: null, plan: null, busy: false, systemPrompt: '' };

  document.getElementById('coach-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'coach-overlay';
  overlay.className = 'coach-overlay';
  document.body.appendChild(overlay);

  renderSetupPhase();
  loadContext().then(ctx => {
    session.context = ctx;
    const el = document.getElementById('coach-ctx-body');
    if (el) el.innerHTML = renderContextSummary(ctx);
  });
}
window.openCoachPanel = openCoachPanel;

// ── Setup phase ────────────────────────────────────────────
function renderSetupPhase() {
  const overlay = document.getElementById('coach-overlay');
  if (!overlay) return;
  const isWorkout = session.type === 'workout';
  const title = isWorkout ? '🏋️ AI Coach Schede' : '🥗 AI Coach Dieta';
  const ph = isWorkout
    ? 'Es: Voglio aumentare la massa muscolare, mi alleno 4 volte/sett., ho esperienza con i pesi da 2 anni...'
    : 'Es: Voglio un bulk lean, parto da 80kg, mi alleno 4 volte/sett., lavoro d\'ufficio...';

  overlay.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden">
      <div style="display:flex;align-items:center;gap:12px;padding:16px;border-bottom:1px solid var(--border);flex-shrink:0">
        <button onclick="document.getElementById('coach-overlay').remove()"
          style="background:none;border:none;color:var(--t2);font-size:22px;cursor:pointer;padding:4px 8px;border-radius:8px;line-height:1">←</button>
        <div style="flex:1">
          <div style="font-size:18px;font-weight:900;color:var(--t1)">${title}</div>
          <div style="font-size:11px;color:var(--accent);font-weight:600">Powered by Gemini</div>
        </div>
      </div>

      <div style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px">
        <div class="card" style="background:linear-gradient(135deg,rgba(124,111,255,0.15),rgba(124,111,255,0.03));border:1px solid rgba(124,111,255,0.25);margin:0">
          <div style="font-size:13px;font-weight:800;color:var(--accent);margin-bottom:6px">✨ Come funziona</div>
          <div style="font-size:12px;color:var(--t2);line-height:1.65">Descrivi il tuo obiettivo. Il coach legge i tuoi dati attuali (check, scheda, dieta) e crea un piano su misura. Chatti con lui per raffinarlo — ogni risposta include una preview del piano aggiornato. Salvi quando sei soddisfatto.</div>
        </div>

        <div class="card" style="margin:0">
          <div style="font-size:11px;font-weight:800;color:var(--t3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Contesto caricato</div>
          <div id="coach-ctx-body" style="font-size:12px;color:var(--t2)"><div class="spin" style="width:20px;height:20px"></div></div>
        </div>

        <div class="card" style="margin:0">
          <label style="font-size:12px;font-weight:800;color:var(--t2);display:block;margin-bottom:8px">Il tuo obiettivo *</label>
          <textarea id="coach-goal" class="fi" rows="4" placeholder="${ph}"
            style="font-size:13px;resize:none;line-height:1.5"></textarea>
        </div>

        <div class="card" style="margin:0;background:rgba(255,255,255,0.02)">
          <label style="font-size:12px;font-weight:800;color:var(--t2);display:block;margin-bottom:4px">
            Immagine di riferimento <span style="color:var(--t3);font-weight:400">(opzionale)</span>
          </label>
          <div style="font-size:11px;color:var(--t3);margin-bottom:10px">Fisico obiettivo o atleta di riferimento — il coach lo analizzerà</div>
          <input type="file" id="coach-img" accept="image/*" style="display:none" onchange="window._coachImgPreview(this)">
          <button onclick="document.getElementById('coach-img').click()" class="btn btn-ghost btn-sm" style="width:auto">📷 Scegli immagine</button>
          <div id="coach-img-preview" style="margin-top:10px"></div>
        </div>
      </div>

      <div style="padding:16px;border-top:1px solid var(--border);flex-shrink:0">
        <button class="btn btn-v" style="width:100%;font-size:15px;padding:14px;font-weight:800" onclick="window._coachStart()">
          🚀 Inizia sessione con il Coach
        </button>
      </div>
    </div>`;
}

function renderContextSummary(ctx) {
  const lines = [];
  if (ctx.lastCheck) {
    lines.push(`⚖️ <b style="color:var(--t1)">Ultimo check</b> (${ctx.lastCheck.date}): ${ctx.lastCheck.weight || '?'}kg`);
    const ms = ctx.lastCheck.measurements || {};
    const details = [ms.waist && `Vita: ${ms.waist}cm`, ms.chest && `Petto: ${ms.chest}cm`, ms.shoulders && `Spalle: ${ms.shoulders}cm`].filter(Boolean).join(', ');
    if (details) lines.push(`📏 ${details}`);
  } else {
    lines.push('⚖️ <span style="color:var(--t3)">Nessun check registrato</span>');
  }
  if (ctx.activeProgram) lines.push(`💪 <b style="color:var(--t1)">Scheda</b>: ${ctx.activeProgram.name}`);
  else lines.push('💪 <span style="color:var(--t3)">Nessuna scheda attiva</span>');
  if (ctx.activeDiet) lines.push(`🥗 <b style="color:var(--t1)">Dieta</b>: ${ctx.activeDiet.name} (ON: ${ctx.activeDiet.day_on?.kcal || 0} kcal)`);
  else lines.push('🥗 <span style="color:var(--t3)">Nessuna dieta attiva</span>');
  return lines.map(l => `<div style="padding:3px 0;line-height:1.5">${l}</div>`).join('');
}

// ── Chat phase ─────────────────────────────────────────────
function switchToChatPhase() {
  const overlay = document.getElementById('coach-overlay');
  if (!overlay) return;
  const title = session.type === 'workout' ? '🏋️ AI Coach Schede' : '🥗 AI Coach Dieta';

  overlay.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden">
      <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border);flex-shrink:0">
        <button onclick="document.getElementById('coach-overlay').remove()"
          style="background:none;border:none;color:var(--t2);font-size:22px;cursor:pointer;padding:4px 8px;border-radius:8px;line-height:1">←</button>
        <div style="flex:1;min-width:0">
          <div style="font-size:16px;font-weight:900;color:var(--t1)">${title}</div>
          <div id="coach-model-lbl" style="font-size:10px;color:var(--accent);font-weight:600">Powered by Gemini</div>
        </div>
        <button onclick="window._coachRestart()"
          style="background:none;border:1px solid var(--border);color:var(--t3);font-size:11px;cursor:pointer;padding:5px 10px;border-radius:8px;white-space:nowrap">↺ Ricomincia</button>
      </div>

      <div id="coach-messages" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px"></div>

      <div id="coach-plan-banner" style="display:none" class="coach-plan-banner">
        <div style="font-size:13px;font-weight:900;color:var(--accent);margin-bottom:10px">📋 Piano pronto — come vuoi salvarlo?</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <button class="btn btn-ghost btn-sm" onclick="window._applyPlan(true)" style="font-size:12px;padding:10px">🔬 Bozza (inattiva)</button>
          <button class="btn btn-v btn-sm" onclick="window._applyPlan(false)" style="font-size:12px;padding:10px">✅ Salva (inattivo)</button>
        </div>
        <div style="font-size:10px;color:var(--t3);margin-top:6px;text-align:center">Entrambe le opzioni salvano come INATTIVO — attivi manualmente da Schede/Dieta</div>
      </div>

      <div class="coach-input-area" style="flex-wrap:wrap">
        <textarea id="coach-input" class="fi" rows="1" placeholder="Rispondi al coach... (Invio per inviare)"
          style="flex:1;min-width:200px;resize:none;font-size:13px;max-height:100px;overflow-y:auto;line-height:1.4"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window._coachSend()}"
          oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'"></textarea>
        <button id="coach-send-btn" class="coach-send-btn" onclick="window._coachSend()">
          <i class="ri-send-plane-fill"></i>
        </button>
        <button onclick="window._coachFinalize()" class="btn btn-ghost btn-sm" style="width:100%;font-size:11px;margin-top:4px">🏁 Finalizza e Genera Piano Json</button>
      </div>
    </div>`;

  renderMessages();
}

// ── Render messages ────────────────────────────────────────
function fmtMarkdown(raw) {
  return raw
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.*?)\*/g, '<i>$1</i>')
    .replace(/`(.*?)`/g, '<code style="background:rgba(255,255,255,0.1);padding:1px 5px;border-radius:4px;font-size:11px">$1</code>')
    .replace(/^#{1,3}\s+(.+)$/gm, '<b style="font-size:14px;color:var(--t1)">$1</b>')
    .replace(/\n/g, '<br>');
}

function renderMessages() {
  const el = document.getElementById('coach-messages');
  if (!el) return;

  const html = [];
  let lastModelIdx = -1;

  session.messages.forEach((m, i) => {
    if (m.role === 'model' && !m._isError) lastModelIdx = i;
  });

  session.messages.forEach((m, i) => {
    const isUser = m.role === 'user';
    const text = m._displayText || m.parts?.find(p => p.text)?.text || '';
    if (!text.trim()) return;

    if (m._isError) {
      html.push(`
        <div class="coach-msg" style="display:flex;align-items:flex-start">
          <div class="coach-bubble-e">${fmtMarkdown(text)}</div>
        </div>`);
      return;
    }

    html.push(`
      <div class="coach-msg" style="display:flex;flex-direction:column;align-items:${isUser ? 'flex-end' : 'flex-start'};gap:3px">
        <div class="${isUser ? 'coach-bubble-u' : 'coach-bubble-a'}">${fmtMarkdown(text)}</div>
        ${!isUser && m._model ? `<div style="font-size:10px;color:var(--t3);padding:0 4px">${m._model}</div>` : ''}
      </div>`);

    // Show plan preview card after the last AI message that has a plan
    if (!isUser && session.plan && i === lastModelIdx) {
      html.push(`<div class="coach-msg">${renderPlanCard(session.plan, session.type)}</div>`);
    }
  });

  el.innerHTML = html.join('');
  el.scrollTop = el.scrollHeight;

  const banner = document.getElementById('coach-plan-banner');
  if (banner) banner.style.display = session.plan ? 'block' : 'none';
}

function addTypingIndicator() {
  const el = document.getElementById('coach-messages');
  if (!el) return;
  const d = document.createElement('div');
  d.id = 'coach-typing';
  d.className = 'coach-msg';
  d.style.cssText = 'display:flex;align-items:flex-start';
  d.innerHTML = `<div class="coach-bubble-a" style="padding:12px 16px"><div class="coach-dots"><span></span><span></span><span></span></div></div>`;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
}

function removeTypingIndicator() { document.getElementById('coach-typing')?.remove(); }

// ── Global handlers ────────────────────────────────────────
window._coachImgPreview = function(input) {
  const file = input.files[0];
  if (!file) return;
  const preview = document.getElementById('coach-img-preview');
  if (!preview) return;
  const url = URL.createObjectURL(file);
  preview.innerHTML = `
    <img src="${url}" style="max-width:100%;max-height:180px;border-radius:10px;object-fit:cover;display:block">
    <div style="font-size:11px;color:var(--t3);margin-top:4px">${file.name}</div>`;
};

window._coachStart = async function() {
  const goal = document.getElementById('coach-goal')?.value?.trim();
  if (!goal) { showToast('Scrivi prima il tuo obiettivo', 'err'); return; }

  const imgInput = document.getElementById('coach-img');
  let imageData = null;
  if (imgInput?.files?.[0]) {
    const file = imgInput.files[0];
    imageData = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => resolve({ data: reader.result.split(',')[1], mimeType: file.type });
      reader.readAsDataURL(file);
    });
  }

  const ctx = session.context || {};
  session.systemPrompt = buildSystemPrompt(session.type, ctx, goal);

  const firstParts = [{ text: goal }];
  if (imageData) {
    firstParts.push({ text: '[Immagine di riferimento allegata — analizzala]' });
    firstParts.push({ inlineData: imageData });
  }

  session.messages.push({ role: 'user', parts: firstParts, _displayText: goal });
  switchToChatPhase();
  await _sendToGemini();
};

window._coachSend = async function() {
  if (session?.busy) return;
  const input = document.getElementById('coach-input');
  const text = input?.value?.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  session.messages.push({ role: 'user', parts: [{ text }], _displayText: text });
  renderMessages();
  await _sendToGemini();
};

window._coachFinalize = async function() {
  if (session?.busy) return;
  const text = "Perfetto, procediamo. Mostrami il JSON finale strutturato della scheda/dieta senza aggiungere altro, assicurati che i nodi del json e la struttura siano esatti come ti è stato richiesto.";
  session.messages.push({ role: 'user', parts: [{ text }], _displayText: "🏁 Finalizza e Genera Piano" });
  renderMessages();
  await _sendToGemini();
};

window._coachRestart = function() {
  const type = session?.type;
  if (type) openCoachPanel(type);
};

window._applyPlan = async function(isDraft) {
  if (!session?.plan) return;
  const banner = document.getElementById('coach-plan-banner');
  if (banner) banner.innerHTML = `<div style="text-align:center;padding:10px"><div class="spin" style="width:24px;height:24px;margin:0 auto"></div></div>`;

  const ok = await applyPlanToFirestore(session.plan, session.type, isDraft);
  if (ok) {
    const dest = session.type === 'workout' ? 'Schede' : 'Dieta';
    const label = isDraft ? 'Bozza salvata' : 'Piano salvato';
    showToast(`✅ ${label}! Vai su ${dest} per vederlo (è inattivo).`);
    document.getElementById('coach-overlay')?.remove();
    if (session.type === 'diet' && typeof window.loadDiets === 'function') window.loadDiets();
    if (session.type === 'workout' && typeof window.loadPrograms === 'function') window.loadPrograms();
  } else {
    showToast('❌ Errore nel salvataggio. Riprova.', 'err');
    renderMessages();
  }
};

// ── Send to Gemini ─────────────────────────────────────────
async function _sendToGemini() {
  session.busy = true;
  const sendBtn = document.getElementById('coach-send-btn');
  if (sendBtn) sendBtn.disabled = true;
  addTypingIndicator();

  const apiMessages = buildApiMessages(session.messages);
  console.log('[Coach] Sending', apiMessages.length, 'messages, turn', Math.ceil(apiMessages.length / 2));

  const r = await callGemini(apiMessages, session.systemPrompt);

  removeTypingIndicator();
  session.busy = false;
  if (sendBtn) sendBtn.disabled = false;

  if (!r.success) {
    // Inline error bubble — NOT added to API history (filtered by _isError)
    session.messages.push({
      role: 'model',
      parts: [{ text: r.error }],
      _displayText: `❌ ${r.error}\n\nRiprova a inviare il messaggio.`,
      _isError: true
    });
    renderMessages();
    return;
  }

  const plan = extractPlan(r.text, session.type);
  if (plan) session.plan = plan;

  const displayText = cleanDisplayText(r.text, session.type);

  session.messages.push({
    role: 'model',
    parts: [{ text: r.text }],
    _displayText: displayText || r.text,
    _model: r.model
  });

  renderMessages();

  const lbl = document.getElementById('coach-model-lbl');
  if (lbl && r.model) lbl.textContent = r.model;
}
