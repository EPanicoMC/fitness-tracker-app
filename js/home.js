import {
  db, USER_ID, doc, getDoc, setDoc, collection, getDocs, query, orderBy
} from './firebase-config.js';
import { limit } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import {
  getTodayString, getDayOfWeek, formatDateIT,
  showToast, setWidth, DEFAULT_TARGETS
} from './app.js';

const TODAY = getTodayString();
let logData = {
  date: TODAY,
  body_weight: null,
  steps: null,
  note: '',
  day_override: null,
  workout: { done: false, exercises: [] },
  nutrition: { meals: [], totals: { kcal:0, protein:0, carbs:0, fats:0 } }
};
let program     = null;
let dietPlan    = null;
let settings    = null;
let prevWeekLog = null;
let autoTimer   = null;

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  document.getElementById('today-label').textContent = formatDateIT(TODAY);
  await loadAll();
  setupAutoSave();
}

async function loadAll() {
  const [logSnap, progSnap, dietSnap, settSnap] = await Promise.all([
    getDoc(doc(db, 'users', USER_ID, 'daily_logs', TODAY)),
    getDocs(collection(db, 'users', USER_ID, 'programs')),
    getDocs(collection(db, 'users', USER_ID, 'diet_plans')),
    getDoc(doc(db, 'users', USER_ID, 'settings', 'app'))
  ]);

  if (logSnap.exists()) {
    logData = { ...logData, ...logSnap.data() };
    if (logData.body_weight) document.getElementById('body-weight').value = logData.body_weight;
    if (logData.steps)       document.getElementById('steps-input').value  = logData.steps;
    if (logData.note)        document.getElementById('daily-note').value    = logData.note;
  }

  program  = progSnap.docs.find(d => d.data().active)?.data() || null;
  dietPlan = dietSnap.docs.find(d => d.data().active)?.data() || null;
  settings = settSnap.exists() ? settSnap.data() : null;

  await loadPrevWeekLog();
  renderWorkoutCard();
  renderNutritionCard();
  updateRing();
}

async function loadPrevWeekLog() {
  try {
    const snap = await getDocs(
      query(collection(db, 'users', USER_ID, 'daily_logs'), orderBy('date', 'desc'), limit(14))
    );
    const dow = getDayOfWeek(TODAY);
    for (const d of snap.docs) {
      const ld = d.data();
      if (ld.date !== TODAY && getDayOfWeek(ld.date) === dow && ld.workout?.exercises?.length) {
        prevWeekLog = ld;
        break;
      }
    }
  } catch(e) { console.warn('prevWeekLog', e); }
}

// ── Day type ───────────────────────────────────────────────────────────────────
function isTrainingDay() {
  if (logData.day_override === true)  return true;
  if (logData.day_override === false) return false;
  return !!(program?.schedule?.[getDayOfWeek(TODAY)]);
}

function updateDayLabel() {
  const training = isTrainingDay();
  const label  = document.getElementById('day-type-label');
  const toggle = document.getElementById('day-override-toggle');
  if (label)  label.textContent = training ? '💪 ON' : '😴 OFF';
  if (toggle) toggle.checked = logData.day_override !== null ? logData.day_override : training;
}

window._onOverrideChange = function(checked) {
  logData.day_override = checked;
  renderWorkoutCard();
  renderNutritionCard();
  updateRing();
};
window._onBodyWeightChange = function(v) { logData.body_weight = v ? +v : null; };
window._onStepsChange      = function(v) { logData.steps = v ? +v : null; };
window._onNoteChange       = function(v) { logData.note = v; };

// ── Workout card ───────────────────────────────────────────────────────────────
function renderWorkoutCard() {
  const el = document.getElementById('workout-card');
  updateDayLabel();

  if (!isTrainingDay()) {
    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <span class="clabel" style="margin:0">🏋️ Allenamento</span>
        <span class="badge badge-o">😴 Riposo</span>
      </div>
      <p style="font-size:13px;color:var(--t2);margin-top:8px">Giorno di riposo. Recupera bene!</p>
      <button class="btn btn-ghost btn-sm" style="margin-top:12px;width:auto"
        onclick="window._forceTraining()">Voglio allenarmi lo stesso</button>`;
    return;
  }

  const dow     = getDayOfWeek(TODAY);
  const session = program?.schedule?.[dow] || null;

  if (session && logData.workout.exercises.length === 0) {
    logData.workout.exercises = (session.exercises || []).map(ex => {
      const setCount = typeof ex.sets === 'number' ? ex.sets : (ex.sets?.length || 3);
      return {
        name:         ex.name,
        done:         false,
        is_cardio:    false,
        rest_seconds: ex.rest_seconds || 90,
        notes:        ex.notes || '',
        show_notes:   false,
        sets: Array.from({ length: setCount }, (_, i) => ({
          reps:   ex.reps || '8',
          weight: getPrevWeight(ex.name) ?? (ex.weight_per_set?.[i] || 0),
          done:   false
        }))
      };
    });
    if (session.cardio?.enabled) {
      logData.workout.exercises.push({
        name: `🏃 ${session.cardio.type} (${session.cardio.duration_minutes} min)`,
        done: false, is_cardio: true, rest_seconds: 0, notes: session.cardio.notes || '',
        show_notes: false, sets: []
      });
    }
  }

  const sessionName = session?.name || 'Allenamento libero';
  const timeMins    = session?.time_minutes || '';
  const doneCount   = logData.workout.exercises.filter(e => e.done).length;
  const totalEx     = logData.workout.exercises.length;

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div>
        <span class="clabel" style="margin:0">🏋️ Allenamento</span>
        <div style="font-size:15px;font-weight:800;margin-top:4px">${sessionName}</div>
        ${timeMins ? `<div style="font-size:11px;color:var(--t2);margin-top:2px">⏱ ~${timeMins} min</div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
        <span class="badge badge-v">${doneCount}/${totalEx}</span>
        <a href="session.html" class="btn btn-g btn-sm" style="text-decoration:none;font-size:12px">▶ Allenati</a>
      </div>
    </div>
    <div id="ex-list">${logData.workout.exercises.map((ex, ei) => renderExRow(ex, ei)).join('')}</div>`;
}

function getPrevWeight(name) {
  const prevEx = prevWeekLog?.workout?.exercises?.find(e => e.name === name);
  if (!prevEx) return null;
  const weights = prevEx.sets?.map(s => s.weight).filter(w => w > 0);
  return weights?.length ? weights[0] : null;
}

function renderExRow(ex, ei) {
  const prevEx = prevWeekLog?.workout?.exercises?.find(e => e.name === ex.name);
  const prevInfo = prevEx
    ? `<span style="font-size:10px;color:var(--t3)">↩ ${prevEx.sets?.map(s=>s.weight||'bw').join('/')}kg</span>`
    : '';
  return `
    <div class="ex-card ${ex.done ? 'card-green' : ''}" id="ex-card-${ei}">
      <div class="ex-head" onclick="window._toggleExDone(${ei})" style="cursor:pointer">
        <div style="flex:1">
          <div class="ex-name">${ex.is_cardio ? '🏃 ' : ''}${ex.name}</div>
          ${prevInfo}
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          ${ex.notes ? `<button class="btn-icon" style="width:30px;height:30px;font-size:13px"
            onclick="event.stopPropagation();window._toggleNotes(${ei})">📝</button>` : ''}
          <div style="width:28px;height:28px;border-radius:50%;
            border:2px solid ${ex.done ? 'var(--green)' : 'var(--border2)'};
            background:${ex.done ? 'var(--green)' : 'transparent'};
            display:flex;align-items:center;justify-content:center;
            font-size:14px;color:${ex.done ? '#fff' : 'var(--t3)'}">
            ${ex.done ? '✓' : ''}
          </div>
        </div>
      </div>
      ${ex.notes && ex.show_notes
        ? `<div style="font-size:12px;color:var(--t2);background:var(--bg4);border-radius:8px;padding:8px 10px;margin-bottom:10px">📝 ${ex.notes}</div>`
        : ''}
      ${ex.is_cardio ? '' : ex.sets.map((s, si) => renderSetRow(ei, si, s)).join('')}
    </div>`;
}

function renderSetRow(ei, si, s) {
  return `
    <div class="set-row">
      <span class="set-num">${si+1}</span>
      <input type="number" class="fi" step="0.5" min="0" placeholder="kg"
        value="${s.weight || ''}"
        style="width:72px;padding:8px;text-align:center;font-size:14px;font-weight:700"
        oninput="window._updSet(${ei},${si},'weight',+this.value)">
      <span style="font-size:12px;color:var(--t2)">kg</span>
      <span style="font-size:12px;color:var(--t3);margin:0 4px">×</span>
      <input type="number" class="fi" step="1" min="0" placeholder="reps"
        value="${s.reps || ''}"
        style="width:64px;padding:8px;text-align:center;font-size:14px;font-weight:700"
        oninput="window._updSet(${ei},${si},'reps',+this.value)">
    </div>`;
}

window._toggleExDone = function(ei) {
  logData.workout.exercises[ei].done = !logData.workout.exercises[ei].done;
  rerenderExList();
};
window._toggleNotes = function(ei) {
  logData.workout.exercises[ei].show_notes = !logData.workout.exercises[ei].show_notes;
  rerenderExList();
};
window._forceTraining = function() {
  logData.day_override = true;
  document.getElementById('day-override-toggle').checked = true;
  renderWorkoutCard();
  updateRing();
};
window._updSet = function(ei, si, field, val) {
  const s = logData.workout.exercises[ei]?.sets?.[si];
  if (s) s[field] = val;
};

function rerenderExList() {
  const el = document.getElementById('ex-list');
  if (el) el.innerHTML = logData.workout.exercises.map((ex, ei) => renderExRow(ex, ei)).join('');
  updateRing();
}

// ── Nutrition card ─────────────────────────────────────────────────────────────
function renderNutritionCard() {
  const el       = document.getElementById('nutrition-card');
  const training = isTrainingDay();
  const dayKey   = training ? 'day_on' : 'day_off';
  const plan     = dietPlan?.[dayKey];
  const targets  = {
    kcal:    plan?.kcal    || DEFAULT_TARGETS[training ? 'kcal_on' : 'kcal_off'],
    protein: plan?.protein || DEFAULT_TARGETS[training ? 'pro_on' : 'pro_off'],
    carbs:   plan?.carbs   || DEFAULT_TARGETS[training ? 'carb_on' : 'carb_off'],
    fats:    plan?.fats    || DEFAULT_TARGETS[training ? 'fat_on' : 'fat_off']
  };

  if (logData.nutrition.meals.length === 0 && plan?.meals?.length) {
    logData.nutrition.meals = plan.meals.map(m => ({ ...m, eaten: false, active_variant: null }));
  }

  const tots = calcTotals();
  logData.nutrition.totals = tots;

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <span class="clabel" style="margin:0">🥗 Nutrizione</span>
      <span class="badge badge-${training ? 'g' : 'o'}">${training ? '💪 ON' : '😴 OFF'}</span>
    </div>
    <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:4px">
      <span class="kcal-big" id="kcal-now">${Math.round(tots.kcal)}</span>
      <span style="font-size:16px;color:var(--t2)">/ ${targets.kcal} kcal</span>
    </div>
    <div class="pbar-bg"><div class="pbar-fill" id="kcal-bar" style="width:${pct(tots.kcal, targets.kcal)}%"></div></div>
    <div class="grid3" style="margin:12px 0">
      ${renderMacroChip('chip-pro',  tots.protein, targets.protein, 'Pro',  'var(--blue)',   'b')}
      ${renderMacroChip('chip-carb', tots.carbs,   targets.carbs,   'Carb', 'var(--yellow)', 'y')}
      ${renderMacroChip('chip-fat',  tots.fats,    targets.fats,    'Fat',  'var(--orange)', 'o')}
    </div>
    <div class="sdiv" style="margin-top:0">Pasti</div>
    ${logData.nutrition.meals.map((m, mi) => renderMealCheck(m, mi)).join('')}
    ${!logData.nutrition.meals.length ? `<p style="color:var(--t2);font-size:13px;text-align:center;padding:16px 0">Nessun piano dieta attivo</p>` : ''}`;
}

function renderMacroChip(id, val, max, label, color, cls) {
  return `
    <div style="text-align:center">
      <div style="font-size:15px;font-weight:800;color:${color}" id="${id}">${Math.round(val)}g</div>
      <div style="font-size:10px;color:var(--t2)">${label} /${max}g</div>
      <div class="pbar-bg"><div class="pbar-fill ${cls}" style="width:${pct(val, max)}%"></div></div>
    </div>`;
}

function renderMealCheck(m, mi) {
  const variantsHtml = m.variants?.length ? `
    <div class="variant-chips">
      ${m.variants.map((v, vi) => {
        const label = typeof v === 'object' ? v.label : v.split('(')[0].trim();
        return `<div class="variant-chip ${m.active_variant === vi ? 'active' : ''}"
          onclick="window._selectVariant(${mi},${vi})">${label}</div>`;
      }).join('')}
    </div>` : '';

  return `
    <div class="meal-check">
      <div class="meal-check-box ${m.eaten ? 'done' : ''}" onclick="window._toggleMeal(${mi})">
        ${m.eaten ? '✓' : ''}
      </div>
      <div class="meal-check-info">
        <div style="display:flex;align-items:center;gap:6px">
          <span class="meal-check-name" style="${m.eaten ? 'text-decoration:line-through;opacity:.5' : ''}">${m.label || m.type}</span>
          ${m.time ? `<span style="font-size:10px;color:var(--t3)">${m.time}</span>` : ''}
        </div>
        <div class="meal-check-sub">${m.kcal} kcal · P:${m.protein}g C:${m.carbs}g F:${m.fats}g</div>
        ${m.items ? `<div style="font-size:11px;color:var(--t3);margin-top:2px">${m.items}</div>` : ''}
        ${variantsHtml}
      </div>
    </div>`;
}

window._toggleMeal = function(mi) {
  logData.nutrition.meals[mi].eaten = !logData.nutrition.meals[mi].eaten;
  rerenderMealBoxes();
  updateNutritionNumbers();
  updateRing();
};

window._selectVariant = function(mi, vi) {
  const m = logData.nutrition.meals[mi];
  m.active_variant = m.active_variant === vi ? null : vi;
  renderNutritionCard();
};

function calcTotals() {
  return logData.nutrition.meals.filter(m => m.eaten).reduce((acc, m) => {
    acc.kcal    += m.kcal    || 0;
    acc.protein += m.protein || 0;
    acc.carbs   += m.carbs   || 0;
    acc.fats    += m.fats    || 0;
    return acc;
  }, { kcal:0, protein:0, carbs:0, fats:0 });
}

function rerenderMealBoxes() {
  const boxes = document.querySelectorAll('.meal-check-box');
  const names = document.querySelectorAll('.meal-check-name');
  logData.nutrition.meals.forEach((m, mi) => {
    if (boxes[mi]) {
      boxes[mi].className = 'meal-check-box' + (m.eaten ? ' done' : '');
      boxes[mi].textContent = m.eaten ? '✓' : '';
    }
    if (names[mi]) names[mi].style.cssText = m.eaten ? 'text-decoration:line-through;opacity:.5' : '';
  });
}

function updateNutritionNumbers() {
  const training = isTrainingDay();
  const dayKey   = training ? 'day_on' : 'day_off';
  const plan     = dietPlan?.[dayKey];
  const targets  = {
    kcal:    plan?.kcal    || DEFAULT_TARGETS[training ? 'kcal_on' : 'kcal_off'],
    protein: plan?.protein || DEFAULT_TARGETS[training ? 'pro_on' : 'pro_off'],
    carbs:   plan?.carbs   || DEFAULT_TARGETS[training ? 'carb_on' : 'carb_off'],
    fats:    plan?.fats    || DEFAULT_TARGETS[training ? 'fat_on' : 'fat_off']
  };
  const tots = calcTotals();
  logData.nutrition.totals = tots;

  setText2('kcal-now', Math.round(tots.kcal));
  setWidth('kcal-bar',  pct(tots.kcal, targets.kcal));
  setText2('chip-pro',  Math.round(tots.protein) + 'g');
  setText2('chip-carb', Math.round(tots.carbs) + 'g');
  setText2('chip-fat',  Math.round(tots.fats) + 'g');
}

function setText2(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function pct(val, max)    { return max ? Math.min(100, Math.round((val/max)*100)) : 0; }

// ── Ring ───────────────────────────────────────────────────────────────────────
function updateRing() {
  const exs   = logData.workout.exercises;
  const meals  = logData.nutrition.meals;
  const training = isTrainingDay();

  const exRatio   = training && exs.length ? exs.filter(e => e.done).length / exs.length : (training ? 0 : 1);
  const mealRatio = meals.length ? meals.filter(m => m.eaten).length / meals.length : 0;
  const overall   = training ? (exRatio * 0.5 + mealRatio * 0.5) : mealRatio;

  const CIRC = 175.9;
  const ring  = document.getElementById('ring-fill');
  const pctEl = document.getElementById('ring-pct');
  if (ring)  ring.style.strokeDashoffset = CIRC - (CIRC * overall);
  if (pctEl) pctEl.textContent = Math.round(overall * 100) + '%';
}

// ── Save ───────────────────────────────────────────────────────────────────────
window.saveLog = async function(silent = false) {
  try {
    await setDoc(doc(db, 'users', USER_ID, 'daily_logs', TODAY), { ...logData, date: TODAY }, { merge: true });
    if (!silent) showToast('Giornata salvata! ✅');
  } catch(e) {
    console.error(e);
    if (!silent) showToast('Errore nel salvataggio', 'err');
  }
};

function setupAutoSave() {
  if (!settings?.auto_save) return;
  document.getElementById('autosave-info').style.display = 'block';
  const mins = settings.auto_save_minutes || 5;
  autoTimer = setInterval(() => window.saveLog(true), mins * 60 * 1000);
}

init();
