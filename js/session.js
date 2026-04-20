import {
  db, USER_ID, collection, doc, getDoc, getDocs, setDoc, query, orderBy, where
} from './firebase-config.js';
import { limit } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import {
  getTodayString, getDayOfWeek, formatDateIT, formatTimer,
  showToast, showModal, DAYS_IT, DAYS_ORDER
} from './app.js';

// ── Global state ───────────────────────────────────────────
const TODAY = getTodayString();
let currentSession   = null;
let programData      = null;
let sessionSeconds   = 0;
let sessionInterval  = null;
let restSeconds      = 0;
let restInterval     = null;
let isPaused         = false;
let exercisesState   = [];
let wakeLock         = null;

// ── Wake Lock ──────────────────────────────────────────────
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch(e) { console.log('Wake Lock n/d:', e); }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

// ── Load session select ────────────────────────────────────
async function loadSessionSelect() {
  const [progSnap, todaySnap] = await Promise.all([
    getDocs(collection(db, 'users', USER_ID, 'programs')),
    getDoc(doc(db, 'users', USER_ID, 'daily_logs', TODAY))
  ]);

  const activeDoc = progSnap.docs.find(d => d.data().active);
  if (!activeDoc) {
    document.getElementById('no-program-msg').style.display = 'block';
    return;
  }

  programData = { id: activeDoc.id, ...activeDoc.data() };
  const todayData   = todaySnap.exists() ? todaySnap.data() : {};
  const dow         = getDayOfWeek(TODAY);
  const todaySession = programData.schedule?.[dow] || null;
  const isTraining  = !!(todaySession);
  const dayOverride = todayData.day_override;
  const effectiveTraining = dayOverride !== null && dayOverride !== undefined ? dayOverride : isTraining;

  // Auto-session card
  if (todaySession) {
    const autoCard = document.getElementById('auto-session-card');
    autoCard.style.display = 'block';
    document.getElementById('auto-session-name').textContent = todaySession.name;
    const exCount = todaySession.exercises?.length || 0;
    const cardio  = todaySession.cardio?.enabled ? ` + ${todaySession.cardio.type}` : '';
    document.getElementById('auto-session-meta').textContent =
      `${DAYS_IT[dow]} · ${exCount} esercizi${cardio}`;
  }

  // All sessions list
  const listEl = document.getElementById('all-sessions-list');
  const days = DAYS_ORDER.filter(d => programData.schedule?.[d]);
  if (!days.length) {
    listEl.innerHTML = '<p style="color:var(--t2);font-size:13px">Nessuna sessione nel programma.</p>';
  } else {
    listEl.innerHTML = days.map(d => {
      const s  = programData.schedule[d];
      const ex = s.exercises?.length || 0;
      const cardioLabel = s.cardio?.enabled ? ` · 🏃 ${s.cardio.type}` : '';
      const isToday = d === dow;
      return `
        <div class="session-select-card ${isToday ? 'card-glow' : ''}" onclick="window.startWithSession('${d}')">
          <div>
            <div class="session-select-name">${s.name}</div>
            <div class="session-select-meta">${DAYS_IT[d]}${s.time ? ' · ' + s.time : ''} · ${ex} esercizi${cardioLabel}</div>
          </div>
          <button class="btn btn-o btn-sm" style="width:auto;flex-shrink:0">▶️</button>
        </div>`;
    }).join('');
  }

  // OFF override notice
  if (!effectiveTraining && !todaySession) {
    document.getElementById('off-override-card').style.display = 'block';
  }
}

// ── Start session ──────────────────────────────────────────
window.startWithSession = async function(dayKey) {
  const effectiveDay = dayKey === 'auto' ? getDayOfWeek(TODAY) : dayKey;
  const session = programData?.schedule?.[effectiveDay];
  if (!session) { showToast('Sessione non trovata', 'err'); return; }

  // Load previous same-session log for pre-fill
  let prevSessionLog = null;
  try {
    const logsSnap = await getDocs(
      query(collection(db, 'users', USER_ID, 'daily_logs'), orderBy('date', 'desc'), limit(20))
    );
    for (const d of logsSnap.docs) {
      const ld = d.data();
      if (ld.date !== TODAY && ld.workout?.session_day === effectiveDay && ld.workout?.exercises?.length) {
        prevSessionLog = ld;
        break;
      }
    }
  } catch(e) { console.warn('prev session load:', e); }

  // Build exercisesState
  exercisesState = (session.exercises || []).map(ex => {
    const prevEx   = prevSessionLog?.workout?.exercises?.find(e => e.name === ex.name);
    const setCount = typeof ex.sets === 'number' ? ex.sets : (ex.sets?.length || 3);
    return {
      name:         ex.name,
      rest_seconds: ex.rest_seconds || 60,
      notes:        ex.notes || '',
      is_cardio:    false,
      sets: Array.from({ length: setCount }, (_, i) => ({
        reps_target:   ex.reps || (ex.sets?.[i]?.reps ? String(ex.sets[i].reps) : '8'),
        ref_weight:    prevEx?.sets?.[i]?.weight ?? (ex.weight_per_set?.[i] || 0),
        actual_weight: prevEx?.sets?.[i]?.weight ?? (ex.weight_per_set?.[i] || 0),
        actual_reps:   '',
        done:          false
      }))
    };
  });

  currentSession = { dayKey: effectiveDay, name: session.name, cardio: session.cardio || null };

  // Switch UI
  document.getElementById('state-select').style.display = 'none';
  document.getElementById('state-active').style.display = 'block';
  document.getElementById('session-title').textContent    = session.name;
  document.getElementById('session-subtitle').textContent = `${DAYS_IT[effectiveDay]} · ${session.exercises?.length || 0} esercizi`;

  // Cardio section
  if (session.cardio?.enabled) {
    const cardioSec  = document.getElementById('cardio-section');
    const cardioCard = document.getElementById('cardio-card');
    cardioSec.style.display = 'block';
    cardioCard.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px">
        <span style="font-size:24px">🏃</span>
        <div>
          <div style="font-weight:700;font-size:15px">${session.cardio.type}</div>
          <div style="font-size:12px;color:var(--t2);margin-top:3px">${session.cardio.duration_minutes} min · ${session.cardio.notes}</div>
        </div>
        <div style="margin-left:auto">
          <label class="tgl"><input type="checkbox" id="cardio-done"><span class="tgl-s"></span></label>
        </div>
      </div>`;
  }

  startSessionTimer();
  renderExercises();
  requestWakeLock();
};

// ── Session timer ──────────────────────────────────────────
function startSessionTimer() {
  const startEpoch = Date.now() - sessionSeconds * 1000;
  sessionInterval = setInterval(() => {
    if (!isPaused) {
      sessionSeconds = Math.floor((Date.now() - startEpoch) / 1000);
      const el = document.getElementById('session-timer');
      if (el) el.textContent = formatTimer(sessionSeconds);
    }
  }, 500);
}

window.togglePause = function() {
  isPaused = !isPaused;
  const btn = document.getElementById('pause-btn');
  if (btn) btn.textContent = isPaused ? '▶️ Riprendi' : '⏸ Pausa';
};

// ── Rest timer ─────────────────────────────────────────────
function startRestTimer(seconds, nextLabel) {
  clearInterval(restInterval);
  restSeconds = seconds;
  document.getElementById('rest-overlay').style.display = 'block';
  document.getElementById('next-set-label').textContent = nextLabel;
  updateRestDisplay();

  restInterval = setInterval(() => {
    restSeconds--;
    updateRestDisplay();
    if (restSeconds <= 0) {
      clearInterval(restInterval);
      hideRestOverlay();
      showToast('⚡ Recupero terminato!');
    }
  }, 1000);
}

function updateRestDisplay() {
  const el = document.getElementById('rest-timer-display');
  if (!el) return;
  el.textContent = restSeconds;
  el.className = 'timer-rest' + (
    restSeconds > 30 ? ' rest-green' :
    restSeconds > 10 ? ' rest-orange' : ' rest-red'
  );
}

function hideRestOverlay() {
  document.getElementById('rest-overlay').style.display = 'none';
}

window.skipRest = function() {
  clearInterval(restInterval);
  hideRestOverlay();
};

// ── Render exercises ───────────────────────────────────────
function renderExercises() {
  const container = document.getElementById('session-exercises');
  container.innerHTML = exercisesState.map((ex, ei) => renderExCard(ex, ei)).join('');
}

function renderExCard(ex, ei) {
  const allDone = ex.sets.every(s => s.done);
  return `
    <div class="ex-live-card ${allDone ? 'card-green' : ''}" id="ex-card-${ei}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:4px">
        <div class="ex-live-name">${ex.name}</div>
        <button class="btn-icon" style="width:28px;height:28px;font-size:13px;flex-shrink:0"
          onclick="window.toggleExNote(${ei})">ℹ️</button>
      </div>
      <div class="ex-live-meta">
        ${ex.rest_seconds ? `⏱ ${ex.rest_seconds}s recupero` : ''}
        ${allDone ? ' · <span style="color:var(--green)">✓ Completato</span>' : ''}
      </div>
      ${ex.notes ? `
        <div id="ex-note-${ei}" style="display:none;font-size:12px;color:var(--t2);background:var(--bg4);
          border-left:3px solid var(--accent);border-radius:0 8px 8px 0;
          padding:10px 12px;margin-bottom:10px;line-height:1.5">${ex.notes}</div>` : ''}
      ${ex.sets.map((s, si) => renderSetRow(ex, ei, si, s)).join('')}
    </div>`;
}

function renderSetRow(ex, ei, si, s) {
  const hasRef = s.ref_weight > 0;
  return `
    <div class="set-live-row" id="set-row-${ei}-${si}">
      <span class="set-live-num">S${si+1}</span>
      <div style="display:flex;flex-direction:column;align-items:center">
        <input type="number" step="0.5" min="0"
          value="${s.actual_weight || ''}" placeholder="kg"
          id="w-${ei}-${si}"
          style="width:70px;padding:8px;text-align:center;font-size:15px;font-weight:700;
            background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--t1);outline:none;"
          oninput="window._onWeightChange(${ei},${si},this.value)">
        ${hasRef ? `<span style="font-size:10px;color:var(--t3);margin-top:2px">↩${s.ref_weight}kg</span>` : ''}
      </div>
      <span style="font-size:11px;color:var(--t2)">kg</span>
      <input type="text" placeholder="${s.reps_target}"
        value="${s.actual_reps}"
        id="r-${ei}-${si}"
        style="width:62px;padding:8px;text-align:center;font-size:15px;font-weight:700;
          background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--t1);outline:none;"
        oninput="window._onRepsChange(${ei},${si},this.value)">
      <span style="font-size:11px;color:var(--t2)">reps</span>
      <button class="set-done-btn ${s.done ? 'done' : ''}" id="done-${ei}-${si}"
        onclick="window.markSetDone(${ei},${si})">
        ${s.done ? '✓' : ''}
      </button>
    </div>`;
}

// ── Input handlers ─────────────────────────────────────────
window._onWeightChange = function(ei, si, val) {
  const parsed = parseFloat(val) || 0;
  exercisesState[ei].sets[si].actual_weight = parsed;
  // Propagate to subsequent empty sets
  for (let j = si + 1; j < exercisesState[ei].sets.length; j++) {
    if (!exercisesState[ei].sets[j].actual_weight) {
      exercisesState[ei].sets[j].actual_weight = parsed;
      const inp = document.getElementById(`w-${ei}-${j}`);
      if (inp) inp.value = parsed || '';
    }
  }
};

window._onRepsChange = function(ei, si, val) {
  exercisesState[ei].sets[si].actual_reps = val;
};

window.toggleExNote = function(ei) {
  const el = document.getElementById(`ex-note-${ei}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

// ── Mark set done ──────────────────────────────────────────
window.markSetDone = function(ei, si) {
  const ex  = exercisesState[ei];
  const set = ex.sets[si];
  set.done = !set.done;

  const btn = document.getElementById(`done-${ei}-${si}`);
  if (btn) {
    btn.className = 'set-done-btn' + (set.done ? ' done' : '');
    btn.textContent = set.done ? '✓' : '';
  }

  if (set.done) {
    // Find next undone set/exercise label
    let nextLabel = 'Fine esercizio';
    const nextSet = ex.sets.find((s, j) => j > si && !s.done);
    if (nextSet) {
      nextLabel = `${ex.name} S${ex.sets.indexOf(nextSet) + 1}`;
    } else {
      const nextEx = exercisesState.find((e, j) => j > ei && e.sets.some(s => !s.done));
      if (nextEx) nextLabel = nextEx.name;
    }
    if (ex.rest_seconds > 0) startRestTimer(ex.rest_seconds, nextLabel);
  }

  // Check if all sets done → mark exercise card
  const allDone = ex.sets.every(s => s.done);
  const card = document.getElementById(`ex-card-${ei}`);
  if (card) {
    if (allDone) card.classList.add('card-green');
    else         card.classList.remove('card-green');
    const meta = card.querySelector('.ex-live-meta');
    if (meta) {
      meta.innerHTML = `${ex.rest_seconds ? `⏱ ${ex.rest_seconds}s recupero` : ''}${allDone ? ' · <span style="color:var(--green)">✓ Completato</span>' : ''}`;
    }
  }
};

// ── Exit / Finish ──────────────────────────────────────────
window.confirmExitSession = function() {
  showModal({
    title: 'Esci dalla sessione?',
    text:  'I progressi non salvati andranno persi.',
    confirmLabel: 'Esci',
    confirmClass: 'btn-r',
    onConfirm: () => {
      clearInterval(sessionInterval);
      clearInterval(restInterval);
      releaseWakeLock();
      sessionSeconds = 0;
      isPaused = false;
      document.getElementById('state-active').style.display = 'none';
      document.getElementById('state-select').style.display = 'block';
      loadSessionSelect();
    }
  });
};

window.finishSession = async function() {
  clearInterval(sessionInterval);
  clearInterval(restInterval);
  releaseWakeLock();

  const cardioEl   = document.getElementById('cardio-done');
  const cardioDone = cardioEl?.checked || false;

  const workoutLog = {
    session_day:  currentSession.dayKey,
    session_name: currentSession.name,
    duration_seconds: sessionSeconds,
    notes:    document.getElementById('session-notes')?.value || '',
    completed: true,
    exercises: exercisesState.map(ex => ({
      name: ex.name,
      sets: ex.sets.map(s => ({
        weight: parseFloat(s.actual_weight) || 0,
        reps:   s.actual_reps || s.reps_target,
        done:   s.done
      }))
    })),
    cardio: currentSession.cardio ? { ...currentSession.cardio, done: cardioDone } : null
  };

  try {
    await setDoc(doc(db, 'users', USER_ID, 'daily_logs', TODAY),
      { workout: workoutLog, date: TODAY }, { merge: true });

    // Update exercise_library last_used
    const today = TODAY;
    for (const ex of exercisesState) {
      if (!ex.is_cardio) {
        const id = ex.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        await setDoc(doc(db, 'users', USER_ID, 'exercise_library', id),
          { name: ex.name, last_used: today }, { merge: true });
      }
    }

    showToast('🏁 Sessione salvata! Ottimo lavoro! 💪');
    setTimeout(() => { window.location.href = 'index.html'; }, 1500);
  } catch(e) {
    console.error(e);
    showToast('Errore salvataggio', 'err');
  }
};

// ── Init ───────────────────────────────────────────────────
loadSessionSelect();
