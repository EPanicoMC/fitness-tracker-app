import {
  db, USER_ID, collection, doc, getDocs, addDoc, setDoc, deleteDoc
} from './firebase-config.js';
import { showToast, showModal, DAYS_IT, DAYS_ORDER } from './app.js';
import { Autocomplete, saveToLibrary } from './autocomplete.js';

let programs  = [];
let editingId = null;
let formSched = {};

// ── Load & render ──────────────────────────────────────────────────────────────
async function loadPrograms() {
  const list = document.getElementById('program-list');
  list.innerHTML = '<div class="spin-wrap"></div>';
  try {
    const snap = await getDocs(collection(db, 'users', USER_ID, 'programs'));
    programs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    programs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
    renderList();
  } catch(e) {
    console.error(e);
    list.innerHTML = '<p style="color:var(--t2);text-align:center;padding:24px">Errore caricamento</p>';
  }
}

function renderList() {
  const list = document.getElementById('program-list');
  if (!programs.length) {
    list.innerHTML = `<div class="empty"><span class="ei">💪</span><p>Nessuna scheda ancora<br>Crea il tuo primo programma!</p></div>`;
    return;
  }
  list.innerHTML = programs.map(p => {
    const days = Object.keys(p.schedule || {}).filter(d => p.schedule[d]);
    const dayLabels = DAYS_ORDER.filter(d => days.includes(d)).map(d => DAYS_IT[d]).join(', ');
    const weeks = p.weeks ? ` · ${p.weeks} settimane` : '';
    return `
      <div class="card" style="cursor:pointer" onclick="window._toggleDetail('${p.id}')">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div style="flex:1;min-width:0">
            <div style="font-size:17px;font-weight:700;margin-bottom:4px">${p.name}</div>
            <div style="font-size:12px;color:var(--t2)">${dayLabels || 'Nessun giorno'}${weeks}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;margin-left:8px">
            ${p.active ? '<span class="badge badge-g">✓ Attivo</span>' : ''}
            <button class="btn-del" onclick="event.stopPropagation();window._deleteProgram('${p.id}')">🗑️</button>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
          ${!p.active ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();window._activateProgram('${p.id}')">⚡ Attiva</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();window._editProgram('${p.id}')">✏️ Modifica</button>
        </div>
        <div id="prog-detail-${p.id}" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
          ${DAYS_ORDER.filter(d => p.schedule?.[d]).map(d => {
            const s = p.schedule[d];
            const cardioLabel = s.cardio?.enabled ? ` · 🏃 ${s.cardio.type} ${s.cardio.duration_minutes}min` : '';
            return `
              <div style="margin-bottom:12px">
                <div style="font-size:12px;font-weight:700;color:var(--accent);margin-bottom:6px">${DAYS_IT[d]} — ${s.name || ''}${cardioLabel}</div>
                ${(s.exercises || []).map(ex => {
                  const setsN = typeof ex.sets === 'number' ? ex.sets : ex.sets?.length || 0;
                  return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px">
                    <span>💪</span>
                    <span style="flex:1">${ex.name}</span>
                    <span style="color:var(--t2);font-size:11px">${setsN}×${ex.reps || ''}</span>
                  </div>`;
                }).join('')}
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }).join('');
}

window._toggleDetail = function(id) {
  const el = document.getElementById(`prog-detail-${id}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

window._activateProgram = async function(id) {
  try {
    for (const p of programs.filter(p => p.active))
      await setDoc(doc(db, 'users', USER_ID, 'programs', p.id), { active: false }, { merge: true });
    await setDoc(doc(db, 'users', USER_ID, 'programs', id), { active: true }, { merge: true });
    showToast('Scheda attivata! ✅');
    await loadPrograms();
  } catch { showToast('Errore', 'err'); }
};

window._deleteProgram = function(id) {
  showModal({
    title: 'Elimina scheda', text: 'Vuoi eliminare questa scheda?',
    confirmLabel: 'Elimina',
    onConfirm: async () => {
      try {
        await deleteDoc(doc(db, 'users', USER_ID, 'programs', id));
        showToast('Scheda eliminata');
        await loadPrograms();
      } catch { showToast('Errore', 'err'); }
    }
  });
};

// ── Form ───────────────────────────────────────────────────────────────────────
window.showProgramForm = function() {
  editingId = null;
  formSched = {};
  renderForm(null);
};

window._editProgram = function(id) {
  const p = programs.find(x => x.id === id);
  if (!p) return;
  editingId = id;
  // Normalize new program format
  formSched = {};
  for (const [day, s] of Object.entries(p.schedule || {})) {
    if (!s) continue;
    formSched[day] = {
      name: s.name || '',
      time: s.time || '',
      time_minutes: s.time_minutes || 60,
      cardio: s.cardio || null,
      exercises: (s.exercises || []).map(ex => ({
        name:         ex.name,
        sets:         typeof ex.sets === 'number' ? ex.sets : (ex.sets?.length || 3),
        reps:         ex.reps || '8',
        weight_per_set: ex.weight_per_set || Array(typeof ex.sets === 'number' ? ex.sets : 3).fill(0),
        rest_seconds: ex.rest_seconds || 90,
        notes:        ex.notes || ''
      }))
    };
  }
  renderForm(p);
};

window.hideProgramForm = function() {
  document.getElementById('program-form-wrap').style.display = 'none';
  document.getElementById('program-list').style.display = 'block';
  document.getElementById('add-prog-btn').style.display = '';
};

function renderForm(prog) {
  document.getElementById('program-list').style.display = 'none';
  document.getElementById('add-prog-btn').style.display = 'none';
  const fw = document.getElementById('program-form-wrap');
  fw.style.display = 'block';
  fw.innerHTML = `
    <div class="ph" style="padding-top:8px">
      <button class="btn-icon" onclick="window.hideProgramForm()">←</button>
      <h1>${prog ? 'Modifica' : 'Nuova Scheda'}</h1>
    </div>
    <div class="card">
      <div class="fg">
        <label class="fl">Nome scheda</label>
        <input class="fi" id="pf-name" placeholder="Es. HIT Forza Primavera…" value="${prog?.name || ''}">
      </div>
      <div class="grid2">
        <div class="fg" style="margin:0">
          <label class="fl">Data inizio</label>
          <input type="date" class="fi" id="pf-start" value="${prog?.start_date || ''}">
        </div>
        <div class="fg" style="margin:0">
          <label class="fl">Settimane</label>
          <input type="number" class="fi" id="pf-weeks" placeholder="4" value="${prog?.weeks || ''}">
        </div>
      </div>
    </div>
    <div class="card">
      <span class="clabel">Giorni di allenamento</span>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
        ${DAYS_ORDER.map(d => {
          const active = !!formSched[d];
          return `<button class="btn btn-sm ${active ? 'btn-v' : 'btn-ghost'}" id="day-btn-${d}"
            onclick="window._toggleDay('${d}')">${DAYS_IT[d].substring(0,3)}</button>`;
        }).join('')}
      </div>
      <div id="days-sections">
        ${DAYS_ORDER.filter(d => formSched[d]).map(d => renderDaySection(d)).join('')}
      </div>
    </div>
    <div class="grid2" style="margin-top:8px">
      <button class="btn btn-ghost" onclick="window.hideProgramForm()">Annulla</button>
      <button class="btn btn-v"     onclick="window.saveProgramForm()">💾 Salva</button>
    </div>`;

  // Attach autocomplete to existing exercise name inputs
  DAYS_ORDER.filter(d => formSched[d]).forEach(d => initExerciseAutocomplete(d));
}

window._toggleDay = function(day) {
  if (formSched[day]) {
    delete formSched[day];
  } else {
    formSched[day] = { name: '', time: '', time_minutes: 60, cardio: null, exercises: [] };
  }
  const btn = document.getElementById(`day-btn-${day}`);
  if (btn) btn.className = `btn btn-sm ${formSched[day] ? 'btn-v' : 'btn-ghost'}`;
  document.getElementById('days-sections').innerHTML =
    DAYS_ORDER.filter(d => formSched[d]).map(d => renderDaySection(d)).join('');
  DAYS_ORDER.filter(d => formSched[d]).forEach(d => initExerciseAutocomplete(d));
};

function renderDaySection(day) {
  const s = formSched[day];
  const cardioEnabled = s.cardio?.enabled || false;
  return `
    <div class="card card-dark" style="margin-bottom:10px" id="day-sec-${day}">
      <div style="font-size:13px;font-weight:700;color:var(--accent);margin-bottom:12px">${DAYS_IT[day]}</div>
      <div class="grid2">
        <div class="fg" style="margin:0">
          <label class="fl">Nome sessione</label>
          <input class="fi" placeholder="Es. Dorso & Spalle…" value="${s.name || ''}"
            oninput="formSched['${day}'].name = this.value">
        </div>
        <div class="fg" style="margin:0">
          <label class="fl">Ora</label>
          <input type="time" class="fi" value="${s.time || ''}"
            oninput="formSched['${day}'].time = this.value">
        </div>
      </div>
      <!-- Cardio -->
      <div class="trow" style="margin:12px 0 8px">
        <div>
          <div style="font-weight:700;font-size:14px">Cardio</div>
          <div style="font-size:12px;color:var(--t2)">Aggiungi sessione cardio</div>
        </div>
        <label class="tgl">
          <input type="checkbox" ${cardioEnabled ? 'checked' : ''}
            onchange="window._toggleCardio('${day}',this.checked)">
          <span class="tgl-s"></span>
        </label>
      </div>
      <div id="cardio-wrap-${day}" style="display:${cardioEnabled ? 'block' : 'none'}">
        <div class="grid2">
          <div class="fg" style="margin:0">
            <label class="fl">Tipo</label>
            <input class="fi" placeholder="Es. Tapis Roulant…"
              value="${s.cardio?.type || ''}"
              oninput="if(!formSched['${day}'].cardio)formSched['${day}'].cardio={};formSched['${day}'].cardio.type=this.value">
          </div>
          <div class="fg" style="margin:0">
            <label class="fl">Durata (min)</label>
            <input type="number" class="fi" placeholder="15" value="${s.cardio?.duration_minutes || ''}"
              oninput="if(!formSched['${day}'].cardio)formSched['${day}'].cardio={};formSched['${day}'].cardio.duration_minutes=+this.value">
          </div>
        </div>
        <div class="fg">
          <label class="fl">Note cardio</label>
          <input class="fi" placeholder="Es. Pendenza 10%, velocità 5 km/h…"
            value="${s.cardio?.notes || ''}"
            oninput="if(!formSched['${day}'].cardio)formSched['${day}'].cardio={};formSched['${day}'].cardio.notes=this.value">
        </div>
      </div>
      <p class="sdiv" style="margin-top:12px">Esercizi</p>
      <div id="ex-wrap-${day}">
        ${(s.exercises || []).map((ex, ei) => renderExCard(day, ei, ex)).join('')}
      </div>
      <button class="btn btn-ghost btn-sm" onclick="window._addEx('${day}')" style="margin-top:8px">＋ Esercizio</button>
    </div>`;
}

window._toggleCardio = function(day, enabled) {
  if (!formSched[day]) return;
  if (!formSched[day].cardio) formSched[day].cardio = {};
  formSched[day].cardio.enabled = enabled;
  const wrap = document.getElementById(`cardio-wrap-${day}`);
  if (wrap) wrap.style.display = enabled ? 'block' : 'none';
};

function renderExCard(day, ei, ex) {
  return `
    <div class="ex-card" id="ex-${day}-${ei}">
      <div class="ex-head">
        <input class="fi ex-name" placeholder="Nome esercizio"
          value="${ex.name || ''}" data-day="${day}" data-ei="${ei}"
          style="flex:1;padding:8px 12px;font-size:14px;font-weight:700">
        <button class="btn-del" onclick="window._removeEx('${day}',${ei})">🗑️</button>
      </div>
      <div class="grid3" style="margin-bottom:8px">
        <div class="fg" style="margin:0">
          <label class="fl">Serie</label>
          <input type="number" class="fi" placeholder="3" value="${ex.sets || ''}"
            style="padding:8px;text-align:center"
            oninput="formSched['${day}'].exercises[${ei}].sets=+this.value||0">
        </div>
        <div class="fg" style="margin:0">
          <label class="fl">Reps / target</label>
          <input class="fi" placeholder="6-8" value="${ex.reps || ''}"
            style="padding:8px;text-align:center"
            oninput="formSched['${day}'].exercises[${ei}].reps=this.value">
        </div>
        <div class="fg" style="margin:0">
          <label class="fl">Recupero (s)</label>
          <input type="number" class="fi" placeholder="90" value="${ex.rest_seconds || ''}"
            style="padding:8px;text-align:center"
            oninput="formSched['${day}'].exercises[${ei}].rest_seconds=+this.value||60">
        </div>
      </div>
      <div class="fg">
        <label class="fl">Note tecniche</label>
        <input class="fi" placeholder="Es. Schiena dritta, 3s eccentrica…"
          value="${ex.notes || ''}"
          oninput="formSched['${day}'].exercises[${ei}].notes=this.value"
          style="padding:8px 12px;font-size:13px">
      </div>
    </div>`;
}

function initExerciseAutocomplete(day) {
  const wrap = document.getElementById(`ex-wrap-${day}`);
  if (!wrap) return;
  wrap.querySelectorAll('input.ex-name:not([data-ac-ready])').forEach(input => {
    input.setAttribute('data-ac-ready', '1');
    const ei = parseInt(input.dataset.ei);
    new Autocomplete({
      inputEl: input,
      collection: 'exercise_library',
      db, USER_ID,
      onSelect: (item) => {
        if (formSched[day]?.exercises?.[ei] != null) {
          formSched[day].exercises[ei].name = item.name;
        }
      },
      onCustom: async (name) => {
        if (formSched[day]?.exercises?.[ei] != null) {
          formSched[day].exercises[ei].name = name;
        }
        await saveToLibrary(db, USER_ID, 'exercise_library', { name, last_used: null });
        showToast(`"${name}" aggiunto alla libreria`);
      }
    });
  });
}

window._addEx = function(day) {
  if (!formSched[day]) return;
  formSched[day].exercises.push({ name: '', sets: 3, reps: '8', weight_per_set: [], rest_seconds: 90, notes: '' });
  reRenderDayExercises(day);
};

window._removeEx = function(day, ei) {
  formSched[day]?.exercises?.splice(ei, 1);
  reRenderDayExercises(day);
};

function reRenderDayExercises(day) {
  const wrap = document.getElementById(`ex-wrap-${day}`);
  if (wrap) wrap.innerHTML = (formSched[day]?.exercises || []).map((ex, ei) => renderExCard(day, ei, ex)).join('');
  initExerciseAutocomplete(day);
}

// ── Save ───────────────────────────────────────────────────────────────────────
window.saveProgramForm = async function() {
  const name = document.getElementById('pf-name')?.value.trim();
  if (!name) { showToast('Inserisci il nome della scheda', 'err'); return; }

  const startDate = document.getElementById('pf-start')?.value || null;
  const weeks     = +(document.getElementById('pf-weeks')?.value || 0) || null;

  // Build schedule (null for non-training days)
  const schedule = {};
  for (const day of DAYS_ORDER) {
    schedule[day] = formSched[day] || null;
  }

  const data = {
    name, schedule,
    start_date: startDate,
    weeks,
    active: editingId ? (programs.find(p => p.id === editingId)?.active || false) : false
  };

  try {
    if (editingId) {
      await setDoc(doc(db, 'users', USER_ID, 'programs', editingId), data, { merge: true });
      showToast('Scheda aggiornata! ✅');
    } else {
      await addDoc(collection(db, 'users', USER_ID, 'programs'), data);
      showToast('Scheda creata! ✅');
    }
    window.hideProgramForm();
    await loadPrograms();
  } catch(e) {
    console.error(e);
    showToast('Errore nel salvataggio', 'err');
  }
};

loadPrograms();
