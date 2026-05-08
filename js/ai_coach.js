import { db, USER_ID, collection, doc, getDoc, getDocs, addDoc, query, orderBy, limit } from './firebase-config.js';
import { showToast } from './app.js';

// ── State ──────────────────────────────────────────────────
let session = null; // { type, messages, context, plan, busy, systemPrompt }

// ── Gemini API ─────────────────────────────────────────────
let _cachedKey = null;
async function getApiKey() {
  if (_cachedKey) return _cachedKey;
  try {
    const s = await getDoc(doc(db, 'users', USER_ID, 'settings', 'gemini'));
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
  if (!key) return { success: false, error: 'API key mancante' };

  for (const model of MODELS) {
    try {
      const body = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: messages,
        generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
      };
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      if (r.status === 429) { console.warn(model, '429 rate limit, next...'); continue; }
      if (!r.ok) { console.warn(model, r.status); continue; }
      const d = await r.json();
      const text = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      if (!text) { console.warn(model, 'empty response'); continue; }
      return { success: true, text, model };
    } catch(e) { console.warn(model, e.message); continue; }
  }
  return { success: false, error: 'Tutti i modelli occupati. Riprova tra 1 minuto.' };
}

// ── Context loader ─────────────────────────────────────────
async function loadContext() {
  const ctx = {};
  try {
    const snap = await getDocs(query(collection(db, 'users', USER_ID, 'checks'), orderBy('date', 'desc'), limit(1)));
    if (!snap.empty) ctx.lastCheck = snap.docs[0].data();
  } catch(e) {}
  try {
    const snap = await getDocs(collection(db, 'users', USER_ID, 'programs'));
    const active = snap.docs.find(d => d.data().active);
    if (active) ctx.activeProgram = { id: active.id, ...active.data() };
    else if (!snap.empty) ctx.activeProgram = { id: snap.docs[0].id, ...snap.docs[0].data() };
  } catch(e) {}
  try {
    const snap = await getDocs(collection(db, 'users', USER_ID, 'diet_plans'));
    const active = snap.docs.find(d => d.data().active);
    if (active) ctx.activeDiet = { id: active.id, ...active.data() };
    else if (!snap.empty) ctx.activeDiet = { id: snap.docs[0].id, ...snap.docs[0].data() };
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
  const bicep = ms.bicep ?? ((ms.bicep_l != null && ms.bicep_r != null) ? ((ms.bicep_l + ms.bicep_r) / 2) : null);
  if (bicep != null) parts.push(`Braccia: ${parseFloat(bicep).toFixed(1)}cm`);
  const thigh = ms.thigh ?? ((ms.thigh_l != null && ms.thigh_r != null) ? ((ms.thigh_l + ms.thigh_r) / 2) : null);
  if (thigh != null) parts.push(`Gambe: ${parseFloat(thigh).toFixed(1)}cm`);
  return parts.join(', ') || 'nessuna misura';
}

function fmtProgram(p) {
  if (!p) return 'nessuna scheda';
  const days = Object.keys(p.schedule || {});
  const exCount = days.reduce((t, d) => t + (p.schedule[d]?.exercises?.length || 0), 0);
  return `"${p.name}" — ${days.length} giorni/sett. (${days.join(', ')}), ${exCount} esercizi totali`;
}

function fmtDiet(d) {
  if (!d) return 'nessuna dieta';
  const on = d.day_on || {};
  const off = d.day_off || {};
  const meals = (on.meals || []).map(m => `${m.label || m.type} ${m.time ? `(${m.time})` : ''}: ${m.kcal}kcal`).join(', ');
  return `"${d.name}" — ON: ${on.kcal||0}kcal / P${on.protein||0}g C${on.carbs||0}g F${on.fats||0}g | OFF: ${off.kcal||0}kcal${meals ? ` | Pasti ON: ${meals}` : ''}`;
}

function buildSystemPrompt(type, ctx, goal) {
  const ctxBlock = `
📊 DATI ATLETA AGGIORNATI:
• Ultimo check (${ctx.lastCheck?.date || 'n/d'}): ${fmtCheck(ctx.lastCheck)}
• Scheda attuale: ${fmtProgram(ctx.activeProgram)}
• Dieta attuale: ${fmtDiet(ctx.activeDiet)}
• Obiettivo dichiarato: ${goal}
`;

  if (type === 'workout') {
    return `Sei KOVA Coach, un personal trainer d'élite. Parli SEMPRE in italiano. Sei diretto, tecnico e motivante.
${ctxBlock}
Il tuo compito è progettare un programma di allenamento personalizzato attraverso una conversazione.

LINEE GUIDA:
• Proponi subito un piano COMPLETO e DETTAGLIATO: giorni, esercizi, serie, ripetizioni, recuperi, note tecniche
• Usa progressioni scientifiche (periodizzazione, sovraccarico progressivo)
• Considera l'esperienza attuale dell'atleta dedotta dai dati
• Sii specifico: angolazioni, prese, accorgimenti tecnici quando rilevante
• Dopo la proposta, chiedi feedback e raffina il piano
• Se l'utente invia un'immagine di riferimento fisico, analizzala e commenta come il piano si allinea a quell'obiettivo

QUANDO L'UTENTE È SODDISFATTO E VUOLE SALVARE, inserisci il JSON in questo formato ESATTO:

<SCHEDA_JSON>
{
  "name": "Nome del Piano",
  "schedule": {
    "lunedi": {
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

Giorni validi (in italiano minuscolo): lunedi, martedi, mercoledi, giovedi, venerdi, sabato, domenica.
Il campo "cardio" è null o una stringa descrittiva (es. "20 min LISS 130bpm").
Includi il JSON SOLO quando l'utente chiede esplicitamente di salvare/finalizzare.`;

  } else {
    return `Sei KOVA Coach, un nutrizionista sportivo d'élite. Parli SEMPRE in italiano. Sei preciso, scientifico e motivante.
${ctxBlock}
Il tuo compito è progettare un piano alimentare personalizzato attraverso una conversazione.

LINEE GUIDA:
• Proponi subito un piano COMPLETO con macro giorno ON e OFF, e tutti i pasti dettagliati
• Indica alimenti specifici con grammature, macro per pasto, timing ottimale
• Considera l'obiettivo, il peso attuale, l'intensità degli allenamenti
• Usa principi scientifici: timing proteico, carboidrati peri-workout, grassi sani
• Proponi varianti pratiche per ogni pasto
• Dopo la proposta, chiedi feedback e raffina

QUANDO L'UTENTE È SODDISFATTO E VUOLE SALVARE, inserisci il JSON in questo formato ESATTO:

<DIETA_JSON>
{
  "name": "Nome del Piano",
  "day_on": {
    "kcal": 0,
    "protein": 0,
    "carbs": 0,
    "fats": 0,
    "meals": [
      { "type": "colazione", "label": "Colazione", "time": "07:30", "items": "Descrizione ingredienti", "kcal": 0, "protein": 0, "carbs": 0, "fats": 0, "variants": null }
    ]
  },
  "day_off": {
    "kcal": 0,
    "protein": 0,
    "carbs": 0,
    "fats": 0,
    "meals": []
  }
}
</DIETA_JSON>

Tipi pasto validi: colazione, pre_workout, post_workout, spuntino, pranzo, merenda, cena.
I macro totali (kcal/protein/carbs/fats) DEVONO essere la somma esatta dei singoli pasti.
Includi il JSON SOLO quando l'utente chiede esplicitamente di salvare/finalizzare.`;
  }
}

// ── Plan extraction ────────────────────────────────────────
function extractPlan(text, type) {
  const tag = type === 'workout' ? 'SCHEDA_JSON' : 'DIETA_JSON';
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const m = text.match(re);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch(e) { console.warn('Plan parse error:', e); return null; }
}

function cleanDisplayText(text, type) {
  const tag = type === 'workout' ? 'SCHEDA_JSON' : 'DIETA_JSON';
  return text.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'g'), '').trim();
}

// ── Apply plan to Firestore ────────────────────────────────
async function applyPlanToFirestore(plan, type, isDraft) {
  const prefix = isDraft ? '🔬 Bozza AI — ' : '';
  try {
    if (type === 'workout') {
      await addDoc(collection(db, 'users', USER_ID, 'programs'), {
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
          items: m.items || '', kcal: Number(m.kcal) || 0,
          protein: Number(m.protein) || 0, carbs: Number(m.carbs) || 0,
          fats: Number(m.fats) || 0, variants: m.variants || null
        }));
        const sum = meals.reduce((a, m) => ({
          kcal: a.kcal + m.kcal, protein: a.protein + m.protein,
          carbs: a.carbs + m.carbs, fats: a.fats + m.fats
        }), { kcal: 0, protein: 0, carbs: 0, fats: 0 });
        return { ...sum, meals };
      };
      await addDoc(collection(db, 'users', USER_ID, 'diet_plans'), {
        name: prefix + plan.name,
        active: false,
        updated_at: new Date().toISOString(),
        day_on: fixDay(plan.day_on),
        day_off: fixDay(plan.day_off)
      });
    }
    return true;
  } catch(e) { console.error('Apply plan error:', e); return false; }
}

// ── Inject styles once ─────────────────────────────────────
function injectStyles() {
  if (document.getElementById('coach-style')) return;
  const style = document.createElement('style');
  style.id = 'coach-style';
  style.textContent = `
    @keyframes coachSlideUp { from { transform:translateY(100%); opacity:0; } to { transform:translateY(0); opacity:1; } }
    @keyframes coachFadeIn  { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
    @keyframes coachPulse   { 0%,100% { opacity:0.3; transform:scale(0.8); } 50% { opacity:1; transform:scale(1); } }
    .coach-overlay { position:fixed;inset:0;background:var(--bg);z-index:9999;display:flex;flex-direction:column;animation:coachSlideUp 0.3s ease-out; }
    .coach-msg { animation:coachFadeIn 0.25s ease-out; }
    .coach-dots span { display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent);margin:0 2px;animation:coachPulse 1.2s infinite; }
    .coach-dots span:nth-child(2) { animation-delay:0.2s; }
    .coach-dots span:nth-child(3) { animation-delay:0.4s; }
    .coach-bubble-user { background:var(--accent);color:#fff;border-radius:18px 18px 4px 18px; }
    .coach-bubble-ai   { background:var(--card);color:var(--t1);border-radius:4px 18px 18px 18px; }
    .coach-input-area  { display:flex;gap:8px;align-items:flex-end;padding:12px 16px;border-top:1px solid var(--border);background:var(--bg);flex-shrink:0; }
    .coach-send-btn    { width:44px;height:44px;border-radius:12px;border:none;background:var(--accent);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:16px;transition:opacity 0.2s; }
    .coach-send-btn:disabled { opacity:0.4;cursor:default; }
    .coach-plan-banner { padding:14px 16px;border-top:1px solid rgba(124,111,255,0.4);background:linear-gradient(135deg,rgba(124,111,255,0.18),rgba(124,111,255,0.06));flex-shrink:0; }
  `;
  document.head.appendChild(style);
}

// ── Open panel ─────────────────────────────────────────────
export function openCoachPanel(type) {
  injectStyles();
  session = { type, messages: [], context: null, plan: null, busy: false, systemPrompt: '' };

  let overlay = document.getElementById('coach-overlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
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
  const type = session.type;
  const title = type === 'workout' ? '🏋️ AI Coach Schede' : '🥗 AI Coach Dieta';
  const ph = type === 'workout'
    ? 'Es: Voglio aumentare la massa muscolare, mi alleno 4 volte a settimana, ho buona esperienza con i pesi da 2 anni...'
    : 'Es: Voglio fare un bulk lean, parto da 80kg, mi alleno 4 volte a settimana, lavoro d\'ufficio...';

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

        <div class="card" style="background:linear-gradient(135deg,rgba(124,111,255,0.15),rgba(124,111,255,0.04));border:1px solid rgba(124,111,255,0.25);margin:0">
          <div style="font-size:13px;font-weight:800;color:var(--accent);margin-bottom:6px">✨ Come funziona</div>
          <div style="font-size:12px;color:var(--t2);line-height:1.65">
            Descrivi il tuo obiettivo. Il coach analizzerà i tuoi dati attuali (check, scheda, dieta) e creerà un piano personalizzato.
            Puoi chattare per raffinarlo, poi salvarlo come bozza o definitivo.
          </div>
        </div>

        <div class="card" style="margin:0">
          <div style="font-size:11px;font-weight:800;color:var(--t3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Dati caricati</div>
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
          <div style="font-size:11px;color:var(--t3);margin-bottom:10px">Fisico obiettivo, atleta di riferimento — il coach lo analizzerà</div>
          <input type="file" id="coach-img" accept="image/*" style="display:none" onchange="window._coachImgPreview(this)">
          <button onclick="document.getElementById('coach-img').click()" class="btn btn-ghost btn-sm" style="width:auto">
            📷 Scegli immagine
          </button>
          <div id="coach-img-preview" style="margin-top:10px"></div>
        </div>

      </div>

      <div style="padding:16px;border-top:1px solid var(--border);flex-shrink:0">
        <button class="btn btn-v" style="width:100%;font-size:15px;padding:14px;font-weight:800" onclick="window._coachStart()">
          🚀 Inizia la sessione con il Coach
        </button>
      </div>
    </div>`;
}

function renderContextSummary(ctx) {
  const lines = [];
  if (ctx.lastCheck) {
    lines.push(`⚖️ <b style="color:var(--t1)">Ultimo check</b> (${ctx.lastCheck.date}): ${ctx.lastCheck.weight || '?'}kg`);
    const ms = ctx.lastCheck.measurements || {};
    if (ms.waist) lines.push(`📏 Vita: ${ms.waist}cm${ms.chest ? `, Petto: ${ms.chest}cm` : ''}${ms.shoulders ? `, Spalle: ${ms.shoulders}cm` : ''}`);
  } else {
    lines.push('⚖️ <span style="color:var(--t3)">Nessun check trovato</span>');
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
          style="background:none;border:1px solid var(--border);color:var(--t3);font-size:11px;cursor:pointer;padding:5px 10px;border-radius:8px;white-space:nowrap">
          ↺ Ricomincia
        </button>
      </div>

      <div id="coach-messages" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px"></div>

      <div id="coach-plan-banner" style="display:none" class="coach-plan-banner">
        <div style="font-size:13px;font-weight:900;color:var(--accent);margin-bottom:10px">📋 Piano pronto! Come vuoi salvarlo?</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <button class="btn btn-ghost btn-sm" onclick="window._applyPlan(true)" style="font-size:12px;padding:10px">
            🔬 Bozza (simulatore)
          </button>
          <button class="btn btn-v btn-sm" onclick="window._applyPlan(false)" style="font-size:12px;padding:10px">
            ✅ Salva definitivo
          </button>
        </div>
        <div style="font-size:10px;color:var(--t3);margin-top:6px;text-align:center">La bozza non sostituisce il piano attivo</div>
      </div>

      <div class="coach-input-area">
        <textarea id="coach-input" class="fi" rows="1" placeholder="Scrivi al coach... (Invio per inviare)"
          style="flex:1;resize:none;font-size:13px;max-height:100px;overflow-y:auto;line-height:1.4"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window._coachSend()}"
          oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'"></textarea>
        <button id="coach-send-btn" class="coach-send-btn" onclick="window._coachSend()">
          <i class="ri-send-plane-fill"></i>
        </button>
      </div>
    </div>`;

  renderMessages();
}

function renderMessages() {
  const el = document.getElementById('coach-messages');
  if (!el) return;

  el.innerHTML = session.messages.map(m => {
    const isUser = m.role === 'user';
    const text = m._displayText || m.parts?.find(p => p.text)?.text || '';
    if (!text.trim()) return '';
    const formatted = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.*?)\*/g, '<i>$1</i>')
      .replace(/`(.*?)`/g, '<code style="background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:4px;font-size:12px">$1</code>')
      .replace(/\n/g, '<br>');
    return `
      <div class="coach-msg" style="display:flex;flex-direction:column;align-items:${isUser ? 'flex-end' : 'flex-start'};gap:3px">
        <div class="${isUser ? 'coach-bubble-user' : 'coach-bubble-ai'}"
          style="max-width:88%;padding:11px 14px;font-size:13px;line-height:1.6;word-break:break-word">
          ${formatted}
        </div>
        ${!isUser && m._model ? `<div style="font-size:10px;color:var(--t3);padding:0 4px">${m._model}</div>` : ''}
      </div>`;
  }).join('');

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
  d.innerHTML = `
    <div class="coach-bubble-ai" style="padding:12px 16px">
      <div class="coach-dots"><span></span><span></span><span></span></div>
    </div>`;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
}

function removeTypingIndicator() {
  document.getElementById('coach-typing')?.remove();
}

// ── Global handlers (accessible from inline onclick) ───────
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
    firstParts.push({ text: '\n[Ho allegato un\'immagine di riferimento fisico — analizzala nel contesto del mio obiettivo]' });
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

window._coachRestart = function() {
  const type = session?.type;
  if (type) openCoachPanel(type);
};

window._applyPlan = async function(isDraft) {
  if (!session?.plan) return;
  const banner = document.getElementById('coach-plan-banner');
  if (banner) banner.innerHTML = `<div style="text-align:center;padding:8px"><div class="spin" style="width:24px;height:24px;margin:0 auto"></div></div>`;

  const ok = await applyPlanToFirestore(session.plan, session.type, isDraft);
  if (ok) {
    const dest = session.type === 'workout' ? 'Schede' : 'Dieta';
    const label = isDraft ? 'Bozza salvata' : 'Piano salvato';
    showToast(`✅ ${label}! Vai su ${dest} per vederlo.`);
    document.getElementById('coach-overlay')?.remove();
  } else {
    showToast('❌ Errore nel salvataggio. Riprova.', 'err');
    renderMessages();
  }
};

async function _sendToGemini() {
  session.busy = true;
  const sendBtn = document.getElementById('coach-send-btn');
  if (sendBtn) sendBtn.disabled = true;

  addTypingIndicator();

  const apiMessages = session.messages.map(m => ({ role: m.role, parts: m.parts }));
  const r = await callGemini(apiMessages, session.systemPrompt);

  removeTypingIndicator();
  session.busy = false;
  if (sendBtn) sendBtn.disabled = false;

  if (!r.success) {
    showToast('❌ ' + r.error, 'err');
    return;
  }

  const plan = extractPlan(r.text, session.type);
  if (plan) session.plan = plan;

  const displayText = plan ? cleanDisplayText(r.text, session.type) : r.text;

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
