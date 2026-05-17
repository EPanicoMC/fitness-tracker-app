import { auth, onAuthStateChanged } from './firebase-config.js';

export function requireAuth() {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      if (user) {
        
        resolve(user);
      } else {
        window.location.href = 'auth.html';
      }
    });
  });
}

export function getTodayString() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
}

export function getYesterdayString() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
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
}) {
  const now = new Date();
  const nowStr = now.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
  const [nowH, nowM] = nowStr.split(':').map(Number);
  const nowMin = nowH * 60 + (isNaN(nowM) ? 0 : nowM);

  const toMin = t => { if (!t || !t.includes(':')) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; };

  const breakdown = [];
  let total = 0, maxTotal = 0;

  // 1. PASTI (40pt): quanti dei pasti "attesi" entro ora sono stati mangiati
  const mealsT = meals.map((m, i) => ({
    ...m,
    timeMin: toMin(m.time) ?? (420 + Math.round((900 / Math.max(meals.length - 1, 1)) * i)),
    eaten: mealStates[i]?.eaten || false
  }));
  const expected = mealsT.filter(m => m.timeMin <= nowMin);
  const eatenExp = expected.filter(m => m.eaten).length;
  const mealPt = expected.length === 0 ? 40 : Math.round((eatenExp / expected.length) * 40);
  const mealNote = expected.length === 0 ? 'In anticipo' : `${eatenExp}/${expected.length} pasti previsti`;
  breakdown.push({ label: 'Pasti', score: mealPt, max: 40, note: mealNote, ok: mealPt >= 32 });
  total += mealPt; maxTotal += 40;

  // 2. ALLENAMENTO (35pt): se non ancora l'ora → pieno punteggio, non penalizza
  const wDone = !!workout?.completed;
  let wPt, wNote;
  if (!isTrainingDay) {
    wPt = 35; wNote = 'Riposo programmato';
  } else if (wDone) {
    wPt = 35; wNote = 'Completato';
  } else {
    const schMin = toMin(workoutScheduledTime);
    if (schMin !== null && nowMin < schMin) {
      wPt = 35; wNote = `Programmato alle ${workoutScheduledTime}`;
    } else if (nowMin < 22 * 60) {
      wPt = 15; wNote = 'Da completare oggi';
    } else {
      wPt = 0; wNote = 'Saltato';
    }
  }
  breakdown.push({ label: 'Allenamento', score: wPt, max: 35, note: wNote, ok: wPt >= 30 });
  total += wPt; maxTotal += 35;

  // 3. PASSI (15pt): proporzionale all'ora (fascia 7:00-23:00)
  if (stepsGoal > 0) {
    const actStart = 7 * 60, actEnd = 23 * 60;
    const elapsed = Math.max(0, Math.min(nowMin, actEnd) - actStart);
    const ratioT = elapsed / (actEnd - actStart);
    const expSteps = Math.round(stepsGoal * ratioT);
    const sPt = expSteps <= 0 ? 15 : Math.round(Math.min(1, steps / expSteps) * 15);
    const sNote = expSteps <= 0 ? '—' : `${steps.toLocaleString('it-IT')} / ~${expSteps.toLocaleString('it-IT')} attesi`;
    breakdown.push({ label: 'Passi', score: sPt, max: 15, note: sNote, ok: sPt >= 10 });
    total += sPt; maxTotal += 15;
  }

  // 4. PROTEINE (10pt): proporzionale ai pasti attesi vs totali
  if (planProtein > 0 && meals.length > 0) {
    const mRatio = expected.length > 0 ? expected.length / meals.length : 1;
    const expProt = planProtein * mRatio;
    const pPt = Math.min(10, Math.round(Math.min(1.2, actualProtein / Math.max(expProt, 1)) * 10));
    breakdown.push({ label: 'Proteine', score: pPt, max: 10, note: `${Math.round(actualProtein)}g / ~${Math.round(expProt)}g attesi`, ok: pPt >= 7 });
    total += pPt; maxTotal += 10;
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

export async function cleanOldLogs(db, userId, monthsToKeep=12) {
  try {
    const { collection, getDocs, deleteDoc, doc } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
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
