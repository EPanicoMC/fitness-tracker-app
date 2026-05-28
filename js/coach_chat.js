/**
 * KOVA Coach Chat — chat AI multi-turno con contesto completo dell'utente
 * Funziona come modulo autonomo, si inietta in tutte le pagine principali.
 */

import { chatWithCoach } from './gemini.js';
import { db, getUserId } from './firebase-config.js';
import { doc, getDoc, getDocs, collection, query, orderBy, limit } from './firebase-config.js';

let chatMessages = []; // { role: 'user'|'coach', content: string }
let userContext = null;
let isCoachTyping = false;

// ── Build context string from user data ─────────────────────
async function buildUserContext() {
  try {
    const uid = getUserId();
    if (!uid) return null;

    const [settingsSnap, checkSnap, logSnap, progSnap, dietSnap] = await Promise.all([
      getDoc(doc(db, 'users', uid, 'settings', 'app')).catch(() => null),
      getDocs(query(collection(db, 'users', uid, 'body_checks'), orderBy('date', 'desc'), limit(1))).catch(() => null),
      getDocs(query(collection(db, 'users', uid, 'daily_logs'), orderBy('date', 'desc'), limit(7))).catch(() => null),
      getDocs(query(collection(db, 'users', uid, 'programs'), limit(1))).catch(() => null),
      getDocs(query(collection(db, 'users', uid, 'diet_plans'), limit(1))).catch(() => null),
    ]);

    const settings = settingsSnap?.data() || {};
    const profile = settings.profile || {};
    const latestCheck = checkSnap?.docs?.[0]?.data() || null;
    const recentLogs = logSnap?.docs?.map(d => d.data()) || [];
    const activeProgram = progSnap?.docs?.[0]?.data() || null;
    const activeDiet = dietSnap?.docs?.[0]?.data() || null;

    let ctx = `=== PROFILO ATLETA ===\n`;
    ctx += `Nome: ${profile.name || 'Non specificato'}\n`;
    ctx += `Età: ${profile.age || '?'} anni | Sesso: ${profile.sex === 'M' ? 'Maschile' : profile.sex === 'F' ? 'Femminile' : '?'}\n`;
    ctx += `Altezza: ${profile.height || '?'} cm\n`;
    ctx += `Obiettivo peso: ${profile.weight_target || '?'} kg\n`;
    ctx += `Obiettivo passi: ${profile.steps_goal || '?'} passi/giorno\n`;

    if (latestCheck) {
      ctx += `\n=== ULTIMO CHECK (${latestCheck.date}) ===\n`;
      ctx += `Peso: ${latestCheck.weight || '?'} kg\n`;
      const ms = latestCheck.measurements || {};
      if (ms.chest) ctx += `Petto: ${ms.chest} cm | `;
      if (ms.waist) ctx += `Vita: ${ms.waist} cm | `;
      if (ms.hips) ctx += `Fianchi: ${ms.hips} cm\n`;
    }

    if (activeProgram) {
      ctx += `\n=== SCHEDA ALLENAMENTO ATTIVA ===\n`;
      ctx += `Nome: ${activeProgram.name || '?'}\n`;
      const schedule = activeProgram.schedule || {};
      Object.entries(schedule).forEach(([day, session]) => {
        if (session) ctx += `- ${day}: ${session.name} (${session.exercises?.length || 0} esercizi)\n`;
      });
    }

    if (activeDiet) {
      ctx += `\n=== PIANO DIETA ATTIVO ===\n`;
      ctx += `Nome: ${activeDiet.name || '?'}\n`;
      const on = activeDiet.day_on;
      const off = activeDiet.day_off;
      if (on) ctx += `Giorno ON: ${on.kcal} kcal | P:${on.protein}g C:${on.carbs}g F:${on.fats}g\n`;
      if (off) ctx += `Giorno OFF: ${off.kcal} kcal | P:${off.protein}g C:${off.carbs}g F:${off.fats}g\n`;
    }

    if (recentLogs.length > 0) {
      ctx += `\n=== ULTIMI 7 GIORNI ===\n`;
      recentLogs.slice(0, 7).forEach(log => {
        const kcal = log.nutrition?.totals?.kcal || 0;
        const pro = log.nutrition?.totals?.protein || 0;
        const wk = log.workout?.completed ? `✅ ${log.workout.session_name || 'Allenamento'}` : (log.is_training_day ? '❌ Non allenato' : '😴 Riposo');
        const steps = log.steps ? `${log.steps} passi` : '';
        const note = log.daily_note ? `Nota: "${log.daily_note.substring(0, 60)}"` : '';
        ctx += `${log.date}: ${kcal > 0 ? `${kcal}kcal / ${Math.round(pro)}gPro` : 'Non loggato'} | ${wk}${steps ? ' | ' + steps : ''}${note ? ' | ' + note : ''}\n`;
      });
    }

    return ctx;
  } catch(e) {
    console.warn('Coach context build failed:', e);
    return 'Contesto non disponibile al momento.';
  }
}

// ── Render messages ─────────────────────────────────────────
function renderMessages() {
  const container = document.getElementById('coach-chat-messages');
  if (!container) return;

  if (chatMessages.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:32px 16px;">
        <div style="font-size:32px;margin-bottom:12px">🧠</div>
        <div style="font-size:14px;font-weight:700;color:var(--t1);margin-bottom:8px">KOVA Coach</div>
        <div style="font-size:13px;color:var(--t2);line-height:1.6">
          Ciao! Sono il tuo coach AI personale.<br>
          Conosco il tuo profilo, i tuoi allenamenti e la tua alimentazione.<br>
          Chiedimi tutto quello che vuoi! 💪
        </div>
      </div>`;
    return;
  }

  container.innerHTML = chatMessages.map(m => {
    const isUser = m.role === 'user';
    const text = m.content
      .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
      .replace(/\n/g, '<br>');
    return `
      <div style="display:flex;flex-direction:${isUser ? 'row-reverse' : 'row'};gap:8px;margin-bottom:12px;align-items:flex-end">
        ${!isUser ? `<div style="width:28px;height:28px;background:linear-gradient(135deg,rgba(124,111,255,0.3),rgba(255,106,0,0.2));border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">🧠</div>` : ''}
        <div style="
          max-width:82%;
          padding:10px 14px;
          border-radius:${isUser ? '18px 18px 4px 18px' : '18px 18px 18px 4px'};
          font-size:13px;
          line-height:1.6;
          ${isUser
            ? 'background:var(--accent);color:#fff;'
            : 'background:rgba(255,255,255,0.06);color:var(--t1);border:1px solid rgba(255,255,255,0.06);'}
        ">${text}</div>
      </div>`;
  }).join('');

  if (isCoachTyping) {
    container.innerHTML += `
      <div style="display:flex;gap:8px;margin-bottom:12px;align-items:flex-end">
        <div style="width:28px;height:28px;background:linear-gradient(135deg,rgba(124,111,255,0.3),rgba(255,106,0,0.2));border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">🧠</div>
        <div style="padding:10px 14px;border-radius:18px 18px 18px 4px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.06)">
          <div style="display:flex;gap:4px;align-items:center">
            <span style="width:6px;height:6px;background:var(--t3);border-radius:50%;animation:coachDot 1.2s infinite" class="cdot1"></span>
            <span style="width:6px;height:6px;background:var(--t3);border-radius:50%;animation:coachDot 1.2s 0.2s infinite" class="cdot2"></span>
            <span style="width:6px;height:6px;background:var(--t3);border-radius:50%;animation:coachDot 1.2s 0.4s infinite" class="cdot3"></span>
          </div>
        </div>
      </div>`;
  }

  container.scrollTop = container.scrollHeight;
}

// ── Send message ─────────────────────────────────────────────
async function sendCoachMessage() {
  const input = document.getElementById('coach-chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text || isCoachTyping) return;

  input.value = '';
  input.style.height = '40px';

  chatMessages.push({ role: 'user', content: text });
  isCoachTyping = true;
  renderMessages();

  // Build context if not yet loaded
  if (!userContext) {
    userContext = await buildUserContext();
  }

  // Convert to API format (only user/model turns, not the greeting)
  const apiMessages = chatMessages.map(m => ({
    role: m.role === 'user' ? 'user' : 'model',
    content: m.content
  }));

  try {
    const result = await chatWithCoach(apiMessages, userContext);
    isCoachTyping = false;
    if (result.success) {
      chatMessages.push({ role: 'coach', content: result.reply });
    } else {
      chatMessages.push({ role: 'coach', content: `⚠️ ${result.error}` });
    }
  } catch(e) {
    isCoachTyping = false;
    chatMessages.push({ role: 'coach', content: '⚠️ Errore di connessione. Riprova.' });
  }

  renderMessages();
}

// ── Create FAB + Modal HTML ──────────────────────────────────
function injectCoachUI() {
  // Don't double-inject
  if (document.getElementById('coach-fab')) return;

  // FAB button
  const fab = document.createElement('button');
  fab.id = 'coach-fab';
  fab.innerHTML = `<span style="font-size:22px">🧠</span>`;
  fab.title = 'Chat con KOVA Coach';
  document.body.appendChild(fab);

  // Modal
  const modal = document.createElement('div');
  modal.id = 'coach-chat-modal';
  modal.innerHTML = `
    <div id="coach-chat-sheet">
      <!-- Header -->
      <div id="coach-chat-header">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:38px;height:38px;background:linear-gradient(135deg,rgba(124,111,255,0.25),rgba(255,106,0,0.15));border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;border:1px solid rgba(124,111,255,0.25)">🧠</div>
          <div>
            <div style="font-size:14px;font-weight:800;color:var(--t1)">KOVA Coach</div>
            <div style="font-size:11px;color:var(--green);font-weight:700;display:flex;align-items:center;gap:4px">
              <span style="width:6px;height:6px;background:var(--green);border-radius:50%;display:inline-block"></span>
              Online · AI Personale
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button id="coach-new-chat" title="Nuova chat">
            <i class="ri-refresh-line" style="font-size:16px;color:var(--t3)"></i>
          </button>
          <button id="coach-close-btn">
            <i class="ri-close-line" style="font-size:20px;color:var(--t3)"></i>
          </button>
        </div>
      </div>

      <!-- Messages -->
      <div id="coach-chat-messages"></div>

      <!-- Input area -->
      <div id="coach-chat-input-area">
        <textarea
          id="coach-chat-input"
          placeholder="Chiedi al tuo coach..."
          rows="1"
          maxlength="500"
        ></textarea>
        <button id="coach-send-btn">
          <i class="ri-send-plane-fill" style="font-size:18px"></i>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Inject styles
  const style = document.createElement('style');
  style.textContent = `
    #coach-fab {
      position: fixed;
      bottom: calc(80px + max(0px, env(safe-area-inset-bottom)));
      right: 16px;
      width: 52px;
      height: 52px;
      border-radius: 50%;
      background: linear-gradient(135deg, rgba(124,111,255,0.85), rgba(255,106,0,0.7));
      border: 1px solid rgba(255,255,255,0.15);
      box-shadow: 0 4px 20px rgba(124,111,255,0.4), 0 2px 8px rgba(0,0,0,0.3);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 400;
      transition: transform 0.2s cubic-bezier(.34,1.56,.64,1), box-shadow 0.2s;
      backdrop-filter: blur(8px);
    }
    #coach-fab:hover { transform: scale(1.08); box-shadow: 0 6px 28px rgba(124,111,255,0.55); }
    #coach-fab:active { transform: scale(0.95); }
    #coach-fab.hidden { transform: scale(0) !important; opacity: 0; pointer-events: none; }

    #coach-chat-modal {
      position: fixed;
      inset: 0;
      z-index: 600;
      display: flex;
      align-items: flex-end;
      justify-content: center;
      background: rgba(0,0,0,0.6);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s ease;
    }
    #coach-chat-modal.open {
      opacity: 1;
      pointer-events: all;
    }
    #coach-chat-sheet {
      width: 100%;
      max-width: 430px;
      height: 72vh;
      max-height: 680px;
      background: rgba(18,18,22,0.98);
      border-radius: 24px 24px 0 0;
      border-top: 1px solid rgba(255,255,255,0.08);
      display: flex;
      flex-direction: column;
      transform: translateY(100%);
      transition: transform 0.3s cubic-bezier(.34,1.2,.64,1);
      overflow: hidden;
      padding-bottom: max(16px, env(safe-area-inset-bottom));
    }
    #coach-chat-modal.open #coach-chat-sheet {
      transform: translateY(0);
    }
    #coach-chat-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 16px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
    }
    #coach-chat-header button {
      background: none;
      border: none;
      cursor: pointer;
      padding: 4px;
      border-radius: 8px;
      transition: background 0.15s;
    }
    #coach-chat-header button:hover { background: rgba(255,255,255,0.07); }
    #coach-chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
    }
    #coach-chat-input-area {
      display: flex;
      gap: 8px;
      padding: 10px 16px;
      border-top: 1px solid rgba(255,255,255,0.06);
      align-items: flex-end;
      flex-shrink: 0;
    }
    #coach-chat-input {
      flex: 1;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 20px;
      padding: 10px 16px;
      color: var(--t1);
      font-size: 14px;
      font-family: inherit;
      resize: none;
      outline: none;
      min-height: 40px;
      max-height: 120px;
      line-height: 1.4;
      transition: border-color 0.2s;
      overflow-y: auto;
    }
    #coach-chat-input:focus { border-color: rgba(124,111,255,0.5); }
    #coach-chat-input::placeholder { color: var(--t3); }
    #coach-send-btn {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: var(--accent);
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      flex-shrink: 0;
      transition: transform 0.15s, opacity 0.15s;
    }
    #coach-send-btn:active { transform: scale(0.92); opacity: 0.8; }
    @keyframes coachDot {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
      30% { transform: translateY(-4px); opacity: 1; }
    }
  `;
  document.head.appendChild(style);

  // Event listeners
  fab.onclick = openChat;
  document.getElementById('coach-close-btn').onclick = closeChat;
  document.getElementById('coach-new-chat').onclick = () => {
    chatMessages = [];
    renderMessages();
  };
  document.getElementById('coach-send-btn').onclick = sendCoachMessage;

  const input = document.getElementById('coach-chat-input');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCoachMessage();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = '40px';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  // Close on backdrop click
  modal.addEventListener('click', e => {
    if (e.target === modal) closeChat();
  });

  renderMessages();
}

function openChat() {
  const modal = document.getElementById('coach-chat-modal');
  const fab = document.getElementById('coach-fab');
  if (modal) modal.classList.add('open');
  if (fab) fab.classList.add('hidden');
  setTimeout(() => document.getElementById('coach-chat-input')?.focus(), 350);
}

function closeChat() {
  const modal = document.getElementById('coach-chat-modal');
  const fab = document.getElementById('coach-fab');
  if (modal) modal.classList.remove('open');
  if (fab) fab.classList.remove('hidden');
}

// ── Auto-init ────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  injectCoachUI();
});

// Also init if DOM is already loaded (module defer)
if (document.readyState !== 'loading') {
  injectCoachUI();
}
