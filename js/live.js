import {
  db, USER_ID, doc, getDoc, setDoc, collection, getDocs, query, orderBy
} from './firebase-config.js';
import { limit } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import {
  getTodayString, getDayOfWeek, formatTimer, showToast, showModal
} from './app.js';

const TODAY = getTodayString();
let session    = null;
let exercises  = [];
let prevLog    = null;
let startTime  = Date.now();
let elapsed    = 0;
let paused     = false;
let sessionInterval = null;
let restSeconds = 0;
let restInterval = null;

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  await loadSession();
  startSessionTimer();
  renderExercises();
}

async function loadSession() {
  const [progSnap, logsSnap, todaySnap] = await Promise.all([
    getDocs(collection(db, 'users', USER_ID, 'programs')),
    getDocs(query(collection(db, 'users', USER_ID, 'daily_logs'), orderBy('date', 'desc'), limit(14))),
    getDoc(doc(db, 'users', USER_ID, 'daily_logs', TODAY))
  ]);

  const program = progSnap.docs.find(d => d.data().active)?.data() || null;
  const dow = getDayOfWeek(TODAY);
  session = program?.schedule?.[dow] || null;

  const nameEl = document.getElementById('session-name');
  const metaEl = document.getElementById('session-meta');
  if (session) {
    if (nameEl) nameEl.textContent = session.name || 'Allenamento';
    if (metaEl) metaEl.textContent = session.time_minutes ? `~${session.time_minutes} min` : '';
  } else {
    if (nameEl) nameEl.textContent = 'Allenamento libero';
    if (metaEl) metaEl.textContent = '';
  }

  // Find prev same-weekday log for pre-fill
  const dow2 = getDayOfWeek(TODAY);
  for (const d of logsSnap.docs) {
    const ld = d.data();
    if (ld.date !== TODAY && getDayOfWeek(ld.date) === dow2 && ld.workout?.exercises?.length) {
      prevLog = ld;
      break;
    }
  }

  // If today's log already has exercises, restore them
  if (todaySnap.exists() && todaySnap.data().workout?.exercises?.length) {
    exercises = todaySnap.data().workout.exercises.map(ex => ({
      ...ex,
      sets: ex.sets.map(s => ({ ...s, done: s.done || false }))
    }));
    return;
  }

  // Build from session
  exercises = (session?.exercises || []).map(ex => ({
    name:        ex.name,
    done:        false,
    is_cardio:   ex.is_cardio || false,
    rest_seconds: ex.rest_seconds || 60,
    notes:       ex.notes || '',
    sets:        ex.sets.map(s => ({
      reps:   s.reps,
      weight: getPrevWeight(ex.name) ?? s.weight,
      done:   false
    }))
  }));
}

function getPrevWeight(name) {
  const prevEx = prevLog?.workout?.exercises?.find(e => e.name === name);
  if (!prevEx) return null;
  const weights = prevEx.sets?.map(s => s.weight).filter(w => w > 0);
  return weights?.length ? weights[0] : null;
}

// ── Session timer ──────────────────────────────────────────────────────────────
function startSessionTimer() {
  startTime = Date.now() - elapsed * 1000;
  sessionInterval = setInterval(() => {
    if (!paused) {
      elapsed = Math.floor((Date.now() - startTime) / 1000);
      const el = document.getElementById('session-timer');
      if (el) el.textContent = formatTimer(elapsed);
    }
  }, 1000);
}

window._pauseResume = function() {
  paused = !paused;
  const btn = document.getElementById('pause-btn');
  if (paused) {
    elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (btn) btn.textContent = '▶ Riprendi';
  } else {
    startTime = Date.now() - elapsed * 1000;
    if (btn) btn.textContent = '⏸ Pausa';
  }
};

// ── Rest timer ─────────────────────────────────────────────────────────────────
function startRest(seconds) {
  clearInterval(restInterval);
  restSeconds = seconds;
  document.getElementById('rest-card').style.display = 'block';
  updateRestDisplay();
  restInterval = setInterval(() => {
    restSeconds--;
    if (restSeconds <= 0) {
      clearInterval(restInterval);
      document.getElementById('rest-card').style.display = 'none';
      showToast('⚡ Recupero terminato!');
    } else {
      updateRestDisplay();
    }
  }, 1000);
}

function updateRestDisplay() {
  const el = document.getElementById('rest-timer');
  if (el) el.textContent = formatTimer(restSeconds);
}

window._skipRest = function() {
  clearInterval(restInterval);
  restSeconds = 0;
  document.getElementById('rest-card').style.display = 'none';
};

// ── Render ─────────────────────────────────────────────────────────────────────
function renderExercises() {
  const list = document.getElementById('live-ex-list');
  if (!list) return;
  list.innerHTML = exercises.map((ex, ei) => renderExCard(ex, ei)).join('');
}

function renderExCard(ex, ei) {
  const allDone = ex.sets.every(s => s.done);
  return `
    <div class="ex-live-card ${allDone ? 'card-green' : ''}">
      <div class="ex-live-name">${ex.is_cardio ? '🏃 ' : ''}${ex.name}</div>
      <div class="ex-live-meta">
        ${ex.rest_seconds ? `⏱ ${ex.rest_seconds}s recupero` : ''}
        ${ex.notes ? ` · 📝 ${ex.notes}` : ''}
      </div>
      ${ex.sets.map((s, si) => renderSetLive(ei, si, s)).join('')}
    </div>`;
}

function renderSetLive(ei, si, s) {
  const prevEx  = prevLog?.workout?.exercises?.find(e => e.name === exercises[ei].name);
  const prevSet = prevEx?.sets?.[si];
  const prevHint = prevSet ? `${prevSet.weight||0}kg×${prevSet.reps||0}` : '';

  return `
    <div class="set-live-row" id="set-row-${ei}-${si}">
      <span class="set-live-num">${si+1}</span>
      <input type="number" class="fi" step="0.5" min="0"
        value="${s.weight || ''}" placeholder="${prevHint ? prevHint.split('×')[0] : 'kg'}"
        style="width:68px;padding:8px;text-align:center;font-size:15px;font-weight:700"
        oninput="window._updLiveSet(${ei},${si},'weight',+this.value)">
      <span style="font-size:12px;color:var(--t2)">kg</span>
      <span style="font-size:12px;color:var(--t3);margin:0 2px">×</span>
      <input type="number" class="fi" step="1" min="0"
        value="${s.reps || ''}" placeholder="${prevHint ? prevHint.split('×')[1] : 'reps'}"
        style="width:60px;padding:8px;text-align:center;font-size:15px;font-weight:700"
        oninput="window._updLiveSet(${ei},${si},'reps',+this.value)">
      ${prevHint ? `<span style="font-size:10px;color:var(--t3);flex:1;text-align:right">↩${prevHint}</span>` : '<span style="flex:1"></span>'}
      <button class="set-done-btn ${s.done ? 'done' : ''}"
        onclick="window._doneSet(${ei},${si})">
        ${s.done ? '✓' : ''}
      </button>
    </div>`;
}

window._updLiveSet = function(ei, si, field, val) {
  const s = exercises[ei]?.sets?.[si];
  if (s) s[field] = val;
};

window._doneSet = function(ei, si) {
  const ex = exercises[ei];
  const s  = ex.sets[si];
  s.done = !s.done;

  // Update just the button
  const btn = document.querySelector(`#set-row-${ei}-${si} .set-done-btn`);
  if (btn) {
    btn.className = 'set-done-btn' + (s.done ? ' done' : '');
    btn.textContent = s.done ? '✓' : '';
  }

  // Start rest timer if set done
  if (s.done && ex.rest_seconds > 0) {
    startRest(ex.rest_seconds);
  }

  // Mark exercise done if all sets done
  const allDone = ex.sets.every(s => s.done);
  if (allDone !== ex.done) {
    ex.done = allDone;
    const card = document.getElementById(`live-ex-list`)?.children[ei];
    if (card) card.className = 'ex-live-card' + (allDone ? ' card-green' : '');
  }
};

// ── Finish ─────────────────────────────────────────────────────────────────────
window._finishSession = async function() {
  clearInterval(sessionInterval);
  clearInterval(restInterval);

  showModal({
    title: 'Termina sessione',
    text:  `Durata: ${formatTimer(elapsed)}. Salvare e tornare alla home?`,
    confirmLabel: '✅ Salva',
    confirmClass: 'btn-g',
    onConfirm: async () => {
      try {
        const logDoc = { date: TODAY, workout: { done: true, exercises, duration_seconds: elapsed } };
        await setDoc(doc(db, 'users', USER_ID, 'daily_logs', TODAY), logDoc, { merge: true });
        showToast('Sessione salvata! 💪');
        setTimeout(() => { window.location.href = 'index.html'; }, 800);
      } catch(e) {
        console.error(e);
        showToast('Errore salvataggio', 'err');
      }
    }
  });
};

init();
