import { db, USER_ID, collection, doc, getDoc, getDocs, query, where, orderBy } from './firebase-config.js';
import { getTodayString, formatDateDisplay, showToast, setProgress, setText, DEFAULT_TARGETS } from './app.js';

const today = getTodayString();

function isOff() {
  return localStorage.getItem(`dayType_${today}`) === 'off';
}

function updateDayTypeUI(off) {
  const label = document.getElementById('day-type-label');
  if (label) label.textContent = off ? 'OFF' : 'ON';
}

async function loadTargets() {
  try {
    const ref = doc(db, 'users', USER_ID, 'settings', 'targets');
    const snap = await getDoc(ref);
    return snap.exists() ? snap.data() : { ...DEFAULT_TARGETS };
  } catch {
    return { ...DEFAULT_TARGETS };
  }
}

async function loadTodayMeals(targets, off) {
  const suffix = off ? '_off' : '_on';
  const kcalTarget   = targets[`kcal_on`]    || DEFAULT_TARGETS.kcal_on;
  const proteinTarget = targets[`protein_on`] || DEFAULT_TARGETS.protein_on;
  const carbsTarget  = targets[`carbs_on`]   || DEFAULT_TARGETS.carbs_on;
  const fatsTarget   = targets[`fats_on`]    || DEFAULT_TARGETS.fats_on;

  const tKcal    = targets[`kcal${suffix}`]    ?? DEFAULT_TARGETS[`kcal${suffix}`];
  const tProtein = targets[`protein${suffix}`] ?? DEFAULT_TARGETS[`protein${suffix}`];
  const tCarbs   = targets[`carbs${suffix}`]   ?? DEFAULT_TARGETS[`carbs${suffix}`];
  const tFats    = targets[`fats${suffix}`]    ?? DEFAULT_TARGETS[`fats${suffix}`];

  let totalKcal = 0, totalProtein = 0, totalCarbs = 0, totalFats = 0;

  try {
    const ref = collection(db, 'users', USER_ID, 'meals');
    const q = query(ref, where('date', '==', today));
    const snap = await getDocs(q);
    snap.forEach(d => {
      const data = d.data();
      totalKcal    += data.kcal    || 0;
      totalProtein += data.protein || 0;
      totalCarbs   += data.carbs   || 0;
      totalFats    += data.fats    || 0;
    });
  } catch (e) {
    console.error('Errore caricamento pasti:', e);
  }

  setText('kcal-current',    Math.round(totalKcal));
  setText('kcal-target',     tKcal);
  setText('protein-current', Math.round(totalProtein));
  setText('protein-target',  tProtein);
  setText('carbs-current',   Math.round(totalCarbs));
  setText('carbs-target',    tCarbs);
  setText('fats-current',    Math.round(totalFats));
  setText('fats-target',     tFats);

  setProgress('progress-kcal',    totalKcal,    tKcal);
  setProgress('progress-protein', totalProtein, tProtein);
  setProgress('progress-carbs',   totalCarbs,   tCarbs);
  setProgress('progress-fats',    totalFats,    tFats);

  const remaining = tKcal - Math.round(totalKcal);
  const remEl = document.getElementById('kcal-remaining');
  if (remEl) {
    if (remaining >= 0) {
      remEl.textContent = `${remaining} kcal rimanenti`;
      remEl.style.color = 'var(--accent-green)';
    } else {
      remEl.textContent = `⚠️ ${Math.abs(remaining)} kcal in eccesso`;
      remEl.style.color = '#ff4444';
    }
  }
}

async function loadLastWorkout() {
  const container = document.getElementById('last-workout-content');
  if (!container) return;
  try {
    const ref = collection(db, 'users', USER_ID, 'workouts');
    const q = query(ref, orderBy('date', 'desc'));
    const snap = await getDocs(q);
    if (snap.empty) {
      container.innerHTML = `<p style="color:var(--text-secondary)">Nessun allenamento ancora 💪</p>`;
      return;
    }
    const data = snap.docs[0].data();
    const nEsercizi = Array.isArray(data.exercises) ? data.exercises.length : 0;
    container.innerHTML = `
      <p style="font-size:18px;font-weight:700;margin-bottom:4px">${data.name || 'Allenamento'}</p>
      <p style="font-size:13px;color:var(--text-secondary)">${formatDateDisplay(data.date)} · ${nEsercizi} esercizi</p>
    `;
  } catch (e) {
    console.error('Errore caricamento ultimo workout:', e);
    container.innerHTML = `<p style="color:var(--text-secondary)">Errore nel caricamento</p>`;
  }
}

async function init() {
  const dateEl = document.getElementById('today-date');
  if (dateEl) dateEl.textContent = formatDateDisplay(today);

  const toggle = document.getElementById('day-toggle');
  const off = isOff();
  if (toggle) toggle.checked = off;
  updateDayTypeUI(off);

  if (toggle) {
    toggle.addEventListener('change', async () => {
      const nowOff = toggle.checked;
      localStorage.setItem(`dayType_${today}`, nowOff ? 'off' : 'on');
      updateDayTypeUI(nowOff);
      const targets = await loadTargets();
      await loadTodayMeals(targets, nowOff);
    });
  }

  try {
    const targets = await loadTargets();
    await Promise.all([
      loadTodayMeals(targets, off),
      loadLastWorkout()
    ]);
  } catch (e) {
    console.error('Errore inizializzazione dashboard:', e);
    showToast('Errore nel caricamento dati', 'error');
  }
}

init();
