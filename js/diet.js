import {
  db, USER_ID, collection, doc, getDocs, addDoc, setDoc, deleteDoc
} from './firebase-config.js';
import { showToast, showModal, DEFAULT_TARGETS } from './app.js';

const MEAL_TYPES = ['colazione','pranzo','cena','spuntino'];
const MEAL_ICONS = { colazione:'🌅', pranzo:'☀️', cena:'🌙', spuntino:'🍎' };

let plans     = [];
let editingId = null;

// formPlan holds the current form state
let formPlan = {
  name: '',
  day_on:  { kcal:0, protein:0, carbs:0, fats:0, meals:[] },
  day_off: { kcal:0, protein:0, carbs:0, fats:0, meals:[] }
};

function emptyPlan() {
  return {
    name: '',
    day_on:  { kcal: DEFAULT_TARGETS.kcal_on,  protein: DEFAULT_TARGETS.pro_on,  carbs: DEFAULT_TARGETS.carb_on,  fats: DEFAULT_TARGETS.fat_on,  meals: [] },
    day_off: { kcal: DEFAULT_TARGETS.kcal_off, protein: DEFAULT_TARGETS.pro_off, carbs: DEFAULT_TARGETS.carb_off, fats: DEFAULT_TARGETS.fat_off, meals: [] }
  };
}

// ─── LOAD & RENDER ────────────────────────────────────────────────────────────

async function loadDietPlans() {
  const list = document.getElementById('diet-list');
  list.innerHTML = '<div class="spin-wrap"></div>';
  try {
    const snap = await getDocs(collection(db, 'users', USER_ID, 'diet_plans'));
    plans = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    plans.sort((a,b) => (b.active?1:0) - (a.active?1:0));
    renderList();
  } catch (e) {
    console.error(e);
    list.innerHTML = '<p style="color:var(--t2);text-align:center;padding:24px">Errore caricamento</p>';
  }
}

function renderList() {
  const list = document.getElementById('diet-list');
  if (!plans.length) {
    list.innerHTML = `<div class="empty"><span class="ei">🥗</span><p>Nessun piano ancora<br>Crea il tuo primo piano dieta!</p></div>`;
    return;
  }
  list.innerHTML = plans.map(p => {
    const onKcal  = p.day_on?.kcal  || 0;
    const offKcal = p.day_off?.kcal || 0;
    return `
      <div class="card" style="cursor:pointer" onclick="window._toggleDietDetail('${p.id}')">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div style="flex:1;min-width:0">
            <div style="font-size:17px;font-weight:700;margin-bottom:4px">${p.name}</div>
            <div style="font-size:12px;color:var(--t2)">
              ON: ${onKcal} kcal · OFF: ${offKcal} kcal
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;margin-left:8px">
            ${p.active ? '<span class="badge badge-g">✓ Attivo</span>' : ''}
            <button class="btn-del" onclick="event.stopPropagation();window._deleteDiet('${p.id}')">🗑️</button>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
          ${!p.active ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();window._activateDiet('${p.id}')">⚡ Attiva</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();window._editDiet('${p.id}')">✏️ Modifica</button>
        </div>
        <div id="diet-detail-${p.id}" style="display:none;border-top:1px solid var(--border);margin-top:14px;padding-top:14px">
          ${['day_on','day_off'].map(dk => {
            const dd = p[dk] || {};
            const label = dk === 'day_on' ? '💪 Giorno ON' : '😴 Giorno OFF';
            return `
              <p style="font-size:12px;font-weight:700;color:var(--t2);margin-bottom:8px">${label}</p>
              <div class="grid4" style="margin-bottom:12px">
                <div class="macro-chip" style="background:rgba(124,111,255,.1)">
                  <div class="mc-val" style="color:var(--accent)">${dd.kcal||0}</div><div class="mc-lbl">kcal</div>
                </div>
                <div class="macro-chip" style="background:rgba(79,195,247,.1)">
                  <div class="mc-val" style="color:var(--blue)">${dd.protein||0}g</div><div class="mc-lbl">Pro</div>
                </div>
                <div class="macro-chip" style="background:rgba(255,213,79,.1)">
                  <div class="mc-val" style="color:var(--yellow)">${dd.carbs||0}g</div><div class="mc-lbl">Carb</div>
                </div>
                <div class="macro-chip" style="background:rgba(255,112,67,.1)">
                  <div class="mc-val" style="color:var(--orange)">${dd.fats||0}g</div><div class="mc-lbl">Fat</div>
                </div>
              </div>
              ${(dd.meals||[]).map(m => `
                <div class="meal-item">
                  <div>
                    <div class="meal-name">${MEAL_ICONS[m.type]||''} ${m.name}</div>
                    <div class="meal-macro">P:${m.protein||0}g C:${m.carbs||0}g F:${m.fats||0}g</div>
                  </div>
                  <span class="meal-kcal">${m.kcal||0}</span>
                </div>`).join('')}`;
          }).join('<hr style="border:none;border-top:1px solid var(--border);margin:14px 0">')}
        </div>
      </div>`;
  }).join('');
}

window._toggleDietDetail = function(id) {
  const el = document.getElementById(`diet-detail-${id}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

window._activateDiet = async function(id) {
  try {
    for (const p of plans.filter(p => p.active))
      await setDoc(doc(db, 'users', USER_ID, 'diet_plans', p.id), { active: false }, { merge: true });
    await setDoc(doc(db, 'users', USER_ID, 'diet_plans', id), { active: true }, { merge: true });
    showToast('Piano attivato! ✅');
    await loadDietPlans();
  } catch { showToast('Errore', 'err'); }
};

window._deleteDiet = function(id) {
  showModal('Elimina piano', 'Vuoi eliminare questo piano alimentare?', 'Elimina', async () => {
    try {
      await deleteDoc(doc(db, 'users', USER_ID, 'diet_plans', id));
      showToast('Piano eliminato');
      await loadDietPlans();
    } catch { showToast('Errore', 'err'); }
  });
};

// ─── FORM ─────────────────────────────────────────────────────────────────────

window.showDietForm = function() {
  editingId = null;
  formPlan  = emptyPlan();
  renderForm(null);
};

window._editDiet = function(id) {
  const p = plans.find(x => x.id === id);
  if (!p) return;
  editingId = id;
  formPlan  = JSON.parse(JSON.stringify(p));
  renderForm(p);
};

window.hideDietForm = function() {
  document.getElementById('diet-form-wrap').style.display = 'none';
  document.getElementById('diet-list').style.display = 'block';
  document.getElementById('add-diet-btn').style.display = 'block';
};

function renderForm(plan) {
  document.getElementById('diet-list').style.display = 'none';
  document.getElementById('add-diet-btn').style.display = 'none';
  const fw = document.getElementById('diet-form-wrap');
  fw.style.display = 'block';
  fw.innerHTML = `
    <div class="ph" style="padding-top:8px">
      <button class="btn-icon" onclick="window.hideDietForm()">←</button>
      <h1>${plan ? 'Modifica' : 'Nuovo Piano'}</h1>
    </div>
    <div class="card">
      <div class="fg">
        <label class="fl">Nome piano</label>
        <input class="fi" id="df-name" placeholder="Es. Bulk 2025…" value="${plan?.name||''}">
      </div>
    </div>
    ${renderDaySection('day_on',  '💪 Giorno ON (allenamento)')}
    ${renderDaySection('day_off', '😴 Giorno OFF (riposo)')}
    <div class="grid2" style="margin-top:8px">
      <button class="btn btn-ghost" onclick="window.hideDietForm()">Annulla</button>
      <button class="btn btn-v"     onclick="window.saveDietForm()">💾 Salva</button>
    </div>`;
}

function renderDaySection(dk, label) {
  const d = formPlan[dk];
  const mealsHtml = (d.meals||[]).map((m,i) => renderMealRow(dk,i,m)).join('');
  const tots = calcDayTotals(dk);
  const borderCol = dk === 'day_on' ? 'var(--green)' : 'var(--t3)';
  return `
    <div class="card" style="border-color:${borderCol};margin-bottom:14px">
      <p style="font-weight:700;font-size:15px;color:${dk==='day_on'?'var(--green)':'var(--t2)'};margin-bottom:16px">${label}</p>
      <div class="grid4" style="margin-bottom:16px">
        <div class="fg" style="margin:0">
          <label class="fl">Kcal</label>
          <input type="number" class="fi" style="padding:10px;text-align:center"
            value="${d.kcal||''}" placeholder="${DEFAULT_TARGETS[dk==='day_on'?'kcal_on':'kcal_off']}"
            oninput="window._updTarget('${dk}','kcal',this.value)">
        </div>
        <div class="fg" style="margin:0">
          <label class="fl">Pro (g)</label>
          <input type="number" class="fi" style="padding:10px;text-align:center"
            value="${d.protein||''}" placeholder="${DEFAULT_TARGETS[dk==='day_on'?'pro_on':'pro_off']}"
            oninput="window._updTarget('${dk}','protein',this.value)">
        </div>
        <div class="fg" style="margin:0">
          <label class="fl">Carb (g)</label>
          <input type="number" class="fi" style="padding:10px;text-align:center"
            value="${d.carbs||''}" placeholder="${DEFAULT_TARGETS[dk==='day_on'?'carb_on':'carb_off']}"
            oninput="window._updTarget('${dk}','carbs',this.value)">
        </div>
        <div class="fg" style="margin:0">
          <label class="fl">Fat (g)</label>
          <input type="number" class="fi" style="padding:10px;text-align:center"
            value="${d.fats||''}" placeholder="${DEFAULT_TARGETS[dk==='day_on'?'fat_on':'fat_off']}"
            oninput="window._updTarget('${dk}','fats',this.value)">
        </div>
      </div>
      <!-- Totali pasti -->
      <div id="tots-${dk}" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;font-size:12px;color:var(--t2)">
        ${renderTotLine(tots)}
      </div>
      <p class="sdiv" style="margin-top:0">Pasti</p>
      <div id="meals-wrap-${dk}">${mealsHtml}</div>
      <button class="btn btn-ghost btn-sm" onclick="window._addMeal('${dk}')" style="margin-top:8px">＋ Pasto</button>
    </div>`;
}

function renderTotLine(tots) {
  return `<span>🔥 ${Math.round(tots.kcal)} kcal</span>
    <span>·</span><span style="color:var(--blue)">P: ${Math.round(tots.protein)}g</span>
    <span>·</span><span style="color:var(--yellow)">C: ${Math.round(tots.carbs)}g</span>
    <span>·</span><span style="color:var(--orange)">F: ${Math.round(tots.fats)}g</span>`;
}

function calcDayTotals(dk) {
  return (formPlan[dk].meals||[]).reduce((acc,m) => {
    acc.kcal    += m.kcal    || 0;
    acc.protein += m.protein || 0;
    acc.carbs   += m.carbs   || 0;
    acc.fats    += m.fats    || 0;
    return acc;
  }, { kcal:0, protein:0, carbs:0, fats:0 });
}

function renderMealRow(dk, mi, m) {
  return `
    <div class="ex-card" id="meal-row-${dk}-${mi}">
      <div class="ex-head">
        <select class="fi" style="flex:1;margin-right:8px;padding:10px"
          oninput="window._updMeal('${dk}',${mi},'type',this.value)">
          ${MEAL_TYPES.map(t => `<option value="${t}" ${m.type===t?'selected':''}>${MEAL_ICONS[t]} ${t}</option>`).join('')}
        </select>
        <button class="btn-del" onclick="window._removeMeal('${dk}',${mi})">🗑️</button>
      </div>
      <div class="fg">
        <label class="fl">Nome pasto</label>
        <input class="fi" placeholder="Es. Pollo con riso…" value="${m.name||''}"
          oninput="window._updMeal('${dk}',${mi},'name',this.value)">
      </div>
      <div class="grid4">
        <div class="fg" style="margin:0">
          <label class="fl">Pro (g)</label>
          <input type="number" class="fi" style="padding:10px;text-align:center"
            placeholder="0" value="${m.protein||''}" min="0" step="0.1"
            oninput="window._updMacro('${dk}',${mi},'protein',this.value)">
        </div>
        <div class="fg" style="margin:0">
          <label class="fl">Carb (g)</label>
          <input type="number" class="fi" style="padding:10px;text-align:center"
            placeholder="0" value="${m.carbs||''}" min="0" step="0.1"
            oninput="window._updMacro('${dk}',${mi},'carbs',this.value)">
        </div>
        <div class="fg" style="margin:0">
          <label class="fl">Fat (g)</label>
          <input type="number" class="fi" style="padding:10px;text-align:center"
            placeholder="0" value="${m.fats||''}" min="0" step="0.1"
            oninput="window._updMacro('${dk}',${mi},'fats',this.value)">
        </div>
        <div class="fg" style="margin:0">
          <label class="fl">Kcal</label>
          <input type="number" class="fi" style="padding:10px;text-align:center"
            placeholder="auto" value="${m.kcal||''}" min="0" id="kcal-${dk}-${mi}"
            oninput="window._updMeal('${dk}',${mi},'kcal',+this.value)">
        </div>
      </div>
    </div>`;
}

// Field updates
window._updTarget = function(dk, field, val) {
  if (formPlan[dk]) formPlan[dk][field] = +val || 0;
};

window._updMeal = function(dk, mi, field, val) {
  const m = formPlan[dk]?.meals?.[mi];
  if (m) { m[field] = val; updateDayTots(dk); }
};

window._updMacro = function(dk, mi, field, val) {
  const m = formPlan[dk]?.meals?.[mi];
  if (!m) return;
  m[field] = parseFloat(val) || 0;
  // Auto-calc kcal
  const kcal = Math.round((m.protein||0)*4 + (m.carbs||0)*4 + (m.fats||0)*9);
  m.kcal = kcal;
  const el = document.getElementById(`kcal-${dk}-${mi}`);
  if (el) el.value = kcal || '';
  updateDayTots(dk);
};

function updateDayTots(dk) {
  const tots = calcDayTotals(dk);
  const el = document.getElementById(`tots-${dk}`);
  if (el) el.innerHTML = renderTotLine(tots);
}

// Add / remove meals
window._addMeal = function(dk) {
  if (!formPlan[dk]) return;
  const m = { type:'colazione', name:'', kcal:0, protein:0, carbs:0, fats:0 };
  formPlan[dk].meals.push(m);
  const wrap = document.getElementById(`meals-wrap-${dk}`);
  if (wrap) wrap.insertAdjacentHTML('beforeend', renderMealRow(dk, formPlan[dk].meals.length-1, m));
};

window._removeMeal = function(dk, mi) {
  if (!formPlan[dk]) return;
  formPlan[dk].meals.splice(mi, 1);
  reRenderMeals(dk);
};

function reRenderMeals(dk) {
  const wrap = document.getElementById(`meals-wrap-${dk}`);
  if (wrap) wrap.innerHTML = (formPlan[dk].meals||[]).map((m,i) => renderMealRow(dk,i,m)).join('');
  updateDayTots(dk);
}

// Save
window.saveDietForm = async function() {
  const name = document.getElementById('df-name')?.value.trim();
  if (!name) { showToast('Inserisci il nome del piano', 'err'); return; }

  formPlan.name = name;
  const data = {
    ...formPlan,
    active: editingId ? (plans.find(p => p.id === editingId)?.active || false) : false
  };

  try {
    if (editingId) {
      await setDoc(doc(db, 'users', USER_ID, 'diet_plans', editingId), data, { merge: true });
      showToast('Piano aggiornato! ✅');
    } else {
      await addDoc(collection(db, 'users', USER_ID, 'diet_plans'), data);
      showToast('Piano creato! ✅');
    }
    window.hideDietForm();
    await loadDietPlans();
  } catch (e) {
    console.error(e);
    showToast('Errore nel salvataggio', 'err');
  }
};

// ─── INIT ─────────────────────────────────────────────────────────────────────
loadDietPlans();
