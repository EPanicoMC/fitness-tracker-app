import {
  db, USER_ID, collection, doc, getDocs, addDoc, setDoc, deleteDoc, query
} from './firebase-config.js';
import { showToast, showModal, DAYS_IT, DAYS_ORDER } from './app.js';

let programs  = [];
let editingId = null;
let formSched = {}; // day → { name, exercises:[{name,sets:[{reps,weight}]}] } | null

function resetSched() {
  DAYS_ORDER.forEach(d => { formSched[d] = null; });
}

// ─── LOAD & RENDER ────────────────────────────────────────────────────────────

async function loadPrograms() {
  const list = document.getElementById('programs-list');
  list.innerHTML = '<div class="spin-wrap"></div>';
  try {
    const snap = await getDocs(collection(db, 'users', USER_ID, 'programs'));
    programs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    programs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
    renderList();
  } catch (e) {
    console.error(e);
    list.innerHTML = '<p style="color:var(--t2);text-align:center;padding:24px">Errore caricamento</p>';
  }
}

function renderList() {
  const list = document.getElementById('programs-list');
  if (!programs.length) {
    list.innerHTML = `<div class="empty"><span class="ei">💪</span><p>Nessuna scheda ancora<br>Crea il tuo primo programma!</p></div>`;
    return;
  }
  list.innerHTML = programs.map(p => {
    const nDays = DAYS_ORDER.filter(d => p.schedule?.[d]).length;
    return `
      <div class="card" style="cursor:pointer" onclick="window._toggleDetail('${p.id}')">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div style="flex:1;min-width:0">
            <div style="font-size:17px;font-weight:700;margin-bottom:4px">${p.name}</div>
            <div style="font-size:12px;color:var(--t2)">
              ${p.start_date ? `${p.start_date}${p.end_date ? ' → ' + p.end_date : ''} · ` : ''}${nDays} giorni/sett.
            </div>
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
        <div id="detail-${p.id}" style="display:none;border-top:1px solid var(--border);margin-top:14px;padding-top:14px">
          ${DAYS_ORDER.map(d => {
            const s = p.schedule?.[d];
            if (!s) return `<div style="display:flex;gap:10px;padding:5px 0;color:var(--t3);font-size:13px"><span style="width:80px;font-weight:700">${DAYS_IT[d]}</span>Riposo</div>`;
            return `<div style="padding:6px 0;border-bottom:1px solid var(--border)">
              <div style="font-size:13px;font-weight:700;color:var(--accent)">${DAYS_IT[d]} — ${s.name||'Sessione'}</div>
              ${(s.exercises||[]).map(e => `<div style="font-size:12px;color:var(--t2);padding:2px 0 2px 10px">${e.name} — ${e.sets?.length||0} serie</div>`).join('')}
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }).join('');
}

window._toggleDetail = function(id) {
  const el = document.getElementById(`detail-${id}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

window._activateProgram = async function(id) {
  try {
    for (const p of programs.filter(p => p.active))
      await setDoc(doc(db, 'users', USER_ID, 'programs', p.id), { active: false }, { merge: true });
    await setDoc(doc(db, 'users', USER_ID, 'programs', id), { active: true }, { merge: true });
    showToast('Programma attivato! ✅');
    await loadPrograms();
  } catch { showToast('Errore', 'err'); }
};

window._deleteProgram = function(id) {
  showModal('Elimina programma', 'Vuoi eliminare questa scheda?', 'Elimina', async () => {
    try {
      await deleteDoc(doc(db, 'users', USER_ID, 'programs', id));
      showToast('Programma eliminato');
      await loadPrograms();
    } catch { showToast('Errore', 'err'); }
  });
};

// ─── FORM ─────────────────────────────────────────────────────────────────────

window.showProgramForm = function() {
  editingId = null;
  resetSched();
  renderForm(null);
};

window._editProgram = function(id) {
  const p = programs.find(x => x.id === id);
  if (!p) return;
  editingId = id;
  resetSched();
  DAYS_ORDER.forEach(d => {
    formSched[d] = p.schedule?.[d] ? JSON.parse(JSON.stringify(p.schedule[d])) : null;
  });
  renderForm(p);
};

window.hideProgramForm = function() {
  document.getElementById('program-form-wrap').style.display = 'none';
  document.getElementById('programs-list').style.display = 'block';
  document.getElementById('add-btn').style.display = 'block';
};

function renderForm(prog) {
  document.getElementById('programs-list').style.display = 'none';
  document.getElementById('add-btn').style.display = 'none';
  const fw = document.getElementById('program-form-wrap');
  fw.style.display = 'block';
  fw.innerHTML = `
    <div class="ph" style="padding-top:8px">
      <button class="btn-icon" onclick="window.hideProgramForm()">←</button>
      <h1>${prog ? 'Modifica' : 'Nuovo Programma'}</h1>
    </div>
    <div class="card">
      <div class="fg">
        <label class="fl">Nome programma</label>
        <input class="fi" id="pf-name" placeholder="Es. Push Pull Legs…" value="${prog?.name||''}">
      </div>
      <div class="grid2">
        <div class="fg"><label class="fl">Data inizio</label><input type="date" class="fi" id="pf-start" value="${prog?.start_date||''}"></div>
        <div class="fg"><label class="fl">Data fine</label><input type="date" class="fi" id="pf-end" value="${prog?.end_date||''}"></div>
      </div>
    </div>
    <p class="sdiv">Schedule Settimanale</p>
    <div id="days-wrap">${DAYS_ORDER.map(d => renderDayCard(d)).join('')}</div>
    <div class="grid2" style="margin-top:8px">
      <button class="btn btn-ghost" onclick="window.hideProgramForm()">Annulla</button>
      <button class="btn btn-v" onclick="window.saveProgramForm()">💾 Salva</button>
    </div>`;
}

function renderDayCard(day) {
  const s   = formSched[day];
  const isOn = !!s;
  return `
    <div class="card" style="margin-bottom:10px" id="dc-${day}">
      <div style="display:flex;justify-content:space-between;align-items:center${isOn ? ';margin-bottom:14px' : ''}">
        <span style="font-weight:700;font-size:15px">${DAYS_IT[day]}</span>
        <label class="tgl">
          <input type="checkbox" ${isOn?'checked':''} onchange="window._toggleDay('${day}',this.checked)">
          <span class="tgl-s"></span>
        </label>
      </div>
      <div id="dc-body-${day}" style="display:${isOn?'block':'none'}">
        <div class="fg">
          <label class="fl">Nome sessione</label>
          <input class="fi" id="dc-name-${day}" placeholder="Es. Push Day…"
            value="${s?.name||''}" oninput="window._updDayName('${day}',this.value)">
        </div>
        <p class="sdiv">Esercizi</p>
        <div id="exs-${day}">
          ${(s?.exercises||[]).map((ex,i) => renderExCard(day,i,ex)).join('')}
        </div>
        <button class="btn btn-ghost btn-sm" onclick="window._addEx('${day}')" style="margin-top:4px">＋ Esercizio</button>
      </div>
    </div>`;
}

function renderExCard(day, ei, ex) {
  const setsHtml = (ex.sets||[]).map((s,si) => `
    <div class="set-row" id="sr-${day}-${ei}-${si}">
      <input type="number" class="fi" placeholder="Reps" value="${s.reps||''}"
        style="padding:8px;font-size:14px"
        oninput="window._updSet('${day}',${ei},${si},'reps',this.value)">
      <input type="number" class="fi" placeholder="kg" value="${s.weight||''}"
        step="0.5" style="padding:8px;font-size:14px"
        oninput="window._updSet('${day}',${ei},${si},'weight',this.value)">
      <button onclick="window._removeSet('${day}',${ei},${si})"
        style="background:none;border:none;color:var(--t3);font-size:18px;cursor:pointer">✕</button>
    </div>`).join('');
  return `
    <div class="ex-card" id="ex-${day}-${ei}">
      <div class="ex-head">
        <input class="fi" placeholder="Nome esercizio" value="${ex.name||''}"
          style="flex:1;margin-right:8px;padding:10px"
          oninput="window._updExName('${day}',${ei},this.value)">
        <button class="btn-del" onclick="window._removeEx('${day}',${ei})">🗑️</button>
      </div>
      <div style="font-size:11px;color:var(--t3);margin-bottom:6px;
                  display:grid;grid-template-columns:1fr 1fr 32px;gap:8px">
        <span>Reps</span><span>Peso (kg)</span><span></span>
      </div>
      <div id="sets-${day}-${ei}">${setsHtml}</div>
      <button class="btn btn-ghost btn-sm" onclick="window._addSet('${day}',${ei})" style="margin-top:6px">＋ Serie</button>
    </div>`;
}

// Day toggles
window._toggleDay = function(day, on) {
  formSched[day] = on ? { name: '', exercises: [] } : null;
  const body = document.getElementById(`dc-body-${day}`);
  const card = document.getElementById(`dc-${day}`);
  if (body) body.style.display = on ? 'block' : 'none';
  // Update heading margin
  const hdr = card?.querySelector(':scope > div:first-child');
  if (hdr) hdr.style.marginBottom = on ? '14px' : '0';
};

window._updDayName = function(day, val) {
  if (formSched[day]) formSched[day].name = val;
};

// Exercise management
window._addEx = function(day) {
  if (!formSched[day]) return;
  formSched[day].exercises.push({ name: '', sets: [{ reps:'', weight:'' }] });
  const cont = document.getElementById(`exs-${day}`);
  if (cont) cont.insertAdjacentHTML('beforeend',
    renderExCard(day, formSched[day].exercises.length - 1,
      formSched[day].exercises[formSched[day].exercises.length - 1]));
};

window._removeEx = function(day, ei) {
  if (!formSched[day]) return;
  formSched[day].exercises.splice(ei, 1);
  reRenderExercises(day);
};

window._addSet = function(day, ei) {
  const ex = formSched[day]?.exercises[ei];
  if (!ex) return;
  ex.sets.push({ reps:'', weight:'' });
  reRenderExercises(day);
};

window._removeSet = function(day, ei, si) {
  const sets = formSched[day]?.exercises[ei]?.sets;
  if (!sets || sets.length <= 1) return;
  sets.splice(si, 1);
  reRenderExercises(day);
};

window._updExName = function(day, ei, val) {
  const ex = formSched[day]?.exercises[ei];
  if (ex) ex.name = val;
};

window._updSet = function(day, ei, si, field, val) {
  const sets = formSched[day]?.exercises[ei]?.sets;
  if (sets?.[si]) sets[si][field] = val;
};

function reRenderExercises(day) {
  const cont = document.getElementById(`exs-${day}`);
  if (cont && formSched[day])
    cont.innerHTML = formSched[day].exercises.map((ex,i) => renderExCard(day,i,ex)).join('');
}

// Save
window.saveProgramForm = async function() {
  const name = document.getElementById('pf-name')?.value.trim();
  if (!name) { showToast('Inserisci il nome del programma', 'err'); return; }

  const data = {
    name,
    start_date: document.getElementById('pf-start')?.value || '',
    end_date:   document.getElementById('pf-end')?.value   || '',
    active: editingId ? (programs.find(p => p.id === editingId)?.active || false) : false,
    schedule: Object.fromEntries(
      DAYS_ORDER.map(d => [d, formSched[d] ? { ...formSched[d] } : null])
    )
  };
  try {
    if (editingId) {
      await setDoc(doc(db, 'users', USER_ID, 'programs', editingId), data, { merge: true });
      showToast('Programma aggiornato! ✅');
    } else {
      await addDoc(collection(db, 'users', USER_ID, 'programs'), data);
      showToast('Programma creato! ✅');
    }
    window.hideProgramForm();
    await loadPrograms();
  } catch (e) {
    console.error(e);
    showToast('Errore nel salvataggio', 'err');
  }
};

// ─── INIT ─────────────────────────────────────────────────────────────────────
loadPrograms();
