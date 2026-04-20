import {
  db, USER_ID, collection, addDoc, getDocs, deleteDoc,
  doc, query, orderBy, serverTimestamp
} from './firebase-config.js';
import { formatDateDisplay, showToast, getTodayString } from './app.js';

// ─── LISTA WORKOUT ────────────────────────────────────────────────────────────

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

async function deleteWorkout(id) {
  showConfirmModal('Eliminare questo allenamento?', async () => {
    try {
      await deleteDoc(doc(db, 'users', USER_ID, 'workouts', id));
      showToast('Allenamento eliminato');
      await loadWorkouts();
    } catch (e) {
      console.error(e);
      showToast('Errore durante eliminazione', 'error');
    }
  });
}

async function loadWorkouts() {
  const container = document.getElementById('workout-list');
  if (!container) return;
  container.innerHTML = '<div class="spinner"></div>';

  try {
    const ref = collection(db, 'users', USER_ID, 'workouts');
    const q = query(ref, orderBy('date', 'desc'));
    const snap = await getDocs(q);

    if (snap.empty) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">💪</div>
          <p>Nessun allenamento ancora<br>Aggiungine uno!</p>
        </div>`;
      return;
    }

    container.innerHTML = '';
    snap.forEach(docSnap => {
      const data = docSnap.data();
      const id = docSnap.id;
      const exercises = Array.isArray(data.exercises) ? data.exercises : [];
      const nEx = exercises.length;
      const duration = data.duration ? `${data.duration} min` : '';

      const card = document.createElement('div');
      card.className = 'card';
      card.style.cursor = 'pointer';

      const exercisesHtml = exercises.map(ex => {
        const sets = Array.isArray(ex.sets) ? ex.sets : [];
        const setsHtml = sets.map(s => `<span style="font-size:12px;color:var(--text-secondary)">${s.reps || '—'} reps × ${s.weight || '—'} kg</span>`).join('<br>');
        return `
          <div style="margin-bottom:10px">
            <p style="font-size:14px;font-weight:600;margin-bottom:4px">${ex.name || 'Esercizio'}</p>
            ${setsHtml}
          </div>`;
      }).join('');

      const notesHtml = data.notes
        ? `<p style="font-size:13px;color:var(--text-secondary);margin-top:8px;font-style:italic">${data.notes}</p>`
        : '';

      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
          <div>
            <p style="font-size:17px;font-weight:700;margin-bottom:4px">${data.name || 'Allenamento'}</p>
            <p style="font-size:13px;color:var(--text-secondary)">${formatDateDisplay(data.date)}</p>
            <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">
              ${nEx > 0 ? `<span class="badge badge-on">${nEx} esercizi</span>` : ''}
              ${duration ? `<span class="badge badge-off">${duration}</span>` : ''}
            </div>
          </div>
          <button class="btn-danger" data-id="${id}">🗑️</button>
        </div>
        <div class="workout-detail" style="display:none;border-top:1px solid var(--border);padding-top:12px;margin-top:8px">
          ${exercisesHtml}
          ${notesHtml}
        </div>
      `;

      card.querySelector('.btn-danger').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteWorkout(id);
      });

      card.addEventListener('click', () => {
        const detail = card.querySelector('.workout-detail');
        detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
      });

      container.appendChild(card);
    });
  } catch (e) {
    console.error('Errore caricamento workout:', e);
    container.innerHTML = `<p style="color:var(--text-secondary);text-align:center;padding:24px">Errore nel caricamento</p>`;
  }
}

// ─── FORM NUOVO WORKOUT ───────────────────────────────────────────────────────

let exercises = [];

window.addExercise = function () {
  exercises.push({ id: Date.now(), name: '', sets: [{ reps: '', weight: '' }] });
  renderExercises();
};

window.addSet = function (exerciseId) {
  const ex = exercises.find(e => e.id === exerciseId);
  if (ex) {
    ex.sets.push({ reps: '', weight: '' });
    renderExercises();
  }
};

window.removeExercise = function (exerciseId) {
  exercises = exercises.filter(e => e.id !== exerciseId);
  renderExercises();
};

window.removeSet = function (exerciseId, setIndex) {
  const ex = exercises.find(e => e.id === exerciseId);
  if (ex && ex.sets.length > 1) {
    ex.sets.splice(setIndex, 1);
    renderExercises();
  }
};

function renderExercises() {
  const container = document.getElementById('exercises-container');
  if (!container) return;
  container.innerHTML = '';

  exercises.forEach((ex, exIdx) => {
    const card = document.createElement('div');
    card.className = 'exercise-card';

    const setsHtml = ex.sets.map((set, sIdx) => `
      <div class="set-row">
        <input
          type="number"
          class="form-input"
          placeholder="Reps"
          min="0"
          value="${set.reps}"
          data-ex="${ex.id}"
          data-set="${sIdx}"
          data-field="reps"
          onchange="window._updateSet(${ex.id}, ${sIdx}, 'reps', this.value)"
        >
        <input
          type="number"
          class="form-input"
          placeholder="Kg"
          min="0"
          step="0.5"
          value="${set.weight}"
          data-ex="${ex.id}"
          data-set="${sIdx}"
          data-field="weight"
          onchange="window._updateSet(${ex.id}, ${sIdx}, 'weight', this.value)"
        >
        <button type="button" onclick="window.removeSet(${ex.id}, ${sIdx})" style="background:none;border:none;color:var(--text-secondary);font-size:18px;cursor:pointer;padding:4px">✕</button>
      </div>
    `).join('');

    card.innerHTML = `
      <div class="exercise-header">
        <input
          type="text"
          class="form-input"
          placeholder="Nome esercizio"
          value="${ex.name}"
          style="flex:1;margin-right:8px"
          onchange="window._updateExerciseName(${ex.id}, this.value)"
        >
        <button type="button" class="btn-danger" onclick="window.removeExercise(${ex.id})">🗑️</button>
      </div>
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;display:grid;grid-template-columns:1fr 1fr auto;gap:8px;padding:0 4px">
        <span>Reps</span><span>Peso (kg)</span><span></span>
      </div>
      ${setsHtml}
      <button type="button" class="btn-secondary" style="width:100%;padding:8px;font-size:14px;margin-top:4px" onclick="window.addSet(${ex.id})">+ Serie</button>
    `;

    container.appendChild(card);
  });
}

window._updateExerciseName = function (exerciseId, value) {
  const ex = exercises.find(e => e.id === exerciseId);
  if (ex) ex.name = value;
};

window._updateSet = function (exerciseId, setIndex, field, value) {
  const ex = exercises.find(e => e.id === exerciseId);
  if (ex && ex.sets[setIndex] !== undefined) {
    ex.sets[setIndex][field] = value;
  }
};

function collectExercisesFromDOM() {
  exercises.forEach(ex => {
    const nameInput = document.querySelector(`input[data-ex="${ex.id}"]`);
    if (!nameInput) {
      const inputs = document.querySelectorAll('.exercise-card .form-input[type="text"]');
    }
  });

  const cards = document.querySelectorAll('.exercise-card');
  const result = [];
  cards.forEach((card, i) => {
    const nameInput = card.querySelector('input[type="text"]');
    const name = nameInput ? nameInput.value.trim() : '';
    const sets = [];
    const setRows = card.querySelectorAll('.set-row');
    setRows.forEach(row => {
      const inputs = row.querySelectorAll('input');
      sets.push({
        reps: inputs[0] ? inputs[0].value : '',
        weight: inputs[1] ? inputs[1].value : ''
      });
    });
    result.push({ name, sets });
  });
  return result;
}

async function initWorkoutForm() {
  const form = document.getElementById('workout-form');
  if (!form) return;

  const dateInput = document.getElementById('workout-date');
  if (dateInput) dateInput.value = getTodayString();

  window.addExercise();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = document.getElementById('workout-name').value.trim();
    if (!name) { showToast('Inserisci il nome dell\'allenamento', 'error'); return; }

    const collectedExercises = collectExercisesFromDOM();
    if (collectedExercises.length === 0) {
      showToast('Aggiungi almeno un esercizio', 'error');
      return;
    }

    const submitBtn = document.getElementById('submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Salvando...';

    try {
      await addDoc(collection(db, 'users', USER_ID, 'workouts'), {
        name,
        date: document.getElementById('workout-date').value,
        duration: Number(document.getElementById('workout-duration').value) || null,
        notes: document.getElementById('workout-notes').value.trim(),
        exercises: collectedExercises,
        createdAt: serverTimestamp()
      });
      showToast('Allenamento salvato! 💪');
      setTimeout(() => { window.location.href = 'workout.html'; }, 800);
    } catch (err) {
      console.error(err);
      showToast('Errore nel salvataggio', 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = '💾 Salva Allenamento';
    }
  });
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

if (document.getElementById('workout-form')) {
  initWorkoutForm();
} else if (document.getElementById('workout-list')) {
  loadWorkouts();
}
