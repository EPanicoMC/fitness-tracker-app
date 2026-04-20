import {
  db, USER_ID, collection, doc, getDocs, addDoc, setDoc, deleteDoc
} from './firebase-config.js';
import { showToast, showModal, DAYS_IT, DAY_ORDER } from './app.js';
import { AutoComplete, saveToLibrary } from './autocomplete.js';

let programs  = [];
let editingId = null;
let formSched = {};

// ── Load & render ──────────────────────────────────────────
async function loadPrograms() {
  const el = document.getElementById('prg-list');
  el.innerHTML = '<div class="spin"></div>';
  const snap = await getDocs(collection(db, 'users', USER_ID, 'programs'));
  programs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  programs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  renderList();
}

function renderList() {
  const el = document.getElementById('prg-list');
  if (!programs.length) {
    el.innerHTML = '<div class="empty"><span class="ei">💪</span><p>Nessuna scheda ancora.<br>Crea il tuo primo programma!</p></div>';
    return;
  }
  el.innerHTML = programs.map(p => {
    const days = DAY_ORDER.filter(d => p.schedule?.[d]);
    const dayLabels = days.map(d => DAYS_IT[d].substring(0,3)).join(', ');
    const weeks = p.weeks ? ` · ${p.weeks} sett.` : '';
    const dates = p.start_date ? ` · ${p.start_date}` : '';
    return `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div style="flex:1">
            <div style="font-size:17px;font-weight:800">${p.name}</div>
            <div style="font-size:12px;color:var(--t2);margin-top:3px">${dayLabels||'Nessun giorno'}${weeks}${dates}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            ${p.active ? '<span class="badge badge-g">✓ Attivo</span>' : ''}
            <button class="btn-del" onclick="deleteProgram('${p.id}')">🗑️</button>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          ${!p.active ? `<button class="btn btn-ghost btn-sm" onclick="activateProgram('${p.id}')">⚡ Attiva</button>` : ''}
          <button class="btn btn-flat btn-sm" onclick="openEdit('${p.id}')">✏️ Modifica</button>
          <button class="btn btn-flat btn-sm" onclick="toggleDetail('${p.id}')">📋 Dettaglio</button>
          <button class="btn btn-flat btn-sm" onclick="cloneProgram('${p.id}')">📋 Clona</button>
        </div>
        <div id="pdet-${p.id}" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
          ${days.map(d => {
            const s = p.schedule[d];
            return `<div style="margin-bottom:10px">
              <div style="font-size:12px;font-weight:800;color:var(--accent);margin-bottom:4px">${DAYS_IT[d]} — ${s.name}</div>
              ${(s.exercises||[]).map(ex =>
                `<div style="font-size:13px;color:var(--t2);padding:2px 0">💪 ${ex.name} · ${ex.sets}×${ex.reps}</div>`
              ).join('')}
              ${s.cardio ? `<div style="font-size:12px;color:var(--blue);margin-top:4px">🏃 ${s.cardio.type} ${s.cardio.duration_minutes}min</div>` : ''}
            </div>`;
          }).join('')}
          ${p.progression_rule ? `<div style="font-size:12px;color:var(--t3);margin-top:8px;font-style:italic">${p.progression_rule}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

window.toggleDetail = function(id) {
  const el = document.getElementById(`pdet-${id}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

window.activateProgram = async function(id) {
  try {
    for (const p of programs.filter(p => p.active))
      await setDoc(doc(db,'users',USER_ID,'programs',p.id), { active: false }, { merge: true });
    await setDoc(doc(db,'users',USER_ID,'programs',id), { active: true }, { merge: true });
    showToast('✅ Scheda attivata!');
    await loadPrograms();
  } catch(e) { showToast('Errore', 'err'); }
};

window.deleteProgram = function(id) {
  showModal({
    title: 'Elimina scheda', text: 'Vuoi eliminare questa scheda?',
    confirmLabel: 'Elimina',
    onConfirm: async () => {
      await deleteDoc(doc(db,'users',USER_ID,'programs',id));
      showToast('Scheda eliminata');
      await loadPrograms();
    }
  });
};

window.cloneProgram = async function(id) {
  const p = programs.find(x => x.id === id);
  if (!p) return;
  try {
    const clone = JSON.parse(JSON.stringify(p));
    delete clone.id;
    clone.name = `${clone.name} (copia)`;
    clone.active = false;
    await addDoc(collection(db, 'users', USER_ID, 'programs'), clone);
    showToast('✅ Scheda clonata!');
    await loadPrograms();
  } catch(e) { showToast('Errore clonazione', 'err'); }
};

// ── Form ───────────────────────────────────────────────────
window.openNew = function() {
  editingId = null; formSched = {};
  renderForm(null);
};

window.openEdit = function(id) {
  const p = programs.find(x => x.id === id);
  if (!p) return;
  editingId = id;
  formSched = {};
  for (const [day, s] of Object.entries(p.schedule || {})) {
    if (!s) continue;
    formSched[day] = {
      name: s.name||'', time: s.time||'',
      cardio: s.cardio || null,
      exercises: (s.exercises||[]).map(ex => ({
        name: ex.name,
        sets: typeof ex.sets === 'number' ? ex.sets : (ex.sets?.length||3),
        reps: ex.reps||'8',
        weight_per_set: ex.weight_per_set || [],
        rest_seconds: ex.rest_seconds||90,
        notes: ex.notes||''
      }))
    };
  }
  renderForm(p);
};

function renderForm(prog) {
  document.getElementById('prg-list').style.display = 'none';
  document.querySelector('.ph').style.display = 'none';
  const fw = document.getElementById('prg-form');
  fw.style.display = 'block';
  fw.innerHTML = `
    <div class="ph" style="padding-top:8px">
      <button class="btn-icon" onclick="closeForm()">←</button>
      <h1>${prog ? 'Modifica' : 'Nuova Scheda'}</h1>
    </div>
    <div class="card">
      <div class="fg"><label class="fl">Nome scheda</label>
        <input class="fi" id="pf-name" placeholder="HIT Forza Primavera…" value="${prog?.name||''}"></div>
      <div class="grid2">
        <div class="fg" style="margin:0"><label class="fl">Data inizio</label>
          <input type="date" class="fi" id="pf-start" value="${prog?.start_date||''}"></div>
        <div class="fg" style="margin:0"><label class="fl">Settimane</label>
          <input type="number" class="fi" id="pf-weeks" placeholder="4" value="${prog?.weeks||''}"></div>
      </div>
      <div class="fg"><label class="fl">Regola progressione</label>
        <textarea class="fi" id="pf-prog" rows="2" placeholder="Es. +0.5kg a settimana…">${prog?.progression_rule||''}</textarea></div>
    </div>
    <div class="card">
      <span class="clabel">Giorni di allenamento</span>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
        ${DAY_ORDER.map(d => {
          const active = !!formSched[d];
          return `<button class="btn btn-sm ${active ? 'btn-v' : 'btn-ghost'}" id="dbtn-${d}"
            onclick="toggleDay('${d}')">${DAYS_IT[d].substring(0,3)}</button>`;
        }).join('')}
      </div>
      <div id="days-secs">
        ${DAY_ORDER.filter(d => formSched[d]).map(d => renderDaySec(d)).join('')}
      </div>
    </div>
    <div class="grid2" style="margin-top:8px">
      <button class="btn btn-flat" onclick="closeForm()">Annulla</button>
      <button class="btn btn-v" onclick="saveProgram()">💾 Salva</button>
    </div>`;
  DAY_ORDER.filter(d => formSched[d]).forEach(d => initAC(d));
}

window.closeForm = function() {
  document.getElementById('prg-form').style.display = 'none';
  document.getElementById('prg-list').style.display = 'block';
  document.querySelector('.ph').style.display = 'flex';
};

window.toggleDay = function(day) {
  if (formSched[day]) {
    delete formSched[day];
  } else {
    formSched[day] = { name:'', time:'', cardio: null, exercises: [] };
  }
  const btn = document.getElementById(`dbtn-${day}`);
  if (btn) btn.className = `btn btn-sm ${formSched[day] ? 'btn-v' : 'btn-ghost'}`;
  document.getElementById('days-secs').innerHTML =
    DAY_ORDER.filter(d => formSched[d]).map(d => renderDaySec(d)).join('');
  DAY_ORDER.filter(d => formSched[d]).forEach(d => initAC(d));
};

function renderDaySec(day) {
  const s = formSched[day];
  const cardioOn = s.cardio?.enabled || false;
  return `
    <div class="card card-dark" style="margin-bottom:10px" id="dsec-${day}">
      <div style="font-size:13px;font-weight:800;color:var(--accent);margin-bottom:10px">${DAYS_IT[day]}</div>
      <div class="grid2">
        <div class="fg" style="margin:0"><label class="fl">Nome sessione</label>
          <input class="fi" placeholder="Es. Dorso & Spalle…" value="${s.name||''}"
            oninput="formSched['${day}'].name=this.value"></div>
        <div class="fg" style="margin:0"><label class="fl">Ora</label>
          <input type="time" class="fi" value="${s.time||''}"
            oninput="formSched['${day}'].time=this.value"></div>
      </div>
      <div class="trow" style="margin:10px 0 8px">
        <div><div style="font-weight:700;font-size:14px">Cardio</div>
          <div style="font-size:12px;color:var(--t2)">Sessione cardio finale</div></div>
        <label class="tgl"><input type="checkbox" ${cardioOn?'checked':''}
          onchange="toggleCardio('${day}',this.checked)"><span class="tgl-s"></span></label>
      </div>
      <div id="cardio-wrap-${day}" style="display:${cardioOn?'block':'none'}">
        <div class="grid2">
          <div class="fg" style="margin:0"><label class="fl">Tipo</label>
            <input class="fi" placeholder="Tapis Roulant…" value="${s.cardio?.type||''}"
              oninput="if(!formSched['${day}'].cardio)formSched['${day}'].cardio={};formSched['${day}'].cardio.type=this.value;formSched['${day}'].cardio.enabled=true"></div>
          <div class="fg" style="margin:0"><label class="fl">Durata (min)</label>
            <input type="number" class="fi" placeholder="15" value="${s.cardio?.duration_minutes||''}"
              oninput="if(!formSched['${day}'].cardio)formSched['${day}'].cardio={};formSched['${day}'].cardio.duration_minutes=+this.value;formSched['${day}'].cardio.enabled=true"></div>
        </div>
        <div class="fg"><label class="fl">Note cardio</label>
          <input class="fi" placeholder="Pendenza 10%, vel 5 km/h…" value="${s.cardio?.notes||''}"
            oninput="if(!formSched['${day}'].cardio)formSched['${day}'].cardio={};formSched['${day}'].cardio.notes=this.value"></div>
      </div>
      <p class="sdiv" style="margin-top:12px">Esercizi</p>
      <div id="exwrap-${day}">
        ${(s.exercises||[]).map((ex,ei) => renderExRow(day,ei,ex)).join('')}
      </div>
      <button class="btn btn-ghost btn-sm" onclick="addEx('${day}')" style="margin-top:8px">＋ Esercizio</button>
    </div>`;
}

window.toggleCardio = function(day, on) {
  if (!formSched[day].cardio) formSched[day].cardio = {};
  formSched[day].cardio.enabled = on;
  const w = document.getElementById(`cardio-wrap-${day}`);
  if (w) w.style.display = on ? 'block' : 'none';
};

function renderExRow(day, ei, ex) {
  return `
    <div class="ex-card" id="exrow-${day}-${ei}">
      <div class="ex-head">
        <input class="fi ex-name-inp" placeholder="Nome esercizio" value="${ex.name||''}"
          data-day="${day}" data-ei="${ei}" style="flex:1;padding:8px;font-size:14px;font-weight:700">
        <button class="btn-del" onclick="removeEx('${day}',${ei})">🗑️</button>
      </div>
      <div class="grid3" style="margin-top:8px">
        <div class="fg" style="margin:0"><label class="fl">Serie</label>
          <input type="number" class="fi" placeholder="3" value="${ex.sets||''}" style="padding:8px;text-align:center"
            oninput="formSched['${day}'].exercises[${ei}].sets=+this.value"></div>
        <div class="fg" style="margin:0"><label class="fl">Reps</label>
          <input class="fi" placeholder="6-8" value="${ex.reps||''}" style="padding:8px;text-align:center"
            oninput="formSched['${day}'].exercises[${ei}].reps=this.value"></div>
        <div class="fg" style="margin:0"><label class="fl">Rec. (s)</label>
          <input type="number" class="fi" placeholder="90" value="${ex.rest_seconds||''}" style="padding:8px;text-align:center"
            oninput="formSched['${day}'].exercises[${ei}].rest_seconds=+this.value"></div>
      </div>
      <div class="fg" style="margin-top:8px"><label class="fl">Note tecniche</label>
        <input class="fi" placeholder="Eccentrica 3s, schiena dritta…" value="${ex.notes||''}" style="padding:8px;font-size:13px"
          oninput="formSched['${day}'].exercises[${ei}].notes=this.value"></div>
    </div>`;
}

function initAC(day) {
  const wrap = document.getElementById(`exwrap-${day}`);
  if (!wrap) return;
  wrap.querySelectorAll('input.ex-name-inp:not([data-ac])').forEach(inp => {
    inp.setAttribute('data-ac','1');
    const ei = parseInt(inp.dataset.ei);
    new AutoComplete(inp, 'exercise_library', {
      onSelect: item => { if (formSched[day]?.exercises?.[ei]) formSched[day].exercises[ei].name = item.name; },
      onCustom: async name => {
        if (formSched[day]?.exercises?.[ei]) formSched[day].exercises[ei].name = name;
        await saveToLibrary('exercise_library', { name });
      }
    });
  });
}

window.addEx = function(day) {
  if (!formSched[day]) return;
  formSched[day].exercises.push({ name:'', sets:3, reps:'8', weight_per_set:[], rest_seconds:90, notes:'' });
  reRenderExes(day);
};

window.removeEx = function(day, ei) {
  formSched[day]?.exercises?.splice(ei, 1);
  reRenderExes(day);
};

function reRenderExes(day) {
  const w = document.getElementById(`exwrap-${day}`);
  if (w) w.innerHTML = (formSched[day]?.exercises||[]).map((ex,ei) => renderExRow(day,ei,ex)).join('');
  initAC(day);
}

// ── Save ───────────────────────────────────────────────────
window.saveProgram = async function() {
  const name = document.getElementById('pf-name')?.value.trim();
  if (!name) { showToast('Inserisci il nome', 'err'); return; }

  const schedule = {};
  for (const day of DAY_ORDER) schedule[day] = formSched[day] || null;

  const data = {
    name,
    start_date: document.getElementById('pf-start')?.value || null,
    weeks: +document.getElementById('pf-weeks')?.value || null,
    progression_rule: document.getElementById('pf-prog')?.value.trim() || '',
    schedule,
    active: editingId ? (programs.find(p => p.id === editingId)?.active || false) : false
  };

  try {
    if (editingId) {
      await setDoc(doc(db,'users',USER_ID,'programs',editingId), data, { merge: true });
    } else {
      await addDoc(collection(db,'users',USER_ID,'programs'), data);
    }
    showToast('✅ Scheda salvata!');
    closeForm();
    await loadPrograms();
  } catch(e) {
    showToast('Errore salvataggio', 'err');
  }
};

loadPrograms();
