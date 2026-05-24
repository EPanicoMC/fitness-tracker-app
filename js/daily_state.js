import { requireAuth } from './app.js';
import {
  db, getUserId, doc, getDoc, setDoc, getDocs, collection, query, orderBy, limit
} from './firebase-config.js';
import {
  getTodayString, getYesterdayString, getDayOfWeek, formatDateIT, formatDateShort, addDays, showToast, showModal, setW, setT, DAYS_IT, DAY_ORDER, cleanOldLogs, calcFitScore, calcSmartScore
} from './app.js';
import { calcMacrosFromText, analyzeFoodImageAI } from './gemini.js';

const TODAY = getTodayString();
let logData = {};
let activeDiet = null;
let activeProgram = null;
let appSettings = null;
let isTrainingDay = false;
let mealStates = [];
let friendLogData = null;
let friendActiveDiet = null;

let cloudSyncTimer = null;
function saveToLocal() {
  try {
    const key = 'fittracker_today_' + getTodayString();
    const meals_state = {};
    mealStates.forEach((m, i) => {
      meals_state[i] = { eaten: m.eaten, variant: m.active_variant };
    });
    logData.meals_state = meals_state;
    const payload = {
      meals_state,
      meals_overrides: logData.meals_overrides || {},
      extra_meals:     logData.extra_meals     || [],
      steps:           logData.steps           || null,
      burned_kcal:     logData.burned_kcal     || null,
      daily_note:      logData.daily_note      || '',
      is_training_day: isTrainingDay,
      day_override:    logData.day_override
    };
    localStorage.setItem(key, JSON.stringify(payload));
    Object.keys(localStorage)
      .filter(k => k.startsWith('fittracker_today_') && k !== key)
      .forEach(k => localStorage.removeItem(k));

    // Debounced cloud sync — 1.5s after last change
    if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(() => { syncToFirebase(); }, 1500);
  } catch(e) {
    console.warn('saveToLocal error:', e);
  }
}

// ── Day rollover auto-save ─────────────────────────────────
async function checkDayRollover() {
  const yesterday = getYesterdayString();
  const yesterdayLS = localStorage.getItem('fittracker_today_' + yesterday);
  if (!yesterdayLS) return;
  try {
    const data = JSON.parse(yesterdayLS);
    const snap = await getDoc(doc(db, 'users', getUserId(), 'daily_logs', yesterday));
    if (!snap.exists()) {
      await setDoc(doc(db, 'users', getUserId(), 'daily_logs', yesterday), {
        date: yesterday,
        is_training_day: data.is_training_day || false,
        steps: data.steps || null,
        burned_kcal: data.burned_kcal || null,
        daily_note: data.daily_note || '',
        nutrition: { totals: data.nutrition_totals || {} },
        auto_saved: true
      }, { merge: false });
      console.log('Auto-salvato giorno precedente:', yesterday);
    } else if (data.daily_note) {
      // Doc esiste ma la nota in localStorage potrebbe non essere stata sincronizzata
      await setDoc(doc(db, 'users', getUserId(), 'daily_logs', yesterday), { daily_note: data.daily_note }, { merge: true });
    }
    localStorage.removeItem('fittracker_today_' + yesterday);
  } catch(e) {
    console.warn('Errore auto-save yesterday:', e);
  }
}

// ── Init ───────────────────────────────────────────────────
async function init() {
  const dlabel = document.getElementById('date-label'); if(dlabel) dlabel.textContent = formatDateIT(TODAY);

  await checkDayRollover();

  try {
    const [logSnap, progSnap, dietSnap, settSnap] = await Promise.all([
      getDoc(doc(db, 'users', getUserId(), 'daily_logs', TODAY)),
      getDocs(collection(db, 'users', getUserId(), 'programs')),
      getDocs(collection(db, 'users', getUserId(), 'diet_plans')),
      getDoc(doc(db, 'users', getUserId(), 'settings', 'app'))
    ]);

    logData = logSnap.exists() ? logSnap.data() : {};
    activeProgram = progSnap.docs.find(d => d.data().active)?.data() || null;
    activeDiet    = dietSnap.docs.find(d => d.data().active)?.data() || null;
    appSettings   = settSnap.exists() ? settSnap.data() : {};
  } catch (e) {
    console.error('DIAGNOSTIC: Error fetching DB data:', e);
    showToast('Errore nel caricamento dati dal cloud', 'err');
    // Fallback to empty states to allow the app to at least boot
    logData = {};
    activeProgram = null;
    activeDiet = null;
    appSettings = {};
  }

  if (appSettings?.friend_email) {
    try {
      const fSnap = await getDoc(doc(db, 'users', appSettings.friend_email, 'daily_logs', TODAY));
      if (fSnap.exists()) friendLogData = fSnap.data();

      const fDietSnap = await getDocs(collection(db, 'users', appSettings.friend_email, 'diet_plans'));
      friendActiveDiet = fDietSnap.docs.find(d => d.data().active)?.data() || null;
    } catch(e) { console.warn('Errore friend log:', e); }
  }

  // Merge localStorage (higher priority for today's working state)
  const lsKey = 'fittracker_today_' + getTodayString();
  const cached = localStorage.getItem(lsKey);
  let local = null;
  if (cached) {
    try {
      local = JSON.parse(cached);
      logData.meals_overrides = local.meals_overrides || {};
      logData.meals_state     = local.meals_state     || {};
      logData.extra_meals     = local.extra_meals     || [];
      if (local.steps != null && local.steps > (logData.steps || 0))        logData.steps        = local.steps;
      if (local.burned_kcal != null && local.burned_kcal > (logData.burned_kcal || 0))  logData.burned_kcal  = local.burned_kcal;
      if (local.daily_note != null)   logData.daily_note   = local.daily_note;
      if (local.day_override != null) logData.day_override = local.day_override;
    } catch(e) {}
  }

  // Align DOM inputs with loaded variables immediately to prevent overwrite on sync
  const sfInput = document.getElementById('steps-in');
  if (sfInput) sfInput.value = logData.steps || '';
  const kfInput = document.getElementById('burned-in');
  if (kfInput) kfInput.value = logData.burned_kcal || '';

  // Apple Health iOS Shortcuts Bridge
  const params = new URLSearchParams(window.location.search);
  const stepsParam = params.get('steps');
  const burnedParam = params.get('burned') || params.get('burned_kcal');
  if (stepsParam || burnedParam) {
    let updated = false;
    if (stepsParam) {
      const sVal = parseInt(stepsParam);
      if (!isNaN(sVal)) {
        logData.steps = sVal;
        const sf = document.getElementById('steps-in');
        if (sf) sf.value = sVal;
        updated = true;
      }
    }
    if (burnedParam) {
      const bVal = parseInt(burnedParam);
      if (!isNaN(bVal)) {
        logData.burned_kcal = bVal;
        const kf = document.getElementById('burned-in');
        if (kf) kf.value = bVal;
        updated = true;
      }
    }
    if (updated) {
      saveToLocal();
      await syncToFirebase();
      showToast('🍎 Dati Apple Health sincronizzati con successo! 👟');
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    }
  }

  const name = appSettings?.profile?.name || appSettings?.name || '';
  const welcomeEl = document.getElementById('welcome-name');
  if (welcomeEl) welcomeEl.textContent = name ? `BENVENUTO, ${name.toUpperCase()}` : 'BENVENUTO';

  const dow = getDayOfWeek(TODAY);
  const progDay = activeProgram?.schedule?.[dow];
  if (logData.day_override != null) {
    isTrainingDay = logData.day_override;
  } else if (local?.is_training_day != null) {
    isTrainingDay = local.is_training_day;
  } else {
    isTrainingDay = !!progDay;
  }
  
  const activeWorkoutEl = document.getElementById('active-workout-info');
  if (activeWorkoutEl) {
    if (isTrainingDay && progDay) {
      activeWorkoutEl.innerHTML = `${progDay.name}<br><span style="font-size:20px;color:var(--accent)">${progDay.exercises?.length || 0} Esercizi</span>`;
    } else {
      activeWorkoutEl.innerHTML = `Giorno di riposo.<br><span style="font-size:20px;color:var(--t2)">Recupera le energie</span>`;
    }
  }
  
  const progNameEl = document.getElementById('active-program-name');
  if (progNameEl) {
    progNameEl.textContent = activeProgram ? activeProgram.name : 'Nessuna scheda';
  }

  buildStreak();
  buildDayType();
  buildNutrition();
  buildMeals();
  buildWorkout();
  buildStats();
  buildFitScore();

  if (new Date().getDate() === 1) {
    cleanOldLogs(db, getUserId());
  }

  checkYesterdayLog();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // Pagina va in background/navigazione: forza sync immediato
      const nf = document.getElementById('note-in');
      if (nf) logData.daily_note = nf.value;
      saveToLocal();
      syncToFirebase();
      return;
    }
    if (getTodayString() !== TODAY) { window.location.reload(); return; }
    const cached = localStorage.getItem('fittracker_today_' + TODAY);
    if (cached) {
      try {
        const local = JSON.parse(cached);
        logData.meals_overrides = local.meals_overrides || {};
        logData.meals_state     = local.meals_state     || {};
        logData.extra_meals     = local.extra_meals     || [];
        if (local.steps != null && local.steps > (logData.steps || 0))       logData.steps       = local.steps;
        if (local.burned_kcal != null && local.burned_kcal > (logData.burned_kcal || 0)) logData.burned_kcal = local.burned_kcal;
        if (local.daily_note != null)  logData.daily_note  = local.daily_note;
      } catch(e) {}
    }
    buildNutrition(); buildMeals(); buildWorkout(); buildStats(); buildFitScore();
  });

  window.addEventListener('pagehide', () => {
    const nf = document.getElementById('note-in');
    if (nf) logData.daily_note = nf.value;
    saveToLocal();
    syncToFirebase();
  });
}

// ── Streak box: show weekly workout count ──────────────────────
async function buildStreak() {
  const box = document.getElementById('streak-box');
  if (!box) return;
  try {
    const snap = await getDocs(query(
      collection(db, 'users', getUserId(), 'daily_logs'),
      orderBy('date', 'desc'),
      limit(14)
    ));
    const logs = snap.docs.map(d => d.data());
    // Count training days completed in the last 7 days
    const weekAgo = new Date(TODAY + 'T12:00:00');
    weekAgo.setDate(weekAgo.getDate() - 6);
    const weekAgoStr = weekAgo.toISOString().split('T')[0];
    const weeklyDone = logs.filter(l => l.date >= weekAgoStr && l.workout?.completed).length;
    const totalDone  = logs.filter(l => l.workout?.completed).length;
    if (weeklyDone > 0) {
      box.innerHTML = `<div class="streak">${weeklyDone} <span style="font-size:10px;opacity:.7">/ sett.</span></div>`;
    } else if (totalDone > 0) {
      box.innerHTML = `<div class="streak">0 <span style="font-size:10px;opacity:.7">/ sett.</span></div>`;
    } else {
      box.innerHTML = '';
    }
  } catch(e) {
    const fallback = logData.streak || 0;
    if (fallback) box.innerHTML = `<div class="streak">🔥 ${fallback} giorni</div>`;
  }
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
    saveToLocal();
    buildDayType(); buildNutrition(); buildMeals(); buildWorkout();
  };
}

// ── Day type ───────────────────────────────────────────────
function buildDayType() {
  const dow = getDayOfWeek(TODAY);
  const session = activeProgram?.schedule?.[dow];
  const lbl = document.getElementById('dtype-label');
  const sub = document.getElementById('dtype-sub');
  const tgl = document.getElementById('override-tgl');
  if(!lbl || !sub || !tgl) return;

  if (isTrainingDay) {
    lbl.innerHTML = `<i class="ri-checkbox-circle-fill" style="color:var(--green)"></i> Giorno ON`;
    sub.textContent = session?.name || 'Allenamento';
    tgl.checked = true;
  } else {
    lbl.innerHTML = `<i class="ri-moon-fill" style="color:var(--t3)"></i> Giorno OFF — Riposo`;
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
    saveToLocal();
    buildDayType();
    buildNutrition();
    buildMeals();
    buildWorkout();
    buildFitScore();
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
  [
    { id: 'mc-pro',  val: tots.protein, t: tgt.protein, name: 'Proteine' },
    { id: 'mc-carb', val: tots.carbs,   t: tgt.carbs,   name: 'Carbo' },
    { id: 'mc-fat',  val: tots.fats,    t: tgt.fats,    name: 'Grassi' }
  ].forEach(({ id, val, t, name }) => {
    setT(id, Math.round(val) + 'g');
    const chip = document.getElementById(id)?.closest('.mchip');
    if (!chip) return;
    const lbl = chip.querySelector('.mchip-l');
    if (!lbl) return;
    const delta = Math.round(val - t);
    const sign  = delta >= 0 ? '+' : '';
    const col   = Math.abs(delta) <= 5 ? 'var(--green)' : delta > 0 ? 'var(--orange)' : 'var(--t2)';
    lbl.innerHTML = `${name} <span style="color:${col};font-size:10px">(${sign}${delta}g)</span>`;
  });

  const rem = tgt.kcal - tots.kcal;
  const deltaEl = document.getElementById('kcal-delta');
  if(deltaEl) { if (rem >= 0) {
    deltaEl.style.color = 'var(--green)';
    deltaEl.textContent = `Rimangono ${Math.round(rem)} kcal`;
  } else {
    deltaEl.style.color = 'var(--orange)';
    deltaEl.textContent = `⚠️ +${Math.round(-rem)} kcal in eccesso`;
  } }

  const pct = Math.round((tots.kcal / tgt.kcal) * 100);
  const cring = document.getElementById('cring-box');
  if(cring) {
    const C = 2 * Math.PI * 20;
    const off = C - (Math.min(pct, 100) / 100) * C;
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
}

function calcTotals() {
  const dayKey   = isTrainingDay ? 'day_on' : 'day_off';
  const planMeals = activeDiet?.[dayKey]?.meals || [];
  let kcal = 0, protein = 0, carbs = 0, fats = 0;

  planMeals.forEach((meal, i) => {
    if (!logData.meals_state?.[i]?.eaten) return;
    const ov = logData.meals_overrides?.[i];
    kcal    += ov?.kcal    ?? meal.kcal    ?? 0;
    protein += ov?.protein ?? meal.protein ?? 0;
    carbs   += ov?.carbs   ?? meal.carbs   ?? 0;
    fats    += ov?.fats    ?? meal.fats    ?? 0;
  });

  (logData.extra_meals || []).forEach(m => {
    kcal    += m.kcal    || 0;
    protein += m.protein || 0;
    carbs   += m.carbs   || 0;
    fats    += m.fats    || 0;
  });

  return { kcal, protein, carbs, fats };
}

function updateNutritionTotals() {
  buildNutrition();
  const tots = calcTotals();
  const recapKcal = document.getElementById('recap-kcal');
  const recapPro = document.getElementById('recap-pro');
  const recapCarb = document.getElementById('recap-carb');
  const recapFat = document.getElementById('recap-fat');
  if (recapKcal) recapKcal.textContent = Math.round(tots.kcal);
  if (recapPro) recapPro.textContent = Math.round(tots.protein) + 'g';
  if (recapCarb) recapCarb.textContent = Math.round(tots.carbs) + 'g';
  if (recapFat) recapFat.textContent = Math.round(tots.fats) + 'g';
}

// ── SmartScore ─────────────────────────────────────────────
function buildFitScore() {
  const box = document.getElementById('fitscore-box');
  if (!box) return;
  const dayKey = isTrainingDay ? 'day_on' : 'day_off';
  const plan   = activeDiet?.[dayKey] || null;
  const tots   = calcTotals();

  // No plan: show neutral hero ring with setup prompt
  if (!plan) {
    const S = 180, R = 72, SW = 9;
    const C = 2 * Math.PI * R;
    box.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;text-align:center">
        <div style="position:relative;width:${S}px;height:${S}px">
          <svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" style="transform:rotate(-90deg)">
            <circle cx="${S/2}" cy="${S/2}" r="${R}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="${SW}"/>
          </svg>
          <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px">
            <div style="font-size:36px;font-weight:700;color:var(--t3);letter-spacing:-1px">—</div>
            <div style="font-size:8px;letter-spacing:2px;color:var(--t3);font-weight:800">SMARTSCORE</div>
          </div>
        </div>
        <div style="font-size:13px;color:var(--t2);margin-top:12px">Configura un piano dieta per attivare lo SmartScore</div>
      </div>`;
    return;
  }

  const todayKey = getDayOfWeek(TODAY);
  const result = calcSmartScore({
    meals: plan.meals || [],
    mealStates,
    workout: logData.workout,
    workoutScheduledTime: activeProgram?.schedule?.[todayKey]?.time || null,
    isTrainingDay,
    steps: logData.steps || 0,
    stepsGoal: appSettings?.steps_goal || 0,
    planProtein: plan.protein || 0,
    actualProtein: tots.protein,
  });

  if (!result) { box.innerHTML = ''; return; }

  const { score, label, icon, breakdown } = result;

  // Color + glow by score band
  let col, glowRGB;
  if      (score >= 90) { col = '#00dc78'; glowRGB = '0,220,120'; }
  else if (score >= 75) { col = '#4ade80'; glowRGB = '74,222,128'; }
  else if (score >= 55) { col = '#fbbf24'; glowRGB = '251,191,36'; }
  else if (score >= 35) { col = '#ff6a00'; glowRGB = '255,106,0'; }
  else                  { col = '#ff3b3b'; glowRGB = '255,59,59'; }

  const S = 180, R = 72, SW = 9;
  const C = 2 * Math.PI * R;
  const dash = (score / 100) * C;

  box.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;text-align:center">

      <!-- Hero ring -->
      <div style="position:relative;width:${S}px;height:${S}px">
        <svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"
          style="transform:rotate(-90deg);filter:drop-shadow(0 0 14px rgba(${glowRGB},0.38))">
          <circle cx="${S/2}" cy="${S/2}" r="${R}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="${SW}"/>
          <circle cx="${S/2}" cy="${S/2}" r="${R}" fill="none" stroke="${col}" stroke-width="${SW}"
            stroke-dasharray="${dash.toFixed(1)} ${C.toFixed(1)}" stroke-linecap="round"
            style="transition:stroke-dasharray 0.9s cubic-bezier(.4,0,.2,1)"/>
        </svg>
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px">
          <div style="font-size:52px;font-weight:700;letter-spacing:-3px;color:${col};line-height:1">${score}</div>
          <div style="font-size:8px;letter-spacing:2.5px;color:var(--t3);font-weight:800;text-transform:uppercase">SmartScore</div>
        </div>
      </div>

      <!-- Label + subtitle -->
      <div style="margin-top:10px;font-size:16px;font-weight:900;color:${col};letter-spacing:-0.3px">${icon} ${label}</div>
      <div style="font-size:11px;color:var(--t3);margin-top:4px;letter-spacing:0.2px">calcolato in tempo reale</div>

      <!-- Breakdown bars -->
      <div style="width:100%;margin-top:24px;display:flex;flex-direction:column;gap:10px">
        ${breakdown.map(b => {
          const pct = Math.round(b.score / b.max * 100);
          const barCol = b.ok ? '#00dc78' : b.score > 0 ? '#fbbf24' : 'rgba(255,255,255,0.08)';
          return `
            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
                <span style="font-size:12px;font-weight:700;color:var(--t1)">${b.label}</span>
                <span style="font-size:11px;color:var(--t3);font-variant-numeric:tabular-nums">${b.score}/${b.max} — ${b.note}</span>
              </div>
              <div style="height:4px;background:rgba(255,255,255,0.06);border-radius:99px;overflow:hidden">
                <div style="height:100%;width:${pct}%;background:${barCol};border-radius:99px;transition:width 0.7s ease;box-shadow:${b.ok ? `0 0 6px rgba(0,220,120,0.5)` : 'none'}"></div>
              </div>
            </div>`;
        }).join('')}
      </div>

      <!-- Tips collapsible -->
      <div style="width:100%;margin-top:20px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.06);text-align:left">
        <div style="font-size:12px;font-weight:800;color:var(--t2);cursor:pointer;display:flex;justify-content:space-between;align-items:center;letter-spacing:0.3px"
          onclick="const l=this.nextElementSibling;const a=this.querySelector('.tipchev');l.style.display=l.style.display==='none'?'block':'none';a.style.transform=l.style.display==='none'?'':'rotate(180deg)'">
          <span>Come si legge lo SmartScore</span>
          <span class="tipchev" style="transition:transform 0.2s;font-size:10px;color:var(--t3)">▼</span>
        </div>
        <div style="display:none;margin-top:10px;font-size:12px;color:var(--t2);line-height:1.75;text-align:left">
          <div style="display:flex;gap:8px;margin-bottom:4px"><span>🍽️</span><span><b>Pasti (40pt)</b> — pasti spuntati rispetto all'orario attuale</span></div>
          <div style="display:flex;gap:8px;margin-bottom:4px"><span>💪</span><span><b>Allenamento (35pt)</b> — sessione completata o programmata per oggi</span></div>
          <div style="display:flex;gap:8px;margin-bottom:4px"><span>👟</span><span><b>Passi (15pt)</b> — progressi verso il tuo obiettivo passi</span></div>
          <div style="display:flex;gap:8px;margin-bottom:10px"><span>🥩</span><span><b>Proteine (10pt)</b> — apporto proteico rispetto al target</span></div>
          <div style="padding:8px 12px;background:rgba(255,255,255,0.04);border-radius:8px;font-size:11px;color:var(--t3);line-height:1.6">
            Il punteggio è calibrato sull'orario attuale: valuta solo ciò che dovevi fare fino ad ora, non l'intera giornata.
          </div>
        </div>
      </div>

    </div>`;
}

// ── Macro compare helper ───────────────────────────────────
function renderMacroCompare(target, actual) {
  if (!actual || actual.kcal === 0) return '';
  const deltaKcal = actual.kcal - target.kcal;
  const deltaPro  = actual.protein - target.protein;
  const deltaCarb = actual.carbs - target.carbs;
  const deltaFat  = actual.fats - target.fats;
  function fmtD(val, isKcal) {
    const sign  = val >= 0 ? '+' : '';
    const thr   = isKcal ? 50 : 5;
    const color = Math.abs(val) <= thr ? 'var(--green)' : val > 0 ? 'var(--orange)' : 'var(--red)';
    const unit  = isKcal ? 'kcal' : 'g';
    return `<span style="color:${color};font-weight:700">${sign}${Math.round(val)}${unit}</span>`;
  }
  return `<div style="margin-top:8px;padding:8px 10px;background:rgba(255,255,255,.03);border-radius:8px;font-size:11px;color:var(--t2)">
    <span style="font-weight:700;margin-right:8px">vs piano:</span>
    Kcal ${fmtD(deltaKcal, true)} &nbsp; Pro ${fmtD(deltaPro)} &nbsp; Carb ${fmtD(deltaCarb)} &nbsp; Fat ${fmtD(deltaFat)}
  </div>`;
}

// ── Meals ──────────────────────────────────────────────────
function buildMeals() {
  const dayKey = isTrainingDay ? 'day_on' : 'day_off';
  const meals  = activeDiet?.[dayKey]?.meals || [];

  mealStates = meals.map((m, i) => {
    const ov = logData.meals_overrides?.[i] || logData.meals_overrides?.[String(i)];
    return {
      ...m,
      kcal:           ov?.kcal    ?? m.kcal,
      protein:        ov?.protein ?? m.protein,
      carbs:          ov?.carbs   ?? m.carbs,
      fats:           ov?.fats    ?? m.fats,
      eaten:          logData.meals_state?.[i]?.eaten ?? logData.meals_state?.[String(i)]?.eaten ?? logData.meals_eaten?.[i] ?? false,
      active_variant: logData.meals_state?.[i]?.variant ?? logData.meals_state?.[String(i)]?.variant ?? logData.meals_variant?.[i] ?? null,
      override_kcal:  ov?.kcal ?? null
    };
  });

  const el = document.getElementById('meals-list');
  if (!el) {
    updateNutritionTotals();
    return;
  }
  if (!meals.length) {
    el.innerHTML = '<p style="color:var(--t2);font-size:13px;text-align:center;padding:16px">Nessun piano dieta attivo</p>';
    updateNutritionTotals();
    return;
  }

  let friendBannerHtml = '';
  if (friendLogData && friendActiveDiet) {
    const fDayKey = friendLogData.is_training_day ? 'day_on' : 'day_off';
    const fMeals = friendActiveDiet[fDayKey]?.meals || [];
    
    let friendList = [];
    fMeals.forEach((fm, fi) => {
       const fsState = friendLogData.meals_state?.[fi] || friendLogData.meals_state?.[String(fi)];
       if (fsState?.eaten) {
          const ov = friendLogData.meals_overrides?.[fi] || friendLogData.meals_overrides?.[String(fi)];
          friendList.push({
             name: fm.label || fm.type,
             kcal: ov?.kcal ?? fm.kcal,
             protein: ov?.protein ?? fm.protein,
             carbs: ov?.carbs ?? fm.carbs,
             fats: ov?.fats ?? fm.fats,
             ingredients: ov?.items_text ?? fm.items ?? ''
          });
       }
    });
    
    (friendLogData.extra_meals || []).forEach(em => {
       friendList.push({
           name: em.name,
           kcal: em.kcal,
           protein: em.protein,
           carbs: em.carbs,
           fats: em.fats,
           ingredients: em.ingredients || ''
       });
    });
    
    window.currentFriendMeals = friendList;
    
    if (friendList.length > 0) {
      friendBannerHtml = `
        <div class="card" style="margin-bottom:12px;background:rgba(124,111,255,0.05);border:1px solid rgba(124,111,255,0.3)">
          <div style="font-size:12px;font-weight:800;color:var(--accent);margin-bottom:8px">🤝 Pasti mangiati da ${appSettings.friend_email.split('@')[0]}</div>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${friendList.map((fm, idx) => `
              <div style="display:flex;justify-content:space-between;align-items:center;background:var(--bg);padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.05)">
                 <div style="flex:1;margin-right:12px">
                   <div style="font-size:13px;font-weight:700;color:var(--t1)">${fm.name}</div>
                   <div style="font-size:11px;color:var(--t2)">${fm.kcal} kcal · P:${fm.protein}g C:${fm.carbs}g F:${fm.fats}g</div>
                   ${fm.ingredients ? `<div style="font-size:11px;color:var(--accent);margin-top:4px;font-style:italic">${fm.ingredients}</div>` : ''}
                 </div>
                 <button class="btn btn-ghost btn-sm" onclick="window.openAddMeal(window.currentFriendMeals[${idx}])">Copia</button>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }
  }
  
  const extraHtml = (logData.extra_meals || []).map((m, xi) => `
    <div class="meal-item eaten" style="border-left:3px solid var(--orange)">
      <div class="meal-top" onclick="window.toggleExtraMealDetail(${xi})" style="cursor:pointer">
        <div class="meal-chk" style="background:var(--orange)">✓</div>
        ${m.time ? `<span class="meal-time">${m.time}</span>` : ''}
        <div class="meal-info">
          <div class="meal-name">${m.name} <span style="font-size:10px;color:var(--orange);font-weight:700;background:rgba(255,152,0,.15);padding:1px 5px;border-radius:4px">EXTRA</span></div>
          <div class="meal-meta">${m.kcal} kcal · P:${m.protein}g C:${m.carbs}g F:${m.fats}g</div>
        </div>
        <div class="meal-kcal">${m.kcal}</div>
      </div>
      ${m.ingredients ? `
      <div class="meal-detail" id="extradtl-${xi}" style="display:none;padding:10px;border-top:1px solid rgba(255,255,255,0.05)">
        <p style="font-size:13px;color:var(--t2);line-height:1.6;margin:0">${m.ingredients}</p>
      </div>
      <div onclick="window.toggleExtraMealDetail(${xi})" style="text-align:right;font-size:11px;color:var(--t3);cursor:pointer;padding:4px 0;margin-bottom:4px">▼ dettagli</div>
      ` : ''}
    </div>`).join('');
    
  el.innerHTML = friendBannerHtml + mealStates.map((m, mi) => renderMealRow(m, mi, meals)).join('') + extraHtml;
  updateNutritionTotals();
}

window.toggleExtraMealDetail = function(xi) {
  const el = document.getElementById(`extradtl-${xi}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

function renderMealRow(m, mi, originalMeals) {
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

  const userTxt = logData.meals_overrides?.[mi]?.items_text ?? logData.meals_overrides?.[String(mi)]?.items_text ?? m.items ?? '';

  const target = originalMeals?.[mi];
  const override = logData.meals_overrides?.[mi] || logData.meals_overrides?.[String(mi)];
  let deltaBadge = '';
  let macroDeltasHtml = '';
  let macroCompareBox = '';
  
  if (override && target) {
    const diffKcal = override.kcal - target.kcal;
    const diffP = (override.protein || 0) - (target.protein || 0);
    const diffC = (override.carbs || 0) - (target.carbs || 0);
    const diffF = (override.fats || 0) - (target.fats || 0);

    if (diffKcal !== 0) {
      const color = diffKcal > 0 ? 'var(--orange)' : 'var(--green)';
      const sign = diffKcal > 0 ? '+' : '';
      deltaBadge = `<span style="font-size:10px;font-weight:800;color:${color};background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:4px;margin-left:6px">${sign}${Math.round(diffKcal)} kcal</span>`;
    }

    if (diffKcal !== 0 || diffP !== 0 || diffC !== 0 || diffF !== 0) {
      const getSign = val => val > 0 ? '+' : '';
      const getCol = val => val > 0 ? 'var(--orange)' : (val < 0 ? 'var(--green)' : 'var(--t3)');
      macroDeltasHtml = `
        <div style="font-size:10px;font-weight:700;color:var(--t2);margin-top:4px;display:flex;gap:8px;flex-wrap:wrap">
          <span style="color:var(--t3)">Δ target:</span>
          <span style="color:${getCol(diffKcal)}">Kcal: ${getSign(diffKcal)}${Math.round(diffKcal)}</span>
          <span style="color:${getCol(diffP)}">Pro: ${getSign(diffP)}${diffP.toFixed(1)}g</span>
          <span style="color:${getCol(diffC)}">Carb: ${getSign(diffC)}${diffC.toFixed(1)}g</span>
          <span style="color:${getCol(diffF)}">Fat: ${getSign(diffF)}${diffF.toFixed(1)}g</span>
        </div>
      `;
    }

    macroCompareBox = renderMacroCompare(target, override);
  }

  return `
    <div class="meal-item ${m.eaten ? 'eaten' : ''}" id="meal-${mi}">
      <div class="meal-top" onclick="toggleMeal(${mi})" style="cursor:pointer">
        <div class="meal-chk">${m.eaten ? '✓' : ''}</div>
        ${m.time ? `<span class="meal-time">${m.time}</span>` : ''}
        <div class="meal-info">
          <div class="meal-name">${m.label || m.type}</div>
          <div class="meal-meta">${kcalDisplay} kcal · P:${m.protein}g C:${m.carbs}g F:${m.fats}g</div>
          ${macroDeltasHtml}
        </div>
        <div class="meal-kcal">${kcalDisplay}</div>
      </div>
      <div class="meal-detail" id="mdtl-${mi}" style="display:none">
        <p style="font-size:13px;color:var(--t2);line-height:1.6;margin-bottom:8px">${userTxt}</p>
        ${varsHtml}
        ${selVariantDetail}
        ${macroCompareBox}
        <div style="margin-top:12px">
          <label class="fl"><i class="ri-edit-2-line"></i> Ingredienti (modifica)</label>
          <textarea id="meal-txt-${mi}" class="fi" rows="2" style="font-size:13px">${userTxt}</textarea>
          <button class="btn btn-ghost btn-sm" onclick="recalcMeal(${mi})" style="margin-top:8px">✨ Ricalcola con AI</button>
          <div id="meal-ai-${mi}" style="display:none;margin-top:8px"></div>
          <div style="margin-top:8px">
            <button class="btn btn-ghost btn-sm" onclick="openManualMacro(${mi})"><i class="ri-pencil-line"></i> Inserisci manuale</button>
          </div>
        </div>
        <div class="meal-delta" id="meal-delta-${mi}"></div>
      </div>
    </div>
    <div onclick="toggleMealDetail(${mi})" style="text-align:right;font-size:11px;color:var(--t3);cursor:pointer;padding:4px 0;margin-bottom:4px">▼ dettagli</div>`;
}

window.toggleMeal = function(mi) {
  mealStates[mi].eaten = !mealStates[mi].eaten;
  if (!logData.meals_state) logData.meals_state = {};
  logData.meals_state[mi] = { eaten: mealStates[mi].eaten, variant: mealStates[mi].active_variant };
  saveToLocal();
  buildMeals();
  updateNutritionTotals();
  buildFitScore();
};

window.toggleMealDetail = function(mi) {
  const el = document.getElementById(`mdtl-${mi}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

window.selectVariant = function(mi, vi) {
  mealStates[mi].active_variant = mealStates[mi].active_variant === vi ? null : vi;
  if (!logData.meals_state) logData.meals_state = {};
  logData.meals_state[mi] = { eaten: mealStates[mi].eaten, variant: mealStates[mi].active_variant };
  saveToLocal();
  buildMeals();
};

window.recalcMeal = async function(mi) {
  const txt = document.getElementById(`meal-txt-${mi}`)?.value.trim();
  if (!txt) return;
  const btn = document.querySelector(`#mdtl-${mi} .btn-ghost`);
  if (btn) { btn.innerHTML = `<i class="ri-loader-4-line ri-spin"></i>...`; btn.disabled = true; }
  const r = await calcMacrosFromText(txt);
  if (btn) { btn.innerHTML = `<i class="ri-magic-line"></i> Ricalcola con AI`; btn.disabled = false; }
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

function patchMealRow(mi, kcal, protein, carbs, fats) {
  if (mealStates[mi]) {
    mealStates[mi].kcal         = kcal;
    mealStates[mi].protein      = protein;
    mealStates[mi].carbs        = carbs;
    mealStates[mi].fats         = fats;
    mealStates[mi].override_kcal = kcal;
    mealStates[mi].eaten        = true;
  }
  if (!logData.meals_state) logData.meals_state = {};
  logData.meals_state[mi] = { eaten: true, variant: mealStates[mi]?.active_variant ?? null };

  const mealEl = document.getElementById(`meal-${mi}`);
  if (mealEl) {
    mealEl.classList.add('eaten');
    const chk = mealEl.querySelector('.meal-chk');
    if (chk) chk.textContent = '✓';
    const meta = mealEl.querySelector('.meal-meta');
    if (meta) meta.textContent = `${kcal} kcal · P:${protein}g C:${carbs}g F:${fats}g`;
    const kcalEl = mealEl.querySelector('.meal-kcal');
    if (kcalEl) kcalEl.textContent = kcal;
  }
}

window.applyMealAI = function(mi, kcal, protein, carbs, fats) {
  if (!logData.meals_overrides) logData.meals_overrides = {};
  const txt = document.getElementById(`meal-txt-${mi}`)?.value || '';
  logData.meals_overrides[mi] = { kcal, protein, carbs, fats, items_text: txt };
  patchMealRow(mi, kcal, protein, carbs, fats);
  saveToLocal();
  buildNutrition();
  const box = document.getElementById(`meal-ai-${mi}`);
  if (box) box.style.display = 'none';
  showToast('✅ Macro applicati! Pasto segnato ✓');
};

// ── Workout ────────────────────────────────────────────────
function buildWorkout() {
  const el = document.getElementById('workout-content');
  if (!el) return;
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
    const notesHtml = workout.notes
      ? `<div style="font-size:12px;color:var(--t2);margin-top:6px;padding-top:6px;border-top:1px solid var(--border)">📝 ${workout.notes}</div>`
      : '';
    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:15px;font-weight:700">${workout.session_name || 'Sessione'}</div>
          <div style="font-size:12px;color:var(--t2);margin-top:4px">⏱ ${dur} min · 🏋️ ${Math.round(vol)} kg volume</div>
        </div>
        <span class="badge badge-g"><i class="ri-check-line"></i> Completato</span>
      </div>
      ${notesHtml}`;
  } else {
    el.innerHTML = `
      <div style="font-size:15px;font-weight:700;margin-bottom:10px">${session?.name || 'Sessione'}</div>
      <a href="session.html" class="btn btn-o" style="text-decoration:none">🏋�// ── Stats ──────────────────────────────────────────────────
function buildStats() {
  const sf = document.getElementById('steps-in');
  if(sf) {
    sf.value = logData.steps || '';
    if (!sf.dataset.listenerSet) {
      sf.dataset.listenerSet = 'true';
      sf.addEventListener('change', () => {
        logData.steps = parseInt(sf.value) || null;
        saveToLocal();
        if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
        syncToFirebase();
        refreshStepsGoal();
      });
      sf.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sf.blur();
      });
    }
  }

  const kf = document.getElementById('burned-in');
  if(kf) {
    kf.value = logData.burned_kcal || '';
    if (!kf.dataset.listenerSet) {
      kf.dataset.listenerSet = 'true';
      kf.addEventListener('change', () => {
        logData.burned_kcal = parseInt(kf.value) || null;
        saveToLocal();
        if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
        syncToFirebase();
      });
      kf.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') kf.blur();
      });
    }
  }

  const nf = document.getElementById('note-in');
  if(nf) {
    nf.value = logData.daily_note || '';
    if (!nf.dataset.listenerSet) {
      nf.dataset.listenerSet = 'true';
      nf.addEventListener('input', () => { logData.daily_note = nf.value; });
      nf.addEventListener('blur', () => {
        logData.daily_note = nf.value;
        saveToLocal();
        if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
        syncToFirebase();
      });
    }
  }
}si (${pct}%)
    </div>`;
}

// ── Stats ──────────────────────────────────────────────────
function buildStats() {
  const sf = document.getElementById('steps-in');
  if(sf) {
    sf.value = logData.steps || '';
    sf.addEventListener('change', () => {
      logData.steps = parseInt(sf.value) || null;
      saveToLocal();
      refreshStepsGoal();
    });
  }

  const kf = document.getElementById('burned-in');
  if(kf) {
    kf.value = logData.burned_kcal || '';
    kf.addEventListener('change', () => {
      logData.burned_kcal = parseInt(kf.value) || null;
      saveToLocal();
    });
  }

  const nf = document.getElementById('note-in');
  if(nf) {
    nf.value = logData.daily_note || '';
    // input aggiorna logData in real-time senza aspettare blur (fix iOS nav)
    nf.addEventListener('input', () => { logData.daily_note = nf.value; });
    nf.addEventListener('blur', () => {
      logData.daily_note = nf.value;
      saveToLocal();
    });
  }
}

// ── AI ─────────────────────────────────────────────────────
window.calcAI = async function() {
  const text = document.getElementById('ai-input').value.trim();
  if (!text) { showToast('Scrivi gli alimenti', 'err'); return; }
  const btn = document.getElementById('ai-btn');
  btn.innerHTML = `<i class="ri-loader-4-line ri-spin"></i> Calcolo...`; btn.disabled = true;
  const r = await calcMacrosFromText(text);
  btn.innerHTML = `<i class="ri-robot-2-line"></i> Calcola Macro`; btn.disabled = false;
  if (!r.success) { showToast('Errore AI: ' + r.error, 'err'); return; }
  const box = document.getElementById('ai-result');
  box.className = 'ai-result show';
  box.innerHTML = `
    <div class="fmp">
      <div class="fmp-item"><div class="fmp-v">${r.kcal}</div><div class="fmp-l">Kcal</div></div>
      <div class="fmp-item"><div class="fmp-v">${r.protein}g</div><div class="fmp-l">Pro</div></div>
      <div class="fmp-item"><div class="fmp-v">${r.carbs}g</div><div class="fmp-l">Carbo</div></div>
      <div class="fmp-item"><div class="fmp-v">${r.fats}g</div><div class="fmp-l">Grassi</div></div>
    </div>
    ${r.items.map(i => `<div style="font-size:12px;color:var(--t2);margin-top:4px">• ${i.name} (${i.grams}g) → ${i.kcal}kcal</div>`).join('')}
    <button class="btn btn-v btn-sm" onclick="openAddMealFromAI(${r.kcal}, ${r.protein}, ${r.carbs}, ${r.fats}, '${text.replace(/'/g, "\\'")}')" style="margin-top:12px;width:100%"><i class="ri-add-circle-fill"></i> Aggiungi come Extra</button>`;
};

window.openAddMealFromAI = function(kcal, protein, carbs, fats, text) {
  openAddMeal();
  setTimeout(() => {
    document.getElementById('am-ingredients').value = text;
    document.getElementById('am-kcal').value = kcal;
    document.getElementById('am-protein').value = protein;
    document.getElementById('am-carbs').value = carbs;
    document.getElementById('am-fats').value = fats;
  }, 100);
};

// ── Cloud Sync (called by saveToLocal debouncer + manual saveDay) ───
async function syncToFirebase() {
  if (!getUserId()) return;

  const sf = document.getElementById('steps-in');
  if(sf) logData.steps = parseInt(sf.value) || null;

  const kf = document.getElementById('burned-in');
  if(kf) logData.burned_kcal = parseInt(kf.value) || null;

  const nf = document.getElementById('note-in');
  if(nf) logData.daily_note = nf.value;

  const tots = calcTotals();

  const data = {
    date:            TODAY,
    is_training_day: isTrainingDay,
    steps:           logData.steps || null,
    burned_kcal:     logData.burned_kcal || null,
    daily_note:      logData.daily_note || '',
    nutrition:       { totals: tots },
    streak:          logData.streak || 1,
    meals_state:     logData.meals_state     || {},
    meals_overrides: logData.meals_overrides || {},
    extra_meals:     logData.extra_meals     || []
  };
  
  if (logData.day_override != null) data.day_override = logData.day_override;
  if (logData.selected_session_day) data.selected_session_day = logData.selected_session_day;
  if (logData.workout) data.workout = logData.workout;

  try {
    await setDoc(doc(db, 'users', getUserId(), 'daily_logs', TODAY), data, { merge: true });
    console.log('✅ Auto-synced to Firebase');
  } catch(e) {
    console.error('Errore Auto-Sync:', e);
    showToast('⚠️ Errore salvataggio: ritenta o controlla connessione', 'err');
  }
};

window.saveDay = async function() {
  // Manual trigger if button still exists
  await syncToFirebase();
  showToast('✅ Sincronizzato con il Cloud!');
};

// ── Recupero giorni passati ────────────────────────────────
async function checkYesterdayLog() {
  const yesterday = getYesterdayString();
  const snap = await getDoc(doc(db, 'users', getUserId(), 'daily_logs', yesterday));
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
    await setDoc(doc(db, 'users', getUserId(), 'daily_logs', dateStr), data, { merge: false });
    document.getElementById('recover-modal')?.remove();
    document.querySelector('[data-yesterday-banner]')?.remove();
    showToast('✅ Giornata recuperata!');
  } catch(e) {
    showToast('Errore salvataggio', 'err');
  }
};

// ── MEAL TEMPLATES ─────────────────────────────────────────
let mealTemplates = [];

window.saveAsTemplate = async function() {
  const name = document.getElementById('am-name')?.value?.trim();
  const kcal = parseFloat(document.getElementById('am-kcal')?.value) || 0;
  const protein = parseFloat(document.getElementById('am-protein')?.value) || 0;
  const carbs = document.getElementById('am-carbs')?.value ? parseFloat(document.getElementById('am-carbs').value) : 0;
  const fats = document.getElementById('am-fats')?.value ? parseFloat(document.getElementById('am-fats').value) : 0;
  const ingredients = document.getElementById('am-ingredients')?.value?.trim() || '';

  if (!name) return showToast('Inserisci un nome per il template', 'err');
  if (kcal === 0 && protein === 0) return showToast('Inserisci almeno le calorie o le proteine', 'err');

  showToast('⭐ Salvataggio template...', 'info');
  try {
    const templateId = `template_${Date.now()}`;
    await setDoc(doc(db, 'users', getUserId(), 'meal_templates', templateId), {
      name, kcal, protein, carbs, fats, ingredients,
      created_at: new Date().toISOString()
    });
    showToast('⭐ Template salvato!');
    await loadMealTemplatesForDropdown();
  } catch(e) {
    showToast('Errore salvataggio template', 'err');
    console.error(e);
  }
};

async function loadMealTemplatesForDropdown() {
  try {
    const snap = await getDocs(collection(db, 'users', getUserId(), 'meal_templates'));
    mealTemplates = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    
    const container = document.getElementById('template-select-container');
    const select = document.getElementById('am-template-select');
    
    if (select && mealTemplates.length > 0) {
      select.innerHTML = '<option value="">-- Seleziona un template --</option>';
      mealTemplates.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `${t.name} (${t.kcal} kcal - P:${t.protein}g C:${t.carbs}g F:${t.fats}g)`;
        select.appendChild(opt);
      });
      if (container) container.style.display = 'block';
    }
  } catch(e) {
    console.warn('Error loading meal templates:', e);
  }
}

window.loadMealTemplate = function(templateId) {
  if (!templateId) return;
  const t = mealTemplates.find(x => x.id === templateId);
  if (!t) return;
  
  if (document.getElementById('am-name')) document.getElementById('am-name').value = t.name || '';
  if (document.getElementById('am-ingredients')) document.getElementById('am-ingredients').value = t.ingredients || '';
  if (document.getElementById('am-kcal')) document.getElementById('am-kcal').value = t.kcal || '';
  if (document.getElementById('am-protein')) document.getElementById('am-protein').value = t.protein || '';
  if (document.getElementById('am-carbs')) document.getElementById('am-carbs').value = t.carbs || '';
  if (document.getElementById('am-fats')) document.getElementById('am-fats').value = t.fats || '';
  
  showToast('⭐ Template caricato!');
};

// ── Aggiungi pasto extra ───────────────────────────────────
window.openAddMeal = function(prefillData) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.id = 'add-meal-modal';
  bg.innerHTML = `
    <div class="modal" style="max-height:85vh;overflow-y:auto">
      <div class="modal-handle"></div>
      <h3>${prefillData ? 'Copia Pasto Amico' : '+ Aggiungi Pasto'}</h3>
 
      <div class="fg" id="template-select-container" style="display:none;margin-bottom:16px">
        <label class="fl">⭐ Carica da Template</label>
        <select class="fi" id="am-template-select" onchange="window.loadMealTemplate(this.value)">
          <option value="">-- Seleziona un template --</option>
        </select>
      </div>

      <div class="fg">
        <label class="fl">Nome pasto</label>
        <input type="text" class="fi" id="am-name" placeholder="Es. Snack, Extra proteine..." value="${prefillData?.name || ''}">
      </div>
 
      <div class="fg">
        <label class="fl">Ingredienti</label>
        <textarea class="fi" id="am-ingredients" rows="3"
          placeholder="Es: 150g pollo, 100g riso, 10g olio&#10;Oppure inserisci macro manualmente sotto">${prefillData?.ingredients || ''}</textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-ghost btn-sm" onclick="calcAIMeal()" style="flex:1">
            ✨ Calcola con AI
          </button>
          <button class="btn btn-ghost btn-sm" onclick="window.startFoodCamera()" style="flex:1">
            📸 Scansiona Cibo
          </button>
        </div>
      </div>
 
      <!-- Video camera preview area -->
      <div id="am-camera-container" style="display:none;margin-bottom:16px;flex-direction:column;gap:8px;align-items:center">
        <video id="am-video" autoplay playsinline style="width:100%;max-width:320px;border-radius:12px;background:#000"></video>
        <div style="display:flex;gap:8px;width:100%;max-width:320px">
          <button class="btn btn-flat btn-sm" onclick="window.stopFoodCamera()" style="flex:1">Annulla</button>
          <button class="btn btn-v btn-sm" onclick="window.captureFoodImage()" style="flex:1">📸 Scatta e Analizza</button>
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
 
      <div class="modal-btns" style="display:flex;flex-wrap:wrap;gap:8px">
        <button class="btn btn-flat btn-sm" onclick="document.getElementById('add-meal-modal').remove()">
          Annulla
        </button>
        <button class="btn btn-ghost btn-sm" onclick="window.saveAsTemplate()">
          ⭐ Salva come Template
        </button>
        <button class="btn btn-g btn-sm" onclick="saveExtraMeal()">
          💾 Salva
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(bg);
  bg.onclick = e => { if (e.target === bg) bg.remove(); };
  loadMealTemplatesForDropdown();
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
  const ingredients = document.getElementById('am-ingredients')?.value?.trim() || '';
 
  if (!name)                       return showToast('Inserisci il nome del pasto', 'err');
  if (kcal === 0 && protein === 0) return showToast('Inserisci almeno le kcal', 'err');
 
  if (!logData.extra_meals) logData.extra_meals = [];
  logData.extra_meals.push({
    name, type, kcal, protein, carbs, fats, ingredients,
    time:     new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
    added_at: new Date().toISOString()
  });
 
  updateNutritionTotals();
  saveToLocal();
  document.getElementById('add-meal-modal')?.remove();
  showToast('✅ Pasto aggiunto!');
  buildMeals();
};

window.openManualMacro = function(mealIndex) {
  const plan = isTrainingDay ? activeDiet?.day_on?.meals : activeDiet?.day_off?.meals;
  const meal = plan?.[mealIndex];
  const existing = logData.meals_overrides?.[mealIndex] || {};

  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.id = 'manual-macro-modal';
  bg.innerHTML = `
    <div class="modal">
      <div class="modal-handle"></div>
      <h3>✏️ ${meal?.label || 'Pasto'}</h3>
      <p style="font-size:13px;color:var(--t2);margin-bottom:16px">Inserisci i valori reali di questo pasto</p>
      <div class="grid2">
        <div class="fg"><label class="fl">Kcal</label>
          <input type="number" class="fi" id="mm-kcal" value="${existing.kcal || meal?.kcal || ''}" placeholder="${meal?.kcal || 0}"></div>
        <div class="fg"><label class="fl">Proteine (g)</label>
          <input type="number" class="fi" id="mm-pro" value="${existing.protein || meal?.protein || ''}" placeholder="${meal?.protein || 0}" step="0.1"></div>
        <div class="fg"><label class="fl">Carboidrati (g)</label>
          <input type="number" class="fi" id="mm-carb" value="${existing.carbs || meal?.carbs || ''}" placeholder="${meal?.carbs || 0}" step="0.1"></div>
        <div class="fg"><label class="fl">Grassi (g)</label>
          <input type="number" class="fi" id="mm-fat" value="${existing.fats || meal?.fats || ''}" placeholder="${meal?.fats || 0}" step="0.1"></div>
      </div>
      <div class="fg">
        <label class="fl">Note ingredienti (opzionale)</label>
        <textarea class="fi" id="mm-note" rows="2" placeholder="Es: 120g pollo invece di 150g...">${existing.items_text || meal?.items || ''}</textarea>
      </div>
      <div class="modal-btns" style="margin-top:16px">
        <button class="btn btn-flat" onclick="document.getElementById('manual-macro-modal').remove()">Annulla</button>
        <button class="btn btn-g" onclick="saveManualMacro(${mealIndex})">✅ Salva</button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  bg.onclick = e => { if (e.target === bg) bg.remove(); };
};

window.saveManualMacro = function(mealIndex) {
  const kcal    = parseFloat(document.getElementById('mm-kcal')?.value)  || 0;
  const protein = parseFloat(document.getElementById('mm-pro')?.value)   || 0;
  const carbs   = parseFloat(document.getElementById('mm-carb')?.value)  || 0;
  const fats    = parseFloat(document.getElementById('mm-fat')?.value)   || 0;
  const note    = document.getElementById('mm-note')?.value || '';

  if (!logData.meals_overrides) logData.meals_overrides = {};
  logData.meals_overrides[mealIndex] = { kcal, protein, carbs, fats, items_text: note };

  patchMealRow(mealIndex, kcal, protein, carbs, fats);
  saveToLocal();
  buildNutrition();
  document.getElementById('manual-macro-modal')?.remove();
  showToast('✅ Macro salvati! Pasto segnato ✓');
};


let cameraStream = null;

window.startFoodCamera = async function() {
  const container = document.getElementById('am-camera-container');
  const video = document.getElementById('am-video');
  if (!container || !video) return;

  showToast('🎥 Avvio fotocamera...', 'info');

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false
    });
    video.srcObject = cameraStream;
    video.style.transform = 'none';
    container.style.display = 'flex';
  } catch(e) {
    showToast('Impossibile accedere alla fotocamera', 'err');
    console.error(e);
  }
};

window.stopFoodCamera = function() {
  const container = document.getElementById('am-camera-container');
  if (container) container.style.display = 'none';

  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
};

window.captureFoodImage = async function() {
  const video = document.getElementById('am-video');
  const canvas = document.getElementById('am-canvas');
  if (!video || !canvas || !cameraStream) return;

  const ctx = canvas.getContext('2d');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  window.stopFoodCamera();

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

window.openAddMealWithCamera = function() {
  window.openAddMeal();
  setTimeout(() => {
    window.startFoodCamera();
  }, 250);
};

(async function() {
  await requireAuth();
  init();
})();
