import {
  db, USER_ID, collection, doc, getDoc, getDocs, setDoc, query, orderBy, limit
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

// ── Load select screen ─────────────────────────────────────
async function loadSessionSelect() {
  const [progSnap, logsSnap] = await Promise.all([
    getDocs(collection(db, 'users', USER_ID, 'programs')),
    getDocs(query(collection(db, 'users', USER_ID, 'daily_logs'), orderBy('date', 'desc'), limit(30)))
  ]);

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
}

// ── Start session ──────────────────────────────────────────
window.startWithSession = async function(dayKey) {
  const session = programData?.schedule?.[dayKey];
  if (!session) { showToast('Sessione non trovata', 'err'); return; }

  // Load last session for weight pre-fill (from last_sessions first, then daily_logs)
  let prevLog = null;
  try {
    const lastSnap = await getDoc(doc(db, 'users', USER_ID, 'last_sessions', dayKey));
    if (lastSnap.exists()) {
      prevLog = { workout: { exercises: lastSnap.data().exercises } };
    } else {
      const snap = await getDocs(
        query(collection(db, 'users', USER_ID, 'daily_logs'), orderBy('date', 'desc'), limit(20))
      );
      for (const d of snap.docs) {
        const ld = d.data();
        if (ld.date !== TODAY && ld.workout?.session_day === dayKey && ld.workout?.exercises?.length) {
          prevLog = ld; break;
        }
      }
    }
  } catch(e) {}

  buildExState(session, dayKey, prevLog);
  sessionData = { dayKey, name: session.name, cardio: session.cardio || null };
  launchActive(session.name, `${DAYS_IT[dayKey]} · ${session.exercises?.length||0} esercizi`);
};

function buildExState(session, dayKey, prevLog) {
  exState = (session.exercises || []).map(ex => {
    const prevEx   = prevLog?.workout?.exercises?.find(e => e.name === ex.name);
    const setCount = typeof ex.sets === 'number' ? ex.sets : (ex.sets?.length || 3);
    return {
      name: ex.name,
      rest_seconds: ex.rest_seconds || 90,
      notes: ex.notes || '',
      sets: Array.from({ length: setCount }, (_, i) => {
        const prevSet = prevEx?.sets?.[i];
        const w = prevSet?.weight ?? (ex.weight_per_set?.[i] || 0);
        return {
          reps_target:   ex.reps || '8',
          ref_weight:    w,
          actual_weight: w,
          actual_reps:   '',
          last_weight:   prevSet?.weight || 0,
          last_reps:     prevSet?.reps   || ex.reps || '8',
          done:          false
        };
      })
    };
  });
}

function launchActive(title, sub) {
  document.getElementById('st-sel').style.display = 'none';
  document.getElementById('st-act').style.display = 'block';
  document.getElementById('s-title').textContent = title;
  document.getElementById('s-sub').textContent   = sub;

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
  document.getElementById('s-exercises').innerHTML =
    exState.map((ex, ei) => renderExCard(ex, ei)).join('');
}

function renderExCard(ex, ei) {
  const allDone = ex.sets.every(s => s.done);
  return `
    <div class="ex-live ${allDone ? 'completed' : ''}" id="exlive-${ei}">
      <div class="ex-head">
        <span class="ex-name">${ex.name}</span>
        <div style="display:flex;gap:8px;align-items:center">
          ${ex.notes ? `<button class="btn-icon" style="width:34px;height:34px;font-size:14px" onclick="toggleNote(${ei})">ℹ️</button>` : ''}
          ${allDone ? '<span class="badge badge-g">✓</span>' : `<span style="font-size:12px;color:var(--t2)">⏱ ${ex.rest_seconds}s</span>`}
        </div>
      </div>
      ${ex.notes ? `<div class="ex-note" id="enote-${ei}">${ex.notes}</div>` : ''}
      <div id="sets-wrap-${ei}">
        ${ex.sets.map((s, si) => renderSetRow(ex, ei, si, s)).join('')}
      </div>
      <button class="btn btn-ghost btn-xs" style="margin-top:6px;width:100%" onclick="addSetToExercise(${ei})">＋ Serie</button>
    </div>`;
}

function renderSetRow(ex, ei, si, s) {
  return `
    <div class="set-row" id="srow-${ei}-${si}">
      <span class="set-n">S${si+1}</span>
      <div>
        <input type="number" step="0.5" min="0" value="${s.actual_weight||''}" placeholder="kg"
          style="width:70px;padding:8px;text-align:center;font-size:15px;font-weight:700;
            background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--t1);outline:none"
          oninput="onWeight(${ei},${si},this.value)">
        ${s.last_weight > 0 ? `<div class="set-prev">↩${s.last_weight}kg × ${s.last_reps}</div>` : s.ref_weight > 0 ? `<div class="set-prev">↩${s.ref_weight}kg</div>` : ''}
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

window.addSetToExercise = function(ei) {
  const ex = exState[ei];
  if (!ex) return;
  const lastSet = ex.sets[ex.sets.length - 1];
  ex.sets.push({
    reps_target:   lastSet?.reps_target || '8',
    ref_weight:    lastSet?.actual_weight || 0,
    actual_weight: lastSet?.actual_weight || 0,
    actual_reps:   '',
    done:          false
  });
  const wrap = document.getElementById(`sets-wrap-${ei}`);
  if (wrap) wrap.innerHTML = ex.sets.map((s, si) => renderSetRow(ex, ei, si, s)).join('');
};

window.onWeight = function(ei, si, val) {
  const v = parseFloat(val) || 0;
  exState[ei].sets[si].actual_weight = v;
  for (let j = si + 1; j < exState[ei].sets.length; j++) {
    if (!exState[ei].sets[j].actual_weight) {
      exState[ei].sets[j].actual_weight = v;
      const inp = document.querySelector(`#srow-${ei}-${j} input[type="number"]`);
      if (inp) inp.value = v || '';
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
  updateRestDisplay();
  restInt = setInterval(() => {
    restSec = Math.max(0, Math.ceil((restEndTime - Date.now()) / 1000));
    updateRestDisplay();
    if (restSec <= 0) {
      clearInterval(restInt); hideRest(); showToast('⚡ Recupero terminato!');
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

window.skipRest    = function() { clearInterval(restInt); hideRest(); };
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
  restEndTime = 0;

  const cardioDone = document.getElementById('cardio-done')?.checked || false;
  const workoutLog = {
    session_day:      sessionData.dayKey,
    session_name:     sessionData.name,
    duration_seconds: sessionSec,
    notes:            document.getElementById('s-notes')?.value || '',
    completed:        true,
    exercises: exState.map(ex => ({
      name: ex.name,
      sets: ex.sets.map(s => ({
        weight: parseFloat(s.actual_weight) || 0,
        reps:   s.actual_reps || s.reps_target,
        done:   s.done
      }))
    })),
    cardio: sessionData.cardio ? { ...sessionData.cardio, done: cardioDone } : null
  };

  try {
    await setDoc(doc(db, 'users', USER_ID, 'daily_logs', TODAY),
      { workout: workoutLog, date: TODAY }, { merge: true });

    // Salva ultima sessione per pre-compilazione pesi
    await setDoc(doc(db, 'users', USER_ID, 'last_sessions', sessionData.dayKey), {
      session_day:      sessionData.dayKey,
      session_name:     sessionData.name,
      completed_date:   TODAY,
      duration_seconds: sessionSec,
      total_volume:     Math.round(calcTotalVolume()),
      session_notes:    document.getElementById('s-notes')?.value || '',
      exercises: exState.map(ex => ({
        name: ex.name,
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
    setTimeout(() => { window.location.href = 'index.html'; }, 1500);
  } catch(e) {
    console.error('Errore salvataggio sessione:', e);
    showToast('Errore salvataggio: ' + e.message, 'err');
  }
};

loadSessionSelect();
