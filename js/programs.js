import {
  db, USER_ID, collection, doc, getDocs, addDoc, setDoc, deleteDoc
} from './firebase-config.js';
import { showToast, showModal, DAYS_IT, DAYS_ORDER } from './app.js';

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
    const days = Object.keys(p.schedule || {});
    const dayLabels = DAYS_ORDER.filter(d => days.includes(d)).map(d => DAYS_IT[d]).join(', ');
    return `
      <div class="card" style="cursor:pointer" onclick="window._toggleDetail('${p.id}')">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div style="flex:1;min-width:0">
            <div style="font-size:17px;font-weight:700;margin-bottom:4px">${p.name}</div>
            <div style="font-size:12px;color:var(--t2)">${dayLabels || 'Nessun giorno'}</div>
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
            return `
              <div style="margin-bottom:12px">
                <div style="font-size:12px;font-weight:700;color:var(--accent);margin-bottom:6px">${DAYS_IT[d]} — ${s.name || ''}</div>
                ${(s.exercises || []).map(ex => `
                  <div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px">
                    <span>${ex.is_cardio ? '🏃' : '💪'}</span>
                    <span style="flex:1">${ex.name}</span>
                    <span style="color:var(--t2);font-size:11px">${ex.sets.length} serie</span>
                  </div>`).join('')}
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
    title: 'Elimina scheda',
    text:  'Vuoi eliminare questa scheda?',
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
  formSched = JSON.parse(JSON.stringify(p.schedule || {}));
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
        <input class="fi" id="pf-name" placeholder="Es. Push Pull Legs…" value="${prog?.name || ''}">
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
}

window._toggleDay = function(day) {
  if (formSched[day]) {
    delete formSched[day];
  } else {
    formSched[day] = { name: '', time_minutes: 60, exercises: [] };
  }
  const btn = document.getElementById(`day-btn-${day}`);
  if (btn) {
    btn.className = `btn btn-sm ${formSched[day] ? 'btn-v' : 'btn-ghost'}`;
  }
  document.getElementById('days-sections').innerHTML =
    DAYS_ORDER.filter(d => formSched[d]).map(d => renderDaySection(d)).join('');
};

function renderDaySection(day) {
  const s = formSched[day];
  return `
    <div class="card card-dark" style="margin-bottom:10px" id="day-sec-${day}">
      <div style="font-size:13px;font-weight:700;color:var(--accent);margin-bottom:12px">${DAYS_IT[day]}</div>
      <div class="grid2">
        <div class="fg" style="margin:0">
          <label class="fl">Nome sessione</label>
          <input class="fi" placeholder="Es. Push…" value="${s.name || ''}"
            oninput="formSched['${day}'].name = this.value">
        </div>
        <div class="fg" style="margin:0">
          <label class="fl">Durata (min)</label>
          <input type="number" class="fi" placeholder="60" value="${s.time_minutes || ''}"
            oninput="formSched['${day}'].time_minutes = +this.value || 0">
        </div>
      </div>
      <p class="sdiv" style="margin-top:12px">Esercizi</p>
      <div id="ex-wrap-${day}">
        ${(s.exercises || []).map((ex, ei) => renderExCard(day, ei, ex)).join('')}
      </div>
      <button class="btn btn-ghost btn-sm" onclick="window._addEx('${day}')" style="margin-top:8px">＋ Esercizio</button>
    </div>`;
}

function renderExCard(day, ei, ex) {
  return `
    <div class="ex-card" id="ex-${day}-${ei}">
      <div class="ex-head">
        <input class="fi ex-name" placeholder="Nome esercizio" value="${ex.name || ''}"
          oninput="formSched['${day}'].exercises[${ei}].name = this.value"
          style="flex:1;padding:8px 12px;font-size:14px;font-weight:700">
        <button class="btn-del" onclick="window._removeEx('${day}',${ei})">🗑️</button>
      </div>
      <div class="grid2" style="margin-bottom:8px">
        <div class="fg" style="margin:0">
          <label class="fl">Recupero (sec)</label>
          <input type="number" class="fi" placeholder="90" value="${ex.rest_seconds || ''}"
            oninput="formSched['${day}'].exercises[${ei}].rest_seconds = +this.value || 60"
            style="padding:8px;text-align:center">
        </div>
        <div class="fg" style="margin:0;display:flex;flex-direction:column;justify-content:flex-end">
          <div class="trow" style="height:42px">
            <label class="fl" style="margin:0">Cardio</label>
            <label class="tgl">
              <input type="checkbox" ${ex.is_cardio ? 'checked' : ''}
                onchange="formSched['${day}'].exercises[${ei}].is_cardio = this.checked">
              <span class="tgl-s"></span>
            </label>
          </div>
        </div>
      </div>
      <div class="fg">
        <label class="fl">Note / indicazioni</label>
        <input class="fi" placeholder="Es. Schiena dritta…" value="${ex.notes || ''}"
          oninput="formSched['${day}'].exercises[${ei}].notes = this.value"
          style="padding:8px 12px;font-size:13px">
      </div>
      <p class="sdiv" style="margin-top:0">Serie</p>
      <div id="sets-wrap-${day}-${ei}">
        ${(ex.sets || []).map((s, si) => renderSetRow(day, ei, si, s)).join('')}
      </div>
      <button class="btn btn-ghost btn-sm" onclick="window._addSet('${day}',${ei})" style="margin-top:6px">＋ Serie</button>
    </div>`;
}

function renderSetRow(day, ei, si, s) {
  return `
    <div class="set-row" id="set-${day}-${ei}-${si}">
      <span class="set-num">${si+1}</span>
      <input type="number" class="fi" placeholder="kg" value="${s.weight || ''}" step="0.5" min="0"
        style="width:72px;padding:8px;text-align:center;font-size:14px;font-weight:700"
        oninput="formSched['${day}'].exercises[${ei}].sets[${si}].weight = +this.value || 0">
      <span style="font-size:12px;color:var(--t2)">kg</span>
      <span style="font-size:12px;color:var(--t3);margin:0 4px">×</span>
      <input type="number" class="fi" placeholder="reps" value="${s.reps || ''}" step="1" min="0"
        style="width:64px;padding:8px;text-align:center;font-size:14px;font-weight:700"
        oninput="formSched['${day}'].exercises[${ei}].sets[${si}].reps = +this.value || 0">
      <button class="btn-del" onclick="window._removeSet('${day}',${ei},${si})" style="margin-left:auto">✕</button>
    </div>`;
}

window._addEx = function(day) {
  if (!formSched[day]) return;
  formSched[day].exercises.push({ name:'', rest_seconds:90, notes:'', is_cardio:false, sets:[{ reps:8, weight:0 }] });
  reRenderDayExercises(day);
};

window._removeEx = function(day, ei) {
  formSched[day]?.exercises?.splice(ei, 1);
  reRenderDayExercises(day);
};

window._addSet = function(day, ei) {
  const ex = formSched[day]?.exercises?.[ei];
  if (!ex) return;
  const last = ex.sets[ex.sets.length - 1] || { reps:8, weight:0 };
  ex.sets.push({ reps: last.reps, weight: last.weight });
  reRenderSets(day, ei);
};

window._removeSet = function(day, ei, si) {
  formSched[day]?.exercises?.[ei]?.sets?.splice(si, 1);
  reRenderSets(day, ei);
};

function reRenderDayExercises(day) {
  const wrap = document.getElementById(`ex-wrap-${day}`);
  if (wrap) wrap.innerHTML = (formSched[day]?.exercises || []).map((ex, ei) => renderExCard(day, ei, ex)).join('');
}

function reRenderSets(day, ei) {
  const wrap = document.getElementById(`sets-wrap-${day}-${ei}`);
  if (wrap) wrap.innerHTML = (formSched[day]?.exercises?.[ei]?.sets || []).map((s, si) => renderSetRow(day, ei, si, s)).join('');
}

// ── Save ───────────────────────────────────────────────────────────────────────
window.saveProgramForm = async function() {
  const name = document.getElementById('pf-name')?.value.trim();
  if (!name) { showToast('Inserisci il nome della scheda', 'err'); return; }

  const data = {
    name,
    schedule: formSched,
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
