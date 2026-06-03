import {
  auth,
  onAuthStateChanged,
  db,
  doc,
  setDoc,
  getDoc,
  getDocs,
  collection,
  deleteDoc
} from './firebase-config.js';

export function requireAuth() {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      unsubscribe();
      if (user) {
        if (user.email) {
          const emailLower = user.email.toLowerCase();
          setDoc(doc(db, 'users', emailLower), { email: emailLower }, { merge: true })
            .catch(e => console.warn('Poteva non essere possibile salvare il doc utente:', e));
        }
        resolve(user);
      } else {
        const search = window.location.search;
        window.location.href = 'auth.html' + search;
      }
    });
  });
}

export function getTodayString() {
  const d = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(d);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value.padStart(2, '0');
  const day = parts.find(p => p.type === 'day').value.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getYesterdayString() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(d);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value.padStart(2, '0');
  const day = parts.find(p => p.type === 'day').value.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getDayOfWeek(dateStr) {
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  if (dateStr) {
    const [y,m,d] = dateStr.split('-').map(Number);
    return days[new Date(y, m-1, d).getDay()];
  }
  const shortDay = new Date().toLocaleDateString('en-US', {
    timeZone: 'Europe/Rome', weekday: 'short'
  }).slice(0, 3);
  const idx = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(shortDay);
  return days[idx >= 0 ? idx : new Date().getDay()];
}
export function formatDateIT(str) {
  const [y,m,d] = str.split('-').map(Number);
  return new Date(y,m-1,d).toLocaleDateString('it-IT',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
}
export function formatDateShort(str) {
  const [y,m,d] = str.split('-').map(Number);
  return new Date(y,m-1,d).toLocaleDateString('it-IT',{weekday:'short',day:'numeric',month:'short'});
}
export function addDays(str, n) {
  const [y,m,d] = str.split('-').map(Number);
  const dt = new Date(y,m-1,d); dt.setDate(dt.getDate()+n);
  return dt.toISOString().split('T')[0];
}
export function showToast(msg, type='ok') {
  document.querySelectorAll('.toast').forEach(t=>t.remove());
  const t=document.createElement('div'); t.className=`toast toast-${type}`; t.textContent=msg;
  document.body.appendChild(t); setTimeout(()=>t.remove(),3000);
}
export function showModal(opts) {
  const bg=document.createElement('div'); bg.className='modal-bg';
  bg.innerHTML=`<div class="modal"><div class="modal-handle"></div><h3>${opts.title}</h3>${opts.text?`<p>${opts.text}</p>`:''}<div class="modal-btns"><button class="btn btn-flat btn-cancel">${opts.cancelLabel||'Annulla'}</button><button class="btn ${opts.confirmClass||'btn-r'} btn-ok">${opts.confirmLabel||'Conferma'}</button></div></div>`;
  document.body.appendChild(bg);
  bg.querySelector('.btn-cancel').onclick=()=>{bg.remove();opts.onCancel?.()};
  bg.querySelector('.btn-ok').onclick=()=>{bg.remove();opts.onConfirm?.()};
  bg.onclick=e=>{if(e.target===bg){bg.remove();opts.onCancel?.()}};
}
export function setW(id,pct){const e=document.getElementById(id);if(e)e.style.width=Math.min(Math.max(pct,0),100)+'%'}
export function setT(id,v){const e=document.getElementById(id);if(e)e.textContent=v}
export function fmtTimer(s){return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')}
export const DAYS_IT={monday:'Lunedì',tuesday:'Martedì',wednesday:'Mercoledì',thursday:'Giovedì',friday:'Venerdì',saturday:'Sabato',sunday:'Domenica'};
export const DAY_ORDER=['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];

/**
 * calcFitScore — 0-100 composite score for a day
 * @param {object} params
 * @param {object} params.log        — daily_log document data
 * @param {object} params.plan       — active diet_plan document data (null ok)
 * @param {boolean} params.isOn      — true = training day
 * @param {string}  params.objective — 'recomposizione'|'cut'|'bulk'|'maintenance'
 * @param {number}  params.stepsGoal — user steps goal (0 = skip)
 * @returns {{ score:number, label:string, breakdown:[{label,score,max,ok}] } | null}
 */
export function calcFitScore({ log, plan, isOn, objective = 'recomposizione', stepsGoal = 0 }) {
  if (!log) return null;

  const breakdown = [];
  let total = 0;

  // — Training (35 pt) —
  const wDone = !!log.workout?.completed;
  let tPt = 0;
  if (!isOn)        tPt = 35;        // rest day as planned
  else if (wDone)   tPt = 35;        // trained as planned
  else              tPt = 0;         // skipped training day
  breakdown.push({ label: isOn ? 'Allenamento' : 'Riposo', score: tPt, max: 35, ok: tPt === 35 });
  total += tPt;

  // — Protein (30 pt) —
  const proteinTarget = plan?.macros?.protein || 0;
  const proteinActual = log.nutrition?.protein || 0;
  let pPt = 0;
  if (proteinTarget > 0) {
    const pRatio = proteinActual / proteinTarget;
    if (pRatio >= 1)         pPt = 30;
    else if (pRatio >= 0.9)  pPt = 22;
    else if (pRatio >= 0.8)  pPt = 14;
    else if (pRatio >= 0.7)  pPt = 6;
    breakdown.push({ label: 'Proteine', score: pPt, max: 30, ok: pPt >= 22 });
    total += pPt;
  }

  // — Calories (25 pt) — objective-aware —
  const kcalTarget = plan?.kcal || 0;
  const kcalActual = log.nutrition?.kcal || 0;
  let cPt = 0;
  if (kcalTarget > 0) {
    const cRatio = kcalActual / kcalTarget;
    if (objective === 'cut') {
      if (cRatio >= 0.80 && cRatio <= 1.00)       cPt = 25;
      else if (cRatio > 1.00 && cRatio <= 1.08)   cPt = 12;
      else if (cRatio >= 0.70 && cRatio < 0.80)   cPt = 10;
      else                                          cPt = 0;
    } else if (objective === 'bulk') {
      if (cRatio >= 1.00 && cRatio <= 1.20)       cPt = 25;
      else if (cRatio >= 0.90 && cRatio < 1.00)   cPt = 15;
      else if (cRatio > 1.20 && cRatio <= 1.30)   cPt = 15;
      else                                          cPt = 5;
    } else {
      // recomposizione / maintenance
      if (cRatio >= 0.88 && cRatio <= 1.12)       cPt = 25;
      else if ((cRatio >= 0.78 && cRatio < 0.88) || (cRatio > 1.12 && cRatio <= 1.20)) cPt = 15;
      else                                          cPt = 5;
    }
    breakdown.push({ label: 'Calorie', score: cPt, max: 25, ok: cPt >= 20 });
    total += cPt;
  }

  // — Steps (10 pt) —
  if (stepsGoal > 0) {
    const steps = log.steps || 0;
    const sRatio = steps / stepsGoal;
    let sPt = 0;
    if (sRatio >= 1)         sPt = 10;
    else if (sRatio >= 0.7)  sPt = 7;
    else if (sRatio >= 0.5)  sPt = 4;
    breakdown.push({ label: 'Passi', score: sPt, max: 10, ok: sPt >= 7 });
    total += sPt;
  }

  if (breakdown.length === 0) return null;

  const maxPossible = breakdown.reduce((s, b) => s + b.max, 0);
  const score = Math.round((total / maxPossible) * 100);
  let label;
  if (score >= 90)      label = 'Elite';
  else if (score >= 75) label = 'Ottimo';
  else if (score >= 60) label = 'Buono';
  else if (score >= 45) label = 'Sufficiente';
  else                  label = 'Da migliorare';

  return { score, label, breakdown };
}

/**
 * calcSmartScore — score contestuale all'ora del giorno (0-100)
 * Risponde a: "sto andando bene rispetto a quello che dovevo fare FINO A ORA?"
 * Include pillar Trend Settimanale per un punteggio più intelligente.
 */
export function calcSmartScore({
  meals = [],
  mealStates = [],
  workout = null,
  workoutScheduledTime = null,
  isTrainingDay = false,
  steps = 0,
  stepsGoal = 0,
  planProtein = 0,
  actualProtein = 0,
  weeklyLogs = [],        // ultimi 7 log per il pillar Trend
  weeklyScore = null,     // score settimanale pre-calcolato (opzionale)
}) {
  const now = new Date();
  const nowStr = now.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
  const [nowH, nowM] = nowStr.split(':').map(Number);
  const nowMin = nowH * 60 + (isNaN(nowM) ? 0 : nowM);
  const isEvening = nowMin >= 18 * 60; // dalle 18 in poi

  const toMin = t => { if (!t || !t.includes(':')) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; };

  const breakdown = [];
  let total = 0, maxTotal = 0;

  // 1. PASTI (35pt): quanti dei pasti "attesi" entro ora sono stati mangiati
  const mealsT = meals.map((m, i) => ({
    ...m,
    timeMin: toMin(m.time) ?? (420 + Math.round((900 / Math.max(meals.length - 1, 1)) * i)),
    eaten: mealStates[i]?.eaten || false
  }));
  const expected = mealsT.filter(m => m.timeMin <= nowMin);
  const eatenExp = expected.filter(m => m.eaten).length;
  const mealPt = expected.length === 0 ? 35 : Math.round((eatenExp / expected.length) * 35);
  const mealNote = expected.length === 0 ? 'In anticipo' : `${eatenExp}/${expected.length} pasti previsti`;
  breakdown.push({ label: 'Pasti', score: mealPt, max: 35, note: mealNote, ok: mealPt >= 28 });
  total += mealPt; maxTotal += 35;

  // 2. ALLENAMENTO (30pt): se non ancora l'ora → pieno punteggio, non penalizza
  const wDone = !!workout?.completed;
  let wPt, wNote;
  if (!isTrainingDay) {
    wPt = 30; wNote = 'Riposo programmato';
  } else if (wDone) {
    wPt = 30; wNote = 'Completato';
  } else {
    const schMin = toMin(workoutScheduledTime);
    if (schMin !== null && nowMin < schMin) {
      wPt = 30; wNote = `Programmato alle ${workoutScheduledTime}`;
    } else if (nowMin < 22 * 60) {
      wPt = 12; wNote = 'Da completare oggi';
    } else {
      wPt = 0; wNote = 'Saltato';
    }
  }
  breakdown.push({ label: 'Allenamento', score: wPt, max: 30, note: wNote, ok: wPt >= 25 });
  total += wPt; maxTotal += 30;

  // 3. PROTEINE (15pt): proporzionale ai pasti attesi vs totali
  if (planProtein > 0 && meals.length > 0) {
    const mRatio = expected.length > 0 ? expected.length / meals.length : 1;
    const expProt = planProtein * mRatio;
    const pPt = Math.min(15, Math.round(Math.min(1.2, actualProtein / Math.max(expProt, 1)) * 15));
    breakdown.push({ label: 'Proteine', score: pPt, max: 15, note: `${Math.round(actualProtein)}g / ~${Math.round(expProt)}g attesi`, ok: pPt >= 11 });
    total += pPt; maxTotal += 15;
  }

  // 4. TREND SETTIMANALE (10pt): costanza degli ultimi 7 giorni
  if (weeklyLogs.length > 0 || weeklyScore !== null) {
    let trendPt;
    let trendNote;
    if (weeklyScore !== null) {
      trendPt = Math.round(weeklyScore / 100 * 10);
      trendNote = `Score sett. ${weeklyScore}/100`;
    } else {
      // Calcola dalla lista log
      const withData = weeklyLogs.filter(l => l && (l.nutrition?.totals?.kcal > 0 || l.workout?.completed || l.steps > 0));
      const consistency = weeklyLogs.length > 0 ? withData.length / weeklyLogs.length : 0;
      trendPt = Math.round(consistency * 10);
      trendNote = `${withData.length}/${weeklyLogs.length} giorni loggati`;
    }
    breakdown.push({ label: 'Trend 7gg', score: trendPt, max: 10, note: trendNote, ok: trendPt >= 7 });
    total += trendPt; maxTotal += 10;
  }

  // 5. PASSI (10pt): solo se goal impostato, proporzionale all'ora
  if (stepsGoal > 0) {
    const actStart = 7 * 60, actEnd = 23 * 60;
    const elapsed = Math.max(0, Math.min(nowMin, actEnd) - actStart);
    const ratioT = elapsed / (actEnd - actStart);
    const expSteps = Math.round(stepsGoal * ratioT);
    const sPt = expSteps <= 0 ? 10 : Math.round(Math.min(1, steps / expSteps) * 10);
    const sNote = expSteps <= 0 ? '—' : `${steps.toLocaleString('it-IT')} / ~${expSteps.toLocaleString('it-IT')} attesi`;
    breakdown.push({ label: 'Passi', score: sPt, max: 10, note: sNote, ok: sPt >= 7 });
    total += sPt; maxTotal += 10;
  }

  if (maxTotal === 0) return null;
  const score = Math.round((total / maxTotal) * 100);

  let label, icon;
  if (score >= 90)      { label = 'In anticipo';          icon = '🚀'; }
  else if (score >= 75) { label = 'In pari';              icon = '✅'; }
  else if (score >= 55) { label = 'Leggermente indietro'; icon = '⚡'; }
  else if (score >= 35) { label = 'Attenzione';           icon = '⚠️'; }
  else                  { label = 'In ritardo';            icon = '🔴'; }

  return { score, label, icon, breakdown };
}

/**
 * calcRecoveryPlan — analizza gli ultimi 7 giorni e genera un piano di recupero
 * @param {object}  params
 * @param {object[]} params.weeklyLogs    — array di daily_log docs (ultimi 7 gg)
 * @param {object}   params.activeDiet    — piano dieta attivo (con day_on / day_off)
 * @param {object}   params.activeProgram — scheda attiva (con schedule)
 * @param {object}   params.appSettings   — settings utente (steps_goal, ecc.)
 * @param {string}   params.today         — data odierna "YYYY-MM-DD"
 * @returns {object|null}
 */
export function calcRecoveryPlan({ weeklyLogs, activeDiet, activeProgram, appSettings, today }) {
  if (!weeklyLogs || weeklyLogs.length === 0 || !activeDiet) return null;

  let kcalWeeklyDelta = 0;
  let proteinWeeklyDelta = 0;
  let carbsWeeklyDelta = 0;
  let fatsWeeklyDelta = 0;
  let stepsWeeklyDelta = 0;
  let totalSteps = 0;
  let stepsLoggedDays = 0;
  let workoutsMissed = 0;
  let workoutsCompleted = 0;
  let workoutsPlanned = 0;
  let lastMissedSession = '';
  let daysWithData = 0;

  const stepsGoal = appSettings?.steps_goal || 0;

  for (const logEntry of weeklyLogs) {
    if (!logEntry) continue;
    const dateStr = logEntry.date || logEntry.id || '';
    const dayOfWeek = getDayOfWeek(dateStr);
    const scheduleDay = activeProgram?.schedule?.[dayOfWeek];
    const isTrainingDay = !!(scheduleDay && scheduleDay !== 'off' && scheduleDay !== 'rest');
    const dayKey = isTrainingDay ? 'day_on' : 'day_off';
    const plan = activeDiet?.[dayKey];

    // ── Macro deltas ──
    const targetKcal = plan?.kcal || 0;
    const targetProtein = plan?.macros?.protein || plan?.protein || 0;
    const targetCarbs = plan?.macros?.carbs || plan?.carbs || 0;
    const targetFats = plan?.macros?.fats || plan?.fats || 0;

    const actualKcal = logEntry.nutrition?.totals?.kcal || logEntry.nutrition?.kcal || 0;
    const actualProtein = logEntry.nutrition?.totals?.protein || logEntry.nutrition?.protein || 0;
    const actualCarbs = logEntry.nutrition?.totals?.carbs || logEntry.nutrition?.carbs || 0;
    const actualFats = logEntry.nutrition?.totals?.fats || logEntry.nutrition?.fats || 0;

    if (actualKcal > 0 || actualProtein > 0) daysWithData++;

    kcalWeeklyDelta += (actualKcal - targetKcal);
    proteinWeeklyDelta += (actualProtein - targetProtein);
    carbsWeeklyDelta += (actualCarbs - targetCarbs);
    fatsWeeklyDelta += (actualFats - targetFats);

    // ── Workouts ──
    if (isTrainingDay) {
      workoutsPlanned++;
      const wDone = !!(logEntry.workout?.completed);
      if (wDone) {
        workoutsCompleted++;
      } else {
        workoutsMissed++;
        const sessionName = typeof scheduleDay === 'string' ? scheduleDay : (scheduleDay?.name || 'Sessione');
        lastMissedSession = sessionName;
      }
    }

    // ── Steps ──
    const daySteps = logEntry.steps || 0;
    totalSteps += daySteps;
    if (daySteps > 0) stepsLoggedDays++;
    if (stepsGoal > 0) {
      stepsWeeklyDelta += (daySteps - stepsGoal);
    }
  }

  const avgDailySteps = stepsLoggedDays > 0 ? Math.round(totalSteps / stepsLoggedDays) : 0;

  // ── Recovery status ──
  const absKcalDelta = Math.abs(kcalWeeklyDelta);
  const absProteinDelta = Math.abs(proteinWeeklyDelta);
  let recoveryStatus;
  if (absKcalDelta > 3000 || workoutsMissed >= 3) {
    recoveryStatus = 'critical';
  } else if (absKcalDelta > 1500 || workoutsMissed >= 2) {
    recoveryStatus = 'needs_recovery';
  } else if (absKcalDelta > 500 || absProteinDelta > 50 || workoutsMissed >= 1) {
    recoveryStatus = 'slight_deviation';
  } else {
    recoveryStatus = 'on_track';
  }

  // ── Adjusted targets for today (with physiological caps) ──
  const todayDow = getDayOfWeek(today);
  const todaySchedule = activeProgram?.schedule?.[todayDow];
  const isTodayTraining = !!(todaySchedule && todaySchedule !== 'off' && todaySchedule !== 'rest');
  const todayPlan = activeDiet?.[isTodayTraining ? 'day_on' : 'day_off'];
  const todayBaseKcal = todayPlan?.kcal || 0;
  const todayBaseProtein = todayPlan?.macros?.protein || todayPlan?.protein || 0;

  // Spread deficit over remaining days — minimum 3 to avoid extreme single-day adjustments
  const remainingDays = Math.max(3, 7 - daysWithData);

  // Calculate raw adjustments per day
  const rawKcalAdjust = kcalWeeklyDelta < 0 ? Math.round(Math.abs(kcalWeeklyDelta) / remainingDays) : 0;
  const rawProteinAdjust = proteinWeeklyDelta < 0 ? Math.round(Math.abs(proteinWeeklyDelta) / remainingDays) : 0;
  const rawStepsAdjust = stepsGoal > 0 && stepsWeeklyDelta < 0
    ? Math.round(Math.abs(stepsWeeklyDelta) / remainingDays)
    : 0;

  // Apply physiological caps — these are safe daily maximums
  const MAX_EXTRA_KCAL_PER_DAY = 400;
  const MAX_EXTRA_PROTEIN_PER_DAY = 40;
  const MAX_EXTRA_STEPS_PER_DAY = 3000;

  const kcalAdjustPerDay = Math.min(rawKcalAdjust, MAX_EXTRA_KCAL_PER_DAY);
  const proteinAdjustPerDay = Math.min(rawProteinAdjust, MAX_EXTRA_PROTEIN_PER_DAY);

  const todayAdjustedKcal = todayBaseKcal + kcalAdjustPerDay;
  const todayExtraProtein = proteinAdjustPerDay;
  const todayAdjustedProtein = todayBaseProtein + todayExtraProtein;
  const todayExtraSteps = Math.min(rawStepsAdjust, MAX_EXTRA_STEPS_PER_DAY);

  // ── Days to recover estimate ──
  let daysToRecover = 0;
  if (recoveryStatus === 'critical') daysToRecover = 5;
  else if (recoveryStatus === 'needs_recovery') daysToRecover = 3;
  else if (recoveryStatus === 'slight_deviation') daysToRecover = 2;
  else daysToRecover = 0;

  // ── Actions ──
  const actions = [];

  if (kcalWeeklyDelta < -200) {
    actions.push({
      type: 'meal',
      icon: '🥩',
      label: 'Spuntino proteico',
      value: `+${kcalAdjustPerDay} kcal`
    });
  }

  if (stepsGoal > 0 && stepsWeeklyDelta < -1000) {
    actions.push({
      type: 'activity',
      icon: '🚶',
      label: 'Camminata 30 min',
      value: `~${todayExtraSteps} passi`
    });
  }

  if (workoutsMissed > 0 && lastMissedSession) {
    actions.push({
      type: 'workout',
      icon: '💪',
      label: 'Recupera sessione',
      value: lastMissedSession
    });
  }

  // If we have fewer than 2 actions, add a generic macro-catch-up
  if (actions.length < 2 && proteinWeeklyDelta < -30) {
    actions.push({
      type: 'meal',
      icon: '🥚',
      label: 'Integra proteine',
      value: `+${todayExtraProtein}g oggi`
    });
  }

  return {
    kcalWeeklyDelta: Math.round(kcalWeeklyDelta),
    proteinWeeklyDelta: Math.round(proteinWeeklyDelta),
    carbsWeeklyDelta: Math.round(carbsWeeklyDelta),
    fatsWeeklyDelta: Math.round(fatsWeeklyDelta),
    workoutsMissed,
    workoutsCompleted,
    workoutsPlanned,
    stepsWeeklyDelta: Math.round(stepsWeeklyDelta),
    avgDailySteps,
    todayBaseKcal,
    todayBaseProtein,
    todayAdjustedKcal,
    todayAdjustedProtein,
    todayExtraProtein,
    todayExtraSteps,
    recoveryStatus,
    daysToRecover,
    actions
  };
}

export async function cleanOldLogs(db, userId, monthsToKeep=12) {
  try {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - monthsToKeep);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    const snap = await getDocs(collection(db, 'users', userId, 'daily_logs'));
    const toDelete = snap.docs.filter(d => d.id < cutoffStr);
    await Promise.all(toDelete.map(d => deleteDoc(doc(db, 'users', userId, 'daily_logs', d.id))));
    if (toDelete.length) console.log(`cleanOldLogs: deleted ${toDelete.length} logs older than ${cutoffStr}`);
  } catch(e) {
    console.warn('cleanOldLogs error:', e);
  }
}


export async function loadSmart(refs, callback) {
  // The Firestore SDK with persistentLocalCache handles caching transparently.
  // We just do a direct getDocs/getDoc — the SDK serves from cache when offline
  // and updates from the network when online. No manual cache-first needed.
  try {
    const snaps = await Promise.all(refs.map(ref => {
      const isDoc = ref.type === 'document' || (ref.path && ref.path.split('/').length % 2 === 0);
      return isDoc ? getDoc(ref) : getDocs(ref);
    }));
    callback(snaps, false);
  } catch (err) {
    console.error('loadSmart: fetch failed:', err.code, err.message);
    // Re-throw so callers can handle (e.g. show error toast)
    throw err;
  }
}


// ── Global Error Logger ──────────────────────────────────────
async function logErrorToFirebase(type, errorData) {
  try {
    let email = null;
    try {
      email = auth?.currentUser?.email || null;
    } catch (e) {}

    const cleanEmail = email ? email.trim().toLowerCase() : 'anonymous';
    const errorId = 'err_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
    await setDoc(doc(db, 'users', cleanEmail, 'errors', errorId), {
      userId: cleanEmail,
      type: type,
      url: window.location.href,
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
      ...errorData
    });
  } catch (e) {
    console.error('Failed to log error to Firebase:', e);
  }
}

window.addEventListener('error', event => {
  logErrorToFirebase('window.onerror', {
    message: event.message,
    source: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error?.stack || null
  });
});

window.addEventListener('unhandledrejection', event => {
  logErrorToFirebase('window.onunhandledrejection', {
    reason: event.reason?.message || String(event.reason),
    stack: event.reason?.stack || null
  });
});
