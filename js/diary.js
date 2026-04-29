import {
  db, USER_ID, collection, doc, getDoc, getDocs, setDoc, deleteField, query, where, orderBy, limit
} from './firebase-config.js';
import { getTodayString, getDayOfWeek, formatDateIT, formatDateShort, showToast, DAYS_IT, DAY_ORDER, calcFitScore } from './app.js';

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
    getDocs(collection(db, 'users', USER_ID, 'programs')),
    getDocs(query(
      collection(db, 'users', USER_ID, 'daily_logs'),
      orderBy('date', 'desc'),
      limit(60)
    )),
    getDoc(doc(db, 'users', USER_ID, 'settings', 'app')),
    getDocs(collection(db, 'users', USER_ID, 'diet_plans'))
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
      ${log.steps       ? `<div style="margin-top:8px;font-size:13px;color:var(--t2)">👟 ${log.steps.toLocaleString('it-IT')} passi</div>` : ''}
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

function computeDayBadge(log, plan, isOn) {
  const fakePlan = plan ? { kcal: plan.kcal || 0, macros: { protein: plan.protein || 0 } } : null;
  const fakeLog = {
    workout:   { completed: !!log.workout?.completed },
    nutrition: { kcal: log.nutrition?.totals?.kcal || 0, protein: log.nutrition?.totals?.protein || 0 },
    steps:     log.steps || 0
  };
  const objective = programData?.objective || 'recomposizione';
  const stepsGoal = settingsData?.steps_goal || 0;
  const result = calcFitScore({ log: fakeLog, plan: fakePlan, isOn, objective, stepsGoal });
  if (!result) return '';

  const { score, label, breakdown } = result;
  const scoreCol = score >= 75 ? 'var(--green)' : score >= 50 ? 'var(--yellow)' : 'var(--orange)';

  const dots = breakdown.map(b =>
    `<span style="color:${b.ok ? 'var(--green)' : 'var(--t3)'};font-size:11px">${b.label}: ${b.score}/${b.max}</span>`
  ).join(' · ');

  return `<div style="padding:10px 12px;background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:10px;margin-bottom:12px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
      <div style="font-size:28px;font-weight:900;color:${scoreCol};letter-spacing:-1px">${score}</div>
      <div>
        <div style="font-size:13px;font-weight:800;color:${scoreCol}">${label}</div>
        <div style="font-size:10px;color:var(--t3)">FitScore / 100</div>
      </div>
      <div style="flex:1;margin-left:4px">
        <div class="pbb h4"><div class="pbf" style="width:${score}%;background:${scoreCol}"></div></div>
      </div>
    </div>
    <div style="line-height:1.9">${dots}</div>
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

// ── 2-Week view ────────────────────────────────────────────
function buildWeekView() {
  const el = document.getElementById('week-view');
  if (!el) return;

  // Find past 7 days up to today
  const todayDate = new Date(TODAY + 'T12:00:00');
  const lastMonday = new Date(todayDate);
  lastMonday.setDate(todayDate.getDate() - 6);

  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(lastMonday);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }

  const objective = programData?.objective || 'recomposizione';
  const stepsGoal = settingsData?.steps_goal || 0;

  // Aggregate stats
  let totalKcal = 0, totalProtein = 0, totalSteps = 0;
  let trainingDaysCount = 0, trainingDone = 0;
  let kcalDays = 0, proteinDays = 0;
  const kcalWarnings = [], proteinWarnings = [];

  const weekSep = ['', ''];
  const rowsHtml = dates.map((dateStr, idx) => {
    const isWeekSep = false;
    const log = allRecentLogs[dateStr];
    const dayDow = getDayOfWeek(dateStr);
    let isOn  = !!(programData?.schedule?.[dayDow]);
    if (log && log.is_training_day != null) isOn = log.is_training_day;
    const isFut = dateStr > TODAY;

    // Day status
    let icon, statusColor = 'var(--t2)';
    if (isFut) {
      icon = isOn ? '📅' : '😴';
    } else if (log?.workout?.completed) {
      icon = '✅'; statusColor = 'var(--green)';
    } else if (!isOn) {
      icon = '😴'; statusColor = 'var(--t3)';
    } else if (log) {
      icon = '⚠️'; statusColor = 'var(--orange)';
    } else {
      icon = '❌'; statusColor = 'var(--red)';
    }

    // Accumulators
    if (!isFut && isOn) {
      trainingDaysCount++;
      if (log?.workout?.completed) trainingDone++;
    }
    const kcal    = log?.nutrition?.totals?.kcal    || 0;
    const protein = log?.nutrition?.totals?.protein || 0;
    if (!isFut && kcal > 0)    { totalKcal    += kcal;    kcalDays++; }
    if (!isFut && protein > 0) { totalProtein += protein; proteinDays++; }
    if (!isFut && log?.steps)   totalSteps    += log.steps;

    const dayLabel = new Date(dateStr + 'T12:00:00')
      .toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' });
    const isToday = dateStr === TODAY;

    const kcalHtml    = kcal    > 0 ? `${Math.round(kcal)} kcal` : isFut ? '' : '—';
    const proteinHtml = protein > 0 ? `· P:${Math.round(protein)}g` : '';

    return `
      ${idx === 0 ? '<p class="sdiv">Ultimi 7 giorni</p>' : ''}
      <div class="week-row" style="${isToday ? 'background:rgba(124,111,255,.07);border-radius:8px;padding:10px 8px;margin:0 -8px;' : ''}">
        <div class="week-row-date" style="color:${isToday ? 'var(--accent)' : 'var(--t3)'}">${dayLabel}</div>
        <div class="week-row-ico">${icon}</div>
        <div class="week-row-body">
          <div class="week-row-name" style="color:${statusColor}">${log?.workout?.session_name || (isOn ? (programData?.schedule?.[dayDow]?.name || 'Training') : 'Riposo')}</div>
          <div class="week-row-meta">${kcalHtml} ${proteinHtml}</div>
        </div>
        ${log?.steps ? `<div style="font-size:11px;color:var(--t3)">👟${(log.steps/1000).toFixed(1)}k</div>` : ''}
      </div>`;
  }).join('');

  // Recommendations
  const recs = [];
  const avgKcal    = kcalDays    > 0 ? Math.round(totalKcal    / kcalDays)    : 0;
  const avgProtein = proteinDays > 0 ? Math.round(totalProtein / proteinDays) : 0;
  const planKcal   = _dietPlanCache?.day_on?.kcal || 0;
  const planPro    = _dietPlanCache?.day_on?.protein || 0;

  if (trainingDaysCount > 0 && trainingDone < trainingDaysCount) {
    const missed = trainingDaysCount - trainingDone;
    recs.push(`💪 Hai saltato ${missed} allenament${missed > 1 ? 'i' : 'o'} su ${trainingDaysCount} — cerca di mantenerla costante!`);
  }
  if (planKcal > 0 && avgKcal > 0) {
    const diff = Math.round(((avgKcal - planKcal) / planKcal) * 100);
    if (diff > 10)  recs.push(`🔥 Kcal medie +${diff}% sopra il piano — considera di ridurre i pasti extra.`);
    if (diff < -10) recs.push(`📉 Kcal medie ${diff}% sotto il piano — assicurati di mangiare abbastanza.`);
  }
  if (planPro > 0 && avgProtein > 0 && avgProtein < planPro * 0.85) {
    recs.push(`🥩 Proteine medie (${avgProtein}g) sotto l'obiettivo (${planPro}g) — priorità alta!`);
  }
  if (stepsGoal > 0 && kcalDays > 0) {
    const avgSteps = Math.round(totalSteps / kcalDays);
    if (avgSteps < stepsGoal * 0.7) recs.push(`👟 Media passi bassa (${avgSteps.toLocaleString('it-IT')} / ${stepsGoal.toLocaleString('it-IT')} obiettivo) — aggiungi una camminata!`);
  }

    const adherence = trainingDaysCount > 0 ? Math.round((trainingDone / trainingDaysCount) * 100) : null;

  el.innerHTML = rowsHtml;

  let recapHtml = '';
  if (recs.length || adherence !== null || avgKcal > 0) {
    let statusText = 'IN CORSO';
    let statusColor = 'var(--t2)';
    if (adherence !== null) {
      if (adherence >= 80) { statusText = 'OTTIMO LAGO'; statusColor = 'var(--green)'; }
      else if (adherence >= 50) { statusText = 'NELLA MEDIA'; statusColor = 'var(--yellow)'; }
      else { statusText = 'DA MIGLIORARE'; statusColor = 'var(--orange)'; }
    }

    const pills = [];
    if (adherence !== null) pills.push(`<div style="background:rgba(255,255,255,0.03); border-radius:12px; padding:12px; flex:1; text-align:center"><div style="font-size:11px;color:var(--t3);margin-bottom:4px;text-transform:uppercase;font-weight:700">Aderenza</div><div style="font-size:22px;font-weight:900;color:${statusColor}">${adherence}%</div></div>`);
    if (avgKcal > 0) pills.push(`<div style="background:rgba(255,255,255,0.03); border-radius:12px; padding:12px; flex:1; text-align:center"><div style="font-size:11px;color:var(--t3);margin-bottom:4px;text-transform:uppercase;font-weight:700">Kcal Medie</div><div style="font-size:20px;font-weight:900;color:var(--t1)">${avgKcal}</div></div>`);
    if (avgProtein > 0) pills.push(`<div style="background:rgba(255,255,255,0.03); border-radius:12px; padding:12px; flex:1; text-align:center"><div style="font-size:11px;color:var(--t3);margin-bottom:4px;text-transform:uppercase;font-weight:700">Pro Medie</div><div style="font-size:20px;font-weight:900;color:var(--blue)">${avgProtein}g</div></div>`);

    const recPills = recs.map(r => `<div style="background:rgba(255,255,255,0.05); border-left:3px solid var(--accent); border-radius:8px; padding:10px 12px; font-size:13px; font-weight:500; color:var(--t1); margin-top:8px">${r.replace(/^([💡💪🔥📉🥩👟]\s*)/, '')}</div>`);

    recapHtml = `
      <div class="clabel" style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
        <span><i class="ri-bar-chart-box-line"></i> Performance (7 gg)</span>
        <span style="font-size:11px;padding:4px 10px;background:rgba(255,255,255,0.1);border-radius:100px;color:${statusColor};font-weight:800">${statusText}</span>
      </div>
      <div style="display:flex; gap:8px; margin-bottom:12px;">
        ${pills.join('')}
      </div>
      ${recPills.join('')}
    `;
  }
  
  const recapEl = document.getElementById('recent-recap');
  if (recapEl) recapEl.innerHTML = recapHtml;
}

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
    await setDoc(doc(db, 'users', USER_ID, 'daily_logs', dateStr), data, { merge: false });
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
    await setDoc(doc(db, 'users', USER_ID, 'daily_logs', dateStr), {
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
    await setDoc(doc(db, 'users', USER_ID, 'daily_logs', dateStr),
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

init();
