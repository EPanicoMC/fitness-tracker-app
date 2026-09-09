import { requireAuth, loadSmart } from './app.js';
import {
  db, getUserId, collection, doc, getDoc, getDocs, setDoc, query, orderBy, limit
} from './firebase-config.js';
import { getTodayString, getDayOfWeek, showToast, showModal, fmtTimer, DAYS_IT, DAY_ORDER } from './app.js';

function calcTotalVolume() {
  return exState.reduce((total, ex) =>
    total + ex.sets.reduce((s, set) => {
      if (!set.done) return s;
      const w = parseFloat(set.actual_weight) || 0;
      const r = parseInt(set.actual_reps) || parseInt(set.reps_target) || 0;
      return s + (w * r);
    }, 0), 0);
}
import { AutoComplete, saveToLibrary } from './autocomplete.js';
import { generateSessionFeedbackAI, generateExerciseTipsAI } from './gemini.js';

const TODAY = getTodayString();
let programData      = null;
let sessionData      = null;
let exState          = [];
let sessionSec       = 0;
let sessionStartTime = 0;
let sessionPausedMs  = 0;
let sessionPausedAt  = 0;
let sessionInt       = null;
let restSec          = 0;
let restEndTime      = 0;
let restInt          = null;
let isPaused         = false;
let sessionStarted   = false;
let wakeLock         = null;
let customExList     = [];

// ── Wake Lock ──────────────────────────────────────────────
async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch(e) {}
}
function releaseWakeLock() { if (wakeLock) { wakeLock.release(); wakeLock = null; } }

// ── Notification helpers ───────────────────────────────────
function beep() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.5);
  } catch(e) {}
}

function postToSW(msg) {
  navigator.serviceWorker?.controller?.postMessage(msg);
}
async function requestNotifPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

// ── Load select screen ─────────────────────────────────────
async function loadSessionSelect() {
  const userId = getUserId();
  if (!userId) {
    console.warn("User ID is not defined yet.");
    return;
  }
  const refs = [
    collection(db, 'users', userId, 'programs'),
    query(collection(db, 'users', userId, 'daily_logs'), orderBy('date', 'desc'), limit(30))
  ];

  try {
    await loadSmart(refs, (snaps) => {
      const [progSnap, logsSnap] = snaps;
      const activeDoc = progSnap.docs.find(d => d.data().active);
      if (!activeDoc) {
        document.getElementById('all-sessions').innerHTML =
          '<div class="empty"><span class="ei">💪</span><p>Nessun programma attivo.<br><a href="programs.html" style="color:var(--accent)">Crea un programma</a></p></div>';
        return;
      }
      programData = { id: activeDoc.id, ...activeDoc.data() };

      const dow       = getDayOfWeek(TODAY);
      const todayLog  = logsSnap.docs.find(d => d.data().date === TODAY)?.data();
      const lastDone  = todayLog?.workout?.completed
        ? todayLog
        : logsSnap.docs.find(d => d.data().date !== TODAY && d.data().workout?.completed)?.data();

      // Suggested session: next after last done
      const days = DAY_ORDER.filter(d => programData.schedule?.[d]);
      let suggested = days.find(d => d === dow) || days[0];
      if (lastDone?.workout?.session_day) {
        const lastIdx = days.indexOf(lastDone.workout.session_day);
        suggested = days[(lastIdx + 1) % days.length] || days[0];
      }

      if (suggested && programData.schedule[suggested]) {
        const s = programData.schedule[suggested];
        document.getElementById('sug-name').textContent = s.name;
        document.getElementById('sug-meta').textContent =
          `${DAYS_IT[suggested]} · ${s.exercises?.length || 0} esercizi${s.cardio ? ' + ' + s.cardio.type : ''}`;
        document.getElementById('suggested-card').style.display = 'block';
        document.getElementById('sug-btn').onclick = () => startWithSession(suggested);
      }

      // All sessions list
      const listEl = document.getElementById('all-sessions');
      listEl.innerHTML = days.map(d => {
        const s = programData.schedule[d];
        const isToday = d === dow;
        return `
          <div class="ss-card ${isToday ? 'card-o' : ''}" onclick="startWithSession('${d}')">
            <div>
              <div class="ss-name">${s.name}</div>
              <div class="ss-meta">${DAYS_IT[d]}${s.time ? ' · ' + s.time : ''} · ${s.exercises?.length||0} esercizi${s.cardio ? ' · 🏃 ' + s.cardio.type : ''}</div>
            </div>
            <button class="btn btn-o btn-sm" style="flex-shrink:0">▶️</button>
          </div>`;
      }).join('');
    });
  } catch (e) {
    console.error('loadSessionSelect error:', e);
    showToast('Errore caricamento sessioni dal cloud', 'err');
  }
}

// ── Start session ──────────────────────────────────────────
window.startWithSession = async function(dayKey) {
  const session = programData?.schedule?.[dayKey];
  if (!session) { showToast('Sessione non trovata', 'err'); return; }

  // Load last session for weight pre-fill (from last_sessions first, then daily_logs)
  let prevLog = null;
  const lastDocRef = doc(db, 'users', getUserId(), 'last_sessions', dayKey);
  const dailyLogsQuery = query(collection(db, 'users', getUserId(), 'daily_logs'), orderBy('date', 'desc'), limit(20));

  let exerciseTips = [];
  let lastCoachSummary = null;
  try {
    const lastSnap = await getDoc(lastDocRef);
    if (lastSnap.exists()) {
      const lastData = lastSnap.data();
      prevLog = { workout: { exercises: lastData.exercises } };
      exerciseTips = lastData.exercise_tips || [];
      lastCoachSummary = lastData.last_coach_summary || null;
    } else {
      const snap = await getDocs(dailyLogsQuery);
      for (const d of snap.docs) {
        const ld = d.data();
        if (ld.date !== TODAY && ld.workout?.session_day === dayKey && ld.workout?.exercises?.length) {
          prevLog = ld; break;
        }
      }
    }
  } catch(e) {
    console.warn('Pre-fill load error:', e.message);
  }

  buildExState(session, dayKey, prevLog, exerciseTips);
  sessionData = { dayKey, name: session.name, session_id: session.session_id || null, cardio: session.cardio || null, lastCoachSummary };
  launchActive(session.name, `${DAYS_IT[dayKey]} · ${session.exercises?.length||0} esercizi`);
};

function buildExState(session, dayKey, prevLog, tips) {
  exState = (session.exercises || []).map(ex => {
    const prevEx   = prevLog?.workout?.exercises?.find(e => e.name === ex.name);
    const tip      = (tips || []).find(t => t.exercise_name?.toLowerCase() === ex.name?.toLowerCase()) || null;
    const setCount = typeof ex.sets === 'number' ? ex.sets : (ex.sets?.length || 3);

    // Range ripetizioni (Fase 3: rip_min/rip_max; Fase 1: reps stringa)
    const ripMin = ex.rip_min || null;
    const ripMax = ex.rip_max || null;
    const repsLabel = ripMin && ripMax
      ? (ripMin === ripMax ? `${ripMin}` : `${ripMin}-${ripMax}`)
      : (ex.reps || '8');

    // Blocchi componenti (APT, Core) — niente serie, solo checklist
    const isBlock = Array.isArray(ex.componenti) && ex.componenti.length > 0;

    return {
      name: ex.name,
      rest_seconds: ex.rest_seconds || 90,
      notes: ex.notes || '',
      tip,
      // Campi Fase 3 (ignorati se assenti → backward compat)
      rpe_target:       ex.rpe_target ?? ex.rpe ?? null,
      rip_min:          ripMin,
      rip_max:          ripMax,
      variante_sicura:  ex.variante_sicura || null,
      intensificazione: ex.intensificazione || null,
      incremento_kg:    ex.incremento_kg || null,
      per_lato:         ex.per_lato || false,
      superset:         ex.superset || false,
      componenti:       isBlock ? ex.componenti : null,
      durata_min:       ex.durata_min || null,
      rip_min_b:        ex.rip_min_b || null,
      rip_max_b:        ex.rip_max_b || null,
      variante_usata:   false,
      sets: isBlock ? [] : Array.from({ length: setCount }, (_, i) => {
        const prevSet = prevEx?.sets?.[i];
        const w = prevSet?.weight ?? (ex.weight_per_set?.[i] || 0);
        return {
          reps_target:   repsLabel,
          ref_weight:    w,
          actual_weight: w,
          actual_reps:   '',
          last_weight:   prevSet?.weight || 0,
          last_reps:     prevSet?.reps   || repsLabel,
          done:          false
        };
      })
    };
  });
}

// Guida metodologia della fase corrente
window.showMethodGuide = function() {
  const regole = programData?.regole_globali;
  const blocchi = programData?.blocchi_settimanali;

  if (!regole) {
    showModal({ title: 'ℹ️ Guida', body: '<p style="color:var(--t2)">Nessuna guida disponibile per questa scheda.</p>', confirmText: 'OK' });
    return;
  }

  // Determina blocco corrente in base alla data
  let bloccoCorrente = null;
  if (blocchi?.length) {
    const today = new Date(TODAY + 'T12:00:00');
    for (const b of blocchi) {
      if (b.date) {
        const parts = b.date.split('-');
        if (parts.length === 2) {
          const [startStr] = parts;
          const [dd, mm] = startStr.split('/');
          const startDate = new Date(today.getFullYear(), parseInt(mm) - 1, parseInt(dd));
          if (today >= startDate) bloccoCorrente = b;
        }
      }
    }
  }

  const bc = bloccoCorrente;
  const bloccoHtml = bc ? `
    <div style="background:rgba(124,111,255,0.08);border-radius:10px;padding:12px;margin-bottom:14px;border:1px solid rgba(124,111,255,0.15)">
      <div style="font-size:10px;font-weight:800;color:var(--accent);letter-spacing:1px;margin-bottom:4px">BLOCCO ATTUALE</div>
      <div style="font-size:14px;font-weight:700">Sett. ${bc.settimane} · ${bc.modalita}</div>
      <div style="font-size:12px;color:var(--t2);margin-top:4px">RPE fondamentali: <b>${bc.rpe_fondamentali}</b> · RPE isolamento: <b>${bc.rpe_isolamento}</b></div>
      <div style="font-size:12px;color:var(--t2)">Intensificazione: <b>${bc.intensificazione ? 'SÌ (myo-reps/drop set)' : 'NO'}</b></div>
      ${bc.nota ? `<div style="font-size:11px;color:var(--orange);margin-top:4px">📌 ${bc.nota}</div>` : ''}
      ${bc.carichi ? `<div style="font-size:11px;color:var(--t3);margin-top:2px">${bc.carichi}</div>` : ''}
    </div>` : '';

  const avanzHtml = regole.avanzamento?.length ? `
    <div style="margin-bottom:14px">
      <div style="font-size:10px;font-weight:800;color:var(--t3);letter-spacing:1px;margin-bottom:6px">PROGRESSIONE CARICHI</div>
      ${regole.avanzamento.map(r => `<div style="font-size:12px;color:var(--t2);padding:3px 0;line-height:1.4">→ ${r}</div>`).join('')}
    </div>` : '';

  const intHtml = (bc?.intensificazione) ? `
    <div style="margin-bottom:14px">
      <div style="font-size:10px;font-weight:800;color:var(--t3);letter-spacing:1px;margin-bottom:6px">TECNICHE INTENSIFICAZIONE</div>
      ${regole.myo_reps ? `<div style="font-size:12px;color:var(--t2);padding:3px 0"><b>Myo-reps:</b> ${regole.myo_reps}</div>` : ''}
      ${regole.drop_set ? `<div style="font-size:12px;color:var(--t2);padding:3px 0"><b>Drop set:</b> ${regole.drop_set}</div>` : ''}
      ${regole.intensificazione ? `<div style="font-size:11px;color:var(--orange);padding:3px 0">⚡ ${regole.intensificazione}</div>` : ''}
    </div>` : '';

  const sicurHtml = `
    <div style="margin-bottom:14px">
      <div style="font-size:10px;font-weight:800;color:var(--t3);letter-spacing:1px;margin-bottom:6px">SICUREZZA</div>
      ${regole.cervicale ? `<div style="font-size:12px;color:var(--t2);padding:3px 0">🦴 <b>Cervicale:</b> ${regole.cervicale}</div>` : ''}
      ${regole.coccige ? `<div style="font-size:12px;color:var(--t2);padding:3px 0">🦴 <b>Coccige:</b> ${regole.coccige}</div>` : ''}
      ${regole.stop ? `<div style="font-size:12px;color:var(--red);padding:3px 0;font-weight:600">🛑 ${regole.stop}</div>` : ''}
    </div>`;

  const setsHtml = regole.straight_sets ? `
    <div style="margin-bottom:14px">
      <div style="font-size:10px;font-weight:800;color:var(--t3);letter-spacing:1px;margin-bottom:6px">REGOLA SERIE</div>
      <div style="font-size:12px;color:var(--t2)">${regole.straight_sets}</div>
    </div>` : '';

  showModal({
    title: 'ℹ️ Guida Fase 3',
    body: `${bloccoHtml}${setsHtml}${avanzHtml}${intHtml}${sicurHtml}`,
    confirmText: 'OK, capito!'
  });
};

function launchActive(title, sub) {
  document.getElementById('st-sel').style.display = 'none';
  document.getElementById('st-act').style.display = 'block';
  document.getElementById('s-title').textContent = title;
  document.getElementById('s-sub').innerHTML = sub + ` &nbsp; <label style="font-size:12px;background:var(--bg3);padding:2px 6px;border-radius:4px;cursor:pointer"><input type="checkbox" id="sound-tgl" checked> 🔔 Suono</label>`;

  if (sessionData?.cardio?.type) {
    const c = sessionData.cardio;
    document.getElementById('s-cardio').style.display = 'block';
    document.getElementById('s-cardio-card').innerHTML = `
      <div style="display:flex;align-items:center;gap:12px">
        <span style="font-size:24px">🏃</span>
        <div><div style="font-weight:700">${c.type}</div>
        <div style="font-size:12px;color:var(--t2)">${c.duration_minutes} min · ${c.notes||''}</div></div>
        <label class="tgl" style="margin-left:auto"><input type="checkbox" id="cardio-done"><span class="tgl-s"></span></label>
      </div>`;
  }

  sessionSec       = 0;
  sessionStartTime = 0;
  sessionPausedMs  = 0;
  sessionPausedAt  = 0;
  sessionStarted   = false;
  setT('s-timer', '00:00');

  const startBtn = document.getElementById('start-btn');
  const pauseBtn = document.getElementById('pause-btn');
  const liveEl   = document.getElementById('live-badge');
  const hintEl   = document.getElementById('s-hint');
  if (startBtn) startBtn.style.display = 'inline-flex';
  if (pauseBtn) pauseBtn.style.display = 'none';
  if (liveEl)   liveEl.style.display   = 'none';
  if (hintEl)   hintEl.style.display   = 'block';

  // Mostra feedback coach della sessione precedente (se disponibile)
  const coachContainer = document.getElementById('s-exercises');
  if (sessionData?.lastCoachSummary) {
    const cs = sessionData.lastCoachSummary;
    const coachCard = document.createElement('div');
    coachCard.id = 'last-coach-card';
    coachCard.innerHTML = `
      <div style="margin-bottom:12px;padding:10px 14px;background:rgba(124,111,255,0.06);border:1px solid rgba(124,111,255,0.12);border-radius:10px">
        <div style="cursor:pointer;display:flex;align-items:center;gap:8px" onclick="const d=document.getElementById('lc-detail');d.style.display=d.style.display==='none'?'block':'none';this.querySelector('.lc-arr').textContent=d.style.display==='none'?'▼':'▲'">
          <span style="font-size:14px">📋</span>
          <span style="font-size:12px;font-weight:700;color:var(--accent)">Feedback ultima sessione</span>
          <span class="lc-arr" style="font-size:11px;color:var(--t3);margin-left:auto">▼</span>
        </div>
        <div id="lc-detail" style="display:none;margin-top:8px">
          <div style="font-size:13px;font-weight:700;color:var(--t1);margin-bottom:4px">${cs.summary_title}</div>
          ${cs.prossima_sessione ? `<div style="font-size:12px;color:var(--t2)">📌 ${cs.prossima_sessione}</div>` : ''}
        </div>
      </div>`;
    coachContainer.before(coachCard);
  }

  renderExercises();
}

window.startSession = function() {
  if (sessionStarted) return;
  sessionStarted = true;

  const startBtn = document.getElementById('start-btn');
  const pauseBtn = document.getElementById('pause-btn');
  const liveEl   = document.getElementById('live-badge');
  const hintEl   = document.getElementById('s-hint');
  if (startBtn) startBtn.style.display = 'none';
  if (pauseBtn) pauseBtn.style.display = 'inline-flex';
  if (liveEl)   liveEl.style.display   = 'inline-flex';
  if (hintEl)   hintEl.style.display   = 'none';

  sessionStartTime = Date.now();
  sessionPausedMs  = 0;
  sessionInt = setInterval(() => {
    if (!isPaused) {
      sessionSec = Math.floor((Date.now() - sessionStartTime - sessionPausedMs) / 1000);
      setT('s-timer', fmtTimer(sessionSec));
    }
  }, 500);

  renderExercises();
  requestWakeLock();
  requestNotifPermission();
};

function setT(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }

function onVisibilityChange() {
  if (document.visibilityState !== 'visible' || !sessionStarted) return;
  if (!isPaused) {
    sessionSec = Math.floor((Date.now() - sessionStartTime - sessionPausedMs) / 1000);
    setT('s-timer', fmtTimer(sessionSec));
  }
  if (restEndTime > 0) {
    restSec = Math.max(0, Math.ceil((restEndTime - Date.now()) / 1000));
    updateRestDisplay();
    if (restSec <= 0) { clearInterval(restInt); hideRest(); }
  }
}
document.addEventListener('visibilitychange', onVisibilityChange);

// ── Render exercises ───────────────────────────────────────
function renderExercises() {
  const total = exState.length;
  const done = exState.filter((ex) => {
    const isBlock = Array.isArray(ex.componenti) && ex.componenti.length > 0;
    return isBlock ? (ex._compDone || []).length >= ex.componenti.length : ex.sets.every(s => s.done);
  }).length;

  const progressHtml = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:8px 12px;background:var(--bg2);border-radius:10px;border:1px solid var(--border)">
      <div style="font-size:12px;font-weight:800;color:var(--t1)">Esercizio ${Math.min(done + 1, total)}/${total}</div>
      <div style="flex:1;height:4px;background:var(--bg3);border-radius:2px;overflow:hidden">
        <div style="height:100%;width:${(done / total) * 100}%;background:var(--accent);border-radius:2px;transition:width .3s"></div>
      </div>
      <div style="font-size:11px;color:var(--t3)">${done} ✓</div>
    </div>`;

  document.getElementById('s-exercises').innerHTML =
    progressHtml + exState.map((ex, ei) => renderExCard(ex, ei)).join('');
}

function renderExCard(ex, ei) {
  const isBlock = Array.isArray(ex.componenti) && ex.componenti.length > 0;
  const allDone = isBlock
    ? (ex._compDone || []).length >= ex.componenti.length
    : ex.sets.every(s => s.done);
  const rpeVal = ex.rpe || '';

  // Barra info: serie × reps · RPE target · incremento
  const setCount = ex.sets?.length || 0;
  const repsLabel = ex.rip_min && ex.rip_max
    ? (ex.rip_min === ex.rip_max ? `${ex.rip_min}` : `${ex.rip_min}-${ex.rip_max}`)
    : (ex.sets?.[0]?.reps_target || '');
  const metaParts = [];
  if (!isBlock && setCount > 0 && repsLabel) {
    let repStr = `${setCount}×${repsLabel}`;
    if (ex.per_lato) repStr += '/lato';
    metaParts.push(repStr);
  }
  if (ex.rpe_target) metaParts.push(`RPE ${ex.rpe_target}`);
  if (ex.incremento_kg) metaParts.push(`+${ex.incremento_kg}kg`);
  if (ex.durata_min && isBlock) metaParts.push(`${ex.durata_min} min`);

  // Superset: range reps parte B
  let supersetInfo = '';
  if (ex.superset && ex.rip_min_b && ex.rip_max_b) {
    supersetInfo = `<span style="font-size:11px;color:var(--orange);font-weight:600;margin-left:4px">(B: ${ex.rip_min_b}-${ex.rip_max_b} rip)</span>`;
  }

  return `
    <div class="ex-live ${allDone ? 'completed' : ''}" id="exlive-${ei}">
      <div class="ex-head">
        <span class="ex-name"><span style="color:var(--t3);font-weight:800;margin-right:4px">#${ei + 1}</span>${ex.name}</span>
        <div style="display:flex;gap:8px;align-items:center">
          ${ex.notes ? `<button class="btn-icon" style="width:34px;height:34px;font-size:14px" onclick="toggleNote(${ei})">ℹ️</button>` : ''}
          ${ex.variante_sicura ? `<button class="btn-icon" style="width:34px;height:34px;font-size:13px" onclick="window.toggleVariant(${ei})">🔄</button>` : ''}
          ${allDone ? '<span class="badge badge-g">✓</span>' : `<span style="font-size:12px;color:var(--t2)">⏱ ${ex.rest_seconds}s</span>`}
        </div>
      </div>

      ${metaParts.length ? `
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:4px 0 8px;font-size:12px;color:var(--t2)">
        <span style="font-weight:700;color:var(--t1)">${metaParts.join(' · ')}</span>
        ${ex.superset ? '<span style="font-size:10px;padding:1px 6px;background:rgba(255,165,0,0.12);border:1px solid rgba(255,165,0,0.25);border-radius:4px;color:var(--orange);font-weight:700">SUPERSET</span>' : ''}
        ${ex.per_lato ? '<span style="font-size:10px;padding:1px 6px;background:rgba(20,184,166,0.1);border:1px solid rgba(20,184,166,0.2);border-radius:4px;color:rgb(20,184,166);font-weight:700">/LATO</span>' : ''}
        ${supersetInfo}
      </div>` : ''}

      ${ex.intensificazione ? `
      <div style="margin:4px 0 8px;padding:6px 10px;background:rgba(255,107,53,0.08);border:1px solid rgba(255,107,53,0.2);border-radius:8px;font-size:12px;color:var(--orange);font-weight:600;display:flex;align-items:center;gap:6px">
        <span>⚡</span><span>${ex.intensificazione}</span>
      </div>` : ''}

      ${!isBlock ? `
      <!-- RPE fatica (con target) -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin:8px 0 12px;padding:6px 12px;background:rgba(255,255,255,0.02);border-radius:8px;border:1px solid rgba(255,255,255,0.05)">
        <span style="font-size:12px;color:var(--t2);font-weight:700">😮 RPE Fatica${ex.rpe_target ? ` <span style="color:var(--t3);font-weight:500">(target: ${ex.rpe_target})</span>` : ''}</span>
        <select class="fi" id="ex-rpe-${ei}" onchange="window.onRpeChange(${ei}, this.value)" style="width:65px;height:28px;font-size:12px;padding:2px;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;color:var(--t1);outline:none">
          <option value="">--</option>
          ${[1,2,3,4,5,6,7,8,9,10].map(v => `<option value="${v}" ${rpeVal == v ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>` : ''}

      ${ex.tip ? `
      <div style="margin:6px 0 10px;padding:8px 12px;background:rgba(124,111,255,0.08);border:1px solid rgba(124,111,255,0.15);border-radius:8px;font-size:12px;color:var(--t2);display:flex;align-items:flex-start;gap:8px">
        <span style="font-size:14px;flex-shrink:0">🧠</span>
        <div>
          <div style="font-weight:700;color:var(--accent);font-size:11px;margin-bottom:2px">${ex.tip.suggestion_text}</div>
          <div style="font-size:11px;color:var(--t3)">${ex.tip.detail}</div>
        </div>
      </div>` : ''}

      ${ex.variante_sicura ? `<div class="ex-note" id="evar-${ei}" style="display:none;border-left:2px solid var(--orange);padding-left:10px"><b style="color:var(--orange)">Variante sicura:</b> ${ex.variante_sicura}</div>` : ''}
      ${ex.notes ? `<div class="ex-note" id="enote-${ei}">${ex.notes}</div>` : ''}

      ${isBlock ? `
      <div style="margin:8px 0">
        ${ex.componenti.map((comp, ci) => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;margin-bottom:4px;background:rgba(255,255,255,0.02);border-radius:8px;border:1px solid rgba(255,255,255,0.05)">
            <div class="set-done ${(ex._compDone||[]).includes(ci) ? 'done' : ''}" onclick="window.markCompDone(${ei},${ci})" style="${!sessionStarted ? 'opacity:0.4;pointer-events:none' : ''}">${(ex._compDone||[]).includes(ci) ? '✓' : ''}</div>
            <span style="font-size:13px;color:var(--t1)">${comp}</span>
          </div>`).join('')}
      </div>` : `
      <div id="sets-wrap-${ei}">
        ${ex.sets.map((s, si) => renderSetRow(ex, ei, si, s)).join('')}
      </div>
      <button class="btn btn-ghost btn-xs" style="margin-top:6px;width:100%" onclick="addSetToExercise(${ei})">＋ Serie</button>`}
    </div>`;
}

function getProgArrow(actual, last) {
  if (!last || last <= 0 || actual == null) return '';
  const diff = parseFloat(actual) - last;
  if (Math.abs(diff) < 0.05) return `<span style="font-size:11px;color:var(--t3);font-weight:700">= stessa</span>`;
  const col = diff > 0 ? 'var(--green)' : 'var(--red)';
  const sign = diff > 0 ? '+' : '';
  return `<span style="font-size:11px;font-weight:800;color:${col}">${diff > 0 ? '↑' : '↓'} ${sign}${diff % 1 === 0 ? diff.toFixed(0) : diff.toFixed(1)}kg</span>`;
}

function renderSetRow(ex, ei, si, s) {
  const progHtml = s.last_weight > 0 && s.actual_weight ? getProgArrow(s.actual_weight, s.last_weight) : '';
  return `
    <div class="set-row" id="srow-${ei}-${si}">
      <span class="set-n">S${si+1}</span>
      <div>
        <input type="number" step="0.5" min="0" value="${s.actual_weight||''}" placeholder="kg"
          style="width:70px;padding:8px;text-align:center;font-size:15px;font-weight:700;
            background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--t1);outline:none"
          oninput="onWeight(${ei},${si},this.value)">
        ${s.last_weight > 0 ? `<div class="set-prev">↩${s.last_weight}kg × ${s.last_reps}</div>` : s.ref_weight > 0 ? `<div class="set-prev">↩${s.ref_weight}kg</div>` : ''}
        <div id="prog-${ei}-${si}" style="min-height:14px">${progHtml}</div>
      </div>
      <input type="text" placeholder="${s.reps_target}" value="${s.actual_reps}"
        style="width:62px;padding:8px;text-align:center;font-size:15px;font-weight:700;
          background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--t1);outline:none"
        oninput="onReps(${ei},${si},this.value)">
      <div class="set-done ${s.done ? 'done' : ''}" id="sd-${ei}-${si}"
           onclick="markDone(${ei},${si})"
           style="${!sessionStarted ? 'opacity:0.4;pointer-events:none;cursor:not-allowed' : ''}">
        ${s.done ? '✓' : ''}
      </div>
    </div>`;
}

window.toggleNote = function(ei) {
  const el = document.getElementById(`enote-${ei}`);
  if (el) el.classList.toggle('open');
};

window.toggleVariant = function(ei) {
  const el = document.getElementById(`evar-${ei}`);
  if (el) {
    const visible = el.style.display !== 'none';
    el.style.display = visible ? 'none' : 'block';
    if (exState[ei]) exState[ei].variante_usata = !visible;
  }
};

window.markCompDone = function(ei, ci) {
  const ex = exState[ei];
  if (!ex || !ex.componenti) return;
  if (!ex._compDone) ex._compDone = [];
  const idx = ex._compDone.indexOf(ci);
  if (idx >= 0) ex._compDone.splice(idx, 1);
  else ex._compDone.push(ci);
  renderExercises();
};

window.onRpeChange = function(ei, val) {
  if (exState[ei]) {
    exState[ei].rpe = parseInt(val) || null;
  }
};

window.addSetToExercise = function(ei) {
  const ex = exState[ei];
  if (!ex) return;
  const lastSet = ex.sets[ex.sets.length - 1];
  ex.sets.push({
    reps_target:   lastSet?.reps_target || '8',
    ref_weight:    lastSet?.actual_weight || 0,
    actual_weight: null,  // null = empty, 0 = explicitly zero
    actual_reps:   '',
    done:          false
  });
  const wrap = document.getElementById(`sets-wrap-${ei}`);
  if (wrap) wrap.innerHTML = ex.sets.map((s, si) => renderSetRow(ex, ei, si, s)).join('');
};

window.onWeight = function(ei, si, val) {
  const v = val === '' ? null : parseFloat(val);
  exState[ei].sets[si].actual_weight = v;

  const progEl = document.getElementById(`prog-${ei}-${si}`);
  if (progEl) progEl.innerHTML = getProgArrow(v, exState[ei].sets[si].last_weight);

  // Propagate only to sets that are still genuinely empty (null)
  for (let j = si + 1; j < exState[ei].sets.length; j++) {
    if (exState[ei].sets[j].actual_weight === null) {
      exState[ei].sets[j].actual_weight = v;
      const inp = document.querySelector(`#srow-${ei}-${j} input[type="number"]`);
      if (inp) inp.value = v ?? '';
      const pEl = document.getElementById(`prog-${ei}-${j}`);
      if (pEl) pEl.innerHTML = getProgArrow(v, exState[ei].sets[j].last_weight);
    }
  }
};

window.onReps = function(ei, si, val) {
  exState[ei].sets[si].actual_reps = val;
};

window.markDone = function(ei, si) {
  const s = exState[ei].sets[si];
  s.done = !s.done;
  const btn = document.getElementById(`sd-${ei}-${si}`);
  if (btn) { btn.className = 'set-done' + (s.done ? ' done' : ''); btn.textContent = s.done ? '✓' : ''; }

  if (s.done) {
    let nextLabel = 'Fine esercizio';
    const nextSet = exState[ei].sets.find((x, j) => j > si && !x.done);
    if (nextSet) {
      nextLabel = `${exState[ei].name} S${exState[ei].sets.indexOf(nextSet)+1}`;
    } else {
      const nextEx = exState.find((e, j) => j > ei && e.sets.some(x => !x.done));
      if (nextEx) nextLabel = nextEx.name;
    }
    if (exState[ei].rest_seconds > 0) startRest(exState[ei].rest_seconds, nextLabel);
  }

  const allDone = exState[ei].sets.every(x => x.done);
  const card = document.getElementById(`exlive-${ei}`);
  if (card) {
    if (allDone) card.classList.add('completed'); else card.classList.remove('completed');
  }
  updateVolume();
};

// ── Rest timer ─────────────────────────────────────────────
function startRest(sec, label) {
  clearInterval(restInt);
  restEndTime = Date.now() + sec * 1000;
  restSec = sec;
  document.getElementById('rest-box').style.display = 'block';
  document.getElementById('rest-next').textContent = label;
  document.getElementById('rest-box').scrollIntoView({ behavior: 'smooth', block: 'center' });
  updateRestDisplay();
  postToSW({ type: 'schedule-rest-done', ms: sec * 1000 });
  restInt = setInterval(() => {
    restSec = Math.max(0, Math.ceil((restEndTime - Date.now()) / 1000));
    updateRestDisplay();
    if (restSec <= 0) {
      clearInterval(restInt); hideRest(); showToast('⚡ Recupero terminato!');
      if (document.getElementById('sound-tgl')?.checked) beep();
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }
  }, 500);
}
function updateRestDisplay() {
  const el = document.getElementById('rest-num');
  if (!el) return;
  el.textContent = restSec;
  el.className = 'timer-rest ' + (restSec > 30 ? 'rest-g' : restSec > 10 ? 'rest-o' : 'rest-r');
}
function hideRest() { document.getElementById('rest-box').style.display = 'none'; }

window.skipRest = function() { clearInterval(restInt); hideRest(); postToSW({ type: 'cancel-rest' }); };
window.togglePause = function() {
  isPaused = !isPaused;
  if (isPaused) {
    sessionPausedAt = Date.now();
  } else {
    sessionPausedMs += Date.now() - sessionPausedAt;
  }
  document.getElementById('pause-btn').textContent = isPaused ? '▶️ Riprendi' : '⏸ Pausa';
};

function updateVolume() {
  const vol = exState.reduce((a, ex) =>
    a + ex.sets.reduce((b, s) => b + (s.done ? (parseFloat(s.actual_weight)||0) * (parseFloat(s.actual_reps)||1) : 0), 0), 0);
  setT('s-volume', Math.round(vol) + ' kg');
}

// ── Confirm exit ───────────────────────────────────────────
window.confirmExit = function() {
  showModal({
    title: 'Esci dalla sessione?',
    text: 'I progressi non salvati andranno persi.',
    confirmLabel: 'Esci', confirmClass: 'btn-r',
    onConfirm: () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      clearInterval(sessionInt); clearInterval(restInt); releaseWakeLock();
      postToSW({ type: 'cancel-rest' });
      restEndTime = 0;
      sessionStarted = false;
      document.getElementById('st-act').style.display = 'none';
      document.getElementById('st-sel').style.display = 'block';
    }
  });
};

// ── Custom session ─────────────────────────────────────────
window.startCustom = function() {
  document.getElementById('custom-form').style.display = 'block';
  customExList = [];
  document.getElementById('custom-ex-list').innerHTML = '';
  addCustomEx();
};

window.addCustomEx = function() {
  const idx = customExList.length;
  customExList.push({ name:'', sets:3, reps:'8', rest_seconds:90 });
  const wrap = document.createElement('div');
  wrap.className = 'card card-dark';
  wrap.style.marginBottom = '10px';
  wrap.id = `cex-${idx}`;
  wrap.innerHTML = `
    <div class="grid2" style="margin-bottom:8px">
      <div class="fg" style="margin:0"><label class="fl">Esercizio</label>
        <input class="fi" id="cex-name-${idx}" placeholder="Nome esercizio"></div>
      <div class="fg" style="margin:0"><label class="fl">Recupero (s)</label>
        <input type="number" class="fi" value="90" oninput="customExList[${idx}].rest_seconds=+this.value"></div>
    </div>
    <div class="grid3">
      <div class="fg" style="margin:0"><label class="fl">Serie</label>
        <input type="number" class="fi" value="3" oninput="customExList[${idx}].sets=+this.value"></div>
      <div class="fg" style="margin:0"><label class="fl">Reps</label>
        <input class="fi" value="8" oninput="customExList[${idx}].reps=this.value"></div>
      <div class="fg" style="margin:0"><label class="fl">Peso</label>
        <input type="number" class="fi" step="0.5" placeholder="kg" oninput="customExList[${idx}].weight=+this.value"></div>
    </div>`;
  document.getElementById('custom-ex-list').appendChild(wrap);
  new AutoComplete(document.getElementById(`cex-name-${idx}`), 'exercise_library', {
    onSelect: item => { customExList[idx].name = item.name; },
    onCustom: name  => { customExList[idx].name = name; }
  });
};

window.launchCustom = function() {
  const valid = customExList.filter(e => e.name.trim());
  if (!valid.length) { showToast('Aggiungi almeno un esercizio', 'err'); return; }
  exState = valid.map(ex => ({
    name: ex.name,
    rest_seconds: ex.rest_seconds || 90,
    notes: '',
    sets: Array.from({ length: ex.sets || 3 }, () => ({
      reps_target: ex.reps || '8',
      ref_weight: ex.weight || 0,
      actual_weight: ex.weight || 0,
      actual_reps: '',
      done: false
    }))
  }));
  sessionData = { dayKey: 'custom', name: 'Sessione Custom', cardio: null };
  launchActive('Sessione Custom', `${exState.length} esercizi`);
};

// ── Finish session ─────────────────────────────────────────
window.finishSession = async function() {
  document.removeEventListener('visibilitychange', onVisibilityChange);
  clearInterval(sessionInt); clearInterval(restInt); releaseWakeLock();
  postToSW({ type: 'cancel-rest' });
  restEndTime = 0;

  const cardioDone = document.getElementById('cardio-done')?.checked || false;
  const workoutLog = {
    session_day:      sessionData.dayKey,
    session_name:     sessionData.name,
    session_id:       sessionData.session_id || null,
    duration_seconds: sessionSec,
    notes:            document.getElementById('s-notes')?.value || '',
    completed:        true,
    exercises: exState.map(ex => {
      const base = {
        name: ex.name,
        rpe:  ex.rpe || null,
        sets: (ex.sets || []).map(s => ({
          weight: parseFloat(s.actual_weight) || 0,
          reps:   s.actual_reps || s.reps_target,
          done:   s.done
        }))
      };
      if (ex.variante_usata) base.variante_usata = true;
      if (ex.componenti) base.componenti_done = ex._compDone || [];
      return base;
    }),
    cardio: sessionData.cardio ? { ...sessionData.cardio, done: cardioDone } : null
  };

  try {
    await setDoc(doc(db, 'users', getUserId(), 'daily_logs', TODAY),
      { workout: workoutLog, date: TODAY }, { merge: true });

    // Salva ultima sessione per pre-compilazione pesi
    await setDoc(doc(db, 'users', getUserId(), 'last_sessions', sessionData.dayKey), {
      session_day:      sessionData.dayKey,
      session_name:     sessionData.name,
      completed_date:   TODAY,
      duration_seconds: sessionSec,
      total_volume:     Math.round(calcTotalVolume()),
      session_notes:    document.getElementById('s-notes')?.value || '',
      exercises: exState.map(ex => ({
        name: ex.name,
        rpe:  ex.rpe || null,
        sets: ex.sets.map((s, i) => ({
          set_num: i + 1,
          weight:  parseFloat(s.actual_weight) || 0,
          reps:    s.actual_reps || s.reps_target,
          done:    s.done
        }))
      }))
    }, { merge: false });

    for (const ex of exState) {
      await saveToLibrary('exercise_library', { name: ex.name, last_used: TODAY });
    }

    showToast('🏁 Sessione completata! 💪');

    // Autoperiodizzazione base
    const rpes = exState.map(ex => ex.rpe).filter(r => r != null);
    let adviceTitle = "Allenamento Completato!";
    let adviceText = "Ottimo lavoro! Continua così per massimizzare la costanza e superare i tuoi limiti.";

    if (rpes.length > 0) {
      const avgRpe = rpes.reduce((a, b) => a + b) / rpes.length;
      if (avgRpe < 7) {
        adviceTitle = "📈 Autoperiodizzazione KOVA. · Incremento peso!";
        adviceText = `Il tuo RPE medio è di <b>${avgRpe.toFixed(1)}</b> (intensità leggera). Per la prossima sessione ti suggeriamo di incrementare i carichi di <b>+2.5 kg</b> (o +2.5%) per mantenere uno stimolo allenante efficace! 💪`;
      } else if (avgRpe >= 9.5) {
        adviceTitle = "😮‍💨 Autoperiodizzazione KOVA. · Scarico consigliato!";
        adviceText = `Il tuo RPE medio è di <b>${avgRpe.toFixed(1)}</b> (intensità estrema/cedimento). Consigliamo di scaricare i carichi del 10% (Deload) o mantenere i pesi stabili per favorire il recupero muscolare e articolare.`;
      } else {
        adviceTitle = "⚖️ Autoperiodizzazione KOVA. · Intensità ottimale";
        adviceText = `Il tuo RPE medio è di <b>${avgRpe.toFixed(1)}</b> (intensità ottimale). Mantieni stabili i pesi per la prossima sessione e concentrati sulla progressione delle ripetizioni o sul perfezionamento della tecnica!`;
      }
    }

    // ── Coach AI Feedback (best-effort, non blocca il salvataggio) ──
    let coachHtml = '';
    try {
      // Carica profilo e storico in parallelo
      const [profileSnap, historySnap] = await Promise.all([
        getDoc(doc(db, 'users', getUserId(), 'settings', 'app')),
        getDocs(query(collection(db, 'users', getUserId(), 'daily_logs'), orderBy('date', 'desc'), limit(30)))
      ]);
      const profile = profileSnap.exists() ? profileSnap.data() : {};

      // Storico sessioni dello stesso tipo (esclusa quella appena salvata)
      const sessionHistory = historySnap.docs
        .map(d => d.data())
        .filter(l => l.date !== TODAY && l.workout?.completed && l.workout?.session_day === sessionData.dayKey)
        .slice(0, 5);

      const previousSession = sessionHistory[0]?.workout || null;

      // Chiama entrambe le AI in parallelo con timeout 15s
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000));

      const [feedbackResult, tipsResult] = await Promise.race([
        Promise.all([
          generateSessionFeedbackAI({
            currentSession: workoutLog,
            previousSession,
            sessionHistory,
            profile,
            programObjective: programData?.objective || null,
            programName: programData?.name || null
          }),
          generateExerciseTipsAI({
            exercises: workoutLog.exercises,
            previousExercises: previousSession?.exercises || [],
            sessionHistory,
            programObjective: programData?.objective || null,
            profileWeight: profile?.current_weight || null
          })
        ]),
        timeoutPromise
      ]);

      // Salva feedback nel daily_log
      if (feedbackResult?.success && feedbackResult.feedback) {
        const fb = feedbackResult.feedback;
        fb.generated_at = new Date().toISOString();
        await setDoc(doc(db, 'users', getUserId(), 'daily_logs', TODAY),
          { workout: { coach_feedback: fb } }, { merge: true });

        // Costruisci HTML per il modale
        const ratingBadge = { eccellente: '🟢', buono: '🔵', sufficiente: '🟡', da_migliorare: '🟠' };
        coachHtml = `
          <div style="margin-top:16px;border-top:1px solid rgba(255,255,255,0.08);padding-top:14px">
            <div style="cursor:pointer;display:flex;align-items:center;gap:8px;margin-bottom:8px" onclick="document.getElementById('coach-fb-detail').style.display = document.getElementById('coach-fb-detail').style.display === 'none' ? 'block' : 'none'; this.querySelector('.fb-arrow').textContent = document.getElementById('coach-fb-detail').style.display === 'none' ? '▼' : '▲'">
              <span style="font-size:16px">🧠</span>
              <span style="font-size:14px;font-weight:800;color:var(--accent)">Coach Feedback</span>
              <span style="font-size:12px">${ratingBadge[fb.overall_rating] || '🔵'} ${fb.overall_rating}</span>
              <span class="fb-arrow" style="font-size:11px;color:var(--t3);margin-left:auto">▼</span>
            </div>
            <div style="font-size:13px;font-weight:700;margin-bottom:6px">${fb.summary_title}</div>
            <div id="coach-fb-detail" style="display:none">
              <div style="font-size:13px;color:var(--t2);line-height:1.6;margin-bottom:10px">${fb.body}</div>
              ${fb.positivi?.length ? fb.positivi.map(p => `<div style="font-size:12px;color:var(--green);padding:2px 0">✅ ${p}</div>`).join('') : ''}
              ${fb.da_migliorare?.length ? fb.da_migliorare.map(p => `<div style="font-size:12px;color:var(--orange);padding:2px 0">⚠️ ${p}</div>`).join('') : ''}
              ${fb.prossima_sessione ? `<div style="margin-top:8px;font-size:12px;color:var(--accent);font-weight:600">📌 ${fb.prossima_sessione}</div>` : ''}
            </div>
          </div>`;
      }

      // Salva tips e summary nel last_sessions
      if (tipsResult?.success && tipsResult.tips?.length) {
        const mergeData = { exercise_tips: tipsResult.tips };
        if (feedbackResult?.success && feedbackResult.feedback) {
          mergeData.last_coach_summary = {
            summary_title: feedbackResult.feedback.summary_title,
            prossima_sessione: feedbackResult.feedback.prossima_sessione
          };
        }
        await setDoc(doc(db, 'users', getUserId(), 'last_sessions', sessionData.dayKey),
          mergeData, { merge: true });
      }

    } catch(aiErr) {
      console.warn('Coach AI non disponibile:', aiErr.message);
    }

    // Modale sintomi (cervicale/coccige) — salvataggio separato merge:true
    const symptomsHtml = `
      <div style="margin-top:16px;border-top:1px solid rgba(255,255,255,0.08);padding-top:14px">
        <div style="font-size:12px;font-weight:700;color:var(--t2);margin-bottom:10px">Fastidio durante la seduta? (0 = nessuno, 10 = massimo)</div>
        <div style="display:flex;gap:12px">
          <div style="flex:1">
            <label style="font-size:11px;color:var(--t3);font-weight:600">Cervicale</label>
            <select class="fi" id="symptom-cervicale" style="width:100%;height:32px;font-size:13px;margin-top:4px">
              ${[0,1,2,3,4,5,6,7,8,9,10].map(v => `<option value="${v}">${v}</option>`).join('')}
            </select>
          </div>
          <div style="flex:1">
            <label style="font-size:11px;color:var(--t3);font-weight:600">Coccige</label>
            <select class="fi" id="symptom-coccige" style="width:100%;height:32px;font-size:13px;margin-top:4px">
              ${[0,1,2,3,4,5,6,7,8,9,10].map(v => `<option value="${v}">${v}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>`;

    showModal({
      title: adviceTitle,
      text: adviceText + coachHtml + symptomsHtml,
      confirmLabel: 'Ok, andiamo! ⚡',
      onConfirm: async () => {
        const cervicale = parseInt(document.getElementById('symptom-cervicale')?.value) || 0;
        const coccige = parseInt(document.getElementById('symptom-coccige')?.value) || 0;
        if (cervicale > 0 || coccige > 0) {
          try {
            await setDoc(doc(db, 'users', getUserId(), 'daily_logs', TODAY), {
              workout: { cervicale_max: cervicale, coccige_max: coccige }
            }, { merge: true });
          } catch(e) { console.warn('Errore salvataggio sintomi:', e); }
        }
        window.location.href = 'index.html';
      }
    });

  } catch(e) {
    console.error('Errore salvataggio sessione:', e);
    showToast('Errore salvataggio: ' + e.message, 'err');
  }
};

(async function() {
  await requireAuth();
  loadSessionSelect();
})();
