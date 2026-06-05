import { requireAuth, loadSmart } from './app.js';
import {
  db, getUserId, doc, getDoc, setDoc, getDocs, addDoc, deleteDoc, collection, query, orderBy, limit
} from './firebase-config.js';
import {
  getTodayString, getYesterdayString, getDayOfWeek, formatDateIT, formatDateShort, addDays, showToast, showModal, setW, setT, DAYS_IT, DAY_ORDER, cleanOldLogs, calcFitScore, calcSmartScore, calcRecoveryPlan
} from './app.js';
import { calcMacrosFromText, analyzeFoodImageAI, generateSmartAdviceAI, generateRecoveryAdviceAI, generateAdvisor360AI, saveAICorrection } from './gemini.js';

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
let recentChecks = [];
let isTrainingDay = false;
let mealStates = [];
let friendLogData = null;
let friendActiveDiet = null;
let loadedFriendEmail = null;
let fridgeItems = [];
let friendBannerCollapsed = true;
let _selectedFridgeIdx = -1;
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
  
  // Load weekly logs in the background concurrently, and update SmartScore and Advisor once loaded
  loadWeeklyLogsForScore().then(() => {
    buildFitScore();
    buildSmartAdvisor();
  }).catch(e => console.warn('loadWeeklyLogsForScore background error:', e));

  try {
    const refs = [
      doc(db, 'users', userId, 'daily_logs', TODAY),
      collection(db, 'users', userId, 'programs'),
      collection(db, 'users', userId, 'diet_plans'),
      doc(db, 'users', userId, 'settings', 'app'),
      query(collection(db, 'users', userId, 'checks'), orderBy('date', 'desc'), limit(4))
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
      recentChecks  = checksSnap.docs.map(d => d.data());
      latestCheck   = recentChecks[0] || null;

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

      // Async load Dispensa (non-blocking)
      loadFridgeFromFirebase().then(() => buildMeals()).catch(() => {});

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
    recentChecks = [];
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

  return {
    kcal: Math.round(kcal),
    protein: parseFloat(protein.toFixed(1)),
    carbs: parseFloat(carbs.toFixed(1)),
    fats: parseFloat(fats.toFixed(1))
  };
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
let _weeklyLogsCache = null;
let _weeklyScoreCache = null;
let _weeklyLoadedDate = null;

async function loadWeeklyLogsForScore() {
  const today = getTodayString();
  if (_weeklyLoadedDate === today && _weeklyLogsCache !== null) return;
  try {
    const q = query(
      collection(db, 'users', getUserId(), 'daily_logs'),
      orderBy('date', 'desc'),
      limit(7)
    );
    const snap = await getDocs(q);
    _weeklyLogsCache = snap.docs.map(d => d.data());
    _weeklyLoadedDate = today;
  } catch(e) {
    _weeklyLogsCache = [];
  }
}

function buildFitScore() {
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
    <div style="display:flex; gap:16px; align-items:center; width:100%; margin-top:8px; overflow:hidden;">
      
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
      <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:10px; overflow:hidden;">
        
        <!-- Pasti -->
        <div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px;">
          <span style="font-size:13px; font-weight:700; color:#fff; flex-shrink:0;">Pasti</span>
          <span style="font-size:11px; color:var(--t2); font-weight:500; text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;">
            ${eatenMealsCount}/${totalMeals} <span style="color:var(--t3);">·</span> ${actualKcal}/${targetKcal}
          </span>
        </div>
        
        <!-- Allenamento -->
        <div style="min-width:0; overflow:hidden;">
          <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px; gap:8px;">
            <span style="font-size:13px; font-weight:700; color:#fff; flex-shrink:0;">Workout</span>
            <span style="font-size:11px; color:var(--t2); font-weight:500; text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;">
              ${sessionName} <span style="color:var(--t3);">·</span> ${workoutScore}/${workoutMax}
            </span>
          </div>
          <div style="height:3px; background:rgba(255,255,255,0.04); border-radius:99px; overflow:hidden;">
            <div style="height:100%; width:${workoutPct}%; background:${workoutScore > 0 ? 'var(--green)' : 'rgba(255,255,255,0.08)'}; border-radius:99px; transition:width 0.5s ease;"></div>
          </div>
        </div>
        
        <!-- Passi -->
        <div style="display:flex; justify-content:space-between; align-items:baseline; border-top:1px solid rgba(255,255,255,0.03); padding-top:6px; gap:8px;">
          <span style="font-size:13px; font-weight:700; color:#fff; flex-shrink:0;">Passi</span>
          <span style="font-size:11px; color:var(--t2); font-weight:500; text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;">
            ${actualSteps.toLocaleString('it-IT')} <span style="color:var(--t3);">·</span> ${stepsGoal > 9999 ? Math.round(stepsGoal/1000) + 'k' : stepsGoal.toLocaleString('it-IT')}
          </span>
        </div>
        
        <!-- Proteine -->
        <div style="display:flex; justify-content:space-between; align-items:baseline; border-top:1px solid rgba(255,255,255,0.03); padding-top:6px; gap:8px;">
          <span style="font-size:13px; font-weight:700; color:#fff; flex-shrink:0;">Proteine</span>
          <span style="font-size:11px; color:var(--t2); font-weight:500; text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;">
            ${actualProtein}g <span style="color:var(--t3);">·</span> ${targetProtein}g
          </span>
        </div>

      </div>
    </div>
  `;
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
      const friendName = appSettings?.friend_email ? appSettings.friend_email.split('@')[0] : 'amico';
      const isToday = !!friendLogData;
      const totalFriendKcal = friendList.reduce((s, fm) => s + (fm.kcal || 0), 0);
      const isCollapsed = friendBannerCollapsed;

      const collapsedHtml = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer" onclick="window.toggleFriendBanner()">
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
            <div style="width:36px;height:36px;border-radius:50%;background:rgba(124,111,255,0.15);border:1px solid rgba(124,111,255,0.4);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">🤝</div>
            <div style="min-width:0">
              <div style="font-size:13px;font-weight:700;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Pasti di ${friendName}</div>
              <div style="font-size:11px;color:var(--t3)">${friendList.length} pasti · ${totalFriendKcal} kcal ${isToday ? '(oggi)' : '(piano)'}</div>
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" style="font-size:11px;flex-shrink:0;border-color:rgba(124,111,255,0.4);color:var(--accent)" onclick="event.stopPropagation();window.toggleFriendBanner()">
            <i class="ri-eye-line"></i> Vedi
          </button>
        </div>`;

      const expandedHtml = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div style="font-size:12px;font-weight:800;color:var(--accent)">🤝 Pasti di ${friendName} ${isToday ? '(oggi)' : '(pianificati)'}</div>
          <button class="btn btn-ghost btn-sm" style="font-size:11px;padding:4px 10px" onclick="window.toggleFriendBanner()">
            <i class="ri-eye-off-line"></i> Nascondi
          </button>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${friendList.map((fm, idx) => `
            <div style="display:flex;justify-content:space-between;align-items:center;background:var(--bg);padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.05)">
              <div style="flex:1;margin-right:12px;min-width:0">
                <div style="font-size:13px;font-weight:700;color:var(--t1)">${fm.name}</div>
                <div style="font-size:11px;color:var(--t2)">${fm.kcal} kcal · P:${fm.protein}g C:${fm.carbs}g F:${fm.fats}g</div>
                ${fm.ingredients ? `<div style="font-size:11px;color:var(--accent);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${fm.ingredients}</div>` : ''}
              </div>
              <button class="btn btn-ghost btn-sm" style="flex-shrink:0" onclick="window.openAddMeal(window.currentFriendMeals[${idx}])">Copia</button>
            </div>
          `).join('')}
        </div>`;

      friendBannerHtml = `
        <div id="friend-banner-card" class="card" style="margin-bottom:12px;background:rgba(124,111,255,0.05);border:1px solid rgba(124,111,255,0.3)">
          ${isCollapsed ? collapsedHtml : expandedHtml}
        </div>`;
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
    
  el.innerHTML = friendBannerHtml + buildFridgeHtml() + mealStates.map((m, mi) => renderMealRow(m, mi, meals)).join('') + extraHtml;
  updateNutritionTotals();
}

window.toggleFriendBanner = function() {
  friendBannerCollapsed = !friendBannerCollapsed;
  // Re-render only the meals section (buildMeals triggers full re-render)
  buildMeals();
};

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
  logData.meals_overrides[mi] = {
    kcal, protein, carbs, fats, items_text: txt,
    ai_estimate: { kcal, protein, carbs, fats }
  };
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

      ${fridgeItems.length > 0 ? `
      <div style="background:rgba(20,184,166,0.06);border:1px solid rgba(20,184,166,0.2);border-radius:10px;padding:12px;margin-bottom:14px">
        <div style="font-size:11px;color:rgb(20,184,166);font-weight:700;margin-bottom:8px">❄️ USA DALLA DISPENSA</div>
        <select class="fi" id="am-fridge-select" onchange="window.onFridgeSelect(this.value)" style="margin-bottom:8px">
          <option value="">— Seleziona un piatto —</option>
          ${fridgeItems.map((it, fi) => {
            const hasSlices = it.slices > 0;
            const remSlices = hasSlices ? (it.slices_remaining ?? it.slices) : null;
            const disabled = hasSlices && remSlices <= 0 ? 'disabled' : '';
            const label = hasSlices
              ? `${it.name} (${remSlices}/${it.slices} fette)`
              : it.name;
            return `<option value="${fi}" ${disabled}>${label}</option>`;
          }).join('')}
        </select>
        <div id="am-fridge-slices-row" style="display:none;align-items:center;gap:8px;margin-bottom:8px">
          <input type="number" class="fi" id="am-fridge-slices" placeholder="Quante fette?" min="1" style="flex:1" oninput="window.onFridgeSlicesInput()">
          <span id="am-fridge-slices-max" style="font-size:11px;color:var(--t3);white-space:nowrap"></span>
        </div>
        <div id="am-fridge-preview" style="font-size:12px;color:rgb(20,184,166);font-weight:600;min-height:16px"></div>
      </div>` : ''}

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
 
window.onFridgeSelect = function(val) {
  _selectedFridgeIdx = val !== '' ? parseInt(val) : -1;
  const slicesRow = document.getElementById('am-fridge-slices-row');
  const preview = document.getElementById('am-fridge-preview');
  const slicesInput = document.getElementById('am-fridge-slices');
  const slicesMax = document.getElementById('am-fridge-slices-max');
  if (_selectedFridgeIdx < 0 || !fridgeItems[_selectedFridgeIdx]) {
    if (slicesRow) slicesRow.style.display = 'none';
    if (preview) preview.textContent = '';
    return;
  }
  const item = fridgeItems[_selectedFridgeIdx];
  const hasSlices = item.slices > 0;
  if (hasSlices) {
    const rem = item.slices_remaining ?? item.slices;
    if (slicesRow) slicesRow.style.display = 'flex';
    if (slicesInput) { slicesInput.value = '1'; slicesInput.max = rem; }
    if (slicesMax) slicesMax.textContent = `max ${rem}`;
    window.onFridgeSlicesInput();
  } else {
    if (slicesRow) slicesRow.style.display = 'none';
    // Fill all fields with total
    _fillFridgeMacros(item, 1, 1);
    if (preview) preview.textContent = `→ ${item.total_kcal||0} kcal · P:${item.total_protein||0}g · C:${item.total_carbs||0}g · F:${item.total_fats||0}g`;
  }
};

window.onFridgeSlicesInput = function() {
  if (_selectedFridgeIdx < 0) return;
  const item = fridgeItems[_selectedFridgeIdx];
  if (!item || !item.slices) return;
  const slicesInput = document.getElementById('am-fridge-slices');
  const preview = document.getElementById('am-fridge-preview');
  const n = Math.max(1, parseInt(slicesInput?.value) || 1);
  const tot = item.slices;
  _fillFridgeMacros(item, n, tot);
  const kcal = Math.round((item.total_kcal||0) * n / tot);
  const pro = ((item.total_protein||0) * n / tot).toFixed(1);
  const carb = ((item.total_carbs||0) * n / tot).toFixed(1);
  const fat = ((item.total_fats||0) * n / tot).toFixed(1);
  if (preview) preview.textContent = n > 0 ? `→ ${kcal} kcal · P:${pro}g · C:${carb}g · F:${fat}g` : '';
};

function _fillFridgeMacros(item, n, tot) {
  const kcal = Math.round((item.total_kcal||0) * n / tot);
  const pro = parseFloat(((item.total_protein||0) * n / tot).toFixed(1));
  const carb = parseFloat(((item.total_carbs||0) * n / tot).toFixed(1));
  const fat = parseFloat(((item.total_fats||0) * n / tot).toFixed(1));
  const sliceLabel = (item.slices > 0 && n > 0) ? ` (${n} ${n === 1 ? 'fetta' : 'fette'})` : '';
  const nameEl = document.getElementById('am-name');
  const kcalEl = document.getElementById('am-kcal');
  const proEl = document.getElementById('am-protein');
  const carbEl = document.getElementById('am-carbs');
  const fatEl = document.getElementById('am-fats');
  if (nameEl && !nameEl.value) nameEl.value = item.name + sliceLabel;
  else if (nameEl) nameEl.value = item.name + sliceLabel;
  if (kcalEl) kcalEl.value = kcal;
  if (proEl) proEl.value = pro;
  if (carbEl) carbEl.value = carb;
  if (fatEl) fatEl.value = fat;
}

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

  // Scala le fette dalla Dispensa se il pasto proviene da essa
  if (_selectedFridgeIdx >= 0 && fridgeItems[_selectedFridgeIdx]) {
    const fi = fridgeItems[_selectedFridgeIdx];
    _selectedFridgeIdx = -1;
    if (fi.slices > 0) {
      const slicesUsed = parseInt(document.getElementById('am-fridge-slices')?.value) || 1;
      const newRem = Math.max(0, (fi.slices_remaining ?? fi.slices) - slicesUsed);
      updateFridgeItem(fi.id, { slices_remaining: newRem }).then(() => {
        const idx = fridgeItems.findIndex(x => x.id === fi.id);
        if (idx >= 0) fridgeItems[idx] = { ...fi, slices_remaining: newRem };
        if (newRem === 0) {
          removeFridgeItem(fi.id).then(() => {
            fridgeItems = fridgeItems.filter(x => x.id !== fi.id);
          }).catch(() => {});
          showToast('🎉 Ultime fette consumate! Piatto rimosso dalla Dispensa.');
        }
        buildMeals();
      }).catch(() => {});
    } else {
      // Piatto senza fette: rimuovi dalla dispensa
      removeFridgeItem(fi.id).then(() => {
        fridgeItems = fridgeItems.filter(x => x.id !== fi.id);
        buildMeals();
      }).catch(() => {});
    }
  } else {
    _selectedFridgeIdx = -1;
    buildMeals();
  }
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

  // Track AI correction if user is overriding a previous AI estimate
  const prevOverride = logData.meals_overrides?.[mealIndex];
  if (prevOverride?.ai_estimate && prevOverride.ai_estimate.kcal > 0) {
    const aiEst = prevOverride.ai_estimate;
    const userVals = { kcal, protein, carbs, fats };
    // Only track if there's a meaningful difference (>5%)
    const diffPct = Math.abs(kcal - aiEst.kcal) / Math.max(aiEst.kcal, 1);
    if (diffPct > 0.05) {
      const foodName = note || prevOverride.items_text || '';
      if (foodName.length > 1) {
        saveAICorrection(foodName, aiEst, userVals);
      }
    }
  }

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

const DAYS_SHORT = ['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];

function computeWeeklyAdherence() {
  const logs = _weeklyLogsCache || [];
  const today = new Date();
  const result = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const dayIdx = (d.getDay() + 6) % 7;
    const dayLabel = DAYS_SHORT[dayIdx];
    const log = logs.find(l => (l.date || l.id) === dateStr);
    if (!log || (!log.nutrition?.totals?.kcal && !log.nutrition?.kcal && !log.workout?.completed)) {
      result.push({ dayLabel, date: dateStr, hasData: false, score: 0 });
      continue;
    }
    const todayDow = getDayOfWeek(dateStr);
    const scheduleDay = activeProgram?.schedule?.[todayDow];
    const isOn = !!(scheduleDay && scheduleDay !== 'off' && scheduleDay !== 'rest');
    const dayKey = isOn ? 'day_on' : 'day_off';
    const plan = activeDiet?.[dayKey];
    const fs = calcFitScore({
      log, plan, isOn,
      objective: activeProgram?.objective || 'recomposizione',
      stepsGoal: appSettings?.steps_goal || 0
    });
    result.push({ dayLabel, date: dateStr, hasData: true, score: fs?.score || 0 });
  }
  return result;
}

function buildAdvisorContext() {
  const p = appSettings?.profile || {};
  const tots = calcTotals();
  const partOfDay = getPartOfDay();
  const dayKey = isTrainingDay ? 'day_on' : 'day_off';
  const plan = activeDiet?.[dayKey];

  // Età
  let age = '';
  if (p.dob) {
    const dob = new Date(p.dob);
    const now = new Date();
    age = now.getFullYear() - dob.getFullYear();
    const m = now.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  }

  // Target macro
  const targetKcal = plan?.kcal || 0;
  const targetProtein = plan?.protein || 0;
  const targetCarbs = plan?.carbs || 0;
  const targetFats = plan?.fats || 0;

  // Percentuali raggiungimento
  const kcalPct = targetKcal > 0 ? Math.round((tots.kcal / targetKcal) * 100) : 0;
  const proteinPct = targetProtein > 0 ? Math.round((tots.protein / targetProtein) * 100) : 0;
  const carbsPct = targetCarbs > 0 ? Math.round((tots.carbs / targetCarbs) * 100) : 0;
  const fatsPct = targetFats > 0 ? Math.round((tots.fats / targetFats) * 100) : 0;

  // Pasti del piano: fatti e rimanenti
  const planMeals = plan?.meals || [];
  const eatenMeals = [];
  const remainingMeals = [];
  planMeals.forEach((m, i) => {
    const eaten = !!mealStates?.[i]?.eaten;
    const mInfo = { label: m.label || m.type, kcal: m.kcal || 0, protein: m.protein || 0, carbs: m.carbs || 0, fats: m.fats || 0 };
    if (eaten) eatenMeals.push(mInfo.label);
    else remainingMeals.push(mInfo);
  });
  const eatenExtra = (logData.extra_meals || []).filter(m => m.eaten !== false).map(m => m.name);
  const allEaten = eatenMeals.concat(eatenExtra);

  // Workout info
  const wk = logData.workout;
  const workoutDone = !!wk?.completed;
  let workoutDurationMin = null;
  let workoutVolumeKg = null;
  if (workoutDone && wk) {
    workoutDurationMin = wk.duration_seconds ? Math.round(wk.duration_seconds / 60) : null;
    workoutVolumeKg = wk.total_volume ? Math.round(wk.total_volume) : null;
  }
  const todayDow = getDayOfWeek(TODAY);
  const scheduleDay = activeProgram?.schedule?.[todayDow];
  const plannedSession = isTrainingDay
    ? (typeof scheduleDay === 'string' ? scheduleDay : scheduleDay?.name || 'Sessione')
    : null;

  // Body trend
  const weightTrend = recentChecks
    .filter(c => c.weight)
    .map(c => ({ date: c.date, weight: c.weight }));
  const bfTrend = recentChecks
    .filter(c => c.body_fat)
    .map(c => ({ date: c.date, bf: c.body_fat }));

  // Dispensa: solo piatti con porzioni disponibili
  const availableFridge = fridgeItems
    .filter(f => f.slices_remaining == null || f.slices_remaining > 0)
    .map(f => ({
      name: f.name,
      kcal: Math.round(f.total_kcal / (f.slices || 1)),
      protein: Math.round(f.total_protein / (f.slices || 1)),
      carbs: Math.round(f.total_carbs / (f.slices || 1)),
      fats: Math.round(f.total_fats / (f.slices || 1)),
      slices_remaining: f.slices_remaining
    }));

  // Recovery plan
  const recoveryPlan = calcRecoveryPlan({
    weeklyLogs: _weeklyLogsCache || [],
    activeDiet, activeProgram, appSettings, today: TODAY
  });

  // Weekly adherence
  const adherence = computeWeeklyAdherence();

  return {
    profile: {
      name: p.name, sex: p.sex, age, height: p.height,
      weight_target: p.weight_target, fat_target: p.fat_target,
      steps_goal: p.steps_goal || 10000
    },
    body: {
      current_weight: latestCheck?.weight || null,
      weight_trend: weightTrend,
      body_fat: latestCheck?.body_fat || null,
      muscle_mass: latestCheck?.muscle_mass || null,
      body_fat_trend: bfTrend
    },
    today: {
      part_of_day: partOfDay,
      is_training_day: isTrainingDay,
      kcal: Math.round(tots.kcal), protein: Math.round(tots.protein),
      carbs: Math.round(tots.carbs), fats: Math.round(tots.fats),
      target_kcal: targetKcal, target_protein: targetProtein,
      target_carbs: targetCarbs, target_fats: targetFats,
      kcal_pct: kcalPct, protein_pct: proteinPct,
      carbs_pct: carbsPct, fats_pct: fatsPct,
      meals_eaten: allEaten.length ? allEaten.join(', ') : 'Nessuno',
      meals_remaining: remainingMeals,
      workout_done: workoutDone,
      workout_session: workoutDone ? (wk?.session_name || plannedSession) : null,
      workout_duration_min: workoutDurationMin,
      workout_volume_kg: workoutVolumeKg,
      planned_session: plannedSession,
      steps: logData.steps || 0,
      smart_score: _weeklyScoreCache
    },
    weekly: {
      recovery_status: recoveryPlan?.recoveryStatus || 'on_track',
      kcal_delta: recoveryPlan?.kcalWeeklyDelta || 0,
      protein_delta: recoveryPlan?.proteinWeeklyDelta || 0,
      carbs_delta: recoveryPlan?.carbsWeeklyDelta || 0,
      fats_delta: recoveryPlan?.fatsWeeklyDelta || 0,
      workouts_completed: recoveryPlan?.workoutsCompleted || 0,
      workouts_planned: recoveryPlan?.workoutsPlanned || 0,
      workouts_missed: recoveryPlan?.workoutsMissed || 0,
      avg_steps: recoveryPlan?.avgDailySteps || 0,
      adherence_pattern: adherence,
      actions: recoveryPlan?.actions || [],
      today_adjusted_kcal: recoveryPlan?.todayAdjustedKcal || null,
      today_adjusted_protein: recoveryPlan?.todayAdjustedProtein || null
    },
    fridge: availableFridge,
    program: {
      name: activeProgram?.name || null,
      objective: activeProgram?.objective || null
    }
  };
}

function generateLocalAdvice({ profile, activeDiet, activeProgram, dailyState, partOfDay }) {
  const name = profile?.name || 'Campione';
  const steps = dailyState?.steps || 0;
  const goalSteps = profile?.steps_goal || 0;
  const tots = calcTotals();
  const dayKey = dailyState?.isTrainingDay ? 'day_on' : 'day_off';
  const plan = activeDiet?.[dayKey];
  const targetKcal = plan?.kcal || 2000;
  const targetProtein = plan?.protein || 0;
  const targetFats = plan?.fats || 0;
  const kcalDiff = targetKcal - tots.kcal;
  const proteinDiff = targetProtein - tots.protein;
  const fatsDiff = targetFats - tots.fats;

  if (partOfDay === 'mattina') {
    const dayType = dailyState?.isTrainingDay ? 'allenamento' : 'riposo';
    return `Buongiorno, **${name}**! Oggi è giorno di **${dayType}**. Target: **${targetKcal} kcal**, **${targetProtein}g** proteine, **${targetFats}g** grassi. ${dailyState?.isTrainingDay ? 'Colazione proteica e idratazione! 🏋️' : 'Recupero e alimentazione in target! 🛀'}`;
  } else if (partOfDay === 'pomeriggio') {
    const kcalSoFar = Math.round(tots.kcal);
    const proSoFar = Math.round(tots.protein);
    let macroNote = '';
    if (proteinDiff > 30) macroNote = ` Proteine: **${proSoFar}/${targetProtein}g**.`;
    if (fatsDiff > 15 && targetFats > 0) macroNote += ` Grassi sotto target.`;
    if (kcalDiff > 200) {
      return `**${kcalSoFar}/${targetKcal} kcal** consumate.${macroNote} ${dailyState?.isTrainingDay && !dailyState?.workoutDone ? "Ricorda l'allenamento! 💪" : 'Continua così! ⚡'}`;
    } else {
      return `**${name}**, sei in linea con **${kcalSoFar} kcal**.${macroNote} ${dailyState?.isTrainingDay && !dailyState?.workoutDone ? "Hai ancora l'allenamento! 🏋️" : 'Ottima gestione! ✅'}`;
    }
  } else {
    const parts = [];
    if (kcalDiff > 100) parts.push(`**${Math.round(kcalDiff)} kcal** sotto target`);
    else if (kcalDiff < -100) parts.push(`**+${Math.round(Math.abs(kcalDiff))} kcal** sopra target`);
    else parts.push(`calorie in target ✅`);

    if (targetProtein > 0) {
      const proPct = Math.round((tots.protein / targetProtein) * 100);
      parts.push(`proteine al **${proPct}%**`);
    }
    if (targetFats > 0 && fatsDiff > 15) parts.push(`grassi sotto target ⚠️`);
    if (goalSteps > 0) {
      if (steps >= goalSteps) parts.push(`passi raggiunti 🏅`);
      else parts.push(`**${steps}/${goalSteps}** passi`);
    }
    return `Buonasera **${name}**! ${parts.join(', ')}. ${kcalDiff > 100 ? 'Valuta uno spuntino pre-nanna. 🥩' : 'Ottima giornata! 🌟'}`;
  }
}

async function buildSmartAdvisor() {
  const box = document.getElementById('smart-advisor-box');
  if (!box) return;

  const partOfDay = getPartOfDay();
  const advice = logData.smart_advice?.[partOfDay];

  await loadWeeklyLogsForScore();

  // Compatibilità: formato vecchio (string) e nuovo ({text, insights})
  const adviceText = typeof advice === 'string' ? advice : advice?.text;
  const adviceInsights = typeof advice === 'object' && advice?.insights ? advice.insights : [];

  if (adviceText) {
    renderSmartAdvisorContent(adviceText, adviceInsights);
    return;
  }

  const cachedKey = `fittracker_advice_${TODAY}_${partOfDay}`;
  const cachedRaw = safeLocalStorage.getItem(cachedKey);

  if (cachedRaw) {
    let parsed = cachedRaw;
    let cachedInsights = [];
    try {
      const obj = JSON.parse(cachedRaw);
      if (obj && obj.text) { parsed = obj.text; cachedInsights = obj.insights || []; }
    } catch(e) { /* formato vecchio, è una stringa semplice */ }

    if (!logData.smart_advice) logData.smart_advice = {};
    logData.smart_advice[partOfDay] = { text: parsed, insights: cachedInsights };
    saveToLocal();
    renderSmartAdvisorContent(parsed, cachedInsights);
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

function renderSmartAdvisorContent(text, insights = []) {
  const box = document.getElementById('smart-advisor-box');
  if (!box) return;

  const formattedText = text
    .replace(/\*\*(.*?)\*\*/g, '<b style="color:var(--t1)">$1</b>')
    .replace(/\n/g, '<br>');

  // Calcola status dal recovery plan corrente
  const recoveryPlan = calcRecoveryPlan({
    weeklyLogs: _weeklyLogsCache || [],
    activeDiet, activeProgram, appSettings, today: TODAY
  });

  let statusClass = 'status-on_track';
  let badgeText = 'IN CARREGGIATA';

  if (recoveryPlan) {
    const rs = recoveryPlan.recoveryStatus;
    if (rs === 'critical') { statusClass = 'status-critical'; badgeText = 'RECUPERO CRITICO'; }
    else if (rs === 'needs_recovery') { statusClass = 'status-needs_recovery'; badgeText = 'RECUPERO CONSIGLIATO'; }
    else if (rs === 'slight_deviation') { statusClass = 'status-slight_deviation'; badgeText = 'DEVIAZIONE LIEVE'; }
    else {
      // Check se serve status "focus" (on track ma un macro richiede attenzione)
      const hasWarning = insights.some(ins => ins.status === 'warning' || ins.status === 'critical');
      if (hasWarning) { statusClass = 'status-focus'; badgeText = 'FOCUS'; }
    }
  }

  // Weekly adherence dots
  const adherence = computeWeeklyAdherence();
  const dotsHtml = `
    <div class="advisor-weekly-dots">
      ${adherence.map(d => {
        let dotClass = 'dot-none';
        if (d.hasData) {
          if (d.score >= 75) dotClass = 'dot-good';
          else if (d.score >= 45) dotClass = 'dot-warning';
          else dotClass = 'dot-bad';
        }
        return `<div class="weekly-dot-wrap">
          <div class="weekly-dot ${dotClass}" title="${d.dayLabel}: ${d.hasData ? d.score + '/100' : 'nessun dato'}"></div>
          <div class="weekly-dot-label">${d.dayLabel}</div>
        </div>`;
      }).join('')}
    </div>`;

  // Insight pills
  let insightsHtml = '';
  if (insights && insights.length > 0) {
    insightsHtml = `
      <div class="advisor-insights">
        ${insights.slice(0, 5).map(ins => {
          const statusCls = ins.status === 'good' ? 'insight-good' : ins.status === 'critical' ? 'insight-critical' : 'insight-warning';
          return `<div class="insight-pill ${statusCls}">
            <span class="insight-label">${ins.label}</span>
            <span class="insight-value">${ins.value}</span>
          </div>`;
        }).join('')}
      </div>`;
  }

  // Recovery actions
  let actionsHtml = '';
  if (recoveryPlan?.actions?.length > 0) {
    actionsHtml = `
      <div style="margin-top: 14px; margin-bottom: 4px;">
        <div style="font-size: 10px; font-weight: 800; color: var(--t3); letter-spacing: 1px; text-transform: uppercase; margin-bottom: 8px;">Azioni Suggerite</div>
        <div class="advisor-actions">
          ${recoveryPlan.actions.map(act => {
            let clickJs = '';
            if (act.type === 'meal') clickJs = `location.href='diet.html'`;
            else if (act.type === 'activity') clickJs = `window.openStepsModal ? window.openStepsModal() : document.getElementById('steps-card').click()`;
            else clickJs = `location.href='session.html'`;
            return `
              <div class="action-item" onclick="${clickJs}">
                <div class="action-left">
                  <span class="action-icon">${act.icon}</span>
                  <span class="action-label">${act.label}</span>
                </div>
                <div class="action-right">
                  <span class="action-value">${act.value}</span>
                  <div class="action-btn-mini"><i class="ri-arrow-right-s-line"></i></div>
                </div>
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  box.innerHTML = `
    <div class="advisor-card ${statusClass}">
      <div class="advisor-header">
        <div class="advisor-title">KOVA SMART ADVISOR</div>
        <div class="recovery-badge">${badgeText}</div>
      </div>
      ${dotsHtml}
      <div id="smart-advisor-content" class="advisor-body">
        ${formattedText}
      </div>
      ${insightsHtml}
      ${actionsHtml}
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

  await loadWeeklyLogsForScore();

  const ctx = buildAdvisorContext();

  try {
    let finalAdvice = '';
    let finalInsights = [];

    const r = await generateAdvisor360AI(ctx);

    if (r.success && r.advice) {
      finalAdvice = r.advice;
      finalInsights = r.insights || [];
    } else {
      if (!silent && r.error && r.error.includes('Key')) {
        showToast('Configura la Gemini API Key in Impostazioni per consigli AI avanzati!', 'info');
      }
      finalAdvice = generateLocalAdvice({
        profile: appSettings?.profile,
        activeDiet,
        activeProgram,
        dailyState: {
          steps: logData.steps || 0,
          kcal: Math.round(ctx.today.kcal),
          protein: Math.round(ctx.today.protein),
          carbs: Math.round(ctx.today.carbs),
          fats: Math.round(ctx.today.fats),
          isTrainingDay,
          workoutDone: ctx.today.workout_done,
        },
        partOfDay
      });
    }

    if (!logData.smart_advice) logData.smart_advice = {};
    logData.smart_advice[partOfDay] = { text: finalAdvice, insights: finalInsights };

    const cachedKey = `fittracker_advice_${TODAY}_${partOfDay}`;
    safeLocalStorage.setItem(cachedKey, JSON.stringify({ text: finalAdvice, insights: finalInsights }));

    saveToLocal();
    await syncToFirebase();
    renderSmartAdvisorContent(finalAdvice, finalInsights);

  } catch(e) {
    console.error('Advisor error:', e);
    const localAdvice = generateLocalAdvice({
      profile: appSettings?.profile,
      activeDiet,
      activeProgram,
      dailyState: {
        steps: logData.steps || 0,
        kcal: Math.round(ctx.today.kcal),
        protein: Math.round(ctx.today.protein),
        carbs: Math.round(ctx.today.carbs),
        fats: Math.round(ctx.today.fats),
        isTrainingDay,
        workoutDone: ctx.today.workout_done,
      },
      partOfDay
    });

    if (!logData.smart_advice) logData.smart_advice = {};
    logData.smart_advice[partOfDay] = { text: localAdvice, insights: [] };

    const cachedKey = `fittracker_advice_${TODAY}_${partOfDay}`;
    safeLocalStorage.setItem(cachedKey, JSON.stringify({ text: localAdvice, insights: [] }));

    saveToLocal();
    await syncToFirebase();
    renderSmartAdvisorContent(localAdvice, []);
  } finally {
    isGeneratingAdvice = false;
    if (refreshIcon) refreshIcon.classList.remove('ri-spin');
  }
};

// ── Dispensa (Fridge) ──────────────────────────────────────

async function loadFridgeFromFirebase() {
  if (!getUserId()) return;
  try {
    const snap = await getDocs(collection(db, 'users', getUserId(), 'fridge'));
    fridgeItems = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    fridgeItems.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  } catch(e) {
    console.warn('Fridge load error:', e.message);
  }
}

async function saveFridgeItem(item) {
  const ref = await addDoc(collection(db, 'users', getUserId(), 'fridge'), item);
  return ref.id;
}

async function updateFridgeItem(id, data) {
  await setDoc(doc(db, 'users', getUserId(), 'fridge', id), data, { merge: true });
}

async function removeFridgeItem(id) {
  await deleteDoc(doc(db, 'users', getUserId(), 'fridge', id));
}

function buildFridgeHtml() {
  if (!getUserId()) return '';
  const items = fridgeItems;
  const hasItems = items.length > 0;

  const itemsHtml = items.map((item, idx) => {
    const hasSlices = item.slices > 0;
    const remSlices = hasSlices ? (item.slices_remaining ?? item.slices) : null;
    const totSlices = item.slices || 1;
    const remPct = hasSlices ? Math.round((remSlices / totSlices) * 100) : 100;
    const barColor = remPct > 50 ? 'var(--green)' : remPct > 20 ? 'var(--yellow)' : '#ef4444';
    const perSliceKcal = hasSlices ? Math.round((item.total_kcal || 0) / totSlices) : (item.total_kcal || 0);
    const perSlicePro = hasSlices ? ((item.total_protein || 0) / totSlices).toFixed(1) : (item.total_protein || 0);
    const perSliceCarb = hasSlices ? ((item.total_carbs || 0) / totSlices).toFixed(1) : (item.total_carbs || 0);
    const perSliceFat = hasSlices ? ((item.total_fats || 0) / totSlices).toFixed(1) : (item.total_fats || 0);
    const statusText = hasSlices
      ? `${remSlices}/${totSlices} fette rimaste`
      : 'Disponibile';
    return `
      <div style="background:var(--bg);border-radius:10px;padding:10px 12px;border:1px solid rgba(255,255,255,0.06)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:${hasSlices ? '6px' : '4px'}">
          <div style="flex:1;min-width:0;margin-right:8px">
            <div style="font-size:13px;font-weight:700;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.name}</div>
            <div style="font-size:11px;color:var(--t3);margin-top:2px">
              ${hasSlices ? `Per fetta: ${perSliceKcal} kcal · P:${perSlicePro}g C:${perSliceCarb}g F:${perSliceFat}g` : `Totale: ${item.total_kcal||0} kcal · P:${item.total_protein||0}g C:${item.total_carbs||0}g F:${item.total_fats||0}g`}
            </div>
          </div>
          <button onclick="window.deleteFridgeItemUI(${idx})" style="background:none;border:none;color:var(--t3);cursor:pointer;padding:4px 6px;font-size:14px;flex-shrink:0">
            <i class="ri-delete-bin-line"></i>
          </button>
        </div>
        ${hasSlices ? `
        <div style="display:flex;gap:8px;align-items:center">
          <div style="flex:1;height:3px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden">
            <div style="height:100%;width:${remPct}%;background:${barColor};border-radius:2px"></div>
          </div>
          <span style="font-size:11px;color:var(--t2);white-space:nowrap;font-weight:600">${statusText}</span>
        </div>` : `<div style="font-size:11px;color:rgb(20,184,166);font-weight:600">${statusText}</div>`}
      </div>`;
  }).join('');

  return `
    <div class="card" style="margin-bottom:12px;background:rgba(20,184,166,0.04);border:1px solid rgba(20,184,166,0.25)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:${hasItems ? '10px' : '0'}">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:15px">❄️</span>
          <div>
            <div style="font-size:12px;font-weight:800;color:rgb(20,184,166);letter-spacing:0.5px">DISPENSA</div>
            <div style="font-size:10px;color:var(--t3)">${hasItems ? `${items.length} piatt${items.length === 1 ? 'o' : 'i'} salvat${items.length === 1 ? 'o' : 'i'} · seleziona da "Aggiungi Pasto"` : 'Vuota — aggiungi un piatto preparato'}</div>
          </div>
        </div>
        <button class="btn btn-ghost btn-sm" style="font-size:11px;border-color:rgba(20,184,166,0.4);color:rgb(20,184,166)" onclick="window.openAddFridgeModal()">
          <i class="ri-add-line"></i> Aggiungi
        </button>
      </div>
      ${hasItems ? `<div style="display:flex;flex-direction:column;gap:8px">${itemsHtml}</div>` : ''}
    </div>`;
}

window.openAddFridgeModal = function() {
  const bg = document.createElement('div');
  bg.className = 'modal-bg fridge-modal';
  bg.innerHTML = `
    <div class="modal" style="max-height:88vh;overflow-y:auto">
      <div class="modal-handle"></div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
        <span style="font-size:18px">❄️</span>
        <h3 style="margin:0;color:rgb(20,184,166)">Aggiungi alla Dispensa</h3>
      </div>

      <div class="fg">
        <label class="fl">Nome ricetta / piatto *</label>
        <input id="fr-name" class="fi" placeholder="Es: Lasagna, Torta cioccolato, Risotto...">
      </div>

      <div style="background:rgba(20,184,166,0.06);border:1px solid rgba(20,184,166,0.18);border-radius:10px;padding:12px;margin:12px 0">
        <div style="font-size:11px;color:rgb(20,184,166);font-weight:700;margin-bottom:8px">🤖 CALCOLA CON AI (consigliato)</div>
        <textarea id="fr-ai-text" class="fi" rows="3" placeholder="Elenca tutti gli ingredienti totali della ricetta&#10;Es: 500g farina, 4 uova, 200g burro, 150g zucchero, 100g cacao..."></textarea>
        <button id="fr-ai-btn" class="btn btn-ghost btn-sm" style="width:100%;margin-top:8px;border-color:rgba(20,184,166,0.5);color:rgb(20,184,166)" onclick="window.calcFridgeAI()">
          <i class="ri-robot-2-line"></i> Calcola macro totali con AI
        </button>
      </div>

      <div style="font-size:11px;color:var(--t2);font-weight:700;letter-spacing:0.5px;margin-bottom:8px">MACRO TOTALI DEL PIATTO *</div>
      <div class="fmp" style="margin-bottom:12px">
        <div class="fmp-item">
          <input type="number" class="fi" id="fr-kcal" placeholder="0" oninput="window.updateFridgeSlicePreview()">
          <div class="fmp-l">Kcal</div>
        </div>
        <div class="fmp-item">
          <input type="number" class="fi" id="fr-protein" placeholder="0" oninput="window.updateFridgeSlicePreview()">
          <div class="fmp-l">Prot g</div>
        </div>
        <div class="fmp-item">
          <input type="number" class="fi" id="fr-carbs" placeholder="0" oninput="window.updateFridgeSlicePreview()">
          <div class="fmp-l">Carbo g</div>
        </div>
        <div class="fmp-item">
          <input type="number" class="fi" id="fr-fats" placeholder="0" oninput="window.updateFridgeSlicePreview()">
          <div class="fmp-l">Grassi g</div>
        </div>
      </div>

      <div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:12px;margin-bottom:12px">
        <div style="font-size:11px;color:var(--t2);font-weight:700;letter-spacing:0.5px;margin-bottom:8px">🍕 DIVIDI IN FETTE / PORZIONI (opzionale)</div>
        <div style="display:flex;align-items:center;gap:10px">
          <input type="number" class="fi" id="fr-slices" placeholder="Es: 8" min="1" style="flex:1" oninput="window.updateFridgeSlicePreview()">
          <span style="font-size:12px;color:var(--t2)">fette / porzioni</span>
        </div>
        <div id="fr-slice-preview" style="font-size:12px;color:rgb(20,184,166);margin-top:8px;min-height:16px;font-weight:600"></div>
      </div>

      <div class="fg">
        <label class="fl">Note (opzionale)</label>
        <input id="fr-note" class="fi" placeholder="Es: Fatta il 5 giugno, si conserva 4 giorni in frigo...">
      </div>

      <div class="modal-btns" style="margin-top:16px">
        <button class="btn btn-flat btn-cancel" onclick="this.closest('.modal-bg').remove()">Annulla</button>
        <button class="btn btn-ok" style="background:rgba(20,184,166,0.2);border:1px solid rgb(20,184,166);color:rgb(20,184,166)" onclick="window.confirmAddFridge()">
          <i class="ri-save-line"></i> Salva in Dispensa
        </button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  bg.addEventListener('click', e => { if (e.target === bg) bg.remove(); });
};

window.updateFridgeSlicePreview = function() {
  const slices = parseInt(document.getElementById('fr-slices')?.value) || 0;
  const kcal = parseFloat(document.getElementById('fr-kcal')?.value) || 0;
  const protein = parseFloat(document.getElementById('fr-protein')?.value) || 0;
  const carbs = parseFloat(document.getElementById('fr-carbs')?.value) || 0;
  const fats = parseFloat(document.getElementById('fr-fats')?.value) || 0;
  const preview = document.getElementById('fr-slice-preview');
  if (!preview) return;
  if (slices > 1 && kcal > 0) {
    preview.textContent = `→ Per fetta: ${Math.round(kcal/slices)} kcal · P:${(protein/slices).toFixed(1)}g · C:${(carbs/slices).toFixed(1)}g · F:${(fats/slices).toFixed(1)}g`;
  } else {
    preview.textContent = '';
  }
};

window.calcFridgeAI = async function() {
  const text = document.getElementById('fr-ai-text')?.value.trim();
  if (!text) { showToast('Descrivi gli ingredienti della ricetta', 'err'); return; }
  const btn = document.getElementById('fr-ai-btn');
  if (btn) { btn.innerHTML = '<i class="ri-loader-4-line ri-spin"></i> Calcolo...'; btn.disabled = true; }
  const r = await calcMacrosFromText(text);
  if (btn) { btn.innerHTML = '<i class="ri-robot-2-line"></i> Calcola macro totali con AI'; btn.disabled = false; }
  if (!r.success) { showToast('Errore AI: ' + r.error, 'err'); return; }
  const setV = (id, v) => { const el = document.getElementById(id); if (el) el.value = parseFloat(v.toFixed(1)); };
  setV('fr-kcal', r.kcal);
  setV('fr-protein', r.protein);
  setV('fr-carbs', r.carbs);
  setV('fr-fats', r.fats);
  window.updateFridgeSlicePreview();
  showToast('✅ Macro totali calcolati!');
};

window.confirmAddFridge = async function() {
  const name = document.getElementById('fr-name')?.value.trim();
  const kcal = parseFloat(document.getElementById('fr-kcal')?.value) || 0;
  const protein = parseFloat(document.getElementById('fr-protein')?.value) || 0;
  const carbs = parseFloat(document.getElementById('fr-carbs')?.value) || 0;
  const fats = parseFloat(document.getElementById('fr-fats')?.value) || 0;
  const slices = parseInt(document.getElementById('fr-slices')?.value) || 0;
  const note = document.getElementById('fr-note')?.value.trim() || '';
  if (!name) { showToast('Inserisci il nome del piatto', 'err'); return; }
  if (kcal < 1) { showToast('Inserisci le kcal totali (usa AI o inseriscile manualmente)', 'err'); return; }
  const item = {
    name,
    total_kcal: kcal, total_protein: protein, total_carbs: carbs, total_fats: fats,
    slices: slices > 1 ? slices : null,
    slices_remaining: slices > 1 ? slices : null,
    note, created_at: new Date().toISOString().split('T')[0]
  };
  try {
    const id = await saveFridgeItem(item);
    fridgeItems.unshift({ id, ...item });
    document.querySelector('.modal-bg.fridge-modal')?.remove();
    buildMeals();
    showToast('❄️ Piatto salvato in Dispensa!');
  } catch(e) {
    showToast('Errore salvataggio: ' + e.message, 'err');
  }
};

window.deleteFridgeItemUI = async function(idx) {
  const item = fridgeItems[idx];
  if (!item) return;
  if (!confirm(`Eliminare "${item.name}" dalla Dispensa?`)) return;
  try {
    await removeFridgeItem(item.id);
    fridgeItems.splice(idx, 1);
    buildMeals();
    showToast('🗑️ Rimosso dalla Dispensa.');
  } catch(e) {
    showToast('Errore: ' + e.message, 'err');
  }
};

(async function() {
  await requireAuth();
  init();
})();