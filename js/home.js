import {
  db, USER_ID, doc, getDoc, setDoc, getDocs, collection, query, orderBy, limit
} from './firebase-config.js';
import {
  getTodayString, getDayOfWeek, formatDateIT, formatDateShort, addDays, showToast, showModal, setW, setT, DAYS_IT, DAY_ORDER, cleanOldLogs
} from './app.js';
import { calcMacrosFromText } from './gemini.js';

const TODAY = getTodayString();
let logData = {};
let activeDiet = null;
let activeProgram = null;
let appSettings = null;
let isTrainingDay = false;
let mealStates = [];

// ── Init ───────────────────────────────────────────────────
async function init() {
  document.getElementById('date-label').textContent = formatDateIT(TODAY);

  const [logSnap, progSnap, dietSnap, settSnap] = await Promise.all([
    getDoc(doc(db, 'users', USER_ID, 'daily_logs', TODAY)),
    getDocs(collection(db, 'users', USER_ID, 'programs')),
    getDocs(collection(db, 'users', USER_ID, 'diet_plans')),
    getDoc(doc(db, 'users', USER_ID, 'settings', 'app'))
  ]);

  logData = logSnap.exists() ? logSnap.data() : {};
  activeProgram = progSnap.docs.find(d => d.data().active)?.data() || null;
  activeDiet    = dietSnap.docs.find(d => d.data().active)?.data() || null;
  appSettings   = settSnap.exists() ? settSnap.data() : {};

  const name = appSettings?.profile?.name || appSettings?.name || '';
  const welcomeEl = document.getElementById('welcome-name');
  if (welcomeEl) welcomeEl.textContent = name ? `Benvenuto, ${name}` : 'Benvenuto';

  const dow = getDayOfWeek(TODAY);
  const progDay = activeProgram?.schedule?.[dow];
  if (logData.day_override != null) {
    isTrainingDay = logData.day_override;
  } else {
    isTrainingDay = !!progDay;
  }

  buildStreak();
  buildDayType();
  buildNutrition();
  buildMeals();
  buildWorkout();
  buildStats();

  if (new Date().getDate() === 1) {
    cleanOldLogs(db, USER_ID);
  }

  checkYesterdayLog();
}

// ── Streak ─────────────────────────────────────────────────
function buildStreak() {
  const streak = logData.streak || 1;
  const box = document.getElementById('streak-box');
  box.innerHTML = `<div class="streak">🔥 ${streak} giorni</div>`;
}

// ── Session picker modal ───────────────────────────────────
function showSessionPicker() {
  const days = DAY_ORDER.filter(d => activeProgram?.schedule?.[d]);
  if (!days.length) {
    isTrainingDay = true;
    logData.day_override = true;
    document.getElementById('override-tgl').checked = true;
    buildDayType(); buildNutrition(); buildWorkout();
    return;
  }

  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal">
      <div class="modal-handle"></div>
      <h3>🏋️ Scegli la sessione</h3>
      <div id="sp-list" style="margin:14px 0;display:flex;flex-direction:column;gap:8px">
        ${days.map(d => {
          const s = activeProgram.schedule[d];
          return `<button class="btn btn-ghost" style="text-align:left;padding:12px"
            onclick="window._pickSession('${d}')">
            <div style="font-weight:700">${s.name}</div>
            <div style="font-size:12px;color:var(--t2)">${DAYS_IT[d]}${s.time ? ' · ' + s.time : ''} · ${s.exercises?.length||0} esercizi</div>
          </button>`;
        }).join('')}
      </div>
      <button class="btn btn-flat" onclick="this.closest('.modal-bg').remove()">Annulla</button>
    </div>`;
  document.body.appendChild(bg);
  bg.onclick = e => { if (e.target === bg) bg.remove(); };

  window._pickSession = function(dayKey) {
    bg.remove();
    isTrainingDay = true;
    logData.day_override = true;
    logData.selected_session_day = dayKey;
    document.getElementById('override-tgl').checked = true;
    buildDayType(); buildNutrition(); buildWorkout();
  };
}

// ── Day type ───────────────────────────────────────────────
function buildDayType() {
  const dow = getDayOfWeek(TODAY);
  const session = activeProgram?.schedule?.[dow];
  const lbl = document.getElementById('dtype-label');
  const sub = document.getElementById('dtype-sub');
  const tgl = document.getElementById('override-tgl');

  if (isTrainingDay) {
    lbl.textContent = `💪 Giorno ON`;
    sub.textContent = session?.name || 'Allenamento';
    tgl.checked = true;
  } else {
    lbl.textContent = `😴 Giorno OFF — Riposo`;
    sub.textContent = 'Nessuna sessione programmata';
    tgl.checked = false;
  }

  tgl.onchange = function() {
    const newVal = this.checked;
    if (newVal && !isTrainingDay) {
      this.checked = false;
      showSessionPicker();
      return;
    }
    isTrainingDay = newVal;
    logData.day_override = newVal;
    buildDayType();
    buildNutrition();
    buildWorkout();
  };
}

// ── Nutrition ──────────────────────────────────────────────
function buildNutrition() {
  const dayKey = isTrainingDay ? 'day_on' : 'day_off';
  const plan   = activeDiet?.[dayKey] || {};
  const tgt    = { kcal: plan.kcal||2700, protein: plan.protein||190, carbs: plan.carbs||300, fats: plan.fats||60 };
  const tots   = calcTotals();

  setT('kcal-now', Math.round(tots.kcal));
  setT('kcal-tgt', tgt.kcal);
  setW('pb-kcal', (tots.kcal / tgt.kcal) * 100);
  setT('mc-pro',  Math.round(tots.protein) + 'g');
  setT('mc-carb', Math.round(tots.carbs) + 'g');
  setT('mc-fat',  Math.round(tots.fats) + 'g');

  const rem = tgt.kcal - tots.kcal;
  const deltaEl = document.getElementById('kcal-delta');
  if (rem >= 0) {
    deltaEl.style.color = 'var(--green)';
    deltaEl.textContent = `Rimangono ${Math.round(rem)} kcal`;
  } else {
    deltaEl.style.color = 'var(--orange)';
    deltaEl.textContent = `⚠️ +${Math.round(-rem)} kcal in eccesso`;
  }

  const pct = Math.round((tots.kcal / tgt.kcal) * 100);
  const cring = document.getElementById('cring-box');
  const C = 125.7;
  const off = C - (C * Math.min(pct, 100) / 100);
  cring.innerHTML = `
    <div class="cring">
      <svg viewBox="0 0 50 50">
        <circle cx="25" cy="25" r="20" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="4"/>
        <circle cx="25" cy="25" r="20" fill="none" stroke="var(--accent)" stroke-width="4"
          stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${off}"/>
      </svg>
      <div class="cring-n" style="font-size:13px">${pct}%</div>
    </div>`;
}

function calcTotals() {
  const fromPlan = mealStates.filter(m => m.eaten).reduce((a, m) => {
    a.kcal    += m.override_kcal ?? m.kcal    ?? 0;
    a.protein += m.protein ?? 0;
    a.carbs   += m.carbs   ?? 0;
    a.fats    += m.fats    ?? 0;
    return a;
  }, { kcal:0, protein:0, carbs:0, fats:0 });
  const fromExtra = (logData.extra_meals || []).reduce((a, m) => {
    a.kcal    += m.kcal    || 0;
    a.protein += m.protein || 0;
    a.carbs   += m.carbs   || 0;
    a.fats    += m.fats    || 0;
    return a;
  }, { kcal:0, protein:0, carbs:0, fats:0 });
  return {
    kcal:    fromPlan.kcal    + fromExtra.kcal,
    protein: fromPlan.protein + fromExtra.protein,
    carbs:   fromPlan.carbs   + fromExtra.carbs,
    fats:    fromPlan.fats    + fromExtra.fats
  };
}

function updateNutritionTotals() { buildNutrition(); }

// ── Meals ──────────────────────────────────────────────────
function buildMeals() {
  const dayKey = isTrainingDay ? 'day_on' : 'day_off';
  const meals  = activeDiet?.[dayKey]?.meals || [];

  if (mealStates.length === 0 || mealStates.length !== meals.length) {
    mealStates = meals.map((m, i) => ({
      ...m,
      eaten: logData.meals_eaten?.[i] || false,
      active_variant: logData.meals_variant?.[i] ?? null,
      override_kcal: logData.meals_override?.[i]?.kcal ?? null
    }));
  }

  const el = document.getElementById('meals-list');
  if (!meals.length) {
    el.innerHTML = '<p style="color:var(--t2);font-size:13px;text-align:center;padding:16px">Nessun piano dieta attivo</p>';
    return;
  }
  const extraHtml = (logData.extra_meals || []).map((m, xi) => `
    <div class="meal-item eaten" style="border-left:3px solid var(--orange)">
      <div class="meal-top">
        <div class="meal-chk" style="background:var(--orange)">✓</div>
        ${m.time ? `<span class="meal-time">${m.time}</span>` : ''}
        <div class="meal-info">
          <div class="meal-name">${m.name} <span style="font-size:10px;color:var(--orange);font-weight:700;background:rgba(255,152,0,.15);padding:1px 5px;border-radius:4px">EXTRA</span></div>
          <div class="meal-meta">${m.kcal} kcal · P:${m.protein}g C:${m.carbs}g F:${m.fats}g</div>
        </div>
        <div class="meal-kcal">${m.kcal}</div>
      </div>
    </div>`).join('');
  el.innerHTML = mealStates.map((m, mi) => renderMealRow(m, mi)).join('') + extraHtml;
}

function renderMealRow(m, mi) {
  const kcalDisplay = m.override_kcal ?? m.kcal;
  const varsHtml = m.variants?.length ? `
    <div class="vars">
      ${m.variants.map((v, vi) => {
        const lbl = typeof v === 'object' ? v.label : v;
        const det = typeof v === 'object' ? v.detail : v;
        return `<div class="var-chip ${m.active_variant === vi ? 'sel' : ''}"
          onclick="selectVariant(${mi},${vi})">${lbl}</div>`;
      }).join('')}
    </div>` : '';
  const selVariantDetail = m.active_variant != null && m.variants?.[m.active_variant]
    ? `<div style="font-size:12px;color:var(--accent2);margin-top:6px;padding:6px 8px;background:rgba(124,111,255,.08);border-radius:6px">
        ${typeof m.variants[m.active_variant] === 'object' ? m.variants[m.active_variant].detail : m.variants[m.active_variant]}
       </div>` : '';

  return `
    <div class="meal-item ${m.eaten ? 'eaten' : ''}" id="meal-${mi}">
      <div class="meal-top" onclick="toggleMeal(${mi})" style="cursor:pointer">
        <div class="meal-chk">${m.eaten ? '✓' : ''}</div>
        ${m.time ? `<span class="meal-time">${m.time}</span>` : ''}
        <div class="meal-info">
          <div class="meal-name">${m.label || m.type}</div>
          <div class="meal-meta">${kcalDisplay} kcal · P:${m.protein}g C:${m.carbs}g F:${m.fats}g</div>
        </div>
        <div class="meal-kcal">${kcalDisplay}</div>
      </div>
      <div class="meal-detail" id="mdtl-${mi}" style="display:none">
        <p style="font-size:13px;color:var(--t2);line-height:1.6;margin-bottom:8px">${m.items || ''}</p>
        ${varsHtml}
        ${selVariantDetail}
        <div style="margin-top:12px">
          <label class="fl">✏️ Ingredienti (modifica)</label>
          <textarea id="meal-txt-${mi}" class="fi" rows="2" style="font-size:13px">${m.items || ''}</textarea>
          <button class="btn btn-ghost btn-sm" onclick="recalcMeal(${mi})" style="margin-top:8px">✨ Ricalcola con AI</button>
          <div id="meal-ai-${mi}" style="display:none;margin-top:8px"></div>
        </div>
        <div class="meal-delta" id="meal-delta-${mi}"></div>
      </div>
    </div>
    <div onclick="toggleMealDetail(${mi})" style="text-align:right;font-size:11px;color:var(--t3);cursor:pointer;padding:4px 0;margin-bottom:4px">▼ dettagli</div>`;
}

window.toggleMeal = function(mi) {
  mealStates[mi].eaten = !mealStates[mi].eaten;
  buildMeals();
  buildNutrition();
};

window.toggleMealDetail = function(mi) {
  const el = document.getElementById(`mdtl-${mi}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

window.selectVariant = function(mi, vi) {
  mealStates[mi].active_variant = mealStates[mi].active_variant === vi ? null : vi;
  buildMeals();
};

window.recalcMeal = async function(mi) {
  const txt = document.getElementById(`meal-txt-${mi}`)?.value.trim();
  if (!txt) return;
  const btn = document.querySelector(`#mdtl-${mi} .btn-ghost`);
  if (btn) { btn.textContent = '⏳...'; btn.disabled = true; }
  const r = await calcMacrosFromText(txt);
  if (btn) { btn.textContent = '✨ Ricalcola con AI'; btn.disabled = false; }
  if (!r.success) { showToast('Errore AI: ' + r.error, 'err'); return; }
  const box = document.getElementById(`meal-ai-${mi}`);
  if (box) {
    box.style.display = 'block';
    box.innerHTML = `
      <div class="fmp">
        <div class="fmp-item"><div class="fmp-v" style="color:var(--green)">${r.kcal}</div><div class="fmp-l">Kcal</div></div>
        <div class="fmp-item"><div class="fmp-v" style="color:var(--blue)">${r.protein}g</div><div class="fmp-l">Pro</div></div>
        <div class="fmp-item"><div class="fmp-v" style="color:var(--yellow)">${r.carbs}g</div><div class="fmp-l">Carbo</div></div>
        <div class="fmp-item"><div class="fmp-v" style="color:var(--purple)">${r.fats}g</div><div class="fmp-l">Grassi</div></div>
      </div>
      <button class="btn btn-v btn-sm" onclick="applyMealAI(${mi},${r.kcal},${r.protein},${r.carbs},${r.fats})" style="margin-top:8px">✅ Applica</button>`;
    const tgt = mealStates[mi].kcal;
    const diff = r.kcal - tgt;
    const deltaEl = document.getElementById(`meal-delta-${mi}`);
    if (deltaEl) {
      deltaEl.textContent = `Target: ${tgt}kcal | AI: ${r.kcal}kcal | ${diff >= 0 ? '+' : ''}${diff}kcal`;
      deltaEl.className = 'meal-delta ' + (Math.abs(diff) < 50 ? 'delta-ok' : diff > 0 ? 'delta-over' : 'delta-warn');
    }
  }
};

window.applyMealAI = function(mi, kcal, protein, carbs, fats) {
  mealStates[mi].override_kcal = kcal;
  mealStates[mi].protein = protein;
  mealStates[mi].carbs   = carbs;
  mealStates[mi].fats    = fats;
  buildMeals();
  buildNutrition();
  showToast('Macro aggiornati ✅');
};

// ── Workout ────────────────────────────────────────────────
function buildWorkout() {
  const el = document.getElementById('workout-content');
  const dow = getDayOfWeek(TODAY);
  const session = activeProgram?.schedule?.[dow];
  const workout = logData.workout;

  if (!isTrainingDay) {
    el.innerHTML = '<p style="color:var(--t2);font-size:14px">Giorno di riposo 🛌</p>';
    return;
  }
  if (workout?.completed) {
    const dur = Math.round((workout.duration_seconds || 0) / 60);
    const vol = (workout.exercises || []).reduce((a, ex) =>
      a + ex.sets.reduce((b, s) => b + (parseFloat(s.weight)||0) * (parseFloat(s.reps)||1), 0), 0);
    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:15px;font-weight:700">${workout.session_name || 'Sessione'}</div>
          <div style="font-size:12px;color:var(--t2);margin-top:4px">⏱ ${dur} min · 🏋️ ${Math.round(vol)} kg volume</div>
        </div>
        <span class="badge badge-g">✅ Completato</span>
      </div>`;
  } else {
    el.innerHTML = `
      <div style="font-size:15px;font-weight:700;margin-bottom:10px">${session?.name || 'Sessione'}</div>
      <a href="session.html" class="btn btn-o" style="text-decoration:none">🏋️ Vai ad Allenarti</a>`;
  }
}

// ── Stats ──────────────────────────────────────────────────
function buildStats() {
  if (logData.steps)       document.getElementById('steps-in').value  = logData.steps;
  if (logData.burned_kcal) document.getElementById('burned-in').value = logData.burned_kcal;
  if (logData.daily_note)  document.getElementById('note-in').value   = logData.daily_note;
}

// ── AI ─────────────────────────────────────────────────────
window.calcAI = async function() {
  const text = document.getElementById('ai-input').value.trim();
  if (!text) { showToast('Scrivi gli alimenti', 'err'); return; }
  const btn = document.getElementById('ai-btn');
  btn.textContent = '⏳ Calcolo...'; btn.disabled = true;
  const r = await calcMacrosFromText(text);
  btn.textContent = '🤖 Calcola Macro'; btn.disabled = false;
  if (!r.success) { showToast('Errore AI: ' + r.error, 'err'); return; }
  const box = document.getElementById('ai-result');
  box.className = 'ai-result show';
  box.innerHTML = `
    <div class="fmp">
      <div class="fmp-item"><div class="fmp-v" style="color:var(--green)">${r.kcal}</div><div class="fmp-l">Kcal</div></div>
      <div class="fmp-item"><div class="fmp-v" style="color:var(--blue)">${r.protein}g</div><div class="fmp-l">Pro</div></div>
      <div class="fmp-item"><div class="fmp-v" style="color:var(--yellow)">${r.carbs}g</div><div class="fmp-l">Carbo</div></div>
      <div class="fmp-item"><div class="fmp-v" style="color:var(--purple)">${r.fats}g</div><div class="fmp-l">Grassi</div></div>
    </div>
    ${r.items.map(i => `<div style="font-size:12px;color:var(--t2);margin-top:4px">• ${i.name} (${i.grams}g) → ${i.kcal}kcal</div>`).join('')}`;
};

// ── Save ───────────────────────────────────────────────────
window.saveDay = async function() {
  const steps       = parseInt(document.getElementById('steps-in').value)  || null;
  const burned_kcal = parseInt(document.getElementById('burned-in').value) || null;
  const daily_note  = document.getElementById('note-in').value;
  const tots = calcTotals();

  const data = {
    date:            TODAY,
    is_training_day: isTrainingDay,
    steps,
    burned_kcal,
    daily_note,
    nutrition:    { totals: tots },
    streak:       logData.streak || 1,
    extra_meals:  logData.extra_meals || []
  };
  if (logData.day_override != null) data.day_override = logData.day_override;

  try {
    await setDoc(doc(db, 'users', USER_ID, 'daily_logs', TODAY), data, { merge: true });
    showToast('💾 Giornata salvata!');
  } catch(e) {
    showToast('Errore salvataggio', 'err');
  }
};

// ── Recupero giorni passati ────────────────────────────────
async function checkYesterdayLog() {
  const yesterday = addDays(TODAY, -1);
  const snap = await getDoc(doc(db, 'users', USER_ID, 'daily_logs', yesterday));
  if (snap.exists()) return;

  const banner = document.createElement('div');
  banner.setAttribute('data-yesterday-banner', '1');
  banner.style.cssText = `
    background:linear-gradient(135deg,rgba(255,107,53,0.15),rgba(255,61,90,0.1));
    border:1px solid rgba(255,107,53,0.3);border-radius:var(--rs);
    padding:12px 16px;margin-bottom:14px;
    display:flex;align-items:center;justify-content:space-between;gap:12px;
    animation:fup .3s ease both;
  `;
  banner.innerHTML = `
    <div>
      <div style="font-size:13px;font-weight:700;color:var(--orange)">📋 Ieri non hai registrato la giornata</div>
      <div style="font-size:12px;color:var(--t2);margin-top:2px">Vuoi recuperare i dati di ${formatDateShort(yesterday)}?</div>
    </div>
    <button class="btn btn-o btn-xs" onclick="openRecoverDay('${yesterday}')">Recupera</button>
  `;
  const wrap = document.querySelector('.wrap');
  if (wrap?.firstChild) wrap.insertBefore(banner, wrap.firstChild);
}

window.openRecoverDay = function(dateStr) {
  const sessionOpts = Object.entries(activeProgram?.schedule || {})
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
  if (didWorkout && sessionDay && activeProgram?.schedule?.[sessionDay]) {
    data.workout = {
      completed: true, recovered: true,
      session_day: sessionDay,
      session_name: activeProgram.schedule[sessionDay].name
    };
  }

  try {
    await setDoc(doc(db, 'users', USER_ID, 'daily_logs', dateStr), data, { merge: false });
    document.getElementById('recover-modal')?.remove();
    document.querySelector('[data-yesterday-banner]')?.remove();
    showToast('✅ Giornata recuperata!');
  } catch(e) {
    showToast('Errore salvataggio', 'err');
  }
};

// ── Aggiungi pasto extra ───────────────────────────────────
window.openAddMeal = function() {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.id = 'add-meal-modal';
  bg.innerHTML = `
    <div class="modal" style="max-height:85vh;overflow-y:auto">
      <div class="modal-handle"></div>
      <h3>+ Aggiungi Pasto</h3>

      <div class="fg">
        <label class="fl">Nome pasto</label>
        <input type="text" class="fi" id="am-name" placeholder="Es. Snack, Extra proteine...">
      </div>

      <div class="fg">
        <label class="fl">Ingredienti</label>
        <textarea class="fi" id="am-ingredients" rows="3"
          placeholder="Es: 150g pollo, 100g riso, 10g olio&#10;Oppure inserisci macro manualmente sotto"></textarea>
        <button class="btn btn-ghost btn-sm" onclick="calcAIMeal()"
                style="margin-top:8px;width:auto">
          ✨ Calcola con AI
        </button>
      </div>

      <div class="fmp" id="am-macro-preview" style="margin-bottom:16px">
        <div class="fmp-item">
          <input type="number" class="fi" id="am-kcal" placeholder="Kcal" min="0">
          <div class="fmp-l">Kcal</div>
        </div>
        <div class="fmp-item">
          <input type="number" class="fi" id="am-protein" placeholder="0" min="0" step="0.1">
          <div class="fmp-l">Proteine g</div>
        </div>
        <div class="fmp-item">
          <input type="number" class="fi" id="am-carbs" placeholder="0" min="0" step="0.1">
          <div class="fmp-l">Carbo g</div>
        </div>
        <div class="fmp-item">
          <input type="number" class="fi" id="am-fats" placeholder="0" min="0" step="0.1">
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
        <button class="btn btn-g" onclick="saveExtraMeal()">
          💾 Salva
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(bg);
  bg.onclick = e => { if (e.target === bg) bg.remove(); };
};

window.calcAIMeal = async function() {
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

window.saveExtraMeal = async function() {
  const name    = document.getElementById('am-name')?.value?.trim();
  const kcal    = parseFloat(document.getElementById('am-kcal')?.value)    || 0;
  const protein = parseFloat(document.getElementById('am-protein')?.value) || 0;
  const carbs   = parseFloat(document.getElementById('am-carbs')?.value)   || 0;
  const fats    = parseFloat(document.getElementById('am-fats')?.value)    || 0;
  const type    = document.getElementById('am-type')?.value || 'extra';

  if (!name)                       return showToast('Inserisci il nome del pasto', 'err');
  if (kcal === 0 && protein === 0) return showToast('Inserisci almeno le kcal', 'err');

  if (!logData.extra_meals) logData.extra_meals = [];
  logData.extra_meals.push({
    name, type, kcal, protein, carbs, fats,
    time:     new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
    added_at: new Date().toISOString()
  });

  updateNutritionTotals();
  document.getElementById('add-meal-modal')?.remove();
  showToast('✅ Pasto aggiunto!');
  buildMeals();
};

init();
