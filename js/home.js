import {
  db, USER_ID, doc, getDoc, setDoc, getDocs,
  collection, query, where, orderBy
} from './firebase-config.js';
import { limit } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import {
  getTodayString, getDayOfWeek, formatDateIT,
  showToast, setWidth, setText, DEFAULT_TARGETS
} from './app.js';

const today   = getTodayString();
const todayDow = getDayOfWeek();

// ─── LOCAL STATE ──────────────────────────────────────────────────────────────

let logData = {
  date: today,
  is_training_day: false,
  body_weight: null,
  daily_note: '',
  streak: 0,
  workout: { completed: false, session_name: '', exercises: [] },
  nutrition: { followed_plan: false, meals: [], totals: { kcal: 0, protein: 0, carbs: 0, fats: 0 } }
};
let activeProgram = null;
let activeDiet    = null;
let appSettings   = null;
let dietTargets   = {};

// ─── LOADERS ─────────────────────────────────────────────────────────────────

async function loadTodayLog() {
  try {
    const snap = await getDoc(doc(db, 'users', USER_ID, 'daily_logs', today));
    if (snap.exists()) logData = { ...logData, ...snap.data() };
  } catch (e) { console.error('loadTodayLog', e); }
}

async function loadActiveProgram() {
  try {
    const q = query(collection(db, 'users', USER_ID, 'programs'), where('active', '==', true));
    const snap = await getDocs(q);
    if (!snap.empty) activeProgram = { id: snap.docs[0].id, ...snap.docs[0].data() };
  } catch (e) { console.error('loadActiveProgram', e); }
}

async function loadActiveDiet() {
  try {
    const q = query(collection(db, 'users', USER_ID, 'diet_plans'), where('active', '==', true));
    const snap = await getDocs(q);
    if (!snap.empty) activeDiet = { id: snap.docs[0].id, ...snap.docs[0].data() };
  } catch (e) { console.error('loadActiveDiet', e); }
}

async function loadAppSettings() {
  try {
    const snap = await getDoc(doc(db, 'users', USER_ID, 'settings', 'app'));
    if (snap.exists()) appSettings = snap.data();
  } catch {}
}

async function loadLastSetsForExercise(exerciseName) {
  try {
    const snap = await getDocs(
      query(collection(db, 'users', USER_ID, 'daily_logs'),
        orderBy('date', 'desc'), limit(15))
    );
    for (const d of snap.docs) {
      if (d.id === today) continue;
      const exs = d.data()?.workout?.exercises || [];
      const found = exs.find(e => e.name === exerciseName);
      if (found?.sets?.length) return found.sets;
    }
  } catch {}
  return null;
}

// ─── RING ─────────────────────────────────────────────────────────────────────

function calcCompletion() {
  let total = 0, done = 0;
  logData.workout.exercises.forEach(ex => {
    total++;
    if (ex.sets.length > 0 && ex.sets.every(s => s.done)) done++;
  });
  logData.nutrition.meals.forEach(m => {
    total++;
    if (m.eaten) done++;
  });
  return total === 0 ? 0 : (done / total) * 100;
}

function updateRing() {
  const pct  = calcCompletion();
  const circ = 175.9;
  const fill = document.getElementById('ring-fill');
  const num  = document.getElementById('ring-pct');
  if (fill) fill.style.strokeDashoffset = circ * (1 - pct / 100);
  if (num)  num.textContent = Math.round(pct) + '%';
}

// ─── WORKOUT CARD ─────────────────────────────────────────────────────────────

async function buildWorkoutCard() {
  const card = document.getElementById('workout-card');
  const sched = activeProgram?.schedule?.[todayDow];
  const hasLog = logData.workout.exercises.length > 0;
  const isTraining = hasLog || (!!sched);
  logData.is_training_day = isTraining;

  if (!isTraining) {
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span class="clabel" style="margin:0">💪 Allenamento</span>
        <span class="badge badge-r">Riposo 😴</span>
      </div>
      <p style="color:var(--t2);font-size:15px">Oggi è giorno di riposo 🛌<br><span style="font-size:13px">Recupera bene!</span></p>`;
    return;
  }

  // Build exercises array: prefer existing log, else pre-fill from program
  let exercises = hasLog
    ? logData.workout.exercises
    : (sched?.exercises || []).map(ex => ({
        name: ex.name,
        sets: (ex.sets || [{ reps:'', weight:'' }]).map(s => ({
          reps: s.reps || '', weight: s.weight || '', done: false
        }))
      }));

  // Pre-fill weights from last session (only if no existing log)
  if (!hasLog) {
    for (let i = 0; i < exercises.length; i++) {
      const last = await loadLastSetsForExercise(exercises[i].name);
      if (last) {
        exercises[i].sets = exercises[i].sets.map((s, si) => ({
          ...s,
          weight: last[si]?.weight ?? s.weight,
          reps:   last[si]?.reps   ?? s.reps
        }));
      }
    }
  }

  logData.workout.session_name = sched?.name || logData.workout.session_name || '';
  logData.workout.exercises    = exercises;

  const sessName = logData.workout.session_name;

  const exHtml = exercises.map((ex, ei) => {
    const allDone = ex.sets.length > 0 && ex.sets.every(s => s.done);
    const setsHtml = ex.sets.map((s, si) => `
      <div class="set-input-row">
        <span class="set-num">${si + 1}</span>
        <input type="number" class="fi" placeholder="Reps" value="${s.reps}"
          min="0" style="padding:8px;font-size:14px"
          oninput="window._setVal(${ei},${si},'reps',this.value)">
        <input type="number" class="fi" placeholder="kg" value="${s.weight}"
          min="0" step="0.5" style="padding:8px;font-size:14px"
          oninput="window._setVal(${ei},${si},'weight',this.value)">
      </div>`).join('');

    return `
      <div class="check-item ${allDone ? 'done' : ''}" id="ex-item-${ei}">
        <div class="check-box" id="ex-box-${ei}" onclick="window._toggleEx(${ei})">${allDone ? '✓' : ''}</div>
        <div class="check-text">
          <div class="check-name">${ex.name}</div>
          <div onclick="event.stopPropagation()">${setsHtml}</div>
        </div>
      </div>`;
  }).join('');

  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <span class="clabel" style="margin:0">💪 Allenamento</span>
      <span class="badge badge-v">Training 🔥</span>
    </div>
    ${sessName ? `<p style="font-size:16px;font-weight:700;margin-bottom:14px">${sessName}</p>` : ''}
    ${exHtml || '<p style="color:var(--t2);font-size:14px">Nessun esercizio programmato</p>'}`;
}

window._toggleEx = function(ei) {
  const ex = logData.workout.exercises[ei];
  if (!ex) return;
  const allDone = ex.sets.every(s => s.done);
  ex.sets.forEach(s => { s.done = !allDone; });
  const item = document.getElementById(`ex-item-${ei}`);
  const box  = document.getElementById(`ex-box-${ei}`);
  if (!allDone) { item?.classList.add('done');    if (box) box.textContent = '✓'; }
  else          { item?.classList.remove('done'); if (box) box.textContent = ''; }
  updateRing();
};

window._setVal = function(ei, si, field, val) {
  const sets = logData.workout.exercises[ei]?.sets;
  if (sets?.[si]) sets[si][field] = val;
};

// ─── NUTRITION CARD ───────────────────────────────────────────────────────────

function buildNutritionCard() {
  const card = document.getElementById('nutrition-card');
  const isOn = logData.is_training_day;
  const sfx  = isOn ? 'on' : 'off';
  const dayKey = isOn ? 'day_on' : 'day_off';

  const dayData = activeDiet?.[dayKey] || {};
  const tKcal = dayData.kcal    || DEFAULT_TARGETS[`kcal_${sfx}`];
  const tPro  = dayData.protein || DEFAULT_TARGETS[`pro_${sfx}`];
  const tCarb = dayData.carbs   || DEFAULT_TARGETS[`carb_${sfx}`];
  const tFat  = dayData.fats    || DEFAULT_TARGETS[`fat_${sfx}`];
  dietTargets = { tKcal, tPro, tCarb, tFat };

  // Meals: prefer existing log, else pre-fill from diet plan
  const hasLogMeals = logData.nutrition.meals.length > 0;
  if (!hasLogMeals && activeDiet) {
    logData.nutrition.meals = (dayData.meals || []).map(m => ({ ...m, eaten: false }));
  }

  const tots = computeNutritionTotals();
  logData.nutrition.totals = tots;

  const mealsHtml = logData.nutrition.meals.map((m, i) => `
    <div class="check-item ${m.eaten ? 'done' : ''}" id="meal-item-${i}" onclick="window._toggleMeal(${i})">
      <div class="check-box" id="meal-box-${i}">${m.eaten ? '✓' : ''}</div>
      <div class="check-text">
        <div class="check-name">${m.name}</div>
        <div class="check-sub">${m.type ? m.type + ' · ' : ''}P:${m.protein||0}g C:${m.carbs||0}g F:${m.fats||0}g</div>
      </div>
      <span class="meal-kcal">${m.kcal || 0}</span>
    </div>`).join('');

  const kcalPct = tKcal > 0 ? (tots.kcal / tKcal) * 100 : 0;

  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <span class="clabel" style="margin:0">🥗 Nutrizione</span>
      <span style="font-size:13px;color:var(--t2);font-weight:600">
        <span id="n-kcal">${Math.round(tots.kcal)}</span> / ${tKcal} kcal
      </span>
    </div>
    <div class="pbar-bg" style="margin-bottom:16px">
      <div class="pbar-fill pb-kcal" id="n-pbar" style="width:${kcalPct}%"></div>
    </div>
    <div class="grid3" style="margin-bottom:${logData.nutrition.meals.length ? '16px' : '0'}">
      <div class="macro-chip" style="background:rgba(79,195,247,.1)">
        <div class="mc-val" id="n-pro" style="color:var(--blue)">${Math.round(tots.protein)}g</div>
        <div class="mc-lbl">Pro / ${tPro}g</div>
      </div>
      <div class="macro-chip" style="background:rgba(255,213,79,.1)">
        <div class="mc-val" id="n-carb" style="color:var(--yellow)">${Math.round(tots.carbs)}g</div>
        <div class="mc-lbl">Carb / ${tCarb}g</div>
      </div>
      <div class="macro-chip" style="background:rgba(255,112,67,.1)">
        <div class="mc-val" id="n-fat" style="color:var(--orange)">${Math.round(tots.fats)}g</div>
        <div class="mc-lbl">Fat / ${tFat}g</div>
      </div>
    </div>
    ${logData.nutrition.meals.length
      ? mealsHtml
      : `<p style="color:var(--t2);font-size:14px;text-align:center;padding:12px 0">
          Nessun piano dieta attivo 🥗<br>
          <a href="diet.html" style="color:var(--accent);font-size:13px">Configura piano →</a>
         </p>`}`;
}

function computeNutritionTotals() {
  return logData.nutrition.meals.reduce((acc, m) => {
    if (m.eaten) {
      acc.kcal    += m.kcal    || 0;
      acc.protein += m.protein || 0;
      acc.carbs   += m.carbs   || 0;
      acc.fats    += m.fats    || 0;
    }
    return acc;
  }, { kcal: 0, protein: 0, carbs: 0, fats: 0 });
}

window._toggleMeal = function(i) {
  const meals = logData.nutrition.meals;
  if (!meals[i]) return;
  meals[i].eaten = !meals[i].eaten;
  const item = document.getElementById(`meal-item-${i}`);
  const box  = document.getElementById(`meal-box-${i}`);
  if (meals[i].eaten) { item?.classList.add('done');    if (box) box.textContent = '✓'; }
  else                { item?.classList.remove('done'); if (box) box.textContent = ''; }

  const tots = computeNutritionTotals();
  logData.nutrition.totals = tots;
  const { tKcal } = dietTargets;

  setText('n-kcal', Math.round(tots.kcal));
  setText('n-pro',  `${Math.round(tots.protein)}g`);
  setText('n-carb', `${Math.round(tots.carbs)}g`);
  setText('n-fat',  `${Math.round(tots.fats)}g`);
  setWidth('n-pbar', tKcal > 0 ? (tots.kcal / tKcal) * 100 : 0);
  updateRing();
};

// ─── STREAK ───────────────────────────────────────────────────────────────────

async function calcStreak() {
  try {
    const snap = await getDocs(
      query(collection(db, 'users', USER_ID, 'daily_logs'), orderBy('date', 'desc'), limit(60))
    );
    let streak = 0;
    const dates = snap.docs.map(d => d.id).sort().reverse();
    let expected = today;
    for (const d of dates) {
      if (d === expected) {
        streak++;
        const [y, mo, dy] = expected.split('-').map(Number);
        const prev = new Date(y, mo - 1, dy - 1);
        expected = prev.toISOString().split('T')[0];
      } else break;
    }
    return Math.max(streak, 1); // at least 1 when saving today
  } catch {
    return logData.streak || 1;
  }
}

// ─── SAVE ─────────────────────────────────────────────────────────────────────

window.saveLog = async function() {
  const bw   = document.getElementById('body-weight')?.value;
  const note = document.getElementById('daily-note')?.value || '';

  logData.body_weight = bw ? parseFloat(bw) : null;
  logData.daily_note  = note;
  logData.streak      = await calcStreak();

  logData.workout.completed =
    logData.workout.exercises.length > 0 &&
    logData.workout.exercises.every(ex => ex.sets.every(s => s.done));

  logData.nutrition.followed_plan =
    logData.nutrition.meals.length > 0 &&
    logData.nutrition.meals.every(m => m.eaten);

  logData.nutrition.totals = computeNutritionTotals();

  try {
    await setDoc(doc(db, 'users', USER_ID, 'daily_logs', today), logData, { merge: true });
    const s = logData.streak;
    setText('streak-badge', `🔥 ${s} ${s === 1 ? 'giorno' : 'giorni'}`);
    showToast('Giornata salvata! 💾');
  } catch (e) {
    console.error('saveLog', e);
    showToast('Errore nel salvataggio', 'err');
  }
};

// ─── AUTO-SAVE ────────────────────────────────────────────────────────────────

function setupAutoSave() {
  if (!appSettings?.auto_save) return;
  const mins = appSettings.auto_save_minutes || 5;
  const info = document.getElementById('autosave-info');
  if (info) info.style.display = 'block';
  setInterval(() => window.saveLog(), mins * 60 * 1000);
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

async function init() {
  setText('today-label', formatDateIT(today));

  await Promise.all([
    loadTodayLog(), loadActiveProgram(), loadActiveDiet(), loadAppSettings()
  ]);

  // Restore persisted fields
  if (logData.body_weight) {
    const bw = document.getElementById('body-weight');
    if (bw) bw.value = logData.body_weight;
  }
  if (logData.daily_note) {
    const note = document.getElementById('daily-note');
    if (note) note.value = logData.daily_note;
  }
  const s = logData.streak || 0;
  setText('streak-badge', `🔥 ${s} ${s === 1 ? 'giorno' : 'giorni'}`);

  await buildWorkoutCard();
  buildNutritionCard();
  updateRing();
  setupAutoSave();
}

init();
