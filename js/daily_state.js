import { requireAuth, loadSmart } from './app.js';
import {
  db, getUserId, doc, getDoc, setDoc, getDocs, collection, query, orderBy, limit
} from './firebase-config.js';
import {
  getTodayString, getYesterdayString, getDayOfWeek, formatDateIT, formatDateShort, addDays, showToast, showModal, setW, setT, DAYS_IT, DAY_ORDER, cleanOldLogs, calcFitScore, calcSmartScore, calcRecoveryPlan
} from './app.js';
import { calcMacrosFromText, analyzeFoodImageAI, generateSmartAdviceAI, generateRecoveryAdviceAI } from './gemini.js';

const TODAY = getTodayString();

const safeLocalStorage = {
  getItem(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      console.warn('safeLocalStorage.setItem error:', e);
    }
  },
  removeItem(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.warn('safeLocalStorage.removeItem error:', e);
    }
  },
  keys() {
    try {
      return Object.keys(localStorage);
    } catch (e) {
      return [];
    }
  }
};

let logData = {};
let activeDiet = null;
let activeProgram = null;
let appSettings = null;
let latestCheck = null;
let isTrainingDay = false;
let mealStates = [];
let friendLogData = null;
let friendActiveDiet = null;
let loadedFriendEmail = null;
window.isServerLoaded = false;
window.isMockData = false;

let cloudSyncTimer = null;
function saveToLocal() {
  if (!window.isServerLoaded) return;
  try {
    const key = 'fittracker_today_' + getTodayString();
    if (document.getElementById('meals-list')) {
      const meals_state = {};
      mealStates.forEach((m, i) => {
        meals_state[i] = { eaten: m.eaten, variant: m.active_variant };
      });
      logData.meals_state = meals_state;
    }
    logData.last_updated = Date.now();
    const payload = {
      meals_state:     logData.meals_state || {},
      meals_overrides: logData.meals_overrides || {},
      extra_meals:     logData.extra_meals     || [],
      steps:           logData.steps           || null,
      burned_kcal:     logData.burned_kcal     || null,
      daily_note:      logData.daily_note      || '',
      is_training_day: isTrainingDay,
      day_override:    logData.day_override,
      smart_advice:    logData.smart_advice    || {},
      last_updated:    logData.last_updated
    };
    safeLocalStorage.setItem(key, JSON.stringify(payload));
    safeLocalStorage.keys()
      .filter(k => k.startsWith('fittracker_today_') && k !== key)
      .forEach(k => safeLocalStorage.removeItem(k));

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
  const yesterdayLS = safeLocalStorage.getItem('fittracker_today_' + yesterday);
  if (!yesterdayLS) return;
  const userId = getUserId();
  if (!userId) return;
  try {
    const data = JSON.parse(yesterdayLS);
    const snap = await getDoc(doc(db, 'users', userId, 'daily_logs', yesterday));
    if (!snap.exists()) {
      await setDoc(doc(db, 'users', userId, 'daily_logs', yesterday), {
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
      await setDoc(doc(db, 'users', userId, 'daily_logs', yesterday), { daily_note: data.daily_note }, { merge: true });
    }
    safeLocalStorage.removeItem('fittracker_today_' + yesterday);
  } catch(e) {
    console.warn('Errore auto-save yesterday:', e);
  }
}

// ── Init ───────────────────────────────────────────────────
async function init() {
  const dlabel = document.getElementById('date-label');
  if (dlabel) dlabel.textContent = formatDateIT(TODAY);
  
  const dietDlabel = document.getElementById('diet-date-label');
  if (dietDlabel) dietDlabel.textContent = `(${formatDateShort(TODAY)})`;

  // Controllo rollover periodico della data (ogni 30 secondi) per evitare viste congelate
  setInterval(() => {
    if (getTodayString() !== TODAY) {
      console.log('Day changed! Reloading page safely...');
      window.location.replace(window.location.href);
    }
  }, 30000);

  const userId = getUserId();
  if (!userId) {
    console.warn('User ID is not defined yet.');
    return;
  }

  await checkDayRollover();
  await loadWeeklyLogsForScore();

  try {
    const refs = [
      doc(db, 'users', userId, 'daily_logs', TODAY),
      collection(db, 'users', userId, 'programs'),
      collection(db, 'users', userId, 'diet_plans'),
      doc(db, 'users', userId, 'settings', 'app'),
      query(collection(db, 'users', userId, 'checks'), orderBy('date', 'desc'), limit(1))
    ];

    window.isServerLoaded = false;
    window.isMockData = false;

    await loadSmart(refs, (snaps) => {
      const [logSnap, progSnap, dietSnap, settSnap, checksSnap] = snaps;
      logData = logSnap.exists() ? logSnap.data() : {};
      activeProgram = progSnap.docs.find(d => d.data().active)?.data() || null;
      
      const activeDiets = dietSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => d.active);
      activeDiets.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
      activeDiet = activeDiets[0] || null;
      appSettings   = settSnap.exists() ? settSnap.data() : {};
      latestCheck   = !checksSnap.empty ? checksSnap.docs[0].data() : null;

      // Merge localStorage (higher priority for today's working state if local is newer)
      const lsKey = 'fittracker_today_' + getTodayString();
      const cached = safeLocalStorage.getItem(lsKey);
      let local = null;
      if (cached) {
        try {
          local = JSON.parse(cached);
          const localTime = local.last_updated || 0;
          const firestoreTime = logData.last_updated || 0;

          if (localTime > firestoreTime) {
            logData.meals_overrides = local.meals_overrides || {};
            logData.meals_state     = local.meals_state     || {};
            logData.extra_meals     = local.extra_meals     || [];
            if (local.steps != null)        logData.steps        = local.steps;
            if (local.burned_kcal != null)  logData.burned_kcal  = local.burned_kcal;
            if (local.daily_note != null)   logData.daily_note   = local.daily_note;
            if (local.day_override != null) logData.day_override = local.day_override;
            if (local.is_training_day != null) logData.is_training_day = local.is_training_day;
            if (local.smart_advice)         logData.smart_advice = local.smart_advice;
            logData.last_updated = localTime;
          } else {
            // Local is outdated — update local storage to match fresh Firestore data
            const payload = {
              meals_state:     logData.meals_state     || {},
              meals_overrides: logData.meals_overrides || {},
              extra_meals:     logData.extra_meals     || [],
              steps:           logData.steps           || null,
              burned_kcal:     logData.burned_kcal     || null,
              daily_note:      logData.daily_note      || '',
              is_training_day: logData.is_training_day ?? logData.day_override ?? (activeProgram?.schedule?.[getDayOfWeek(TODAY)] ? true : false),
              day_override:    logData.day_override,
              smart_advice:    logData.smart_advice    || {},
              last_updated:    firestoreTime
            };
            safeLocalStorage.setItem(lsKey, JSON.stringify(payload));
          }
        } catch(e) {}
      }

      renderDailyStateUI(local);
      window.isServerLoaded = true;

      // Async load friend data (non-blocking — don't block main render)
      if (appSettings?.friend_email) {
        const cleanFriendEmail = appSettings.friend_email.trim().toLowerCase();
        if (cleanFriendEmail !== loadedFriendEmail) {
          loadedFriendEmail = cleanFriendEmail;
          const fLogRef = doc(db, 'users', cleanFriendEmail, 'daily_logs', TODAY);
          const fDietRef = collection(db, 'users', cleanFriendEmail, 'diet_plans');
          loadSmart([fLogRef, fDietRef], (fSnaps) => {
            const [fSnap, fDietSnap] = fSnaps;
            friendLogData = fSnap.exists() ? fSnap.data() : null;
            const fDiets = fDietSnap.docs
              .map(d => ({ id: d.id, ...d.data() }))
              .filter(d => d.active);
            fDiets.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
            friendActiveDiet = fDiets[0] || null;
            buildNutrition();
            buildMeals();
          }).catch((err) => {
            console.warn('Friend data fetch failed (non-critical):', err.message);
          });
        }
      }
    });

    // loadSmart resolved — mark loaded and build advisor
    window.isServerLoaded = true;
    buildSmartAdvisor();

  } catch (e) {
    window.isServerLoaded = true;
    console.error('CRITICAL: Firestore data load failed:', e.code, e.message);
    showToast('Errore caricamento dati. Controlla la connessione.', 'err');
    // Still render with empty data so app is usable
    logData = {};
    activeProgram = null;
    activeDiet = null;
    appSettings = {};
    latestCheck = null;
    renderDailyStateUI(null);
    buildSmartAdvisor();
  }


  if (new Date().getDate() === 1) {
    cleanOldLogs(db, getUserId());
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // Pagina va in background/navigazione: forza sync immediato
      const nf = document.getElementById('note-in');
      if (nf) logData.daily_note = nf.value;
      saveToLocal();
      syncToFirebase();
      return;
    }
    if (getTodayString() !== TODAY) { window.location.replace(window.location.href); return; }
    const cached = safeLocalStorage.getItem('fittracker_today_' + TODAY);
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

function renderDailyStateUI(local) {
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
      // Forziamo isServerLoaded=true perché siamo dentro renderDailyStateUI
      // che viene chiamata DOPO il caricamento dati da Firestore
      window.isServerLoaded = true;
      // Aggiorna last_updated ora per garantire che i dati da shortcut
      // vincano sul merge con Firestore al prossimo avvio
      logData.last_updated = Date.now();
      saveToLocal();
      syncToFirebase();
      showToast('🍎 Dati Apple Health sincronizzati con successo! 👟');
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    }
  }

  const name = appSettings?.profile?.name || appSettings?.name || '';
  const welcomeEl = document.getElementById('welcome-name');
  if (welcomeEl) {
    welcomeEl.textContent = name ? `Benvenuto, ${name} — recupera le energie.` : 'Benvenuto — recupera le energie.';
  }
  
  const dateLabelEl = document.getElementById('date-label');
  if (dateLabelEl) {
    dateLabelEl.textContent = formatDateIT(TODAY).toUpperCase();
  }
  
  const avatarEl = document.getElementById('home-avatar');
  if (avatarEl) {
    avatarEl.textContent = name ? name.charAt(0).toUpperCase() : 'K';
  }

  const dow = getDayOfWeek(TODAY);
  const progDay = activeProgram?.schedule?.[dow];
  if (logData.is_training_day != null) {
    isTrainingDay = logData.is_training_day;
  } else if (logData.day_override != null) {
    isTrainingDay = logData.day_override;
  } else if (local?.is_training_day != null) {
    isTrainingDay = local.is_training_day;
  } else {
    isTrainingDay = !!progDay;
  }
  
  const activeWorkoutEl = document.getElementById('active-workout-info');
  if (activeWorkoutEl) {
    if (isTrainingDay && progDay) {
      activeWorkoutEl.textContent = progDay.name || 'Giorno ON';
    } else {
      activeWorkoutEl.textContent = 'Giorno di riposo';
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
  buildStepsCard();
  buildFitScore();
  buildSmartAdvisor();

  checkYesterdayLog();
}

// ── Streak box: show weekly workout count ──────────────────────
async function buildStreak() {
  const box = document.getElementById('streak-box');
  if (!box) return;
  
  const q = query(
    collection(db, 'users', getUserId(), 'daily_logs'),
    orderBy('date', 'desc'),
    limit(14)
  );

  const render = (snap) => {
    const logs = snap.docs.map(d => d.data());
    const weekAgo = new Date(TODAY + 'T12:00:00');
    weekAgo.setDate(weekAgo.getDate() - 6);
    const weekAgoStr = weekAgo.toISOString().split('T')[0];
    const weeklyDone = logs.filter(l => l.date >= weekAgoStr && l.workout?.completed).length;
    const totalDone  = logs.filter(l => l.workout?.completed).length;
    if (weeklyDone > 0) {
      box.innerHTML = `<div class="streak"><span class="num">${weeklyDone}</span> <span style="font-size:9px;color:var(--t3);text-transform:lowercase;font-weight:600;">/ sett.</span></div>`;
    } else if (totalDone > 0) {
      box.innerHTML = `<div class="streak"><span class="num">0</span> <span style="font-size:9px;color:var(--t3);text-transform:lowercase;font-weight:600;">/ sett.</span></div>`;
    } else {
      box.innerHTML = '';
    }
  };

  try {
    const snap = await getDocs(q);
    render(snap);
  } catch (e) {
    console.warn('buildStreak error:', e.message);
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
  const desc = document.getElementById('dtype-desc');
  const icon = document.getElementById('dtype-icon');
  const tgl = document.getElementById('override-tgl');
  if(!lbl || !sub || !tgl) return;

  if (isTrainingDay) {
    if (lbl) lbl.textContent = 'OGGI';
    if (sub) sub.textContent = 'Giorno ON — allenamento';
    if (desc) desc.textContent = session?.name || 'Sessione programmata';
    if (icon) {
      icon.className = 'ri-boxing-fill';
      icon.style.color = 'var(--accent)';
    }
    tgl.checked = true;
  } else {
    if (lbl) lbl.textContent = 'OGGI';
    if (sub) sub.textContent = 'Giorno off — riposo';
    if (desc) desc.textContent = 'Nessuna sessione programmata';
    if (icon) {
      icon.className = 'ri-moon-fill';
      icon.style.color = 'var(--t3)';
    }
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
    if (m.eaten === false) return;
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

// ── SmartScore ──────────────────────function buildFitScore() {
  const box = document.getElementById('fitscore-box');
  if (!box) return;
  const dayKey = isTrainingDay ? 'day_on' : 'day_off';
  const plan   = activeDiet?.[dayKey] || null;
  const tots   = calcTotals();

  // No plan: show neutral card
  if (!plan) {
    box.innerHTML = `
      <div style="text-align:center; padding:10px 0; color:var(--t3);">
        <div style="font-size:32px; margin-bottom:8px;">📊</div>
        <div style="font-size:12px; font-weight:700; color:var(--t2);">Nessun piano dieta attivo</div>
        <div style="font-size:11px; margin-top:4px;">Configura la dieta per visualizzare lo SmartScore</div>
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
    weeklyLogs: _weeklyLogsCache || [],
    weeklyScore: _weeklyScoreCache,
  });

  if (!result) { box.innerHTML = ''; return; }

  const { score, label, icon, breakdown } = result;

  // Color + glow by score band
  let col;
  if      (score >= 90) col = '#00dc78';
  else if (score >= 75) col = '#4ade80';
  else if (score >= 55) col = '#fbbf24';
  else if (score >= 35) col = '#ff6a00';
  else                  col = '#ff3b3b';

  // Set the badge in index.html if it exists
  const badgeEl = document.getElementById('smartscore-badge');
  if (badgeEl) {
    badgeEl.textContent = `${icon} ${label}`;
    badgeEl.style.borderColor = col;
    badgeEl.style.color = col;
  }

  // Draw the split card (Left ring chart, Right metrics list)
  const totalMeals = plan.meals?.length || 0;
  const eatenMealsCount = mealStates.filter(m => m.eaten).length;
  const targetKcal = plan.kcal || 0;
  const actualKcal = Math.round(tots.kcal);
  
  const workoutBreakdown = breakdown.find(b => b.label.toLowerCase().includes('allen'));
  const scheduleDay = activeProgram?.schedule?.[todayKey];
  const sessionName = isTrainingDay 
    ? (typeof scheduleDay === 'string' ? scheduleDay : (scheduleDay?.name || 'Workout')) 
    : 'riposo';
  const workoutScore = workoutBreakdown?.score || 0;
  const workoutMax = workoutBreakdown?.max || 30;
  const workoutPct = Math.round((workoutScore / workoutMax) * 100);
  
  const stepsGoal = appSettings?.steps_goal || 0;
  const actualSteps = logData.steps || 0;
  
  const targetProtein = plan.protein || 0;
  const actualProtein = Math.round(tots.protein);

  const S = 110, R = 44, SW = 7;
  const C = 2 * Math.PI * R;
  const dash = (score / 100) * C;

  box.innerHTML = `
    <div style="display:flex; gap:20px; align-items:center; width:100%; margin-top:8px;">
      
      <!-- Left Column: Circular chart -->
      <div style="position:relative; width:${S}px; height:${S}px; flex-shrink:0;">
        <svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" style="transform:rotate(-90deg); filter:drop-shadow(0 0 10px ${col}25);">
          <circle cx="${S/2}" cy="${S/2}" r="${R}" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="${SW}"/>
          <circle cx="${S/2}" cy="${S/2}" r="${R}" fill="none" stroke="${col}" stroke-width="${SW}"
            stroke-dasharray="${dash} ${C}" stroke-linecap="round"
            style="transition:stroke-dasharray 0.8s cubic-bezier(.4,0,.2,1)"/>
        </svg>
        <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;">
          <div style="font-size:30px; font-weight:800; color:#fff; line-height:1;">${score}</div>
          <div style="font-size:10px; color:var(--t3); font-weight:700;">/ 100</div>
        </div>
      </div>
      
      <!-- Right Column: Metrics list -->
      <div style="flex:1; display:flex; flex-direction:column; gap:10px;">
        
        <!-- Pasti -->
        <div style="display:flex; justify-content:space-between; align-items:baseline;">
          <span style="font-size:13px; font-weight:700; color:#fff;">Pasti</span>
          <span style="font-size:12px; color:var(--t2); font-weight:500;">
            ${eatenMealsCount}/${totalMeals} <span style="color:var(--t3); margin:0 4px;">·</span> ${actualKcal}/${targetKcal} kcal
          </span>
        </div>
        
        <!-- Allenamento -->
        <div>
          <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px;">
            <span style="font-size:13px; font-weight:700; color:#fff;">Allenamento</span>
            <span style="font-size:12px; color:var(--t2); font-weight:500;">
              ${sessionName} <span style="color:var(--t3); margin:0 4px;">·</span> ${workoutScore}/${workoutMax}
            </span>
          </div>
          <div style="height:3px; background:rgba(255,255,255,0.04); border-radius:99px; overflow:hidden;">
            <div style="height:100%; width:${workoutPct}%; background:${workoutScore > 0 ? 'var(--green)' : 'rgba(255,255,255,0.08)'}; border-radius:99px; transition:width 0.5s ease;"></div>
          </div>
        </div>
        
        <!-- Passi -->
        <div style="display:flex; justify-content:space-between; align-items:baseline; border-top:1px solid rgba(255,255,255,0.03); padding-top:6px;">
          <span style="font-size:13px; font-weight:700; color:#fff;">Passi</span>
          <span style="font-size:12px; color:var(--t2); font-weight:500;">
            ${actualSteps.toLocaleString('it-IT')} <span style="color:var(--t3); margin:0 4px;">·</span> ${stepsGoal.toLocaleString('it-IT')}
          </span>
        </div>
        
        <!-- Proteine -->
        <div style="display:flex; justify-content:space-between; align-items:baseline; border-top:1px solid rgba(255,255,255,0.03); padding-top:6px;">
          <span style="font-size:13px; font-weight:700; color:#fff;">Proteine</span>
          <span style="font-size:12px; color:var(--t2); font-weight:500;">
            ${actualProtein} g <span style="color:var(--t3); margin:0 4px;">·</span> ${targetProtein} g
          </span>
        </div>

      </div>
    </div>
  `;
}span><span><b>Proteine (15pt)</b> — apporto proteico rispetto al target proporzionale</span></div>
          <div style="display:flex;gap:8px;margin-bottom:4px"><span>&#128200;</span><span><b>Trend 7gg (10pt)</b> — costanza settimanale: quanti giorni hai loggato e allenato</span></div>
          <div style="display:flex;gap:8px;margin-bottom:10px"><span>&#128087;</span><span><b>Passi (10pt)</b> — solo se hai impostato un obiettivo passi</span></div>
          <div style="padding:8px 12px;background:rgba(255,255,255,0.04);border-radius:8px;font-size:11px;color:var(--t3);line-height:1.6">
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
  if (friendLogData || friendActiveDiet) {
    const fIsTraining = friendLogData ? (friendLogData.is_training_day ?? false) : isTrainingDay;
    const fDayKey = fIsTraining ? 'day_on' : 'day_off';
    const fMeals = friendActiveDiet ? (friendActiveDiet[fDayKey]?.meals || []) : [];
    
    let friendList = [];
    fMeals.forEach((fm, fi) => {
       const fsState = friendLogData ? (friendLogData.meals_state?.[fi] || friendLogData.meals_state?.[String(fi)]) : null;
       // Se abbiamo il log del giorno dell'amico, mostra solo i pasti che ha flaggato come mangiati.
       // Se non abbiamo il log (solo piano dieta), mostra tutti i pasti pianificati.
       const isEaten = friendLogData ? (fsState?.eaten === true) : true;
       
       if (isEaten) {
          const ov = friendLogData ? (friendLogData.meals_overrides?.[fi] || friendLogData.meals_overrides?.[String(fi)]) : null;
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
    
    if (friendLogData) {
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
    }
    
    window.currentFriendMeals = friendList;
    
    if (friendList.length > 0) {
      const bannerTitle = friendLogData 
        ? `🤝 Pasti di ${appSettings?.friend_email ? appSettings.friend_email.split('@')[0] : 'amico'} (Oggi)` 
        : `🤝 Pasti di ${appSettings?.friend_email ? appSettings.friend_email.split('@')[0] : 'amico'} (Pianificati)`;
      friendBannerHtml = `
        <div class="card" style="margin-bottom:12px;background:rgba(124,111,255,0.05);border:1px solid rgba(124,111,255,0.3)">
          <div style="font-size:12px;font-weight:800;color:var(--accent);margin-bottom:8px">${bannerTitle}</div>
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
  
  const extraHtml = (logData.extra_meals || []).map((m, xi) => {
    const isEaten = m.eaten !== false;
    return `
    <div class="meal-item ${isEaten ? 'eaten' : ''}" style="border-left:3px solid var(--orange)">
      <div class="meal-top">
        <div class="meal-chk" style="background:${isEaten ? 'var(--orange)' : 'transparent'}; border:1px solid var(--orange); cursor:pointer" onclick="window.toggleExtraMeal(${xi})">
          ${isEaten ? '✓' : ''}
        </div>
        <div class="meal-info" onclick="window.toggleExtraMealDetail(${xi})" style="cursor:pointer; flex:1">
          <div class="meal-name">${m.name} <span style="font-size:10px;color:var(--orange);font-weight:700;background:rgba(255,152,0,.15);padding:1px 5px;border-radius:4px">EXTRA</span></div>
          <div class="meal-meta">${m.kcal} kcal · P:${m.protein}g C:${m.carbs}g F:${m.fats}g</div>
        </div>
        <div class="meal-kcal" onclick="window.toggleExtraMealDetail(${xi})" style="cursor:pointer">${m.kcal}</div>
      </div>
      <div class="meal-detail" id="extradtl-${xi}" style="display:none;padding:12px;border-top:1px solid rgba(255,255,255,0.05)">
        ${m.ingredients ? `<p style="font-size:13px;color:var(--t2);line-height:1.6;margin-bottom:8px">${m.ingredients}</p>` : '<p style="font-size:12px;color:var(--t3);margin-bottom:8px;font-style:italic">Nessun ingrediente inserito</p>'}
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-ghost btn-sm" onclick="window.openEditExtraMeal(${xi})" style="flex:1"><i class="ri-edit-2-line"></i> Modifica</button>
          <button class="btn btn-del" onclick="window.deleteExtraMeal(${xi})" style="padding: 7px 12px;"><i class="ri-delete-bin-line"></i> Elimina</button>
        </div>
      </div>
      <div onclick="window.toggleExtraMealDetail(${xi})" style="text-align:right;font-size:11px;color:var(--t3);cursor:pointer;padding:4px 0;margin-bottom:4px">▼ dettagli</div>
    </div>`;
  }).join('');
    
  el.innerHTML = friendBannerHtml + mealStates.map((m, mi) => renderMealRow(m, mi, meals)).join('') + extraHtml;
  updateNutritionTotals();
}

window.toggleExtraMealDetail = function(xi) {
  const el = document.getElementById(`extradtl-${xi}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

window.toggleExtraMeal = function(xi) {
  if (logData.extra_meals && logData.extra_meals[xi]) {
    logData.extra_meals[xi].eaten = logData.extra_meals[xi].eaten === false ? true : false;
    saveToLocal();
    buildMeals();
    updateNutritionTotals();
    buildFitScore();
  }
};

window.deleteExtraMeal = function(xi) {
  if (confirm('Sei sicuro di voler eliminare questo pasto extra?')) {
    logData.extra_meals.splice(xi, 1);
    saveToLocal();
    buildMeals();
    updateNutritionTotals();
    buildFitScore();
    document.getElementById('add-meal-modal')?.remove();
  }
};

window.openEditExtraMeal = function(xi) {
  const m = logData.extra_meals[xi];
  if (!m) return;
  window.openAddMeal(m, xi);
};

function renderMealRow(m, mi, originalMeals) {
  const target = originalMeals?.[mi];
  const override = logData.meals_overrides?.[mi] || logData.meals_overrides?.[String(mi)];
  const isEaten = !!m.eaten;
  const useOverride = isEaten && !!override;

  const kcalDisplay = useOverride ? (override.kcal ?? target?.kcal ?? m.kcal) : (target?.kcal ?? m.kcal);
  const proteinDisplay = useOverride ? (override.protein ?? target?.protein ?? m.protein) : (target?.protein ?? m.protein);
  const carbsDisplay = useOverride ? (override.carbs ?? target?.carbs ?? m.carbs) : (target?.carbs ?? m.carbs);
  const fatsDisplay = useOverride ? (override.fats ?? target?.fats ?? m.fats) : (target?.fats ?? m.fats);

  const varsHtml = m.variants?.length ? `
    <div class="vars">
      ${m.variants.map((v, vi) => {
        const lbl = typeof v === 'object' ? v.label : v;
        const det = typeof v === 'object' ? v.detail : v;
        return `<div class="var-chip ${m.active_variant === vi ? 'sel' : ''}"
          onclick="window.selectVariant(${mi},${vi})">${lbl}</div>`;
      }).join('')}
    </div>` : '';
  const selVariantDetail = m.active_variant != null && m.variants?.[m.active_variant]
    ? `<div style="font-size:12px;color:var(--accent2);margin-top:6px;padding:6px 8px;background:rgba(124,111,255,.08);border-radius:6px">
        ${typeof m.variants[m.active_variant] === 'object' ? m.variants[m.active_variant].detail : m.variants[m.active_variant]}
       </div>` : '';

  const userTxt = logData.meals_overrides?.[mi]?.items_text ?? logData.meals_overrides?.[String(mi)]?.items_text ?? m.items ?? '';

  let deltaBadge = '';
  let macroDeltasHtml = '';
  let macroCompareBox = '';
  
  if (useOverride && target) {
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
      <div class="meal-top" onclick="window.toggleMeal(${mi})" style="cursor:pointer">
        <div class="meal-chk">${m.eaten ? '✓' : ''}</div>
        ${m.time ? `<span class="meal-time">${m.time}</span>` : ''}
        <div class="meal-info">
          <div class="meal-name">${m.label || m.type}</div>
          <div class="meal-meta">${kcalDisplay} kcal · P:${proteinDisplay}g C:${carbsDisplay}g F:${fatsDisplay}g</div>
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
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn btn-ghost btn-sm" onclick="window.recalcMeal(${mi})" style="flex:1">✨ Ricalcola con AI</button>
            <button class="btn btn-ghost btn-sm" onclick="window.startMealCamera(${mi})" style="flex:1">📸 Scansiona Cibo</button>
          </div>
          
          <div id="meal-camera-container-${mi}" style="display:none;margin-top:8px;flex-direction:column;gap:8px;align-items:center">
            <video id="meal-video-${mi}" autoplay playsinline style="width:100%;max-width:320px;border-radius:12px;background:#000"></video>
            <div style="display:flex;gap:8px;width:100%;max-width:320px">
              <button class="btn btn-flat btn-sm" onclick="window.stopMealCamera(${mi})" style="flex:1">Annulla</button>
              <button class="btn btn-v btn-sm" onclick="window.captureMealImage(${mi})" style="flex:1">📸 Scatta e Analizza</button>
            </div>
            <canvas id="meal-canvas-${mi}" style="display:none"></canvas>
          </div>

          <div id="meal-ai-${mi}" style="display:none;margin-top:8px"></div>
          <div style="margin-top:8px">
            <button class="btn btn-ghost btn-sm" onclick="window.openManualMacro(${mi})"><i class="ri-pencil-line"></i> Inserisci manuale</button>
          </div>
        </div>
        <div class="meal-delta" id="meal-delta-${mi}"></div>
      </div>
    </div>
    <div onclick="window.toggleMealDetail(${mi})" style="text-align:right;font-size:11px;color:var(--t3);cursor:pointer;padding:4px 0;margin-bottom:4px">▼ dettagli</div>`;
}

window.toggleMeal = function(mi) {
  if (!window.isServerLoaded) {
    showToast('Caricamento dati in corso... Riprova tra un istante', 'info');
    return;
  }
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
  if (el) {
    const isOpening = el.style.display === 'none';
    el.style.display = isOpening ? 'block' : 'none';
    if (!isOpening) {
      window.stopMealCamera(mi);
    }
  }
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
      <button class="btn btn-v btn-sm" onclick="window.applyMealAI(${mi},${r.kcal},${r.protein},${r.carbs},${r.fats})" style="margin-top:8px">✅ Applica</button>`;
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
      <a href="session.html" class="btn btn-o" style="text-decoration:none">🏋️ Vai ad Allenarti</a>`;
  }
}

// ── Stats ──────────────────────────────────────────────────
function buildStats() {
  const sf = document.getElementById('steps-in');
  if(sf) {
    sf.value = logData.steps || '';
    sf.addEventListener('change', () => {
      logData.steps = parseInt(sf.value) || null;
      saveToLocal();
      refreshStepsCard();
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

// ── Steps Card (nuova pano-card clickabile) ─────────────────
function buildStepsCard() {
  const card = document.getElementById('steps-card');
  if (!card) return;

  const steps = logData.steps || 0;
  const goal = appSettings?.steps_goal || 0;
  const pct = goal > 0 ? Math.min(100, Math.round(steps / goal * 100)) : 0;

  let ringHtml = '';
  if (goal > 0) {
    const R = 12, CX = 16, CY = 16;
    const C = 2 * Math.PI * R;
    const off = C * (1 - pct / 100);
    const ringCol = pct >= 100 ? '#1ce370' : pct >= 70 ? '#fbbf24' : 'var(--accent)';
    ringHtml = `
      <svg width="32" height="32" viewBox="0 0 32 32" style="flex-shrink:0">
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="3"/>
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${ringCol}" stroke-width="3"
          stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"
          stroke-linecap="round" transform="rotate(-90 ${CX} ${CY})"/>
      </svg>`;
  } else {
    ringHtml = `<i class="ri-walk-line" style="font-size:20px;color:var(--t3)"></i>`;
  }

  const valHtml = steps > 0
    ? `<span style="font-weight:700;color:#fff">${steps.toLocaleString('it-IT')}</span>${goal > 0 ? ` <span style="font-size:11px;color:var(--t3)">/ ${goal.toLocaleString('it-IT')}</span>` : ''}`
    : `<span style="font-size:12px;color:var(--t3)">Aggiungi passi</span>`;

  card.innerHTML = `
    <div class="pano-icon" style="width:32px;display:flex;align-items:center;justify-content:center">${ringHtml}</div>
    <div class="pano-info" style="flex:1">
      <div class="pano-label">ATTIVIT&Agrave;</div>
      <div class="pano-val">${valHtml}</div>
    </div>
    <i class="ri-add-circle-line pano-arrow" style="font-size:20px"></i>`;

  card.onclick = () => openStepsModal();
  card.style.cursor = 'pointer';
}

function refreshStepsCard() {
  buildStepsCard();
  buildFitScore();
  buildSmartAdvisor();
}

window.openStepsModal = function() {
  const steps = logData.steps || '';
  const burned = logData.burned_kcal || '';

  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.id = 'steps-modal';
  bg.innerHTML = `
    <div class="modal">
      <div class="modal-handle"></div>
      <h3>&#128694; Attivit&agrave; Fisica</h3>
      <p style="color:var(--t2);font-size:13px;margin-bottom:20px">Inserisci i tuoi dati di attivit&agrave; per oggi</p>
      <div class="fg">
        <label class="fl">&#128694; Passi</label>
        <input type="number" class="fi" id="sm-steps" placeholder="Es. 8500" value="${steps}" inputmode="numeric">
      </div>
      <div class="fg">
        <label class="fl">&#128293; Kcal bruciate (opzionale)</label>
        <input type="number" class="fi" id="sm-burned" placeholder="Es. 350" value="${burned}" inputmode="numeric">
      </div>
      <div class="modal-btns">
        <button class="btn btn-flat" onclick="document.getElementById('steps-modal').remove()">Annulla</button>
        <button class="btn btn-v" onclick="window.saveStepsModal()">&#10003; Salva</button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  bg.onclick = e => { if (e.target === bg) bg.remove(); };
  setTimeout(() => document.getElementById('sm-steps')?.focus(), 100);
};

window.saveStepsModal = function() {
  const steps = parseInt(document.getElementById('sm-steps')?.value) || null;
  const burned = parseInt(document.getElementById('sm-burned')?.value) || null;
  if (steps !== null) logData.steps = steps;
  if (burned !== null) logData.burned_kcal = burned;
  const sf = document.getElementById('steps-in');
  const kf = document.getElementById('burned-in');
  if (sf && steps !== null) sf.value = steps;
  if (kf && burned !== null) kf.value = burned;
  logData.last_updated = Date.now();
  saveToLocal();
  document.getElementById('steps-modal')?.remove();
  buildStepsCard();
  buildFitScore();
  buildSmartAdvisor();
  showToast('&#128694; Attivit\u00e0 salvata!');
};

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
    <button class="btn btn-v btn-sm" onclick="window.openAddMealFromAI(${r.kcal}, ${r.protein}, ${r.carbs}, ${r.fats}, '${text.replace(/'/g, "\\'")}')" style="margin-top:12px;width:100%"><i class="ri-add-circle-fill"></i> Aggiungi come Extra</button>`;
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
  if (!window.isServerLoaded) return;
  if (window.isMockData) {
    console.log("Skipping syncToFirebase because we only have mock/unloaded data");
    return;
  }
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
    extra_meals:     logData.extra_meals     || [],
    smart_advice:    logData.smart_advice    || {},
    last_updated:    logData.last_updated    || Date.now()
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
  let snap;
  try {
    snap = await getDoc(doc(db, 'users', getUserId(), 'daily_logs', yesterday));
  } catch (err) {
    console.warn('checkYesterdayLog error:', err.message);
    return;
  }
  if (snap && snap.exists()) {
    const banner = document.querySelector('[data-yesterday-banner]');
    if (banner) banner.remove();
    return;
  }

  if (document.querySelector('[data-yesterday-banner]')) return;

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
    <button class="btn btn-o btn-xs" onclick="window.openRecoverDay('${yesterday}')">Recupera</button>
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
        <button class="btn btn-v" onclick="window.saveRecoveredDay('${dateStr}')">💾 Salva</button>
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
    
    const select = document.getElementById('am-template-select');
    const container = document.getElementById('template-select-container');
    if (!select || !container) return;
    
    if (mealTemplates.length === 0) {
      container.style.display = 'none';
      return;
    }
    
    container.style.display = 'block';
    select.innerHTML = '<option value="">-- Seleziona un template --</option>' + 
      mealTemplates.map(t => `<option value="${t.id}">${t.name} (${t.kcal} kcal · P:${t.protein}g)</option>`).join('');
  } catch(e) {
    console.warn('Errore caricamento template per dropdown:', e);
  }
}

window.loadMealTemplate = function(id) {
  const t = mealTemplates.find(x => x.id === id);
  if (!t) return;
  const setVal = (id, val) => { const e = document.getElementById(id); if (e) e.value = val; };
  setVal('am-name', t.name || '');
  setVal('am-ingredients', t.ingredients || '');
  setVal('am-kcal', t.kcal || 0);
  setVal('am-protein', t.protein || 0);
  setVal('am-carbs', t.carbs || 0);
  setVal('am-fats', t.fats || 0);
};

// ── Aggiungi pasto extra ───────────────────────────────────
window.openAddMeal = function(prefillData, editIndex) {
  const isEdit = editIndex !== undefined && editIndex !== null;
  const dayKey = isTrainingDay ? 'day_on' : 'day_off';
  const planMeals = activeDiet?.[dayKey]?.meals || [];

  const destHtml = !isEdit ? `
    <div class="fg" style="margin-bottom:16px">
      <label class="fl">📋 Destinazione Pasto</label>
      <select class="fi" id="am-destination">
        <option value="extra">Aggiungi come Extra / Fuori piano</option>
        ${planMeals.map((pm, pmi) => `
          <option value="${pmi}">Sostituisci: ${pm.label || pm.type} (${pm.kcal} kcal)</option>
        `).join('')}
      </select>
    </div>` : '';

  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.id = 'add-meal-modal';
  bg.innerHTML = `
    <div class="modal" style="max-height:85vh;overflow-y:auto">
      <div class="modal-handle"></div>
      <h3>${isEdit ? '✏️ Modifica Pasto Extra' : (prefillData ? 'Copia Pasto Amico' : '+ Aggiungi Pasto')}</h3>
  
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
 
      ${destHtml}
 
      <div class="fg">
        <label class="fl">Ingredienti</label>
        <textarea class="fi" id="am-ingredients" rows="3"
          placeholder="Es: 150g pollo, 100g riso, 10g olio&#10;Oppure inserisci macro manualmente sotto">${prefillData?.ingredients || ''}</textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-ghost btn-sm" onclick="window.calcAIMeal()" style="flex:1">
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
 

 
      <div class="modal-btns" style="display:flex;flex-wrap:wrap;gap:8px">
        <button class="btn btn-flat btn-sm" onclick="document.getElementById('add-meal-modal').remove()">
          Annulla
        </button>
        ${isEdit ? `
        <button class="btn btn-del btn-sm" onclick="window.deleteExtraMeal(${editIndex})" style="background:rgba(255,61,90,0.1);color:var(--red);border:1px solid rgba(255,61,90,0.2)">
          <i class="ri-delete-bin-line"></i> Elimina
        </button>` : `
        <button class="btn btn-ghost btn-sm" onclick="window.saveAsTemplate()">
          ⭐ Salva come Template
        </button>`}
        <button class="btn btn-g btn-sm" onclick="window.saveExtraMeal(${isEdit ? editIndex : 'null'})">
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
 
window.saveExtraMeal = async function(editIndex) {
  const name    = document.getElementById('am-name')?.value?.trim();
  const kcal    = parseFloat(document.getElementById('am-kcal')?.value)    || 0;
  const protein = parseFloat(document.getElementById('am-protein')?.value) || 0;
  const carbs   = parseFloat(document.getElementById('am-carbs')?.value)   || 0;
  const fats    = parseFloat(document.getElementById('am-fats')?.value)    || 0;
  const type    = 'extra';
  const ingredients = document.getElementById('am-ingredients')?.value?.trim() || '';
  const destination = document.getElementById('am-destination')?.value || 'extra';
 
  if (!name)                       return showToast('Inserisci il nome del pasto', 'err');
  if (kcal === 0 && protein === 0) return showToast('Inserisci almeno le kcal', 'err');
 
  if (!window.isServerLoaded) {
    showToast('Caricamento dati in corso... Riprova tra un istante', 'info');
    return;
  }

  if (destination !== 'extra') {
    const targetMealIndex = parseInt(destination);
    if (!logData.meals_overrides) logData.meals_overrides = {};
    logData.meals_overrides[targetMealIndex] = {
      kcal,
      protein,
      carbs,
      fats,
      items_text: name + (ingredients ? `: ${ingredients}` : '')
    };
    patchMealRow(targetMealIndex, kcal, protein, carbs, fats);
    saveToLocal();
    buildNutrition();
    document.getElementById('add-meal-modal')?.remove();
    showToast('✅ Pasto del piano sostituito con successo!');
    buildMeals();
    return;
  }
 
  if (!logData.extra_meals) logData.extra_meals = [];
  
  if (editIndex !== undefined && editIndex !== null) {
    const existing = logData.extra_meals[editIndex];
    logData.extra_meals[editIndex] = {
      ...existing,
      name, type, kcal, protein, carbs, fats, ingredients
    };
  } else {
    logData.extra_meals.push({
      name, type, kcal, protein, carbs, fats, ingredients,
      time:     new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
      added_at: new Date().toISOString(),
      eaten:    true
    });
  }
 
  updateNutritionTotals();
  saveToLocal();
  document.getElementById('add-meal-modal')?.remove();
  showToast(editIndex !== undefined && editIndex !== null ? '✅ Pasto modificato!' : '✅ Pasto aggiunto!');
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
        <button class="btn btn-g" onclick="window.saveManualMacro(${mealIndex})">✅ Salva</button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  bg.onclick = e => { if (e.target === bg) bg.remove(); };
};

window.saveManualMacro = function(mealIndex) {
  if (!window.isServerLoaded) {
    showToast('Caricamento dati in corso... Riprova tra un istante', 'info');
    return;
  }
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

window.startMealCamera = async function(mi) {
  const container = document.getElementById(`meal-camera-container-${mi}`);
  const video = document.getElementById(`meal-video-${mi}`);
  if (!container || !video) return;

  showToast('🎥 Avvio fotocamera...', 'info');

  try {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
    }
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

window.stopMealCamera = function(mi) {
  const container = document.getElementById(`meal-camera-container-${mi}`);
  if (container) container.style.display = 'none';

  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
};

window.captureMealImage = async function(mi) {
  const video = document.getElementById(`meal-video-${mi}`);
  const canvas = document.getElementById(`meal-canvas-${mi}`);
  if (!video || !canvas || !cameraStream) return;

  const ctx = canvas.getContext('2d');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  window.stopMealCamera(mi);

  showToast('⏳ Analisi immagine cibo con AI...', 'info');

  try {
    const base64Image = canvas.toDataURL('image/jpeg').split(',')[1];
    const r = await analyzeFoodImageAI(base64Image, 'image/jpeg');

    if (!r.success) {
      showToast(r.error, 'err');
      return;
    }

    const textEl = document.getElementById(`meal-txt-${mi}`);
    if (textEl) textEl.value = r.ingredients || r.name;

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
        <button class="btn btn-v btn-sm" onclick="window.applyMealAI(${mi},${r.kcal},${r.protein},${r.carbs},${r.fats})" style="margin-top:8px">✅ Applica</button>`;

      const tgt = mealStates[mi].kcal;
      const diff = r.kcal - tgt;
      const deltaEl = document.getElementById(`meal-delta-${mi}`);
      if (deltaEl) {
        deltaEl.textContent = `Target: ${tgt}kcal | AI: ${r.kcal}kcal | ${diff >= 0 ? '+' : ''}${diff}kcal`;
        deltaEl.className = 'meal-delta ' + (Math.abs(diff) < 50 ? 'delta-ok' : diff > 0 ? 'delta-over' : 'delta-warn');
      }
    }

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

// ── Smart Advisor ──────────────────────────────
let isGeneratingAdvice = false;

function getPartOfDay() {
  const hr = new Date().getHours();
  if (hr >= 5 && hr < 12) return 'mattina';
  if (hr >= 12 && hr < 18) return 'pomeriggio';
  return 'sera';
}

function generateLocalAdvice({ profile, activeDiet, activeProgram, dailyState, partOfDay }) {
  const name = profile?.name || 'Campione';
  const steps = dailyState.steps || 0;
  const goalSteps = profile?.steps_goal || 0;
  const tots = calcTotals();
  const dayKey = dailyState.isTrainingDay ? 'day_on' : 'day_off';
  const plan = activeDiet?.[dayKey];
  const targetKcal = plan?.kcal || 2000;
  const kcalDiff = targetKcal - tots.kcal;

  if (partOfDay === 'mattina') {
    if (dailyState.isTrainingDay) {
      return `Buongiorno, **${name}**! Oggi è giorno di **allenamento**. Assicurati di fare una colazione proteica e idratati bene. Target calorico: **${targetKcal} kcal**. Forza! 🏋️`;
    } else {
      return `Buongiorno, **${name}**! Oggi è un giorno di **riposo**. Concentrati sul recupero, mantieni l'alimentazione in target (**${targetKcal} kcal**) e goditi il relax. 🛀`;
    }
  } else if (partOfDay === 'pomeriggio') {
    const kcalSoFar = Math.round(tots.kcal);
    if (kcalDiff > 200) {
      return `Buon pomeriggio! Hai consumato **${kcalSoFar} kcal** su ${targetKcal}. Ti mancano circa **${Math.round(kcalDiff)} kcal** al target. ${dailyState.isTrainingDay && !dailyState.workoutDone ? "Ricorda l'allenamento! 💪" : 'Continua così! ⚡'}`;
    } else {
      return `Buon pomeriggio, **${name}**! Sei sulla strada giusta con **${kcalSoFar} kcal**. ${dailyState.isTrainingDay && !dailyState.workoutDone ? "Hai ancora l'allenamento da completare! 🏋️" : 'Ottima gestione delle calorie! ✅'}`;
    }
  } else {
    // Sera — include passi
    const parts = [];
    if (kcalDiff > 100) {
      parts.push(`Ti mancano **${Math.round(kcalDiff)} kcal** per raggiungere il target`);
    } else if (kcalDiff < -100) {
      parts.push(`Hai superato il target di **${Math.round(Math.abs(kcalDiff))} kcal**`);
    } else {
      parts.push(`Sei perfettamente in target con le calorie`);
    }
    if (goalSteps > 0) {
      if (steps >= goalSteps) parts.push(`obiettivo passi raggiunto 🏅`);
      else parts.push(`**${steps}/${goalSteps} passi** completati`);
    }
    return `Buonasera, **${name}**! ${parts.join(', ')}. ${kcalDiff > 100 ? 'Valuta uno spuntino proteico pre-nanna. 🥩' : 'Buona notte e recupero! 🌟'}`;
  }
}

async function buildSmartAdvisor() {
  const box = document.getElementById('smart-advisor-box');
  if (!box) return;

  const partOfDay = getPartOfDay();
  const advice = logData.smart_advice?.[partOfDay];

  // We need to load weekly logs first to compute the plan
  await loadWeeklyLogsForScore();

  const recoveryPlan = calcRecoveryPlan({
    weeklyLogs: _weeklyLogsCache || [],
    activeDiet,
    activeProgram,
    appSettings,
    today: TODAY
  });

  if (advice) {
    renderSmartAdvisorContent(advice, recoveryPlan);
    return;
  }

  const cachedKey = `fittracker_advice_${TODAY}_${partOfDay}`;
  const cachedText = safeLocalStorage.getItem(cachedKey);

  if (cachedText) {
    if (!logData.smart_advice) logData.smart_advice = {};
    logData.smart_advice[partOfDay] = cachedText;
    saveToLocal();
    renderSmartAdvisorContent(cachedText, recoveryPlan);
    return;
  }

  // Mostra skeleton in attesa
  const skeletonHtml = `
    <div class="card" style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06); padding:16px; border-radius:var(--rs);">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <div style="font-size:10px; font-weight:800; color:var(--accent); letter-spacing:1px; display:flex; align-items:center; gap:6px;">
          <i class="ri-flashlight-fill"></i> KOVA SMART ADVISOR
        </div>
      </div>
      <div style="display:flex; flex-direction:column; gap:8px;">
        <div style="height:12px; background:rgba(255,255,255,0.05); width:80%; border-radius:4px; animation: pulse 1.5s infinite ease-in-out;"></div>
        <div style="height:12px; background:rgba(255,255,255,0.05); width:95%; border-radius:4px; animation: pulse 1.5s infinite ease-in-out;"></div>
        <div style="height:12px; background:rgba(255,255,255,0.05); width:50%; border-radius:4px; animation: pulse 1.5s infinite ease-in-out;"></div>
      </div>
    </div>
    <style>
      @keyframes pulse {
        0% { opacity: 0.6; }
        50% { opacity: 0.3; }
        100% { opacity: 0.6; }
      }
    </style>
  `;
  box.innerHTML = skeletonHtml;

  if (!window.isServerLoaded) {
    // Non ancora caricato: aspetta il caricamento server prima di generare
    // La chiamata verrà fatta dalla init() dopo loadSmart
    return;
  }

  // Server caricato e nessun consiglio: genera
  setTimeout(() => {
    window.refreshSmartAdvisor(true);
  }, 200);
}

function renderSmartAdvisorContent(text, recoveryPlan = null) {
  const box = document.getElementById('smart-advisor-box');
  if (!box) return;

  const formattedText = text
    .replace(/\*\*(.*?)\*\*/g, '<b style="color:var(--t1)">$1</b>')
    .replace(/\n/g, '<br>');

  let statusClass = 'status-on_track';
  let badgeText = 'IN CARREGGIATA';
  let actionsHtml = '';

  if (recoveryPlan) {
    statusClass = `status-${recoveryPlan.recoveryStatus}`;
    if (recoveryPlan.recoveryStatus === 'critical') {
      badgeText = 'RECUPERO CRITICO';
    } else if (recoveryPlan.recoveryStatus === 'needs_recovery') {
      badgeText = 'RECUPERO CONSIGLIATO';
    } else if (recoveryPlan.recoveryStatus === 'slight_deviation') {
      badgeText = 'DEVIAZIONE LIEVE';
    }

    if (recoveryPlan.actions && recoveryPlan.actions.length > 0) {
      actionsHtml = `
        <div style="margin-top: 14px; margin-bottom: 4px;">
          <div style="font-size: 10px; font-weight: 800; color: var(--t3); letter-spacing: 1px; text-transform: uppercase; margin-bottom: 8px;">Azioni di Recupero</div>
          <div class="advisor-actions">
            \${recoveryPlan.actions.map(act => {
              let clickJs = '';
              if (act.type === 'meal') clickJs = `location.href='diet.html'`;
              else if (act.type === 'activity') clickJs = `window.openStepsModal ? window.openStepsModal() : document.getElementById('steps-card').click()`;
              else clickJs = `location.href='session.html'`;

              return `
                <div class="action-item" onclick="\${clickJs}">
                  <div class="action-left">
                    <span class="action-icon">\${act.icon}</span>
                    <span class="action-label">\${act.label}</span>
                  </div>
                  <div class="action-right">
                    <span class="action-value">\${act.value}</span>
                    <div class="action-btn-mini"><i class="ri-arrow-right-s-line"></i></div>
                  </div>
                </div>`;
            }).join('')}
          </div>
        </div>`;
    }
  }

  box.innerHTML = `
    <div class="advisor-card \${statusClass}">
      <div class="advisor-header">
        <div class="advisor-title">KOVA SMART ADVISOR</div>
        <div class="recovery-badge">\${badgeText}</div>
      </div>
      <div id="smart-advisor-content" class="advisor-body">
        \${formattedText}
      </div>
      \${actionsHtml}
      <div class="advisor-footer">
        <button onclick="window.refreshSmartAdvisor(false)" style="background:none; border:none; color:var(--t3); font-size:12px; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:6px; background:rgba(255,255,255,0.03); border:1px solid var(--border); transition: all 0.2s;" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--t3)'">
          <i class="ri-refresh-line" id="advisor-refresh-icon"></i> Aggiorna
        </button>
      </div>
    </div>
  `;
}

window.refreshSmartAdvisor = async function(silent = false) {
  if (isGeneratingAdvice) return;
  isGeneratingAdvice = true;

  const refreshIcon = document.getElementById('advisor-refresh-icon');
  if (refreshIcon) refreshIcon.classList.add('ri-spin');

  const partOfDay = getPartOfDay();
  const tots = calcTotals();

  // Load weekly logs to ensure data is updated
  await loadWeeklyLogsForScore();

  const recoveryPlan = calcRecoveryPlan({
    weeklyLogs: _weeklyLogsCache || [],
    activeDiet,
    activeProgram,
    appSettings,
    today: TODAY
  });

  const planMeals = activeDiet?.[isTrainingDay ? 'day_on' : 'day_off']?.meals || [];
  const eatenMeals = planMeals
    .filter((m, i) => logData.meals_state?.[i]?.eaten)
    .map(m => m.label || m.type);
  const eatenExtraMeals = (logData.extra_meals || [])
    .filter(m => m.eaten !== false)
    .map(m => m.name);
  const allEaten = eatenMeals.concat(eatenExtraMeals);
  const eatenMealsStr = allEaten.length ? allEaten.join(', ') : 'Nessuno';

  const dailyState = {
    steps: logData.steps || 0,
    kcal: Math.round(tots.kcal),
    protein: Math.round(tots.protein),
    carbs: Math.round(tots.carbs),
    fats: Math.round(tots.fats),
    isTrainingDay,
    workoutDone: !!logData.workout?.completed,
    eatenMealsStr,
    weeklyScore: _weeklyScoreCache,
  };

  try {
    let finalAdvice = '';
    
    if (recoveryPlan) {
      const r = await generateRecoveryAdviceAI({
        profile: appSettings?.profile,
        currentWeight: latestCheck?.weight || null,
        activeDiet,
        activeProgram,
        recoveryPlan,
        partOfDay
      });

      if (r.success && r.advice) {
        finalAdvice = r.advice;
      } else {
        if (!silent && r.error && r.error.includes('Key')) {
          showToast('Configura la Gemini API Key in Impostazioni per consigli AI avanzati!', 'info');
        }
        finalAdvice = generateLocalAdvice({
          profile: appSettings?.profile,
          activeDiet,
          activeProgram,
          dailyState,
          partOfDay
        });
      }
    } else {
      const r = await generateSmartAdviceAI({
        profile: appSettings?.profile,
        currentWeight: latestCheck?.weight || null,
        activeDiet,
        activeProgram,
        dailyState,
        partOfDay
      });

      if (r.success && r.advice) {
        finalAdvice = r.advice;
      } else {
        finalAdvice = generateLocalAdvice({
          profile: appSettings?.profile,
          activeDiet,
          activeProgram,
          dailyState,
          partOfDay
        });
      }
    }

    if (!logData.smart_advice) logData.smart_advice = {};
    logData.smart_advice[partOfDay] = finalAdvice;

    const cachedKey = `fittracker_advice_\${TODAY}_\${partOfDay}`;
    safeLocalStorage.setItem(cachedKey, finalAdvice);

    saveToLocal();
    await syncToFirebase();
    renderSmartAdvisorContent(finalAdvice, recoveryPlan);

  } catch(e) {
    console.error('Advisor error:', e);
    const localAdvice = generateLocalAdvice({
      profile: appSettings?.profile,
      activeDiet,
      activeProgram,
      dailyState,
      partOfDay
    });

    if (!logData.smart_advice) logData.smart_advice = {};
    logData.smart_advice[partOfDay] = localAdvice;

    const cachedKey = `fittracker_advice_\${TODAY}_\${partOfDay}`;
    safeLocalStorage.setItem(cachedKey, localAdvice);

    saveToLocal();
    await syncToFirebase();
    renderSmartAdvisorContent(localAdvice, recoveryPlan);
  } finally {
    isGeneratingAdvice = false;
    if (refreshIcon) refreshIcon.classList.remove('ri-spin');
  }
};

(async function() {
  await requireAuth();
  init();
})();