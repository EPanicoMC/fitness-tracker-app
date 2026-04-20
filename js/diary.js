import {
  db, USER_ID, collection, doc, getDocs, query, where, orderBy, limit
} from './firebase-config.js';
import { getTodayString, getDayOfWeek, formatDateIT, formatDateShort, DAYS_IT, DAY_ORDER } from './app.js';

const TODAY = getTodayString();
let currentMonth = new Date(TODAY + 'T12:00:00');
currentMonth.setDate(1);
let programData = null;
let monthLogs   = {};

async function init() {
  const [progSnap, logsSnap] = await Promise.all([
    getDocs(collection(db, 'users', USER_ID, 'programs')),
    getDocs(query(
      collection(db, 'users', USER_ID, 'daily_logs'),
      orderBy('date', 'desc'),
      limit(60)
    ))
  ]);

  const activeDoc = progSnap.docs.find(d => d.data().active);
  if (activeDoc) programData = activeDoc.data();

  const lastCompleted = logsSnap.docs
    .map(d => d.data())
    .find(d => d.workout?.completed);

  renderNextSession(lastCompleted);
  loadCalendar();
}

// ── Prossima sessione ──────────────────────────────────────
function renderNextSession(lastLog) {
  const el = document.getElementById('next-session');
  if (!el) return;
  if (!programData?.schedule) { el.innerHTML = ''; return; }

  const trainingDays = DAY_ORDER.filter(d => programData.schedule[d]);
  if (!trainingDays.length) { el.innerHTML = ''; return; }

  let nextDay;
  if (lastLog?.workout?.session_day && trainingDays.includes(lastLog.workout.session_day)) {
    const lastIdx = trainingDays.indexOf(lastLog.workout.session_day);
    nextDay = trainingDays[(lastIdx + 1) % trainingDays.length];
  } else {
    const todayDowIdx = DAY_ORDER.indexOf(getDayOfWeek(TODAY));
    nextDay = trainingDays.find(d => DAY_ORDER.indexOf(d) >= todayDowIdx) || trainingDays[0];
  }

  const session  = programData.schedule[nextDay];
  const nextDate = getNextDateForDay(nextDay);

  el.innerHTML = `
    <div class="card card-o" style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:11px;color:var(--t2);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px">📌 Prossima sessione</div>
          <div style="font-size:16px;font-weight:800">${session.name}</div>
          <div style="font-size:12px;color:var(--t2);margin-top:3px">${DAYS_IT[nextDay]} · ${formatDateShort(nextDate)} · ${session.exercises?.length || 0} esercizi</div>
        </div>
        <a href="session.html" class="btn btn-o btn-sm" style="text-decoration:none;flex-shrink:0">▶️ Vai</a>
      </div>
    </div>`;
}

function getNextDateForDay(targetDow) {
  const targetIdx  = DAY_ORDER.indexOf(targetDow);
  const todayDowIdx = DAY_ORDER.indexOf(getDayOfWeek(TODAY));
  let diff = targetIdx - todayDowIdx;
  if (diff <= 0) diff += 7;
  const base = new Date(TODAY + 'T12:00:00');
  base.setDate(base.getDate() + diff);
  return base.toISOString().split('T')[0];
}

// ── Calendar ───────────────────────────────────────────────
async function loadCalendar() {
  const y = currentMonth.getFullYear();
  const m = currentMonth.getMonth();
  const monthStr = `${y}-${String(m + 1).padStart(2, '0')}`;

  document.getElementById('month-label').textContent =
    currentMonth.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });

  monthLogs = {};
  try {
    const snap = await getDocs(query(
      collection(db, 'users', USER_ID, 'daily_logs'),
      where('date', '>=', `${monthStr}-01`),
      where('date', '<=', `${monthStr}-31`),
      orderBy('date')
    ));
    snap.docs.forEach(d => { monthLogs[d.data().date] = d.data(); });
  } catch(e) {}

  renderGrid(y, m);
}

function renderGrid(year, month) {
  const el = document.getElementById('cal-grid');
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay    = new Date(year, month, 1).getDay();
  const offset      = firstDay === 0 ? 6 : firstDay - 1;

  let html = '';
  for (let i = 0; i < offset; i++) html += '<div class="cal-day empty"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const log     = monthLogs[dateStr];
    const dow     = getDayOfWeek(dateStr);
    const isOn    = !!(programData?.schedule?.[dow]);
    const isToday = dateStr === TODAY;

    let cls = 'cal-day';
    if (isToday) cls += ' today';

    if (log) {
      cls += log.workout?.completed ? ' has-on' : ' has-off';
    } else if (dateStr < TODAY) {
      if (isOn) cls += ' missed';
    } else if (dateStr > TODAY) {
      if (isOn) cls += ' planned';
    }

    html += `<div class="${cls}" onclick="showDay('${dateStr}')">${d}</div>`;
  }

  el.innerHTML = html;
}

// ── Day detail ─────────────────────────────────────────────
window.showDay = async function(dateStr) {
  const det = document.getElementById('day-detail');
  det.style.display = 'block';
  det.innerHTML = '<div class="spin"></div>';

  const log = monthLogs[dateStr];
  const dow = getDayOfWeek(dateStr);
  const isOn = !!(programData?.schedule?.[dow]);
  const isFuture = dateStr > TODAY;
  const isPast   = dateStr < TODAY;
  const session  = programData?.schedule?.[dow];

  // Futuro pianificato
  if (isFuture && !log && isOn && session) {
    det.innerHTML = `
      <div class="diary-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <p style="font-size:15px;font-weight:700">${formatDateIT(dateStr)}</p>
          <span class="badge" style="background:rgba(124,111,255,.2);color:var(--accent)">📅 Pianificato</span>
        </div>
        <div style="font-size:14px;font-weight:700;color:var(--accent)">${session.name}</div>
        ${session.time ? `<div style="font-size:12px;color:var(--t2);margin-top:4px">🕐 ${session.time}</div>` : ''}
        <div style="margin-top:10px">
          ${(session.exercises || []).map(ex =>
            `<div style="font-size:13px;color:var(--t2);padding:3px 0">💪 ${ex.name} · ${ex.sets}×${ex.reps}</div>`
          ).join('')}
          ${session.cardio ? `<div style="font-size:12px;color:var(--blue);margin-top:4px">🏃 ${session.cardio.type} ${session.cardio.duration_minutes}min</div>` : ''}
        </div>
      </div>`;
    return;
  }

  // Passato senza log e con sessione pianificata = saltata
  if (isPast && !log && isOn) {
    det.innerHTML = `
      <div class="diary-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <p style="font-size:15px;font-weight:700">${formatDateIT(dateStr)}</p>
          <span class="badge badge-r">❌ Saltata</span>
        </div>
        <div style="font-size:14px;font-weight:700;color:var(--red)">Sessione saltata: ${session?.name || 'Allenamento'}</div>
        ${session ? `
          <div style="margin-top:10px">
            ${(session.exercises || []).map(ex =>
              `<div style="font-size:13px;color:var(--t3);padding:2px 0">💪 ${ex.name} · ${ex.sets}×${ex.reps}</div>`
            ).join('')}
          </div>` : ''}
      </div>`;
    return;
  }

  // Nessun dato
  if (!log) {
    det.innerHTML = `
      <div class="diary-card">
        <p style="font-size:15px;font-weight:700;margin-bottom:4px">${formatDateIT(dateStr)}</p>
        <p style="color:var(--t2);font-size:14px">Nessun dato registrato</p>
      </div>`;
    return;
  }

  // Log esistente — riepilogo completo
  const tots = log.nutrition?.totals || {};
  const plan = isOn
    ? (await getActiveDietPlan())?.day_on
    : (await getActiveDietPlan())?.day_off;

  let workoutHtml = '';
  if (log.workout?.completed) {
    const w   = log.workout;
    const dur = Math.round((w.duration_seconds || 0) / 60);
    const vol = (w.exercises || []).reduce((a, ex) =>
      a + ex.sets.reduce((b, s) => b + (parseFloat(s.weight) || 0) * (parseFloat(s.reps) || 1), 0), 0);
    workoutHtml = `
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-weight:700;font-size:14px">💪 ${w.session_name || 'Allenamento'}</div>
            <div style="font-size:12px;color:var(--t2);margin-top:3px">⏱ ${dur} min · 🏋️ ${Math.round(vol)} kg vol.</div>
          </div>
          <span class="badge badge-g">✅</span>
        </div>
      </div>`;
  } else if (isOn) {
    workoutHtml = `<div style="margin-top:12px;font-size:13px;color:var(--orange)">⚠️ Sessione non completata</div>`;
  }

  det.innerHTML = `
    <div class="diary-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <p style="font-size:16px;font-weight:800">${formatDateShort(dateStr)}</p>
        <span class="badge ${isOn ? 'badge-g' : 'badge-r'}">${isOn ? '💪 ON' : '😴 OFF'}</span>
      </div>
      ${tots.kcal ? `
        <div class="mrow">
          <span class="mlabel">🔥 Kcal</span>
          <span class="mval">${Math.round(tots.kcal)} ${plan?.kcal ? '/ ' + plan.kcal : ''}</span>
        </div>
        <div class="pbb h4" style="margin-bottom:8px">
          <div class="pbf pb-v" style="width:${plan?.kcal ? Math.min(100, (tots.kcal / plan.kcal * 100)) : 0}%"></div>
        </div>
        <div style="display:flex;gap:12px;font-size:13px;color:var(--t2)">
          <span>🥩 ${Math.round(tots.protein || 0)}g</span>
          <span>🌾 ${Math.round(tots.carbs || 0)}g</span>
          <span>🧈 ${Math.round(tots.fats || 0)}g</span>
        </div>` : '<p style="color:var(--t3);font-size:13px">Nessun dato nutrizionale</p>'}
      ${log.steps       ? `<div style="margin-top:8px;font-size:13px;color:var(--t2)">👟 ${log.steps} passi</div>` : ''}
      ${log.burned_kcal ? `<div style="font-size:13px;color:var(--t2)">🔥 ${log.burned_kcal} kcal bruciate</div>` : ''}
      ${log.daily_note  ? `<div style="margin-top:10px;font-size:13px;color:var(--t2);font-style:italic">"${log.daily_note}"</div>` : ''}
      ${workoutHtml}
    </div>`;
};

let _dietPlanCache = null;
async function getActiveDietPlan() {
  if (_dietPlanCache) return _dietPlanCache;
  const snap = await getDocs(collection(db, 'users', USER_ID, 'diet_plans'));
  _dietPlanCache = snap.docs.find(d => d.data().active)?.data() || null;
  return _dietPlanCache;
}

window.changeMonth = function(delta) {
  currentMonth.setMonth(currentMonth.getMonth() + delta);
  document.getElementById('day-detail').style.display = 'none';
  loadCalendar();
};

init();
