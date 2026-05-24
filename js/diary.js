import { requireAuth } from './app.js';
import {
  db, getUserId, collection, doc, getDoc, getDocs, setDoc, deleteField, query, where, orderBy, limit
} from './firebase-config.js';
import { getTodayString, getDayOfWeek, formatDateIT, formatDateShort, showToast, DAYS_IT, DAY_ORDER } from './app.js';
import { generateWeeklyCoachReportAI, calcMacrosFromText, analyzeFoodImageAI } from './gemini.js';

const TODAY = getTodayString();
let currentMonth = new Date(TODAY + 'T12:00:00');
currentMonth.setDate(1);
let programData  = null;
let monthLogs    = {};
let allRecentLogs = {};
let selectedDate = null;
let settingsData = null;

async function init() {
  const [progSnap, logsSnap, settSnap, dietSnap] = await Promise.all([
    getDocs(collection(db, 'users', getUserId(), 'programs')),
    getDocs(query(
      collection(db, 'users', getUserId(), 'daily_logs'),
      orderBy('date', 'desc'),
      limit(60)
    )),
    getDoc(doc(db, 'users', getUserId(), 'settings', 'app')),
    getDocs(collection(db, 'users', getUserId(), 'diet_plans'))
  ]);

  const activeDoc = progSnap.docs.find(d => d.data().active);
  if (activeDoc) programData = activeDoc.data();
  settingsData = settSnap.exists() ? settSnap.data() : {};
  _dietPlanCache = dietSnap.docs.find(d => d.data().active)?.data() || null;

  logsSnap.docs.forEach(d => { allRecentLogs[d.data().date] = d.data(); });

  const lastCompleted = logsSnap.docs
    .map(d => d.data())
    .find(d => d.workout?.completed);

  renderNextSession(lastCompleted);
  buildWeekView();
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
      collection(db, 'users', getUserId(), 'daily_logs'),
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

    if (dateStr === selectedDate) cls += ' selected';
    html += `<div class="${cls}" onclick="showDay('${dateStr}')">${d}</div>`;
  }

  el.innerHTML = html;
}

// ── Day detail ─────────────────────────────────────────────
window.closeDay = function() {
  document.getElementById('day-detail').style.display = 'none';
  selectedDate = null;
  renderGrid(currentMonth.getFullYear(), currentMonth.getMonth());
};

window.showDay = async function(dateStr) {
  const det = document.getElementById('day-detail');

  // Toggle: click same day again to close
  if (selectedDate === dateStr && det.style.display !== 'none') {
    det.style.display = 'none';
    selectedDate = null;
    renderGrid(currentMonth.getFullYear(), currentMonth.getMonth());
    return;
  }

  selectedDate = dateStr;
  renderGrid(currentMonth.getFullYear(), currentMonth.getMonth());

  det.style.display = 'block';
  det.innerHTML = '<div class="spin"></div>';
  setTimeout(() => { det.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 100);

  const log = monthLogs[dateStr];
  const dow = getDayOfWeek(dateStr);
  const isOn = !!(programData?.schedule?.[dow]);
  const isFuture = dateStr > TODAY;
  const isPast   = dateStr < TODAY;
  const session  = programData?.schedule?.[dow];
  const X = `<button onclick="closeDay()" style="float:right;background:none;border:none;color:var(--t2);font-size:20px;cursor:pointer;line-height:1;padding:0">✕</button>`;

  // Futuro pianificato
  if (isFuture && !log && isOn && session) {
    det.innerHTML = `
      <div class="diary-card">
        ${X}
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
        ${X}
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
        <button class="btn btn-ghost btn-sm" style="margin-top:12px;width:100%" onclick="openRecoverDay('${dateStr}')">📋 Recupera questa giornata</button>
      </div>`;
    return;
  }

  // Nessun dato
  if (!log) {
    det.innerHTML = `
      <div class="diary-card">
        ${X}
        <p style="font-size:15px;font-weight:700;margin-bottom:4px">${formatDateIT(dateStr)}</p>
        <p style="color:var(--t2);font-size:14px">Nessun dato registrato</p>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn-ghost btn-sm" onclick="window.openAddMealForDate('${dateStr}')" style="flex:1">＋ Pasto</button>
          <button class="btn btn-ghost btn-sm" onclick="window.openAddMealWithCameraForDate('${dateStr}')" style="flex:1">📸 Scanner</button>
        </div>
        ${isPast ? `<button class="btn btn-ghost btn-sm" style="margin-top:10px;width:100%" onclick="openRecoverDay('${dateStr}')">📋 Recupera questa giornata</button>` : ''}
      </div>`;
    return;
  }

  // Log esistente — riepilogo completo
  const tots = log.nutrition?.totals || {};
  const dietPlan = await getActiveDietPlan();
  const plan = isOn ? dietPlan?.day_on : dietPlan?.day_off;

  let workoutHtml = '';
  if (log.workout?.completed) {
    const w   = log.workout;
    const dur = Math.round((w.duration_seconds || 0) / 60);
    const vol = (w.exercises || []).reduce((a, ex) =>
      a + ex.sets.reduce((b, s) => b + (parseFloat(s.weight) || 0) * (parseFloat(s.reps) || 1), 0), 0);
    const notesHtml = w.notes ? `<div style="font-size:12px;color:var(--t3);margin-top:4px;font-style:italic">"${w.notes}"</div>` : '';
    workoutHtml = `
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div style="flex:1">
            <div style="font-weight:700;font-size:14px">💪 ${w.session_name || 'Allenamento'}</div>
            <div style="font-size:12px;color:var(--t2);margin-top:3px">⏱ ${dur} min · 🏋️ ${Math.round(vol)} kg vol.</div>
            ${notesHtml}
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <span class="badge badge-g">✅</span>
            <button class="btn-del" style="padding:5px 10px;font-size:11px" onclick="confirmDeleteWorkout('${dateStr}')">🗑️</button>
          </div>
        </div>
      </div>`;
  } else if (isOn) {
    workoutHtml = `<div style="margin-top:12px;font-size:13px;color:var(--orange)">⚠️ Sessione non completata</div>`;
  }

  const badgeHtml = computeDayBadge(log, plan, isOn);

  det.innerHTML = `
    <div class="diary-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <p style="font-size:16px;font-weight:800">${formatDateShort(dateStr)}</p>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="badge ${isOn ? 'badge-g' : ''}" style="${!isOn ? 'background:rgba(120,120,160,.15);color:var(--t2)' : ''}">${isOn ? '💪 ON' : '😴 OFF'}</span>
          <button class="btn btn-ghost btn-xs" onclick="openEditDay('${dateStr}')">✏️</button>
          ${X}
        </div>
      </div>
      ${badgeHtml}
      ${tots.kcal ? (() => {
        const diffKcal = plan?.kcal ? Math.round(tots.kcal - plan.kcal) : null;
        const diffPro  = plan?.protein ? Math.round((tots.protein || 0) - plan.protein) : null;
        const diffCarb = plan?.carbs ? Math.round((tots.carbs || 0) - plan.carbs) : null;
        const diffFat  = plan?.fats ? Math.round((tots.fats || 0) - plan.fats) : null;

        const fmtDiff = (val, unit='') => {
          if (val === null) return '';
          const sign = val > 0 ? '+' : '';
          const col = val > 0 ? '#ff453a' : val < 0 ? '#0a84ff' : 'var(--t3)';
          return ` <span style="color:${col};font-weight:700;font-size:11px">(${sign}${val}${unit})</span>`;
        };

        const fmtDiffPro = (val) => {
          if (val === null) return '';
          const sign = val > 0 ? '+' : '';
          const col = val >= 0 ? '#30d158' : '#ff453a';
          return ` <span style="color:${col};font-weight:700;font-size:11px">(${sign}${val}g)</span>`;
        };

        const fmtDiffCarbFat = (val) => {
          if (val === null) return '';
          const sign = val > 0 ? '+' : '';
          const col = val > 0 ? '#ff9f0a' : val < 0 ? '#0a84ff' : 'var(--t3)';
          return ` <span style="color:${col};font-weight:700;font-size:11px">(${sign}${val}g)</span>`;
        };

        const kcalDiffStr = diffKcal !== null ? fmtDiff(diffKcal, ' kcal') : '';
        const proDiffStr  = diffPro !== null ? fmtDiffPro(diffPro) : '';
        const carbDiffStr = diffCarb !== null ? fmtDiffCarbFat(diffCarb) : '';
        const fatDiffStr  = diffFat !== null ? fmtDiffCarbFat(diffFat) : '';

        return `
          <div class="mrow">
            <span class="mlabel">🔥 Kcal</span>
            <span class="mval">${Math.round(tots.kcal)} ${plan?.kcal ? '/ ' + plan.kcal : ''}${kcalDiffStr}</span>
          </div>
          <div class="pbb h4" style="margin-bottom:8px">
            <div class="pbf pb-v" style="width:${plan?.kcal ? Math.min(100, (tots.kcal / plan.kcal * 100)) : 0}%"></div>
          </div>
          <div style="display:flex;gap:12px;font-size:13px;color:var(--t2);flex-wrap:wrap">
            <span>🥩 ${Math.round(tots.protein || 0)}g${proDiffStr}</span>
            <span>🌾 ${Math.round(tots.carbs || 0)}g${carbDiffStr}</span>
            <span>🧈 ${Math.round(tots.fats || 0)}g${fatDiffStr}</span>
          </div>`;
      })() : '<p style="color:var(--t3);font-size:13px">Nessun dato nutrizionale</p>'}
      ${log.steps       ? `<div style="margin-top:8px;font-size:13px;color:var(--t2)">👟 ${log.steps.toLocaleString('it-IT')} passi</div>` : ''}
      ${log.burned_kcal ? `<div style="font-size:13px;color:var(--t2)">🔥 ${log.burned_kcal} kcal bruciate</div>` : ''}
      ${log.daily_note  ? `<div style="margin-top:10px;font-size:13px;color:var(--t2);font-style:italic">"${log.daily_note}"</div>` : ''}
      
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-ghost btn-sm" onclick="window.openAddMealForDate('${dateStr}')" style="flex:1">＋ Pasto Extra</button>
        <button class="btn btn-ghost btn-sm" onclick="window.openAddMealWithCameraForDate('${dateStr}')" style="flex:1">📸 Scanner Pasto</button>
      </div>

      ${workoutHtml}
    </div>`;
};

let _dietPlanCache = null;
async function getActiveDietPlan() {
  if (_dietPlanCache) return _dietPlanCache;
  const snap = await getDocs(collection(db, 'users', getUserId(), 'diet_plans'));
  _dietPlanCache = snap.docs.find(d => d.data().active)?.data() || null;
  return _dietPlanCache;
}

function computeDayBadge(log, plan, isOn) {
  const kcal    = log.nutrition?.totals?.kcal    || 0;
  const protein = log.nutrition?.totals?.protein || 0;
  const steps   = log.steps || 0;
  const workoutDone = !!log.workout?.completed;

  // Pasti (40pt) — FitScore 2.0
  let pastiPt = 0;
  if (plan?.kcal > 0 && kcal > 0) {
    let scoreKcal = 0, scoreFats = 0, scoreCarbs = 0;
    
    // Kcal (max 20)
    const ratioKcal = kcal / plan.kcal;
    if (ratioKcal >= 0.95 && ratioKcal <= 1.05) scoreKcal = 20;
    else if (ratioKcal < 0.95) scoreKcal = Math.max(0, 20 - (1 - ratioKcal) * 40);
    else scoreKcal = Math.max(0, 20 - (ratioKcal - 1) * 50); // Penalty for overeating
    
    // Fats (max 10) - Heavy penalty for overeating
    const fats = log.nutrition?.totals?.fats || 0;
    if (plan.fats > 0) {
      const ratioFats = fats / plan.fats;
      if (ratioFats <= 1.05) scoreFats = 10;
      else scoreFats = Math.max(0, 10 - (ratioFats - 1) * 30); // Steep penalty
    } else scoreFats = 10;
    
    // Carbs (max 10) - Moderate penalty
    const carbs = log.nutrition?.totals?.carbs || 0;
    if (plan.carbs > 0) {
      const ratioCarbs = carbs / plan.carbs;
      if (ratioCarbs <= 1.10) scoreCarbs = 10;
      else scoreCarbs = Math.max(0, 10 - (ratioCarbs - 1) * 15);
    } else scoreCarbs = 10;
    
    pastiPt = Math.round(scoreKcal + scoreFats + scoreCarbs);
  } else if (kcal > 0) {
    pastiPt = 20;
  }

  // Allenamento (35pt)
  let allenamPt = 0;
  if (!isOn) allenamPt = 35;
  else if (workoutDone) allenamPt = 35;

  // Passi (15pt)
  const stepsGoal = settingsData?.steps_goal || 0;
  let passiPt = 0;
  if (stepsGoal <= 0) {
    passiPt = 15;
  } else if (steps > 0) {
    const r = steps / stepsGoal;
    if (r >= 1) passiPt = 15;
    else if (r >= 0.75) passiPt = 10;
    else if (r >= 0.5) passiPt = 5;
  }

  // Proteine (10pt) - Heavy penalty for under-eating
  let protPt = 0;
  const planPro = plan?.protein || 0;
  if (planPro > 0 && protein > 0) {
    const ratioPro = protein / planPro;
    if (ratioPro >= 0.9) protPt = 10;
    else protPt = Math.max(0, 10 - (1 - ratioPro) * 20);
  } else if (protein > 0) {
    protPt = 5;
  }
  protPt = Math.round(protPt);

  const score = pastiPt + allenamPt + passiPt + protPt;
  const col = score >= 90 ? '#00dc78' : score >= 75 ? '#4ade80' : score >= 55 ? '#fbbf24' : score >= 35 ? '#ff6a00' : '#ff3b3b';
  const label = score >= 90 ? 'Eccellente' : score >= 75 ? 'Ottimo' : score >= 55 ? 'Nella media' : score >= 35 ? 'Da migliorare' : 'Critico';

  const r = 22, cx = 27, cy = 27;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - score / 100);

  const breakdown = [
    { label: 'Pasti', pts: pastiPt, max: 40, ok: pastiPt >= 30 },
    { label: 'Gym',   pts: allenamPt, max: 35, ok: allenamPt >= 25 },
    { label: 'Passi', pts: passiPt,   max: 15, ok: passiPt >= 10 },
    { label: 'Pro',   pts: protPt,    max: 10, ok: protPt >= 7 }
  ];
  const dots = breakdown.map(b =>
    `<span style="color:${b.ok ? '#4ade80' : 'var(--t3)'};font-size:11px">${b.label}: ${b.pts}/${b.max}</span>`
  ).join(' · ');

  return `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:10px;margin-bottom:12px">
      <svg width="54" height="54" viewBox="0 0 54 54" style="flex-shrink:0">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="5"/>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col}" stroke-width="5"
          stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" stroke-linecap="round"
          transform="rotate(-90 ${cx} ${cy})" style="filter:drop-shadow(0 0 4px ${col}80)"/>
        <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
          font-size="13" font-weight="900" fill="${col}">${score}</text>
      </svg>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:800;color:${col};margin-bottom:2px">${label}</div>
        <div style="font-size:10px;color:var(--t3);margin-bottom:6px">SmartScore / 100</div>
        <div style="line-height:1.9">${dots}</div>
      </div>
    </div>`;
}

// ── Tab switcher ───────────────────────────────────────────
window.showTab = function(tab) {
  document.getElementById('week-view').style.display = tab === 'week' ? 'block' : 'none';
  document.getElementById('cal-view').style.display  = tab === 'cal'  ? 'block' : 'none';
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.classList.toggle('tab-active', (i === 0 && tab === 'week') || (i === 1 && tab === 'cal'));
  });
};

// ── WeeklySmartScore algorithm ─────────────────────────────
function calcWeeklySmartScore(dates, logs, programData, dietPlan, settings) {
  const today = getTodayString();

  // ── Workout pillar (40%) ───────────────────────────────────
  const workoutDays = [];
  let wPoints = 0, wMax = 0;

  for (let i = 0; i < dates.length; i++) {
    const dateStr = dates[i];
    if (dateStr > today) continue;

    const log = logs[dateStr];
    const dow = getDayOfWeek(dateStr);
    let isTraining = !!(programData?.schedule?.[dow]);
    if (log?.is_training_day != null) isTraining = log.is_training_day;

    if (!isTraining) {
      workoutDays.push({ date: dateStr, status: 'rest', label: 'Riposo', pct: 100 });
      wPoints += 100; wMax += 100;
      continue;
    }

    if (log?.workout?.completed) {
      const isRecov = log.workout.recovered;
      workoutDays.push({ date: dateStr, status: isRecov ? 'recovered-logged' : 'done', label: log.workout.session_name || 'Allenamento', pct: 100 });
      wPoints += 100; wMax += 100;
    } else {
      // Cerca recupero nei 2 giorni successivi
      let recovered = false, recoveredLate = false;
      for (let j = 1; j <= 2; j++) {
        const nextDate = dates[i + j];
        if (!nextDate || nextDate > today) break;
        const nextLog = logs[nextDate];
        if (!nextLog?.workout?.completed) continue;
        // Conta come recupero solo se il giorno successivo era riposo o l'allenamento è esplicitamente marked
        const nextDow = getDayOfWeek(nextDate);
        let nextIsTraining = !!(programData?.schedule?.[nextDow]);
        if (nextLog.is_training_day != null) nextIsTraining = nextLog.is_training_day;
        if (nextLog.workout.recovered || !nextIsTraining) {
          if (j === 1) recovered = true;
          else recoveredLate = true;
          break;
        }
      }
      if (recovered) {
        workoutDays.push({ date: dateStr, status: 'recovered', label: 'Recuperato', pct: 80 });
        wPoints += 80; wMax += 100;
      } else if (recoveredLate) {
        workoutDays.push({ date: dateStr, status: 'recovered-late', label: 'Rec. tardivo', pct: 65 });
        wPoints += 65; wMax += 100;
      } else {
        workoutDays.push({ date: dateStr, status: 'missed', label: 'Saltato', pct: 0 });
        wPoints += 0; wMax += 100;
      }
    }
  }
  const workoutScore = wMax > 0 ? Math.round((wPoints / wMax) * 100) : null;

  // ── Nutrition pillar (40%) ─────────────────────────────────
  const nutritionDays = [];
  let nScoreSum = 0, nDays = 0;

  for (const dateStr of dates) {
    if (dateStr > today) continue;
    const log = logs[dateStr];
    if (!log) continue;
    const kcal    = log.nutrition?.totals?.kcal    || 0;
    const protein = log.nutrition?.totals?.protein || 0;
    if (kcal <= 0 && protein <= 0) continue;

    const isOn = log.is_training_day != null
      ? log.is_training_day
      : !!(programData?.schedule?.[getDayOfWeek(dateStr)]);
    const plan = isOn ? dietPlan?.day_on : dietPlan?.day_off;

    let kcalScore = 25, proteinScore = 25, fatsScore = 25, carbsScore = 25;
    let kcalRatio = null, proteinRatio = null;

    if (plan?.kcal > 0 && kcal > 0) {
      kcalRatio = kcal / plan.kcal;
      if (kcalRatio >= 0.95 && kcalRatio <= 1.05) kcalScore = 100;
      else if (kcalRatio < 0.95) kcalScore = Math.max(0, 100 - (1 - kcalRatio) * 200);
      else kcalScore = Math.max(0, 100 - (kcalRatio - 1) * 250);
    }
    
    if (plan?.protein > 0 && protein > 0) {
      proteinRatio = protein / plan.protein;
      if (proteinRatio >= 0.90) proteinScore = 100;
      else proteinScore = Math.max(0, 100 - (1 - proteinRatio) * 200);
    }

    const fats = log.nutrition?.totals?.fats || 0;
    if (plan?.fats > 0 && fats > 0) {
      const ratioFats = fats / plan.fats;
      if (ratioFats <= 1.05) fatsScore = 100;
      else fatsScore = Math.max(0, 100 - (ratioFats - 1) * 300); // Steep penalty for fats
    }

    const carbs = log.nutrition?.totals?.carbs || 0;
    if (plan?.carbs > 0 && carbs > 0) {
      const ratioCarbs = carbs / plan.carbs;
      if (ratioCarbs <= 1.10) carbsScore = 100;
      else carbsScore = Math.max(0, 100 - (ratioCarbs - 1) * 150); // Moderate penalty for carbs
    }

    const dayScore = kcal > 0 ? (kcalScore * 0.4 + proteinScore * 0.3 + fatsScore * 0.2 + carbsScore * 0.1) : proteinScore;
    nutritionDays.push({ date: dateStr, kcal, protein, kcalTarget: plan?.kcal || 0, proteinTarget: plan?.protein || 0, kcalRatio, proteinRatio, dayScore });
    nScoreSum += dayScore; nDays++;
  }
  const nutritionScore = nDays > 0 ? Math.round(nScoreSum / nDays) : null;

  // ── Consistency pillar (20%) ───────────────────────────────
  const pastDates = dates.filter(d => d <= today);
  const daysWithData = pastDates.filter(d => {
    const l = logs[d];
    return l && (l.nutrition?.totals?.kcal > 0 || l.workout?.completed || l.steps > 0);
  });
  const consistencyScore = pastDates.length > 0
    ? Math.round((daysWithData.length / pastDates.length) * 100)
    : null;

  // ── Final weighted score ──────────────────────────────────
  let finalScore = null;
  const components = [];
  if (workoutScore !== null)     components.push({ score: workoutScore, weight: 0.40 });
  if (nutritionScore !== null)   components.push({ score: nutritionScore, weight: 0.40 });
  if (consistencyScore !== null) components.push({ score: consistencyScore, weight: 0.20 });
  if (components.length > 0) {
    const totalWeight = components.reduce((s, c) => s + c.weight, 0);
    finalScore = Math.round(components.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight);
  }

  const tips = generateWeeklyTips({ workoutDays, nutritionDays, dates, today, workoutScore, nutritionScore, consistencyScore, pastDates });
  return { finalScore, workoutScore, nutritionScore, consistencyScore, workoutDays, nutritionDays, tips };
}

function generateWeeklyTips({ workoutDays, nutritionDays, dates, today, workoutScore, nutritionScore, consistencyScore, pastDates }) {
  const tips = [];

  // Workout tips
  const missedWorkouts = workoutDays.filter(d => d.status === 'missed');
  const recoveredWorkouts = workoutDays.filter(d => d.status === 'recovered' || d.status === 'recovered-late');

  if (recoveredWorkouts.length > 0 && missedWorkouts.length === 0) {
    tips.push({ type: 'positive', icon: '💪', title: 'Recupero perfetto!', text: `Hai recuperato ${recoveredWorkouts.length} session${recoveredWorkouts.length > 1 ? 'i' : 'e'} saltata. Questa flessibilità è la chiave della consistenza a lungo termine.` });
  } else if (missedWorkouts.length > 0) {
    const remainingDays = dates.filter(d => d > today).length;
    if (remainingDays > 0) {
      tips.push({ type: 'warning', icon: '⏰', title: `${missedWorkouts.length} session${missedWorkouts.length > 1 ? 'i' : 'e'} da recuperare`, text: `Hai ancora ${remainingDays} giorn${remainingDays > 1 ? 'i' : 'o'} questa settimana. Aggiungila ai giorni liberi per chiudere in parità.` });
    } else {
      tips.push({ type: 'alert', icon: '❌', title: 'Settimana di allenamento incompleta', text: `Hai saltato ${missedWorkouts.length} allenament${missedWorkouts.length > 1 ? 'i' : 'o'} senza recupero. Inizia la prossima con più margine nei giorni liberi.` });
    }
  }

  // Nutrition tips (per singolo giorno, non media)
  if (nutritionDays.length > 0) {
    const overDays  = nutritionDays.filter(d => d.kcalRatio && d.kcalRatio > 1.15);
    const underDays = nutritionDays.filter(d => d.kcalRatio && d.kcalRatio < 0.85);
    if (overDays.length >= 2) {
      const maxOver = overDays.reduce((m, d) => d.kcalRatio > m.kcalRatio ? d : m, overDays[0]);
      tips.push({ type: 'warning', icon: '🔥', title: `Calorie in eccesso per ${overDays.length} giorni`, text: `Picco massimo: +${Math.round((maxOver.kcalRatio - 1) * 100)}% sopra il target. Identifica i pasti extra e sostituiscili con opzioni più leggere.` });
    } else if (underDays.length >= 2) {
      tips.push({ type: 'warning', icon: '📉', title: `Apporto calorico basso per ${underDays.length} giorni`, text: `Mangiare stabilmente sotto l'85% del target rallenta metabolismo e recupero muscolare. Aggiungi uno spuntino nutriente.` });
    }
    const lowProteinDays = nutritionDays.filter(d => d.proteinTarget > 0 && d.proteinRatio && d.proteinRatio < 0.80);
    if (lowProteinDays.length >= 2) {
      const avgPro = Math.round(nutritionDays.reduce((s, d) => s + d.protein, 0) / nutritionDays.length);
      const target = nutritionDays.find(d => d.proteinTarget > 0)?.proteinTarget || 0;
      tips.push({ type: 'alert', icon: '🥩', title: `Proteine sotto target per ${lowProteinDays.length} giorni`, text: `Media settimanale: ${avgPro}g${target > 0 ? ` / ${target}g obiettivo` : ''}. Aggiungi ricotta, uova o petto di pollo come spuntino pomeridiano.` });
    }
  }

  // Consistency tip
  if (consistencyScore !== null && consistencyScore < 70) {
    const loggedDays = Math.round(consistencyScore / 100 * pastDates.length);
    tips.push({ type: 'alert', icon: '📋', title: 'Tracciamento da migliorare', text: `Dati registrati per ${loggedDays} giorn${loggedDays !== 1 ? 'i' : 'o'} su ${pastDates.length}. Trackare ogni giorno ti aiuta a capire cosa funziona per te.` });
  }

  // Positive tip se tutto va bene
  if (tips.length === 0 || (workoutScore >= 90 && nutritionScore !== null && nutritionScore >= 80)) {
    if (!tips.find(t => t.type === 'positive')) {
      tips.push({ type: 'positive', icon: '🚀', title: 'Settimana eccellente!', text: 'Allenamenti e alimentazione in linea con gli obiettivi. La costanza porta risultati concreti!' });
    }
  }

  const order = { alert: 0, warning: 1, positive: 2 };
  return tips.sort((a, b) => (order[a.type] || 0) - (order[b.type] || 0)).slice(0, 3);
}

// ── 2-Week view ────────────────────────────────────────────
function buildWeekView() {
  const el = document.getElementById('week-view');
  if (!el) return;

  // Calcola ultimi 7 giorni (da 6 giorni fa ad oggi)
  const todayDate = new Date(TODAY + 'T12:00:00');
  const startDate = new Date(todayDate);
  startDate.setDate(todayDate.getDate() - 6);

  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }

  const wss = calcWeeklySmartScore(dates, allRecentLogs, programData, _dietPlanCache, settingsData);

  // ── #recent-recap: Weekly Score Hero ──────────────────────
  const recapEl = document.getElementById('recent-recap');
  if (recapEl) {
    if (wss.finalScore !== null) {
      const score = wss.finalScore;
      const col   = score >= 85 ? '#1ce370' : score >= 70 ? '#4ade80' : score >= 55 ? '#fbbf24' : score >= 35 ? '#ff6a00' : '#ff453a';
      const label = score >= 85 ? 'Eccellente' : score >= 70 ? 'Ottimo' : score >= 55 ? 'Nella media' : score >= 35 ? 'Da migliorare' : 'Critico';

      const r = 28, cx = 34, cy = 34;
      const circ  = 2 * Math.PI * r;
      const offset = circ * (1 - score / 100);

      const pCol = (s) => s >= 80 ? 'var(--green)' : s >= 60 ? 'var(--yellow)' : 'var(--orange)';
      const pillars = [
        { label: '💪 Workout',   score: wss.workoutScore },
        { label: '🍽 Nutrizione', score: wss.nutritionScore },
        { label: '📋 Costanza',   score: wss.consistencyScore },
      ].filter(p => p.score !== null);

      const pillarsHtml = pillars.map(p => `
        <div class="wss-pillar">
          <span class="wss-pillar-label">${p.label}</span>
          <div class="wss-pillar-bar">
            <div class="pbb h6"><div class="pbf" style="width:${p.score}%;background:${pCol(p.score)}"></div></div>
          </div>
          <span class="wss-pillar-val" style="color:${pCol(p.score)}">${p.score}%</span>
        </div>`).join('');

      recapEl.innerHTML = `
        <div class="card" style="margin-bottom:16px">
          <div class="clabel" style="margin-bottom:12px"><i class="ri-bar-chart-box-line"></i> Weekly Performance</div>
          <div style="display:flex;align-items:center;gap:16px">
            <div style="flex-shrink:0;text-align:center">
              <svg width="68" height="68" viewBox="0 0 68 68">
                <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="5"/>
                <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col}" stroke-width="5"
                  stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" stroke-linecap="round"
                  transform="rotate(-90 ${cx} ${cy})" style="filter:drop-shadow(0 0 6px ${col}80)"/>
                <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
                  font-size="15" font-weight="900" fill="${col}">${score}</text>
              </svg>
              <div style="margin-top:2px;font-size:10px;font-weight:800;color:${col}">${label}</div>
            </div>
            <div style="flex:1;min-width:0">${pillarsHtml}</div>
          </div>
        </div>`;
    } else {
      recapEl.innerHTML = '';
    }
  }

  // ── #week-view: 7-Day Heatmap + Smart Tips ────────────────
  const heatCards = dates.map(dateStr => {
    const log    = allRecentLogs[dateStr];
    const isFut  = dateStr > TODAY;
    const isToday = dateStr === TODAY;
    const dayDow = getDayOfWeek(dateStr);
    let isOn = !!(programData?.schedule?.[dayDow]);
    if (log?.is_training_day != null) isOn = log.is_training_day;

    let ico;
    if (isFut)                        ico = isOn ? '📅' : '😴';
    else if (log?.workout?.completed) ico = '✅';
    else if (!isOn)                   ico = '😴';
    else if (log)                     ico = '⚠️';
    else                              ico = '❌';

    const kcal = log?.nutrition?.totals?.kcal || 0;
    const isOn2 = log?.is_training_day != null ? log.is_training_day : isOn;
    const dayPlan = isOn2 ? _dietPlanCache?.day_on : _dietPlanCache?.day_off;
    const targetKcal = dayPlan?.kcal || 0;
    const kcalPct = targetKcal > 0 && kcal > 0 ? Math.min(130, Math.round(kcal / targetKcal * 100)) : 0;

    let barCol = 'var(--accent)';
    if (kcalPct > 115)        barCol = 'var(--red)';
    else if (kcalPct >= 90)   barCol = 'var(--green)';
    else if (kcalPct >= 70)   barCol = 'var(--yellow)';
    else if (kcalPct > 0)     barCol = 'var(--orange)';

    const dayShort = new Date(dateStr + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'short' }).replace('.', '');
    const dayNum   = new Date(dateStr + 'T12:00:00').getDate();

    const miniR = 11, miniCx = 14, miniCy = 14;
    const miniCirc   = 2 * Math.PI * miniR;
    const miniOffset = miniCirc * (1 - Math.min(1, kcalPct / 100));
    const kcalMini = kcalPct > 0
      ? `<svg width="28" height="28" viewBox="0 0 28 28">
          <circle cx="${miniCx}" cy="${miniCy}" r="${miniR}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="3"/>
          <circle cx="${miniCx}" cy="${miniCy}" r="${miniR}" fill="none" stroke="${barCol}" stroke-width="3"
            stroke-dasharray="${miniCirc.toFixed(2)}" stroke-dashoffset="${miniOffset.toFixed(2)}" stroke-linecap="round"
            transform="rotate(-90 ${miniCx} ${miniCy})"/>
          <text x="${miniCx}" y="${miniCy}" text-anchor="middle" dominant-baseline="central" font-size="7" font-weight="800" fill="${barCol}">${kcalPct}%</text>
        </svg>`
      : `<div style="width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:9px;color:var(--t3)">—</div>`;

    return `
      <div class="day-heat-card${isToday ? ' day-today' : ''}" onclick="selectWeekDay('${dateStr}')">
        <div class="day-heat-label" style="${isToday ? 'color:var(--accent)' : ''}">${dayShort}</div>
        <div style="font-size:9px;color:var(--t3);font-weight:600;margin-top:-1px">${dayNum}</div>
        <div class="day-heat-ico">${ico}</div>
        ${kcalMini}
      </div>`;
  }).join('');

  const tipsHtml = wss.tips.length > 0 ? `
    <p class="sdiv" style="margin-top:18px">Consigli</p>
    ${wss.tips.map(tip => `
      <div class="tip-card tip-${tip.type}">
        <div class="tip-card-icon">${tip.icon}</div>
        <div>
          <div class="tip-card-title">${tip.title}</div>
          <div class="tip-card-text">${tip.text}</div>
        </div>
      </div>`).join('')}` : '';

  const s = new Date(dates[0] + 'T12:00:00');
  const e = new Date(dates[6] + 'T12:00:00');
  const dateRangeLabel = `${s.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} – ${e.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}`;

  el.innerHTML = `
    <p class="sdiv" style="margin-bottom:10px">Ultimi 7 giorni · ${dateRangeLabel}</p>
    <div class="day-heat-wrap">
      <div class="day-heat-row">${heatCards}</div>
    </div>
    <div style="margin-top:5px;font-size:10px;color:var(--t3);text-align:center">Tocca un giorno per i dettagli</div>
    
    <!-- AI Weekly Coach Card -->
    <div class="card" style="margin-top:18px;background:rgba(124,111,255,0.04);border:1px solid rgba(124,111,255,0.12);padding:18px;border-radius:18px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:10px;font-weight:800;color:var(--accent);letter-spacing:0.5px">🤖 AI WEEKLY COACH</span>
        <span style="font-size:9px;color:var(--t3);font-weight:700">FEEDBACK PERSONALIZZATO</span>
      </div>
      <p style="font-size:12px;color:var(--t2);line-height:1.55;margin-bottom:12px;text-align:left">
        Analizza l'andamento settimanale delle tue calorie, macro, passi e allenamenti svolti per ricevere consigli strategici mirati.
      </p>
      <button class="btn btn-v btn-sm" onclick="window.generateWeeklyCoachReport()" style="width:100%;font-weight:700">
        🧠 Genera Report AI Settimanale
      </button>
    </div>

    ${tipsHtml}`;
}

// Naviga al giorno selezionato nella heatmap: switcha al calendario e apre il detail
window.selectWeekDay = function(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const target = new Date(y, m - 1, 1);
  const needsMonthChange = target.getFullYear() !== currentMonth.getFullYear() || target.getMonth() !== currentMonth.getMonth();

  showTab('cal');

  if (needsMonthChange) {
    currentMonth = new Date(target);
    loadCalendar().then(() => showDay(dateStr));
  } else {
    showDay(dateStr);
  }
};

window.changeMonth = function(delta) {
  currentMonth.setMonth(currentMonth.getMonth() + delta);
  selectedDate = null;
  document.getElementById('day-detail').style.display = 'none';
  loadCalendar();
};

// ── Recupero giornata passata ──────────────────────────────
window.openRecoverDay = function(dateStr) {
  const sessionOpts = Object.entries(programData?.schedule || {})
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `<option value="${k}">${v.name} (${DAYS_IT[k]})</option>`)
    .join('');

  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.id = 'recover-modal';
  bg.innerHTML = `
    <div class="modal" style="max-height:80vh;overflow-y:auto">
      <div class="modal-handle"></div>
      <h3>📋 Recupera Giornata</h3>
      <p style="color:var(--t2);font-size:13px;margin-bottom:14px">${formatDateIT(dateStr)}</p>
      <div class="fg">
        <label class="fl">Kcal totali consumate</label>
        <input type="number" class="fi" id="rec-kcal" placeholder="Es. 2650">
      </div>
      <div class="grid2">
        <div class="fg"><label class="fl">Proteine (g)</label>
          <input type="number" class="fi" id="rec-pro" placeholder="0" step="0.1"></div>
        <div class="fg"><label class="fl">Carboidrati (g)</label>
          <input type="number" class="fi" id="rec-carb" placeholder="0" step="0.1"></div>
      </div>
      <div class="grid2">
        <div class="fg"><label class="fl">Grassi (g)</label>
          <input type="number" class="fi" id="rec-fat" placeholder="0" step="0.1"></div>
        <div class="fg"><label class="fl">Passi</label>
          <input type="number" class="fi" id="rec-steps" placeholder="0"></div>
      </div>
      <div class="fg">
        <label class="fl">Ti sei allenato?</label>
        <select class="fi" id="rec-workout">
          <option value="no">No, giorno di riposo</option>
          <option value="yes">Sì, mi sono allenato</option>
        </select>
      </div>
      <div id="rec-session-select" style="display:none" class="fg">
        <label class="fl">Quale sessione?</label>
        <select class="fi" id="rec-session">${sessionOpts}</select>
      </div>
      <div class="fg">
        <label class="fl">Note</label>
        <textarea class="fi" id="rec-note" rows="2" placeholder="Come è andata..."></textarea>
      </div>
      <div class="modal-btns">
        <button class="btn btn-flat" onclick="document.getElementById('recover-modal').remove()">Annulla</button>
        <button class="btn btn-v" onclick="saveRecoveredDay('${dateStr}')">💾 Salva</button>
      </div>
    </div>`;
  document.body.appendChild(bg);

  document.getElementById('rec-workout').onchange = function() {
    document.getElementById('rec-session-select').style.display =
      this.value === 'yes' ? 'block' : 'none';
  };
  bg.onclick = e => { if (e.target === bg) bg.remove(); };
};

window.saveRecoveredDay = async function(dateStr) {
  const kcal       = parseFloat(document.getElementById('rec-kcal')?.value)   || 0;
  const protein    = parseFloat(document.getElementById('rec-pro')?.value)     || 0;
  const carbs      = parseFloat(document.getElementById('rec-carb')?.value)    || 0;
  const fats       = parseFloat(document.getElementById('rec-fat')?.value)     || 0;
  const steps      = parseInt(document.getElementById('rec-steps')?.value)     || null;
  const note       = document.getElementById('rec-note')?.value                || '';
  const didWorkout = document.getElementById('rec-workout')?.value             === 'yes';
  const sessionDay = document.getElementById('rec-session')?.value             || null;

  const data = {
    date: dateStr,
    is_training_day: didWorkout,
    steps, daily_note: note, recovered: true,
    nutrition: { totals: { kcal, protein, carbs, fats } }
  };
  if (didWorkout && sessionDay && programData?.schedule?.[sessionDay]) {
    data.workout = {
      completed: true, recovered: true,
      session_day: sessionDay,
      session_name: programData.schedule[sessionDay].name
    };
  }

  try {
    await setDoc(doc(db, 'users', getUserId(), 'daily_logs', dateStr), data, { merge: false });
    document.getElementById('recover-modal')?.remove();
    monthLogs[dateStr] = data;
    renderGrid(currentMonth.getFullYear(), currentMonth.getMonth());
    document.getElementById('day-detail').style.display = 'none';
    showToast('✅ Giornata recuperata!');
  } catch(e) {
    showToast('Errore salvataggio', 'err');
  }
};

// ── Edit day modal ─────────────────────────────────────────
window.openEditDay = function(dateStr) {
  const log = monthLogs[dateStr];
  if (!log) return;
  const tots = log.nutrition?.totals || {};

  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.id = 'edit-day-modal';
  bg.innerHTML = `
    <div class="modal" style="max-height:85vh;overflow-y:auto">
      <div class="modal-handle"></div>
      <h3>✏️ Modifica giornata</h3>
      <p style="font-size:13px;color:var(--t2);margin-bottom:14px">${formatDateIT(dateStr)}</p>
      <div class="grid2">
        <div class="fg"><label class="fl">Passi</label>
          <input type="number" class="fi" id="ed-steps" value="${log.steps || ''}" placeholder="0"></div>
        <div class="fg"><label class="fl">Kcal bruciate</label>
          <input type="number" class="fi" id="ed-burned" value="${log.burned_kcal || ''}" placeholder="0"></div>
      </div>
      <div class="fg"><label class="fl">Note</label>
        <textarea class="fi" id="ed-note" rows="2">${log.daily_note || ''}</textarea>
      </div>
      <span class="clabel">🔥 Nutrizione</span>
      <div class="grid2">
        <div class="fg"><label class="fl">Kcal totali</label>
          <input type="number" class="fi" id="ed-kcal" value="${Math.round(tots.kcal || 0)}" placeholder="0"></div>
        <div class="fg"><label class="fl">Proteine (g)</label>
          <input type="number" class="fi" id="ed-pro" value="${Math.round(tots.protein || 0)}" placeholder="0" step="0.1"></div>
        <div class="fg"><label class="fl">Carboidrati (g)</label>
          <input type="number" class="fi" id="ed-carb" value="${Math.round(tots.carbs || 0)}" placeholder="0" step="0.1"></div>
        <div class="fg"><label class="fl">Grassi (g)</label>
          <input type="number" class="fi" id="ed-fat" value="${Math.round(tots.fats || 0)}" placeholder="0" step="0.1"></div>
      </div>
      <div class="modal-btns">
        <button class="btn btn-flat" onclick="document.getElementById('edit-day-modal').remove()">Annulla</button>
        <button class="btn btn-v" onclick="saveEditDay('${dateStr}')">💾 Salva</button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  bg.onclick = e => { if (e.target === bg) bg.remove(); };
};

window.saveEditDay = async function(dateStr) {
  const steps      = parseInt(document.getElementById('ed-steps')?.value)  || null;
  const burned     = parseInt(document.getElementById('ed-burned')?.value) || null;
  const note       = document.getElementById('ed-note')?.value || '';
  const kcal       = parseFloat(document.getElementById('ed-kcal')?.value)  || 0;
  const protein    = parseFloat(document.getElementById('ed-pro')?.value)   || 0;
  const carbs      = parseFloat(document.getElementById('ed-carb')?.value)  || 0;
  const fats       = parseFloat(document.getElementById('ed-fat')?.value)   || 0;

  try {
    await setDoc(doc(db, 'users', getUserId(), 'daily_logs', dateStr), {
      steps,
      burned_kcal: burned,
      daily_note: note,
      nutrition: { totals: { kcal, protein, carbs, fats } }
    }, { merge: true });

    // Update local cache
    if (monthLogs[dateStr]) {
      monthLogs[dateStr].steps       = steps;
      monthLogs[dateStr].burned_kcal = burned;
      monthLogs[dateStr].daily_note  = note;
      monthLogs[dateStr].nutrition   = { totals: { kcal, protein, carbs, fats } };
    }

    document.getElementById('edit-day-modal')?.remove();
    showToast('✅ Giornata aggiornata!');
    showDay(dateStr); // Refresh the day detail
  } catch(e) {
    showToast('Errore salvataggio', 'err');
  }
};

window.confirmDeleteWorkout = function(dateStr) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal">
      <div class="modal-handle"></div>
      <h3>🗑️ Elimina allenamento</h3>
      <p style="color:var(--t2);font-size:13px;margin-bottom:16px">Vuoi rimuovere i dati di allenamento da questa giornata? I dati di nutrizione e passi rimarranno.</p>
      <div class="modal-btns">
        <button class="btn btn-flat" onclick="this.closest('.modal-bg').remove()">Annulla</button>
        <button class="btn btn-r" onclick="deleteWorkout('${dateStr}',this.closest('.modal-bg'))">🗑️ Elimina</button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  bg.onclick = e => { if (e.target === bg) bg.remove(); };
};

window.deleteWorkout = async function(dateStr, modalBg) {
  try {
    await setDoc(doc(db, 'users', getUserId(), 'daily_logs', dateStr),
      { workout: deleteField() }, { merge: true });
    if (monthLogs[dateStr]) delete monthLogs[dateStr].workout;
    modalBg?.remove();
    showToast('✅ Allenamento rimosso');
    renderGrid(currentMonth.getFullYear(), currentMonth.getMonth());
    showDay(dateStr);
  } catch(e) {
    showToast('Errore eliminazione', 'err');
  }
};

window.generateWeeklyCoachReport = async function() {
  const keySnap = await getDoc(doc(db, 'users', getUserId(), 'settings', 'gemini'));
  if (!keySnap.exists() || !keySnap.data().api_key) {
    showToast('⚠️ Per favore, imposta la tua Gemini API Key nelle Impostazioni!', 'err');
    return;
  }

  showToast('⏳ Analisi dati settimanali...', 'info');

  const todayDate = new Date(TODAY + 'T12:00:00');
  const startDate = new Date(todayDate);
  startDate.setDate(todayDate.getDate() - 6);

  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }

  let totalKcal = 0, totalProtein = 0, totalCarbs = 0, totalFats = 0;
  let loggedDays = 0;
  let totalSteps = 0;
  let stepDays = 0;
  let completedWorkouts = 0;
  let totalWorkoutsPlanned = 0;
  let totalCalorieAdherenceSum = 0;

  dates.forEach(dateStr => {
    const log = allRecentLogs[dateStr];
    if (log && log.steps > 0) {
      totalSteps += log.steps;
      stepDays++;
    }
    
    const dow = getDayOfWeek(dateStr);
    let isTrainingPlanned = !!(programData?.schedule?.[dow]);
    if (log?.is_training_day != null) isTrainingPlanned = log.is_training_day;
    if (isTrainingPlanned) {
      totalWorkoutsPlanned++;
      if (log?.workout?.completed) {
        completedWorkouts++;
      }
    }
    
    if (log && log.nutrition?.totals?.kcal > 0) {
      totalKcal += log.nutrition.totals.kcal;
      totalProtein += log.nutrition.totals.protein || 0;
      totalCarbs += log.nutrition.totals.carbs || 0;
      totalFats += log.nutrition.totals.fats || 0;
      loggedDays++;
      
      const targetDayPlan = isTrainingPlanned ? _dietPlanCache?.day_on : _dietPlanCache?.day_off;
      const targetKcal = targetDayPlan?.kcal || 0;
      if (targetKcal > 0) {
        const ratio = log.nutrition.totals.kcal / targetKcal;
        const diff = Math.abs(1 - ratio);
        const dayAdherence = Math.max(0, Math.round((1 - diff) * 100));
        totalCalorieAdherenceSum += dayAdherence;
      }
    }
  });

  const avgCalories = loggedDays > 0 ? Math.round(totalKcal / loggedDays) : 0;
  const avgProtein = loggedDays > 0 ? Math.round(totalProtein / loggedDays) : 0;
  const avgCarbs = loggedDays > 0 ? Math.round(totalCarbs / loggedDays) : 0;
  const avgFats = loggedDays > 0 ? Math.round(totalFats / loggedDays) : 0;
  const avgSteps = stepDays > 0 ? Math.round(totalSteps / stepDays) : 0;
  const avgCalorieAdherence = loggedDays > 0 ? Math.round(totalCalorieAdherenceSum / loggedDays) : 0;

  const isTodayTraining = !!(programData?.schedule?.[getDayOfWeek(TODAY)]);
  const defaultTargetPlan = isTodayTraining ? _dietPlanCache?.day_on : _dietPlanCache?.day_off;
  const targetCalories = defaultTargetPlan?.kcal || 2000;

  const wss = calcWeeklySmartScore(dates, allRecentLogs, programData, _dietPlanCache, settingsData);
  const weeklyScore = wss.finalScore || 0;

  const dataForAI = {
    avgCalorieAdherence,
    avgCalories,
    targetCalories,
    avgProtein,
    avgCarbs,
    avgFats,
    totalSteps,
    avgSteps,
    completedWorkouts,
    totalWorkoutsPlanned,
    weeklyScore
  };

  showToast('🧠 AI Coach sta elaborando il report...', 'info');

  try {
    const aiResult = await generateWeeklyCoachReportAI(dataForAI);
    if (!aiResult.success) {
      showToast(aiResult.error, 'err');
      return;
    }
    showWeeklyReportModal(aiResult.report);
  } catch(e) {
    showToast('Errore generazione report', 'err');
    console.error(e);
  }
};

function markdownToHtml(md) {
  if (!md) return '';
  // Normalize newlines and strip markdown code blocks
  let text = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/```markdown/gi, '').replace(/```/g, '').trim();
  
  // Parse paragraphs
  const paragraphs = text.split(/\n\n+/);
  return paragraphs.map(p => {
    p = p.trim();
    if (!p) return '';
    
    // Headers
    if (p.startsWith('### ')) {
      return `<h4 style="color:var(--accent);margin-top:16px;margin-bottom:8px;font-weight:700">${p.substring(4)}</h4>`;
    }
    if (p.startsWith('## ')) {
      return `<h3 style="color:var(--accent);margin-top:18px;margin-bottom:10px;font-weight:800">${p.substring(3)}</h3>`;
    }
    if (p.startsWith('# ')) {
      return `<h2 style="color:var(--accent);margin-top:20px;margin-bottom:12px;font-weight:900">${p.substring(2)}</h2>`;
    }
    
    // Bullet points
    if (p.startsWith('- ') || p.startsWith('* ')) {
      const items = p.split(/\n[-*]\s+/);
      const listHtml = items.map((item, idx) => {
        let cleanItem = item;
        if (idx === 0) {
          cleanItem = item.replace(/^[-*]\s+/, '');
        }
        // Bold tags inside list item
        cleanItem = cleanItem.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
        return `<li style="margin-left:14px;margin-bottom:6px;font-size:13px;line-height:1.55;color:var(--t2)">${cleanItem}</li>`;
      }).join('');
      return `<ul style="margin-bottom:12px;padding-left:10px">${listHtml}</ul>`;
    }
    
    // Regular text (with bold formatting)
    let processed = p.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
    processed = processed.replace(/\n/g, '<br>');
    return `<p style="margin-bottom:12px;font-size:13px;line-height:1.55;color:var(--t2)">${processed}</p>`;
  }).filter(html => html !== '').join('');
}

function showWeeklyReportModal(reportMarkdown) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.id = 'weekly-report-modal';
  
  let htmlContent = markdownToHtml(reportMarkdown);

  bg.innerHTML = `
    <div class="modal" style="max-height:85vh;overflow-y:auto;padding:24px;border:1px solid rgba(255,255,255,0.08);background:rgba(18,18,20,0.95);backdrop-filter:blur(20px);border-radius:24px">
      <div class="modal-handle"></div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <div style="background:rgba(124,111,255,0.15);width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px">🧠</div>
        <div>
          <h2 style="font-size:18px;font-weight:900;color:var(--t1);margin:0">Report AI Weekly Coach</h2>
          <span style="font-size:10px;color:var(--purple);font-weight:800;letter-spacing:0.5px;text-transform:uppercase">KOVA. Intelligenza Artificiale</span>
        </div>
      </div>
      
      <div style="background:rgba(255,255,255,0.01);border:1px solid rgba(255,255,255,0.04);border-radius:16px;padding:16px;margin-bottom:20px;max-height:50vh;overflow-y:auto;text-align:left">
        ${htmlContent}
      </div>
      
      <div class="modal-btns">
        <button class="btn btn-v" style="width:100%" onclick="document.getElementById('weekly-report-modal').remove()">
          Ho capito, grazie Coach! 💪
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(bg);
  bg.onclick = e => { if (e.target === bg) bg.remove(); };
}

window.openAddMealForDate = function(dateStr, prefillData) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.id = 'add-meal-modal';
  bg.innerHTML = `
    <div class="modal" style="max-height:85vh;overflow-y:auto">
      <div class="modal-handle"></div>
      <h3>${prefillData ? 'Copia Pasto' : '+ Aggiungi Pasto'}</h3>
 
      <div class="fg">
        <label class="fl">Nome pasto</label>
        <input type="text" class="fi" id="am-name" placeholder="Es. Snack, Extra proteine..." value="${prefillData?.name || ''}">
      </div>
 
      <div class="fg">
        <label class="fl">Ingredienti</label>
        <textarea class="fi" id="am-ingredients" rows="3"
          placeholder="Es: 150g pollo, 100g riso, 10g olio&#10;Oppure inserisci macro manualmente sotto">${prefillData?.ingredients || ''}</textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-ghost btn-sm" onclick="calcAIMealForDate()" style="flex:1">
            ✨ Calcola con AI
          </button>
          <button class="btn btn-ghost btn-sm" onclick="window.startFoodCameraForDate()" style="flex:1">
            📸 Scansiona Cibo
          </button>
        </div>
      </div>
 
      <!-- Video camera preview area -->
      <div id="am-camera-container" style="display:none;margin-bottom:16px;flex-direction:column;gap:8px;align-items:center">
        <video id="am-video" autoplay playsinline style="width:100%;max-width:320px;border-radius:12px;background:#000"></video>
        <div style="display:flex;gap:8px;width:100%;max-width:320px">
          <button class="btn btn-flat btn-sm" onclick="window.stopFoodCameraForDate()" style="flex:1">Annulla</button>
          <button class="btn btn-v btn-sm" onclick="window.captureFoodImageForDate()" style="flex:1">📸 Scatta e Analizza</button>
        </div>
        <canvas id="am-canvas" style="display:none"></canvas>
      </div>
 
      <div class="fmp" id="am-macro-preview" style="margin-bottom:16px">
        <div class="fmp-item">
          <input type="number" class="fi" id="am-kcal" placeholder="Kcal" min="0" value="${prefillData?.kcal || ''}">
          <div class="fmp-l">Kcal</div>
        </div>
        <div class="fmp-item">
          <input type="number" class="fi" id="am-protein" placeholder="0" min="0" step="0.1" value="${prefillData?.protein || ''}">
          <div class="fmp-l">Proteine g</div>
        </div>
        <div class="fmp-item">
          <input type="number" class="fi" id="am-carbs" placeholder="0" min="0" step="0.1" value="${prefillData?.carbs || ''}">
          <div class="fmp-l">Carbo g</div>
        </div>
        <div class="fmp-item">
          <input type="number" class="fi" id="am-fats" placeholder="0" min="0" step="0.1" value="${prefillData?.fats || ''}">
          <div class="fmp-l">Grassi g</div>
        </div>
      </div>
 
      <div class="fg">
        <label class="fl">Tipo pasto</label>
        <select class="fi" id="am-type">
          <option value="extra">Extra / Fuori piano</option>
          <option value="colazione">Colazione</option>
          <option value="spuntino">Spuntino</option>
          <option value="pranzo">Pranzo</option>
          <option value="merenda">Merenda</option>
          <option value="cena">Cena</option>
        </select>
      </div>
 
      <div class="modal-btns">
        <button class="btn btn-flat" onclick="document.getElementById('add-meal-modal').remove()">
          Annulla
        </button>
        <button class="btn btn-g" onclick="window.saveExtraMealForDate('${dateStr}')">
          💾 Salva
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(bg);
  bg.onclick = e => { if (e.target === bg) bg.remove(); };
};

window.openAddMealWithCameraForDate = function(dateStr) {
  window.openAddMealForDate(dateStr);
  setTimeout(() => {
    window.startFoodCameraForDate();
  }, 250);
};

window.calcAIMealForDate = async function() {
  const text = document.getElementById('am-ingredients')?.value?.trim();
  if (!text) return showToast('Inserisci gli ingredienti', 'err');
  showToast('⏳ Calcolo in corso...', 'info');
  const r = await calcMacrosFromText(text);
  if (!r.success) return showToast('Errore AI: ' + r.error, 'err');
  document.getElementById('am-kcal').value    = r.kcal;
  document.getElementById('am-protein').value = r.protein;
  document.getElementById('am-carbs').value   = r.carbs;
  document.getElementById('am-fats').value    = r.fats;
  showToast('✅ Macro calcolati!');
};

window.saveExtraMealForDate = async function(dateStr) {
  const name    = document.getElementById('am-name')?.value?.trim();
  const kcal    = parseFloat(document.getElementById('am-kcal')?.value)    || 0;
  const protein = parseFloat(document.getElementById('am-protein')?.value) || 0;
  const carbs   = parseFloat(document.getElementById('am-carbs')?.value)   || 0;
  const fats    = parseFloat(document.getElementById('am-fats')?.value)    || 0;
  const type    = document.getElementById('am-type')?.value || 'extra';
  const ingredients = document.getElementById('am-ingredients')?.value?.trim() || '';

  if (!name) return showToast('Inserisci il nome del pasto', 'err');
  if (kcal === 0 && protein === 0) return showToast('Inserisci almeno le kcal', 'err');

  let log = monthLogs[dateStr] || { nutrition: { totals: { kcal: 0, protein: 0, carbs: 0, fats: 0 } }, extra_meals: [] };
  if (!log.extra_meals) log.extra_meals = [];

  log.extra_meals.push({
    name, type, kcal, protein, carbs, fats, ingredients,
    time: new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
    added_at: new Date().toISOString()
  });

  const totals = log.nutrition?.totals || { kcal: 0, protein: 0, carbs: 0, fats: 0 };
  totals.kcal += kcal;
  totals.protein += protein;
  totals.carbs += carbs;
  totals.fats += fats;

  if (!log.nutrition) log.nutrition = {};
  log.nutrition.totals = totals;

  try {
    showToast('💾 Salvataggio in corso...', 'info');
    await setDoc(doc(db, 'users', getUserId(), 'daily_logs', dateStr), log, { merge: true });
    
    monthLogs[dateStr] = log;
    document.getElementById('add-meal-modal')?.remove();
    showToast('✅ Pasto aggiunto!');
    
    renderGrid(currentMonth.getFullYear(), currentMonth.getMonth());
    showDay(dateStr);
  } catch(e) {
    showToast('Errore salvataggio', 'err');
    console.error(e);
  }
};

let diaryCameraStream = null;

window.startFoodCameraForDate = async function() {
  const container = document.getElementById('am-camera-container');
  const video = document.getElementById('am-video');
  if (!container || !video) return;

  showToast('🎥 Avvio fotocamera...', 'info');

  try {
    diaryCameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false
    });
    video.srcObject = diaryCameraStream;
    video.style.transform = 'none';
    container.style.display = 'flex';
  } catch(e) {
    showToast('Impossibile accedere alla fotocamera', 'err');
    console.error(e);
  }
};

window.stopFoodCameraForDate = function() {
  const container = document.getElementById('am-camera-container');
  if (container) container.style.display = 'none';

  if (diaryCameraStream) {
    diaryCameraStream.getTracks().forEach(track => track.stop());
    diaryCameraStream = null;
  }
};

window.captureFoodImageForDate = async function() {
  const video = document.getElementById('am-video');
  const canvas = document.getElementById('am-canvas');
  if (!video || !canvas || !diaryCameraStream) return;

  const ctx = canvas.getContext('2d');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  window.stopFoodCameraForDate();

  showToast('⏳ Analisi immagine cibo con AI...', 'info');

  try {
    const base64Image = canvas.toDataURL('image/jpeg').split(',')[1];
    const r = await analyzeFoodImageAI(base64Image, 'image/jpeg');

    if (!r.success) {
      showToast(r.error, 'err');
      return;
    }

    if (document.getElementById('am-name')) document.getElementById('am-name').value = r.name;
    if (document.getElementById('am-ingredients')) document.getElementById('am-ingredients').value = r.ingredients;
    if (document.getElementById('am-kcal')) document.getElementById('am-kcal').value = r.kcal;
    if (document.getElementById('am-protein')) document.getElementById('am-protein').value = r.protein;
    if (document.getElementById('am-carbs')) document.getElementById('am-carbs').value = r.carbs;
    if (document.getElementById('am-fats')) document.getElementById('am-fats').value = r.fats;

    showToast('🥗 Cibo scansionato con successo!');
  } catch(e) {
    showToast('Errore durante la scansione', 'err');
    console.error(e);
  }
};

(async function() {
  await requireAuth();
  init();
})();
