import {
  db, USER_ID, collection, doc, getDocs, setDoc, deleteDoc, query, orderBy
} from './firebase-config.js';
import { getApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js';
import { getTodayString, formatDateShort, showToast, showModal } from './app.js';

const storage = getStorage(getApp());
let checks = [];
let formData = {};

const MEASURES = [
  { key: 'weight',    label: 'Peso',     unit: 'kg', positive: false },
  { key: 'shoulders', label: 'Spalle',   unit: 'cm', positive: true  },
  { key: 'chest',     label: 'Petto',    unit: 'cm', positive: true  },
  { key: 'waist',     label: 'Vita',     unit: 'cm', positive: false },
  { key: 'hips',      label: 'Fianchi',  unit: 'cm', positive: false },
  { key: 'bicep_l',   label: 'Bicipite', unit: 'cm', positive: true  },
  { key: 'thigh_l',   label: 'Coscia',   unit: 'cm', positive: true  },
  { key: 'calf_l',    label: 'Polpaccio',unit: 'cm', positive: true  }
];

// ── Load ───────────────────────────────────────────────────────────────────────
async function loadChecks() {
  const list = document.getElementById('check-list');
  list.innerHTML = '<div class="spin-wrap"></div>';
  try {
    const snap = await getDocs(query(collection(db, 'users', USER_ID, 'checks'), orderBy('date', 'desc')));
    checks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderList();
  } catch(e) {
    console.error(e);
    list.innerHTML = '<p style="color:var(--t2);text-align:center;padding:32px">Errore caricamento</p>';
  }
}

function renderList() {
  const list = document.getElementById('check-list');
  if (!checks.length) {
    list.innerHTML = `<div class="empty"><span class="ei">📏</span><p>Nessun check-in ancora<br>Registra le tue misurazioni!</p></div>`;
    return;
  }

  list.innerHTML = checks.map((c, idx) => {
    const prev = checks[idx + 1] || c.prev;
    const weightDelta = prev ? (c.weight - (prev.weight || 0)).toFixed(1) : null;
    const deltaClass  = weightDelta === null ? 'delta-neu' : (+weightDelta >= 0 ? 'delta-pos' : 'delta-neg');
    const deltaSign   = weightDelta !== null && +weightDelta > 0 ? '+' : '';

    return `
      <div class="check-card">
        <div style="display:flex;align-items:flex-start;justify-content:space-between">
          <div>
            <div class="check-date">${formatDateShort(c.date)}</div>
            <div>
              <span class="check-weight">${c.weight}</span>
              <span class="check-unit"> kg</span>
              ${weightDelta !== null ? `<span class="measure-delta ${deltaClass}" style="margin-left:8px">${deltaSign}${weightDelta} kg</span>` : ''}
            </div>
          </div>
          <button class="btn-del" onclick="window._deleteCheck('${c.id}')">🗑️</button>
        </div>

        ${renderMeasureGrid(c, prev)}

        ${c.photos?.length ? `
          <p class="sdiv" style="margin-top:12px">Foto</p>
          <div class="photo-grid">
            ${c.photos.map(url => `
              <div class="photo-item">
                <img src="${url}" loading="lazy" onclick="window._openPhoto('${url}')">
              </div>`).join('')}
          </div>` : ''}

        ${c.notes ? `<p style="font-size:12px;color:var(--t2);margin-top:12px;font-style:italic">"${c.notes}"</p>` : ''}
      </div>`;
  }).join('');
}

function renderMeasureGrid(c, prev) {
  const prevM = prev?.measurements || {};
  const curM  = c.measurements || {};

  const items = MEASURES.filter(m => m.key !== 'weight').map(m => {
    const val     = curM[m.key];
    if (val == null) return '';
    const prevVal = prevM[m.key];
    const delta   = prevVal != null ? (val - prevVal) : null;
    const isGood  = delta === null ? null : (m.positive ? delta >= 0 : delta <= 0);
    const cls     = delta === null ? 'delta-neu' : (isGood ? 'delta-pos' : 'delta-neg');
    const sign    = delta !== null && delta > 0 ? '+' : '';
    return `
      <div class="measure-item">
        <div class="measure-label">${m.label}</div>
        <div class="measure-val">${val} ${m.unit}</div>
        ${delta !== null ? `<div class="measure-delta ${cls}">${sign}${delta.toFixed(1)}</div>` : ''}
      </div>`;
  }).filter(Boolean);

  return items.length ? `<div class="measure-grid">${items.join('')}</div>` : '';
}

window._openPhoto = function(url) {
  const bg = document.createElement('div');
  bg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:400;display:flex;align-items:center;justify-content:center;cursor:pointer';
  bg.innerHTML = `<img src="${url}" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:8px">`;
  bg.onclick = () => bg.remove();
  document.body.appendChild(bg);
};

window._deleteCheck = function(id) {
  showModal({
    title: 'Elimina check-in',
    text:  'Vuoi eliminare questo check-in?',
    confirmLabel: 'Elimina',
    onConfirm: async () => {
      try {
        await deleteDoc(doc(db, 'users', USER_ID, 'checks', id));
        showToast('Check-in eliminato');
        await loadChecks();
      } catch { showToast('Errore', 'err'); }
    }
  });
};

// ── Form ───────────────────────────────────────────────────────────────────────
window.showCheckForm = function() {
  formData = {
    date: getTodayString(),
    weight: null,
    measurements: {},
    photos: [],
    notes: ''
  };
  document.getElementById('check-list').style.display = 'none';
  document.querySelector('.ph button')?.setAttribute('style', 'display:none');
  const fw = document.getElementById('check-form-wrap');
  fw.style.display = 'block';
  fw.innerHTML = `
    <div class="ph" style="padding-top:8px">
      <button class="btn-icon" onclick="window.hideCheckForm()">←</button>
      <h1>Nuovo Check-in</h1>
    </div>

    <div class="card">
      <div class="fg">
        <label class="fl">Data</label>
        <input type="date" class="fi" id="cf-date" value="${getTodayString()}"
          oninput="formData.date = this.value">
      </div>
      <div class="fg">
        <label class="fl">Peso corpo (kg)</label>
        <input type="number" class="fi" id="cf-weight" step="0.1" placeholder="75.0"
          oninput="formData.weight = +this.value">
      </div>
    </div>

    <div class="card">
      <span class="clabel">Misurazioni (cm)</span>
      <div class="measure-grid">
        ${MEASURES.filter(m => m.key !== 'weight').map(m => `
          <div class="measure-item" style="padding:0">
            <label class="fl" style="padding:8px 12px 4px">${m.label}</label>
            <input type="number" class="fi" step="0.5" placeholder="—"
              style="border:none;background:transparent;padding:4px 12px 10px;font-size:17px;font-weight:800"
              oninput="formData.measurements['${m.key}'] = +this.value || null">
          </div>`).join('')}
      </div>
    </div>

    <div class="card">
      <span class="clabel">Foto</span>
      <div class="photo-grid" id="photo-preview">
        <div class="photo-item photo-add" onclick="document.getElementById('photo-input').click()">
          <span class="photo-add-icon">＋</span>
          <span>Aggiungi</span>
        </div>
      </div>
      <input type="file" id="photo-input" accept="image/*" multiple style="display:none"
        onchange="window._handlePhotos(this.files)">
      <p style="font-size:11px;color:var(--t3);margin-top:8px">Carica fino a 3 foto</p>
    </div>

    <div class="card">
      <span class="clabel">Note</span>
      <textarea class="notes-area" placeholder="Come ti senti? Progressi notati…"
        oninput="formData.notes = this.value"></textarea>
    </div>

    <div class="grid2" style="margin-top:8px">
      <button class="btn btn-ghost" onclick="window.hideCheckForm()">Annulla</button>
      <button class="btn btn-v" onclick="window.saveCheck()">💾 Salva</button>
    </div>`;
};

window.hideCheckForm = function() {
  document.getElementById('check-form-wrap').style.display = 'none';
  document.getElementById('check-list').style.display = 'block';
  document.querySelector('.ph button')?.removeAttribute('style');
};

let pendingFiles = [];

window._handlePhotos = async function(files) {
  pendingFiles = Array.from(files).slice(0, 3);
  const grid = document.getElementById('photo-preview');
  grid.innerHTML = pendingFiles.map((f, i) => `
    <div class="photo-item">
      <img src="${URL.createObjectURL(f)}" style="width:100%;height:100%;object-fit:cover">
    </div>`).join('') + `
    <div class="photo-item photo-add" onclick="document.getElementById('photo-input').click()">
      <span class="photo-add-icon">＋</span>
    </div>`;
};

window.saveCheck = async function() {
  if (!formData.weight) { showToast('Inserisci il peso', 'err'); return; }

  const id = 'check_' + formData.date.replace(/-/g, '');
  try {
    // Upload photos
    const photoUrls = [];
    for (const file of pendingFiles) {
      const storageRef = ref(storage, `users/${USER_ID}/checks/${id}/${file.name}`);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      photoUrls.push(url);
    }
    formData.photos = photoUrls;

    await setDoc(doc(db, 'users', USER_ID, 'checks', id), formData);
    showToast('Check-in salvato! ✅');
    window.hideCheckForm();
    pendingFiles = [];
    await loadChecks();
  } catch(e) {
    console.error(e);
    showToast('Errore nel salvataggio', 'err');
  }
};

loadChecks();
