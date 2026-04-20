import {
  db, USER_ID, collection, doc, getDocs, addDoc, setDoc, deleteDoc
} from './firebase-config.js';
import { showToast, showModal, DEFAULT_TARGETS } from './app.js';
import { Autocomplete, saveToLibrary } from './autocomplete.js';
import { searchOpenFoodFacts, calcKcalFromMacro } from './food-search.js';

const MEAL_TYPES = ['colazione','pranzo','cena','spuntino','pre_workout','post_workout','merenda'];
const MEAL_ICONS = { colazione:'🌅', pranzo:'☀️', cena:'🌙', spuntino:'🍎', pre_workout:'⚡', post_workout:'💪', merenda:'🧃' };

let plans     = [];
let editingId = null;
let formPlan  = {};
// Track food calc state per meal key: `${dk}-${mi}`
const foodCalcState = {};

function emptyPlan() {
  return {
    name: '',
    day_on:  { kcal: DEFAULT_TARGETS.kcal_on,  protein: DEFAULT_TARGETS.pro_on,  carbs: DEFAULT_TARGETS.carb_on,  fats: DEFAULT_TARGETS.fat_on,  meals: [] },
    day_off: { kcal: DEFAULT_TARGETS.kcal_off, protein: DEFAULT_TARGETS.pro_off, carbs: DEFAULT_TARGETS.carb_off, fats: DEFAULT_TARGETS.fat_off, meals: [] }
  };
}

// ── Load & render ──────────────────────────────────────────────────────────────
async function loadDietPlans() {
  const list = document.getElementById('diet-list');
  list.innerHTML = '<div class="spin-wrap"></div>';
  try {
    const snap = await getDocs(collection(db, 'users', USER_ID, 'diet_plans'));
    plans = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    plans.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
    renderList();
  } catch(e) {
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
            <div style="font-size:12px;color:var(--t2)">ON: ${onKcal} kcal · OFF: ${offKcal} kcal</div>
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
                <div class="macro-chip" style="background:rgba(124,111,255,.1)"><div class="mc-val" style="color:var(--accent)">${dd.kcal||0}</div><div class="mc-lbl">kcal</div></div>
                <div class="macro-chip" style="background:rgba(79,195,247,.1)"><div class="mc-val" style="color:var(--blue)">${dd.protein||0}g</div><div class="mc-lbl">Pro</div></div>
                <div class="macro-chip" style="background:rgba(255,213,79,.1)"><div class="mc-val" style="color:var(--yellow)">${dd.carbs||0}g</div><div class="mc-lbl">Carb</div></div>
                <div class="macro-chip" style="background:rgba(255,112,67,.1)"><div class="mc-val" style="color:var(--orange)">${dd.fats||0}g</div><div class="mc-lbl">Fat</div></div>
              </div>
              ${(dd.meals||[]).map(m => `
                <div class="meal-item">
                  <div>
                    <div class="meal-name">${MEAL_ICONS[m.type]||''} ${m.label||m.type}</div>
                    ${m.time ? `<div style="font-size:10px;color:var(--t3)">${m.time}</div>` : ''}
                    <div class="meal-macro">P:${m.protein||0}g C:${m.carbs||0}g F:${m.fats||0}g</div>
                  </div>
                  <span class="meal-kcal">${m.kcal||0}</span>
                </div>`).join('')}`;
          }).join('<hr>')}
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
  showModal({
    title: 'Elimina piano', text: 'Vuoi eliminare questo piano alimentare?',
    confirmLabel: 'Elimina',
    onConfirm: async () => {
      try {
        await deleteDoc(doc(db, 'users', USER_ID, 'diet_plans', id));
        showToast('Piano eliminato');
        await loadDietPlans();
      } catch { showToast('Errore', 'err'); }
    }
  });
};

// ── Form ───────────────────────────────────────────────────────────────────────
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
  document.getElementById('add-diet-btn').style.display = '';
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
        <input class="fi" id="df-name" placeholder="Es. Bulk Primavera 2025…" value="${plan?.name || ''}">
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
  const d    = formPlan[dk];
  const tots = calcDayTotals(dk);
  const borderCol = dk === 'day_on' ? 'var(--green)' : 'var(--t3)';
  return `
    <div class="card" style="border-color:${borderCol};margin-bottom:14px">
      <p style="font-weight:700;font-size:15px;color:${dk==='day_on'?'var(--green)':'var(--t2)'};margin-bottom:16px">${label}</p>
      <div class="grid4" style="margin-bottom:16px">
        ${['kcal','protein','carbs','fats'].map(f => {
          const p = f === 'protein' ? 'Pro (g)' : f === 'carbs' ? 'Carb (g)' : f === 'fats' ? 'Fat (g)' : 'Kcal';
          const key = f === 'protein' ? (dk==='day_on'?'pro_on':'pro_off') : f === 'carbs' ? (dk==='day_on'?'carb_on':'carb_off') : f === 'fats' ? (dk==='day_on'?'fat_on':'fat_off') : (dk==='day_on'?'kcal_on':'kcal_off');
          return `<div class="fg" style="margin:0">
            <label class="fl">${p}</label>
            <input type="number" class="fi" style="padding:10px;text-align:center"
              value="${d[f]||''}" placeholder="${DEFAULT_TARGETS[key]}"
              oninput="window._updTarget('${dk}','${f}',this.value)">
          </div>`;
        }).join('')}
      </div>
      <div id="tots-${dk}" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;font-size:12px;color:var(--t2)">
        ${renderTotLine(tots)}
      </div>
      <p class="sdiv" style="margin-top:0">Pasti</p>
      <div id="meals-wrap-${dk}">${(d.meals||[]).map((m,i) => renderMealRow(dk,i,m)).join('')}</div>
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
  const key = `${dk}-${mi}`;
  const variantsText = Array.isArray(m.variants)
    ? m.variants.map(v => typeof v === 'object' ? `${v.label}: ${v.detail}` : v).join('\n')
    : '';

  return `
    <div class="ex-card" id="meal-row-${dk}-${mi}">
      <div class="ex-head">
        <select class="fi" style="flex:1;margin-right:8px;padding:10px"
          oninput="window._updMeal('${dk}',${mi},'type',this.value)">
          ${MEAL_TYPES.map(t => `<option value="${t}" ${m.type===t?'selected':''}>${MEAL_ICONS[t]||''} ${t}</option>`).join('')}
        </select>
        <button class="btn-del" onclick="window._removeMeal('${dk}',${mi})">🗑️</button>
      </div>
      <div class="grid2">
        <div class="fg">
          <label class="fl">Label / Nome</label>
          <input class="fi" placeholder="Es. Pranzo…" value="${m.label||''}"
            oninput="window._updMeal('${dk}',${mi},'label',this.value)">
        </div>
        <div class="fg">
          <label class="fl">Orario</label>
          <input type="time" class="fi" value="${m.time||''}"
            oninput="window._updMeal('${dk}',${mi},'time',this.value)">
        </div>
      </div>
      <div class="fg">
        <label class="fl">Alimenti / Descrizione</label>
        <input class="fi" placeholder="Es. 150g Pollo + 100g Riso…" value="${m.items||''}"
          oninput="window._updMeal('${dk}',${mi},'items',this.value)">
      </div>

      <!-- Food calculator -->
      <details style="margin-bottom:10px">
        <summary style="font-size:12px;color:var(--accent);cursor:pointer;user-select:none;font-weight:700;padding:4px 0">
          🔍 Calcola macros da alimento
        </summary>
        <div style="margin-top:10px;padding:12px;background:var(--bg4);border-radius:10px">
          <div class="fg" style="margin-bottom:8px">
            <label class="fl">Cerca alimento</label>
            <input class="fi food-calc-input" id="food-calc-${key}" placeholder="Es. Pollo petto…"
              style="margin-bottom:0" autocomplete="off">
          </div>
          <div class="food-grams-row" id="food-grams-row-${key}" style="display:none">
            <label class="fl" style="margin:0;white-space:nowrap">Quantità (g)</label>
            <input type="number" class="fi" id="food-grams-${key}" placeholder="100" step="5"
              style="width:90px;padding:8px;text-align:center"
              oninput="window._calcFoodMacros('${key}')">
          </div>
          <div class="food-macro-preview" id="food-preview-${key}" style="display:none">
            <div class="fmp-item"><div class="fmp-val" id="fp-kcal-${key}" style="color:var(--accent)">0</div><div class="fmp-lbl">kcal</div></div>
            <div class="fmp-item"><div class="fmp-val" id="fp-pro-${key}" style="color:var(--blue)">0g</div><div class="fmp-lbl">Pro</div></div>
            <div class="fmp-item"><div class="fmp-val" id="fp-carb-${key}" style="color:var(--yellow)">0g</div><div class="fmp-lbl">Carb</div></div>
            <div class="fmp-item"><div class="fmp-val" id="fp-fat-${key}" style="color:var(--orange)">0g</div><div class="fmp-lbl">Fat</div></div>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn btn-ghost btn-sm" onclick="window._applyFoodMacros('${key}','${dk}',${mi},'add')" style="flex:1">+ Somma</button>
            <button class="btn btn-v btn-sm"     onclick="window._applyFoodMacros('${key}','${dk}',${mi},'set')" style="flex:1">= Sostituisci</button>
          </div>
        </div>
      </details>

      <div class="grid4">
        ${['protein','carbs','fats'].map(f => `
          <div class="fg" style="margin:0">
            <label class="fl">${f==='protein'?'Pro (g)':f==='carbs'?'Carb (g)':'Fat (g)'}</label>
            <input type="number" class="fi" style="padding:10px;text-align:center"
              placeholder="0" value="${m[f]||''}" min="0" step="0.1" id="${f}-${dk}-${mi}"
              oninput="window._updMacro('${dk}',${mi},'${f}',this.value)">
          </div>`).join('')}
        <div class="fg" style="margin:0">
          <label class="fl">Kcal</label>
          <input type="number" class="fi" style="padding:10px;text-align:center"
            placeholder="auto" value="${m.kcal||''}" min="0" id="kcal-${dk}-${mi}"
            oninput="window._updMeal('${dk}',${mi},'kcal',+this.value)">
        </div>
      </div>
      <div class="fg" style="margin-top:4px">
        <label class="fl">Varianti (una per riga — label: dettaglio)</label>
        <textarea class="notes-area" placeholder="Opzione 1: 130g Riso Basmati&#10;Opzione 2: 130g Couscous"
          oninput="window._updVariants('${dk}',${mi},this.value)">${variantsText}</textarea>
      </div>
    </div>`;
}

// ── Food calc ──────────────────────────────────────────────────────────────────
function initFoodAutocomplete(dk, mi) {
  const key   = `${dk}-${mi}`;
  const input = document.getElementById(`food-calc-${key}`);
  if (!input || input.dataset.acReady) return;
  input.dataset.acReady = '1';

  new Autocomplete({
    inputEl: input,
    collection: 'food_library',
    db, USER_ID,
    onSelect: async (item) => {
      foodCalcState[key] = item;
      document.getElementById(`food-grams-row-${key}`)?.style && (document.getElementById(`food-grams-row-${key}`).style.display = 'flex');
      document.getElementById(`food-preview-${key}`)?.style    && (document.getElementById(`food-preview-${key}`).style.display = 'grid');
      window._calcFoodMacros(key);
    },
    onCustom: async (name) => {
      // Try OpenFoodFacts
      showToast('Cerco su Open Food Facts…', 'inf');
      const results = await searchOpenFoodFacts(name);
      if (results.length) {
        const r = results[0];
        foodCalcState[key] = r;
        input.value = r.name;
        await saveToLibrary(db, USER_ID, 'food_library', r);
        document.getElementById(`food-grams-row-${key}`).style.display = 'flex';
        document.getElementById(`food-preview-${key}`).style.display    = 'grid';
        window._calcFoodMacros(key);
        showToast(`"${r.name}" trovato e salvato in libreria`);
      } else {
        foodCalcState[key] = { name, kcal_per_100g: 0, protein_per_100g: 0, carbs_per_100g: 0, fats_per_100g: 0 };
        document.getElementById(`food-grams-row-${key}`).style.display = 'flex';
        document.getElementById(`food-preview-${key}`).style.display    = 'grid';
        showToast('Non trovato — inserisci i valori manualmente', 'inf');
      }
    }
  });
}

window._calcFoodMacros = function(key) {
  const food  = foodCalcState[key];
  const grams = parseFloat(document.getElementById(`food-grams-${key}`)?.value) || 0;
  if (!food || !grams) return;

  const factor = grams / 100;
  const kcal   = Math.round(food.kcal_per_100g   * factor);
  const pro    = Math.round(food.protein_per_100g * factor * 10) / 10;
  const carb   = Math.round(food.carbs_per_100g   * factor * 10) / 10;
  const fat    = Math.round(food.fats_per_100g    * factor * 10) / 10;

  const set2 = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set2(`fp-kcal-${key}`, kcal);
  set2(`fp-pro-${key}`,  pro + 'g');
  set2(`fp-carb-${key}`, carb + 'g');
  set2(`fp-fat-${key}`,  fat + 'g');

  foodCalcState[key + '_calc'] = { kcal, protein: pro, carbs: carb, fats: fat };
};

window._applyFoodMacros = function(key, dk, mi, mode) {
  const calc = foodCalcState[key + '_calc'];
  if (!calc) { showToast('Calcola prima le macro', 'err'); return; }
  const m = formPlan[dk]?.meals?.[mi];
  if (!m) return;

  if (mode === 'add') {
    m.kcal    = (m.kcal    || 0) + calc.kcal;
    m.protein = Math.round(((m.protein || 0) + calc.protein) * 10) / 10;
    m.carbs   = Math.round(((m.carbs   || 0) + calc.carbs)   * 10) / 10;
    m.fats    = Math.round(((m.fats    || 0) + calc.fats)    * 10) / 10;
  } else {
    m.kcal    = calc.kcal;
    m.protein = calc.protein;
    m.carbs   = calc.carbs;
    m.fats    = calc.fats;
  }

  const upd = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  upd(`kcal-${dk}-${mi}`,    m.kcal);
  upd(`protein-${dk}-${mi}`, m.protein);
  upd(`carbs-${dk}-${mi}`,   m.carbs);
  upd(`fats-${dk}-${mi}`,    m.fats);
  updateDayTots(dk);
  showToast('Macro applicate ✅');
};

// ── Field update handlers ──────────────────────────────────────────────────────
window._updTarget = function(dk, field, val) {
  if (formPlan[dk]) formPlan[dk][field] = +val || 0;
};

window._updMeal = function(dk, mi, field, val) {
  const m = formPlan[dk]?.meals?.[mi];
  if (m) { m[field] = val; if (field === 'kcal') updateDayTots(dk); }
};

window._updVariants = function(dk, mi, text) {
  const m = formPlan[dk]?.meals?.[mi];
  if (!m) return;
  m.variants = text.split('\n').map(l => {
    l = l.trim(); if (!l) return null;
    const colonIdx = l.indexOf(':');
    if (colonIdx > 0) return { label: l.slice(0, colonIdx).trim(), detail: l.slice(colonIdx+1).trim() };
    return l;
  }).filter(Boolean);
};

window._updMacro = function(dk, mi, field, val) {
  const m = formPlan[dk]?.meals?.[mi];
  if (!m) return;
  m[field] = parseFloat(val) || 0;
  const kcal = calcKcalFromMacro(m.protein||0, m.carbs||0, m.fats||0);
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

window._addMeal = function(dk) {
  if (!formPlan[dk]) return;
  const m = { type:'colazione', label:'', time:'', items:'', kcal:0, protein:0, carbs:0, fats:0, variants:[] };
  formPlan[dk].meals.push(m);
  const wrap = document.getElementById(`meals-wrap-${dk}`);
  const mi = formPlan[dk].meals.length - 1;
  if (wrap) wrap.insertAdjacentHTML('beforeend', renderMealRow(dk, mi, m));
  initFoodAutocomplete(dk, mi);
};

window._removeMeal = function(dk, mi) {
  formPlan[dk]?.meals?.splice(mi, 1);
  reRenderMeals(dk);
};

function reRenderMeals(dk) {
  const wrap = document.getElementById(`meals-wrap-${dk}`);
  if (wrap) wrap.innerHTML = (formPlan[dk].meals||[]).map((m,i) => renderMealRow(dk,i,m)).join('');
  (formPlan[dk].meals||[]).forEach((_, mi) => initFoodAutocomplete(dk, mi));
  updateDayTots(dk);
}

// ── Save ───────────────────────────────────────────────────────────────────────
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
  } catch(e) {
    console.error(e);
    showToast('Errore nel salvataggio', 'err');
  }
};

loadDietPlans();
