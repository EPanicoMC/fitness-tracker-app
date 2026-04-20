import {
  db, USER_ID, collection, addDoc, getDocs, deleteDoc,
  doc, getDoc, query, where, orderBy, serverTimestamp
} from './firebase-config.js';
import {
  getTodayString, formatDateDisplay, showToast,
  setProgress, DEFAULT_TARGETS
} from './app.js';

// ─── STATO ────────────────────────────────────────────────────────────────────

let currentDate = getTodayString();

// ─── LISTA PASTI ──────────────────────────────────────────────────────────────

function showConfirmModal(message, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card">
      <h3>Conferma</h3>
      <p>${message}</p>
      <div class="modal-actions">
        <button class="btn-secondary" id="modal-cancel" style="padding:12px">Annulla</button>
        <button class="btn-danger" id="modal-confirm" style="padding:12px;border-radius:var(--radius);font-size:15px;width:100%">Elimina</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#modal-confirm').addEventListener('click', () => {
    overlay.remove();
    onConfirm();
  });
}

async function deleteMeal(id) {
  showConfirmModal('Eliminare questo pasto?', async () => {
    try {
      await deleteDoc(doc(db, 'users', USER_ID, 'meals', id));
      showToast('Pasto eliminato');
      await loadMeals(currentDate);
    } catch (e) {
      console.error(e);
      showToast('Errore durante eliminazione', 'error');
    }
  });
}

const MEAL_ORDER = ['colazione', 'pranzo', 'cena', 'spuntino'];
const MEAL_LABELS = {
  colazione: '🌅 Colazione',
  pranzo:    '☀️ Pranzo',
  cena:      '🌙 Cena',
  spuntino:  '🍎 Spuntino'
};

async function loadMeals(dateString) {
  const container = document.getElementById('meals-list');
  if (!container) return;
  container.innerHTML = '<div class="spinner"></div>';

  let targets = { ...DEFAULT_TARGETS };
  try {
    const ref = doc(db, 'users', USER_ID, 'settings', 'targets');
    const snap = await getDoc(ref);
    if (snap.exists()) targets = snap.data();
  } catch {}

  const isOff = localStorage.getItem(`dayType_${getTodayString()}`) === 'off';
  const suffix = isOff ? '_off' : '_on';
  const tKcal = targets[`kcal${suffix}`] ?? DEFAULT_TARGETS[`kcal${suffix}`];

  let totalKcal = 0, totalProtein = 0, totalCarbs = 0, totalFats = 0;
  const groups = { colazione: [], pranzo: [], cena: [], spuntino: [] };

  try {
    const ref = collection(db, 'users', USER_ID, 'meals');
    const q = query(ref, where('date', '==', dateString));
    const snap = await getDocs(q);

    snap.forEach(d => {
      const data = { id: d.id, ...d.data() };
      totalKcal    += data.kcal    || 0;
      totalProtein += data.protein || 0;
      totalCarbs   += data.carbs   || 0;
      totalFats    += data.fats    || 0;
      const type = data.meal_type || 'spuntino';
      if (groups[type]) groups[type].push(data);
      else groups['spuntino'].push(data);
    });
  } catch (e) {
    console.error('Errore caricamento pasti:', e);
  }

  const totalKcalEl    = document.getElementById('total-kcal');
  const totalProteinEl = document.getElementById('total-protein');
  const totalCarbsEl   = document.getElementById('total-carbs');
  const totalFatsEl    = document.getElementById('total-fats');
  if (totalKcalEl)    totalKcalEl.textContent    = Math.round(totalKcal);
  if (totalProteinEl) totalProteinEl.textContent = `${Math.round(totalProtein)}g`;
  if (totalCarbsEl)   totalCarbsEl.textContent   = `${Math.round(totalCarbs)}g`;
  if (totalFatsEl)    totalFatsEl.textContent     = `${Math.round(totalFats)}g`;
  setProgress('meals-progress-kcal', totalKcal, tKcal);

  const hasMeals = MEAL_ORDER.some(t => groups[t].length > 0);
  if (!hasMeals) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🥗</div>
        <p>Nessun pasto registrato</p>
      </div>`;
    return;
  }

  container.innerHTML = '';
  MEAL_ORDER.forEach(type => {
    const items = groups[type];
    if (items.length === 0) return;

    const sectionTitle = document.createElement('p');
    sectionTitle.className = 'meal-section-title';
    sectionTitle.textContent = MEAL_LABELS[type] || type;
    container.appendChild(sectionTitle);

    items.forEach(meal => {
      const card = document.createElement('div');
      card.className = 'meal-card';

      const macros = [
        meal.protein ? `P: ${Math.round(meal.protein)}g` : '',
        meal.carbs   ? `C: ${Math.round(meal.carbs)}g`   : '',
        meal.fats    ? `F: ${Math.round(meal.fats)}g`    : ''
      ].filter(Boolean).join(' · ');

      card.innerHTML = `
        <div class="meal-info">
          <h4>${meal.name || 'Pasto'}</h4>
          <p>${macros || '—'}</p>
          ${meal.notes ? `<p style="margin-top:2px;font-style:italic">${meal.notes}</p>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
          <span class="meal-kcal">${Math.round(meal.kcal || 0)}</span>
          <button class="btn-danger" data-id="${meal.id}">🗑️</button>
        </div>
      `;

      card.querySelector('.btn-danger').addEventListener('click', () => deleteMeal(meal.id));
      container.appendChild(card);
    });
  });
}

window.changeDate = function (delta) {
  const [y, m, d] = currentDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + delta);
  const newDate = date.toISOString().split('T')[0];
  const today = getTodayString();
  if (newDate > today) return;
  currentDate = newDate;

  const display = document.getElementById('current-date-display');
  if (display) display.textContent = formatDateDisplay(currentDate);

  const nextBtn = document.getElementById('next-day-btn');
  if (nextBtn) nextBtn.disabled = currentDate === today;

  loadMeals(currentDate);
};

// ─── FORM AGGIUNGI PASTO ─────────────────────────────────────────────────────

function setupKcalCalculation() {
  const inputs = document.querySelectorAll('.macro-input');
  inputs.forEach(input => {
    input.addEventListener('input', () => {
      const p = parseFloat(document.getElementById('meal-protein').value) || 0;
      const c = parseFloat(document.getElementById('meal-carbs').value)   || 0;
      const f = parseFloat(document.getElementById('meal-fats').value)    || 0;
      if (p > 0 || c > 0 || f > 0) {
        document.getElementById('meal-kcal').value = Math.round(p * 4 + c * 4 + f * 9);
      }
    });
  });
}

async function initMealForm() {
  const form = document.getElementById('meal-form');
  if (!form) return;

  const dateInput = document.getElementById('meal-date');
  if (dateInput) dateInput.value = getTodayString();

  setupKcalCalculation();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('meal-name').value.trim();
    const kcal = parseFloat(document.getElementById('meal-kcal').value) || 0;

    if (!name) { showToast('Inserisci il nome del pasto', 'error'); return; }
    if (kcal <= 0) { showToast('Inserisci le kcal o almeno un macro', 'error'); return; }

    const submitBtn = document.getElementById('submit-meal-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Salvando...';

    try {
      await addDoc(collection(db, 'users', USER_ID, 'meals'), {
        date:      document.getElementById('meal-date').value,
        meal_type: document.getElementById('meal-type').value,
        name,
        kcal,
        protein: parseFloat(document.getElementById('meal-protein').value) || 0,
        carbs:   parseFloat(document.getElementById('meal-carbs').value)   || 0,
        fats:    parseFloat(document.getElementById('meal-fats').value)    || 0,
        notes:   document.getElementById('meal-notes').value.trim(),
        createdAt: serverTimestamp()
      });
      showToast('Pasto salvato! 🥗');
      setTimeout(() => { window.location.href = 'meals.html'; }, 800);
    } catch (err) {
      console.error(err);
      showToast('Errore nel salvataggio', 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = '💾 Salva Pasto';
    }
  });
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

if (document.getElementById('meal-form')) {
  initMealForm();
} else if (document.getElementById('meals-list')) {
  const display = document.getElementById('current-date-display');
  if (display) display.textContent = formatDateDisplay(currentDate);
  const nextBtn = document.getElementById('next-day-btn');
  if (nextBtn) nextBtn.disabled = true;
  loadMeals(currentDate);
}
