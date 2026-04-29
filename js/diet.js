import {
  db, USER_ID, collection, doc, getDocs, addDoc, setDoc, deleteDoc
} from './firebase-config.js';
import { showToast, showModal } from './app.js';
import { AutoComplete, saveToLibrary } from './autocomplete.js';
import { calcMacrosFromText } from './gemini.js';

let diets     = [];
let editingId = null;
let formData  = { name:'', day_on: buildEmptyDay(), day_off: buildEmptyDay() };
window.formData = formData;

function buildEmptyDay() {
  return { kcal:0, protein:0, carbs:0, fats:0, meals:[] };
}

// ── Load & render ──────────────────────────────────────────
async function loadDiets() {
  const el = document.getElementById('diet-list');
  el.innerHTML = '<div class="spin"></div>';
  const snap = await getDocs(collection(db, 'users', USER_ID, 'diet_plans'));
  diets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  diets.sort((a, b) => (b.active?1:0) - (a.active?1:0));
  renderList();
}

function renderList() {
  const el = document.getElementById('diet-list');
  if (!diets.length) {
    el.innerHTML = '<div class="empty"><span class="ei">🥗</span><p>Nessun piano dieta.<br>Crea il tuo primo piano!</p></div>';
    return;
  }
  el.innerHTML = diets.map(d => `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div style="flex:1">
          <div style="font-size:17px;font-weight:800">${d.name}</div>
          <div style="font-size:12px;color:var(--t2);margin-top:3px">
            💪 ON: ${d.day_on?.kcal||0} kcal · 😴 OFF: ${d.day_off?.kcal||0} kcal
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          ${d.active ? '<span class="badge badge-g">✓ Attivo</span>' : ''}
          <button class="btn-del" onclick="deleteDiet('${d.id}')">🗑️</button>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        ${!d.active ? `<button class="btn btn-ghost btn-sm" onclick="activateDiet('${d.id}')">⚡ Attiva</button>` : ''}
        <button class="btn btn-flat btn-sm" onclick="openEdit('${d.id}')">✏️ Modifica</button>
        <button class="btn btn-flat btn-sm" onclick="toggleDietDetail('${d.id}')">📋 Pasti</button>
        <button class="btn btn-flat btn-sm" onclick="cloneDiet('${d.id}')">📋 Clona</button>
      </div>
      <div id="ddet-${d.id}" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
        ${renderDietPreview(d)}
      </div>
    </div>`).join('');
}

function renderDietPreview(d) {
  const renderMeals = meals => (meals||[]).map(m => `
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">
      <span>${m.label||m.type} ${m.time?'<span style="color:var(--t3)">'+m.time+'</span>':''}</span>
      <span style="color:var(--green);font-weight:700">${m.kcal} kcal</span>
    </div>`).join('');
  return `
    <div style="font-size:12px;font-weight:800;color:var(--accent);margin-bottom:6px">💪 Giorno ON</div>
    ${renderMeals(d.day_on?.meals)}
    <div style="font-size:12px;font-weight:800;color:var(--blue);margin:12px 0 6px">😴 Giorno OFF</div>
    ${renderMeals(d.day_off?.meals)}`;
}

window.toggleDietDetail = function(id) {
  const el = document.getElementById(`ddet-${id}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

window.activateDiet = async function(id) {
  try {
    for (const d of diets.filter(d => d.active))
      await setDoc(doc(db,'users',USER_ID,'diet_plans',d.id), { active: false }, { merge: true });
    await setDoc(doc(db,'users',USER_ID,'diet_plans',id), { active: true }, { merge: true });
    showToast('✅ Piano attivato!');
    await loadDiets();
  } catch(e) { showToast('Errore', 'err'); }
};

window.deleteDiet = function(id) {
  showModal({
    title: 'Elimina piano', text: 'Vuoi eliminare questo piano alimentare?',
    confirmLabel: 'Elimina',
    onConfirm: async () => {
      await deleteDoc(doc(db,'users',USER_ID,'diet_plans',id));
      showToast('Piano eliminato');
      await loadDiets();
    }
  });
};

window.cloneDiet = async function(id) {
  const d = diets.find(x => x.id === id);
  if (!d) return;
  try {
    const clone = JSON.parse(JSON.stringify(d));
    delete clone.id;
    clone.name = `${clone.name} (copia)`;
    clone.active = false;
    await addDoc(collection(db, 'users', USER_ID, 'diet_plans'), clone);
    showToast('✅ Piano clonato!');
    await loadDiets();
  } catch(e) { showToast('Errore clonazione', 'err'); }
};

// ── Form ───────────────────────────────────────────────────
window.openNewDiet = function() {
  editingId = null;
  formData  = { name:'', day_on: buildEmptyDay(), day_off: buildEmptyDay() };
  window.formData = formData;
  renderDietForm(null);
};

window.openEdit = function(id) {
  const d = diets.find(x => x.id === id);
  if (!d) return;
  editingId = id;
  formData  = JSON.parse(JSON.stringify(d));
  window.formData = formData;
  renderDietForm(d);
};

function renderDietForm(diet) {
  document.getElementById('diet-list').style.display = 'none';
  document.querySelector('.ph').style.display = 'none';
  const fw = document.getElementById('diet-form');
  fw.style.display = 'block';
  fw.innerHTML = `
    <div class="ph" style="padding-top:8px">
      <button class="btn-icon" onclick="closeDietForm()">←</button>
      <h1>${diet ? 'Modifica' : 'Nuovo Piano'}</h1>
    </div>
    <div class="card">
      <div class="fg"><label class="fl">Nome piano</label>
        <input class="fi" id="df-name" placeholder="Bulk Primavera 2025…" value="${formData.name||''}"></div>
    </div>
    ${renderDayForm('day_on', '💪 Giorno ON', formData.day_on)}
    ${renderDayForm('day_off', '😴 Giorno OFF', formData.day_off)}
    <div class="grid2" style="margin-top:8px;margin-bottom:30px">
      <button class="btn btn-flat" onclick="closeDietForm()">Annulla</button>
      <button class="btn btn-v" onclick="saveDiet()">💾 Salva</button>
    </div>`;
}

function renderDayForm(dk, title, day) {
  return `
    <div class="card">
      <span class="clabel">${title}</span>
      <div class="grid3" style="margin-bottom:16px">
        <div class="fg" style="margin:0"><label class="fl">Kcal</label>
          <input type="number" class="fi" id="${dk}-kcal-input" value="${day.kcal||0}" readonly style="background:transparent;border-color:transparent;color:var(--t1);font-weight:bold;padding:0"></div>
        <div class="fg" style="margin:0"><label class="fl">Pro (g)</label>
          <input type="number" class="fi" id="${dk}-pro-input" value="${day.protein||0}" readonly style="background:transparent;border-color:transparent;color:var(--t1);font-weight:bold;padding:0"></div>
        <div class="fg" style="margin:0"><label class="fl">Carb (g)</label>
          <input type="number" class="fi" id="${dk}-carb-input" value="${day.carbs||0}" readonly style="background:transparent;border-color:transparent;color:var(--t1);font-weight:bold;padding:0"></div>
      </div>
      <div id="meal-list-${dk}">
        ${(day.meals||[]).map((m,mi) => renderMealForm(dk,mi,m)).join('')}
      </div>
      <button class="btn btn-ghost btn-sm" onclick="addMeal('${dk}')" style="margin-top:8px">＋ Aggiungi Pasto</button>
      <div id="totals-${dk}" style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);font-size:13px;color:var(--t2)"></div>
    </div>`;
}

function renderMealForm(dk, mi, m) {
  const varsText = (m.variants||[]).map(v =>
    typeof v === 'object' ? `${v.label}: ${v.detail}` : v
  ).join('\n');
  return `
    <div class="ex-card" id="mform-${dk}-${mi}">
      <div class="ex-head">
        <select class="fi" style="flex:1;padding:8px;font-size:13px"
          onchange="formData.${dk}.meals[${mi}].type=this.value">
          ${['colazione','pre_workout','post_workout','spuntino','pranzo','merenda','cena'].map(t =>
            `<option value="${t}" ${m.type===t?'selected':''}>${t}</option>`).join('')}
        </select>
        <button class="btn-del" onclick="removeMeal('${dk}',${mi})">🗑️</button>
      </div>
      <div class="grid2" style="margin-top:8px">
        <div class="fg" style="margin:0"><label class="fl">Label</label>
          <input class="fi" value="${m.label||''}" placeholder="Es. Pranzo" style="padding:8px"
            oninput="formData.${dk}.meals[${mi}].label=this.value"></div>
        <div class="fg" style="margin:0"><label class="fl">Orario</label>
          <input type="time" class="fi" value="${m.time||''}" style="padding:8px"
            oninput="formData.${dk}.meals[${mi}].time=this.value"></div>
      </div>
      <div class="fg" style="margin-top:8px"><label class="fl">Ingredienti</label>
        <textarea class="fi" rows="2" style="font-size:13px"
          oninput="formData.${dk}.meals[${mi}].items=this.value">${m.items||''}</textarea></div>
      <div class="grid3" style="margin-top:8px">
        <div class="fg" style="margin:0"><label class="fl">Kcal</label>
          <input type="number" class="fi" value="${m.kcal||''}" id="mkcal-${dk}-${mi}" style="padding:8px;text-align:center"
            oninput="formData.${dk}.meals[${mi}].kcal=+this.value;recalcTotals('${dk}')"></div>
        <div class="fg" style="margin:0"><label class="fl">Pro (g)</label>
          <input type="number" class="fi" value="${m.protein||''}" id="mpro-${dk}-${mi}" style="padding:8px;text-align:center"
            oninput="formData.${dk}.meals[${mi}].protein=+this.value"></div>
        <div class="fg" style="margin:0"><label class="fl">Carb (g)</label>
          <input type="number" class="fi" value="${m.carbs||''}" id="mcarb-${dk}-${mi}" style="padding:8px;text-align:center"
            oninput="formData.${dk}.meals[${mi}].carbs=+this.value"></div>
      </div>
      <div class="fg" style="margin-top:8px"><label class="fl">Grassi (g)</label>
        <input type="number" class="fi" value="${m.fats||''}" id="mfat-${dk}-${mi}" style="padding:8px;text-align:center;width:100px"
          oninput="formData.${dk}.meals[${mi}].fats=+this.value"></div>
      <button class="btn btn-ghost btn-sm" onclick="aiCalcMeal('${dk}',${mi})" style="margin-top:6px">✨ Calcola da testo con AI</button>
      <div class="fg" style="margin-top:10px"><label class="fl">Varianti (una per riga: Label: Dettaglio)</label>
        <textarea class="fi" rows="3" style="font-size:12px"
          oninput="parseVariants('${dk}',${mi},this.value)">${varsText}</textarea></div>
    </div>`;
}

window.addMeal = function(dk) {
  formData[dk].meals.push({ type:'pranzo', label:'', time:'', items:'', kcal:0, protein:0, carbs:0, fats:0, variants:null });
  reRenderMeals(dk);
};

window.removeMeal = function(dk, mi) {
  formData[dk].meals.splice(mi, 1);
  reRenderMeals(dk);
};

function reRenderMeals(dk) {
  const el = document.getElementById(`meal-list-${dk}`);
  if (el) el.innerHTML = (formData[dk].meals||[]).map((m,mi) => renderMealForm(dk,mi,m)).join('');
  recalcTotals(dk);
}

window.aiCalcMeal = async function(dk, mi) {
  const m = formData[dk].meals[mi];
  if (!m.items?.trim()) { showToast('Scrivi prima gli ingredienti', 'err'); return; }
  showToast('⏳ Calcolo AI...', 'info');
  const r = await calcMacrosFromText(m.items);
  if (!r.success) { showToast('Errore AI: ' + r.error, 'err'); return; }
  formData[dk].meals[mi].kcal    = r.kcal;
  formData[dk].meals[mi].protein = r.protein;
  formData[dk].meals[mi].carbs   = r.carbs;
  formData[dk].meals[mi].fats    = r.fats;
  const setVal = (id, val) => { const e = document.getElementById(id); if (e) e.value = val; };
  setVal(`mkcal-${dk}-${mi}`, r.kcal);
  setVal(`mpro-${dk}-${mi}`,  r.protein);
  setVal(`mcarb-${dk}-${mi}`, r.carbs);
  setVal(`mfat-${dk}-${mi}`,  r.fats);
  recalcTotals(dk);
  showToast('✅ Macro calcolati!');
};

window.parseVariants = function(dk, mi, text) {
  formData[dk].meals[mi].variants = text.split('\n').map(line => {
    const colon = line.indexOf(':');
    if (colon > 0) return { label: line.slice(0, colon).trim(), detail: line.slice(colon+1).trim() };
    return line.trim() || null;
  }).filter(Boolean);
};

window.recalcTotals = function(dk) {
  const meals = formData[dk].meals || [];
  const sum = meals.reduce((a, m) => ({
    kcal:    a.kcal    + (m.kcal||0),
    protein: a.protein + (m.protein||0),
    carbs:   a.carbs   + (m.carbs||0),
    fats:    a.fats    + (m.fats||0)
  }), { kcal:0, protein:0, carbs:0, fats:0 });

  formData[dk].kcal = sum.kcal;
  formData[dk].protein = sum.protein;
  formData[dk].carbs = sum.carbs;
  formData[dk].fats = sum.fats;

  const kIn = document.getElementById(`${dk}-kcal-input`);
  const pIn = document.getElementById(`${dk}-pro-input`);
  const cIn = document.getElementById(`${dk}-carb-input`);
  if (kIn) kIn.value = sum.kcal;
  if (pIn) pIn.value = sum.protein;
  if (cIn) cIn.value = sum.carbs;

  const el = document.getElementById(`totals-${dk}`);
  if (el) {
    el.innerHTML = `Totale pasti: ${sum.kcal} kcal · P:${sum.protein}g C:${sum.carbs}g F:${sum.fats}g`;
  }
};

window.closeDietForm = function() {
  document.getElementById('diet-form').style.display = 'none';
  document.getElementById('diet-list').style.display = 'block';
  document.querySelector('.ph').style.display = 'flex';
};

window.saveDiet = async function() {
  const nameVal = document.getElementById('df-name')?.value?.trim();
  if (!nameVal) { showToast('Inserisci il nome', 'err'); return; }
  try {
    const sanitizeMeals = meals => (meals || []).map(m => ({
      type:    m.type    || 'pranzo',
      label:   m.label   || '',
      time:    m.time    || '',
      items:   m.items   || '',
      kcal:    Number(m.kcal)    || 0,
      protein: Number(m.protein) || 0,
      carbs:   Number(m.carbs)   || 0,
      fats:    Number(m.fats)    || 0,
      variants: m.variants || null
    }));
    
    const sumMeals = (meals) => {
      const s = sanitizeMeals(meals);
      return s.reduce((a, m) => ({
        kcal: a.kcal + m.kcal,
        protein: a.protein + m.protein,
        carbs: a.carbs + m.carbs,
        fats: a.fats + m.fats
      }), { kcal: 0, protein: 0, carbs: 0, fats: 0 });
    };

    const dayOnTotals = sumMeals(formData.day_on?.meals);
    const dayOffTotals = sumMeals(formData.day_off?.meals);

    const dataToSave = {
      name:       nameVal,
      active:     editingId ? (diets.find(d => d.id === editingId)?.active || false) : false,
      updated_at: new Date().toISOString(),
      day_on: {
        kcal:    dayOnTotals.kcal,
        protein: dayOnTotals.protein,
        carbs:   dayOnTotals.carbs,
        fats:    dayOnTotals.fats,
        meals:   sanitizeMeals(formData.day_on?.meals)
      },
      day_off: {
        kcal:    dayOffTotals.kcal,
        protein: dayOffTotals.protein,
        carbs:   dayOffTotals.carbs,
        fats:    dayOffTotals.fats,
        meals:   sanitizeMeals(formData.day_off?.meals)
      }
    };
    console.log('Salvataggio dieta:', JSON.stringify(dataToSave).slice(0, 500));
    if (editingId) {
      await setDoc(doc(db,'users',USER_ID,'diet_plans',editingId), dataToSave);
    } else {
      await addDoc(collection(db,'users',USER_ID,'diet_plans'), dataToSave);
    }
    showToast('✅ Piano salvato!');
    closeDietForm();
    await loadDiets();
  } catch(e) {
    console.error('ERRORE salvataggio dieta:', e);
    console.error('Stack:', e.stack);
    showToast('❌ Errore: ' + e.message, 'err');
  }
};

loadDiets();
