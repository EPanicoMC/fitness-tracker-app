import {
  db, USER_ID, collection, doc, getDocs, setDoc, deleteDoc, query, orderBy, storage
} from './firebase-config.js';
import { showToast, showModal, formatDateIT } from './app.js';
import {
  ref, uploadBytes, getDownloadURL
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js';

let checks = [];
let formPhotos = [];

const MEASURES = [
  { key:'weight',   label:'Peso (kg)',        unit:'kg', icon:'⚖️' },
  { key:'shoulders', label:'Spalle (cm)',      unit:'cm', icon:'🔴' },
  { key:'waist',    label:'Vita (cm)',          unit:'cm', icon:'🔴' },
  { key:'chest',    label:'Petto (cm)',          unit:'cm', icon:'🔴' },
  { key:'bicep_l',  label:'Braccio SX (cm)',  unit:'cm', icon:'💪' },
  { key:'bicep_r',  label:'Braccio DX (cm)',  unit:'cm', icon:'💪' },
  { key:'thigh_l',  label:'Coscia SX (cm)',   unit:'cm', icon:'🦵' },
  { key:'thigh_r',  label:'Coscia DX (cm)',   unit:'cm', icon:'🦵' },
  { key:'calf_l',   label:'Polpaccio SX (cm)', unit:'cm', icon:'🦵' },
  { key:'calf_r',   label:'Polpaccio DX (cm)', unit:'cm', icon:'🦵' }
];

// ── Load & render ──────────────────────────────────────────
async function loadChecks() {
  const el = document.getElementById('checks-list');
  el.innerHTML = '<div class="spin"></div>';
  const snap = await getDocs(
    query(collection(db, 'users', USER_ID, 'checks'), orderBy('date', 'desc'))
  );
  checks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  
  // Fill the legend values
  const lastCheck = checks[0];
  if (lastCheck && lastCheck.measurements) {
    const ms = lastCheck.measurements;
    if (ms.chest) document.getElementById('lbl-chest').textContent = ms.chest + ' cm';
    if (ms.waist) document.getElementById('lbl-waist').textContent = ms.waist + ' cm';
    if (ms.thigh_l) document.getElementById('lbl-legs').textContent = ms.thigh_l + ' cm';
    if (ms.bicep_l) document.getElementById('lbl-arms').textContent = ms.bicep_l + ' cm';
  }

  renderList();
  loadVolumeStats();
}

async function loadVolumeStats() {
  const elChart = document.getElementById('vol-chart');
  if (!elChart) return;
  try {
    const snap = await getDocs(query(collection(db, 'users', USER_ID, 'daily_logs'), orderBy('date', 'desc'), limit(14)));
    const logs = snap.docs.map(d => d.data());
    
    // Calculate volumes per day
    const vols = [];
    let totThisWeek = 0;
    let totLastWeek = 0;
    
    const todayObj = new Date();
    // 7 days ago
    for(let i=6; i>=0; i--) {
      const d = new Date(todayObj);
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().split('T')[0];
      const log = logs.find(l => l.date === ds);
      let v = 0;
      if (log && log.workout && log.workout.exercises) {
        v = log.workout.exercises.reduce((a, ex) => a + ex.sets.reduce((b, s) => b + (parseFloat(s.weight) || 0) * (parseFloat(s.reps) || 1), 0), 0);
      }
      vols.push({ date: ds, val: v });
      totThisWeek += v;
    }

    // Last week total
    for(let i=13; i>=7; i--) {
      const d = new Date(todayObj);
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().split('T')[0];
      const log = logs.find(l => l.date === ds);
      let v = 0;
      if (log && log.workout && log.workout.exercises) {
        v = log.workout.exercises.reduce((a, ex) => a + ex.sets.reduce((b, s) => b + (parseFloat(s.weight) || 0) * (parseFloat(s.reps) || 1), 0), 0);
      }
      totLastWeek += v;
    }

    document.getElementById('vol-total').textContent = totThisWeek.toLocaleString('it-IT');
    const trendEl = document.getElementById('vol-trend');
    if (totLastWeek > 0) {
      const diff = Math.round(((totThisWeek - totLastWeek) / totLastWeek) * 100);
      trendEl.textContent = `${diff >= 0 ? '+' : ''}${diff}% vs settimana scorsa`;
      trendEl.style.color = diff >= 0 ? 'var(--green)' : 'var(--red)';
    } else {
      trendEl.textContent = '';
    }

    const maxV = Math.max(...vols.map(v => v.val), 100); // minimum 100 to avoid div by zero
    elChart.innerHTML = vols.map((v, i) => {
      const isToday = i === 6;
      const hPct = Math.max(5, (v.val / maxV) * 100);
      const lbl = new Date(v.date).toLocaleDateString('it-IT', { weekday: 'short' }).toUpperCase();
      return `
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;">
          ${isToday && v.val > 0 ? `<div style="font-size:10px;font-weight:700;color:var(--t1);background:rgba(255,255,255,0.1);padding:2px 4px;border-radius:4px;margin-bottom:2px">${v.val}</div>` : ''}
          <div style="width:100%;max-width:24px;height:100px;display:flex;align-items:flex-end">
            <div style="width:100%;background:${isToday ? 'var(--accent)' : 'rgba(255,255,255,0.1)'};height:${hPct}%;border-radius:4px 4px 0 0;transition:all 0.3s"></div>
          </div>
          <div style="font-size:9px;color:${isToday ? 'var(--t1)' : 'var(--t3)'};font-weight:700">${lbl}</div>
        </div>
      `;
    }).join('');
  } catch(e) {
    elChart.innerHTML = '';
  }
}

function renderList() {
  const el = document.getElementById('checks-list');
  if (!checks.length) {
    el.innerHTML = '<div class="empty"><span class="ei">📸</span><p>Nessun check ancora.<br>Inizia il tuo primo check-in!</p></div>';
    return;
  }
  el.innerHTML = checks.map((c, ci) => {
    const prev = checks[ci + 1];
    const weightDelta = prev ? (c.weight - prev.weight).toFixed(1) : null;
    return `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-size:16px;font-weight:800">${formatDateIT(c.date)}</div>
            <div style="font-size:13px;color:var(--t2);margin-top:2px">${c.notes||''}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:22px;font-weight:900">${c.weight||'—'} kg</div>
            ${weightDelta !== null ? `<div style="font-size:13px;font-weight:700;color:${weightDelta>0?'var(--green)':weightDelta<0?'var(--red)':'var(--t2)'}">${weightDelta>0?'+':''}${weightDelta} kg</div>` : ''}
          </div>
        </div>
        ${renderMeasureDeltas(c, prev)}
        ${c.photos?.length ? `<div style="display:flex;gap:8px;overflow-x:auto;margin-top:10px">
          ${c.photos.map(url => `<img src="${url}" style="width:80px;height:80px;object-fit:cover;border-radius:10px;flex-shrink:0">`).join('')}
        </div>` : ''}
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-flat btn-sm" onclick="deleteCheck('${c.id}')">🗑️ Elimina</button>
        </div>
      </div>`;
  }).join('');
}

function renderMeasureDeltas(c, prev) {
  const ms = c.measurements || {};
  const pm = prev?.measurements || {};
  const rows = MEASURES.filter(m => m.key !== 'weight' && ms[m.key] != null);
  if (!rows.length) return '';
  return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:10px">
    ${rows.map(m => {
      const val  = ms[m.key];
      const pval = pm[m.key];
      const diff = pval != null ? (val - pval) : null;
      const col  = diff === null ? 'var(--t2)' : diff > 0 ? 'var(--green)' : diff < 0 ? 'var(--red)' : 'var(--t2)';
      return `<div style="font-size:12px;color:var(--t2)">${m.icon} ${m.label.split(' ')[0]}:
        <span style="color:var(--t1);font-weight:700">${val} ${m.unit}</span>
        ${diff !== null ? `<span style="color:${col}">${diff>0?'+':''}${diff}</span>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

window.deleteCheck = function(id) {
  showModal({
    title: 'Elimina check-in', text: 'Vuoi eliminare questo check-in?',
    confirmLabel: 'Elimina',
    onConfirm: async () => {
      await deleteDoc(doc(db,'users',USER_ID,'checks',id));
      showToast('Check eliminato');
      await loadChecks();
    }
  });
};

// ── Body Map UI ────────────────────────────────────────────
window.showZone = function(key, label) {
  document.querySelectorAll('.b-zone').forEach(el => el.classList.remove('active'));
  const target = document.getElementById(`bz-${key}`);
  if (target) target.classList.add('active');

  const history = checks.filter(c => c.measurements?.[key] != null || (key === 'weight' && c.weight != null));
  if (!history.length) {
    document.getElementById('zone-info').innerHTML = `
      <div style="font-size:16px;font-weight:800;color:var(--t1);margin-bottom:4px">${label}</div>
      <div style="font-size:13px;color:var(--t3)">Nessun dato registrato.</div>`;
    return;
  }

  const latest = key === 'weight' ? history[0].weight : history[0].measurements[key];
  const unit = key === 'weight' ? 'kg' : 'cm';
  
  let listHtml = history.slice(0, 5).map((c, i) => {
    const val = key === 'weight' ? c.weight : c.measurements[key];
    const prevC = history[i+1];
    const pval = prevC ? (key === 'weight' ? prevC.weight : prevC.measurements[key]) : null;
    const diff = pval != null ? (val - pval).toFixed(1) : null;
    const col = diff == null ? 'var(--t2)' : diff > 0 ? 'var(--green)' : diff < 0 ? 'var(--red)' : 'var(--t2)';
    
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:13px">
      <span style="color:var(--t2)">${formatDateIT(c.date)}</span>
      <div><span style="font-weight:700">${val}</span> <span style="font-size:11px;color:${col}">${diff? (diff>0?'+':'')+diff : ''}</span></div>
    </div>`;
  }).join('');

  document.getElementById('zone-info').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div style="font-size:16px;font-weight:800;color:var(--accent)">${label}</div>
      <div style="font-size:20px;font-weight:900">${latest} <span style="font-size:12px;color:var(--t2)">${unit}</span></div>
    </div>
    <div style="margin-top:12px;text-align:left">
      <div style="font-size:11px;color:var(--t2);font-weight:800;text-transform:uppercase;margin-bottom:6px">Ultimi 5 check</div>
      ${listHtml}
    </div>
  `;
};

// ── Form ───────────────────────────────────────────────────
window.openNewCheck = function() {
  formPhotos = [];
  document.getElementById('checks-list-container').style.display = 'none';
  document.getElementById('body-map-section').style.display = 'none';
  document.querySelector('.ph').style.display = 'none';
  const fw = document.getElementById('check-form');
  fw.style.display = 'block';
  fw.innerHTML = `
    <div class="ph" style="padding-top:8px">
      <button class="btn-icon" onclick="closeCheckForm()">←</button>
      <h1>Nuovo Check-in</h1>
    </div>
    <div class="card">
      <div class="grid2">
        <div class="fg" style="margin:0"><label class="fl">Data</label>
          <input type="date" class="fi" id="ck-date" value="${new Date().toISOString().split('T')[0]}"></div>
        <div class="fg" style="margin:0"><label class="fl">Peso (kg)</label>
          <input type="number" class="fi" id="ck-weight" step="0.1" placeholder="75.0"></div>
      </div>
      <div class="fg" style="margin-top:12px"><label class="fl">Note</label>
        <textarea class="fi" id="ck-notes" rows="2" placeholder="Come ti senti..."></textarea></div>
    </div>
    <div class="card">
      <span class="clabel">📐 Misure corporee</span>
      ${MEASURES.filter(m => m.key !== 'weight').map(m => `
        <div class="s-row">
          <div><div class="s-lbl">${m.icon} ${m.label}</div></div>
          <input type="number" class="fi-in" id="ck-${m.key}" step="0.5" placeholder="—"> ${m.unit}
        </div>`).join('')}
    </div>
    <div class="card">
      <span class="clabel">📸 Foto</span>
      <input type="file" id="ck-photos" multiple accept="image/*" capture class="fi" style="padding:8px">
      <div id="photo-preview" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"></div>
    </div>
    <div class="grid2" style="margin-bottom:30px">
      <button class="btn btn-flat" onclick="closeCheckForm()">Annulla</button>
      <button class="btn btn-v" onclick="saveCheck()">💾 Salva</button>
    </div>`;

  document.getElementById('ck-photos').addEventListener('change', function() {
    const prev = document.getElementById('photo-preview');
    prev.innerHTML = '';
    Array.from(this.files).forEach(f => {
      const img = document.createElement('img');
      img.style.cssText = 'width:80px;height:80px;object-fit:cover;border-radius:10px';
      img.src = URL.createObjectURL(f);
      prev.appendChild(img);
    });
  });
};

window.closeCheckForm = function() {
  document.getElementById('check-form').style.display = 'none';
  document.getElementById('checks-list-container').style.display = 'block';
  document.getElementById('body-map-section').style.display = 'block';
  document.querySelector('.ph').style.display = 'flex';
};

window.saveCheck = async function() {
  const date   = document.getElementById('ck-date').value;
  const weight = parseFloat(document.getElementById('ck-weight').value) || null;
  if (!date) { showToast('Inserisci la data', 'err'); return; }

  const measurements = {};
  MEASURES.filter(m => m.key !== 'weight').forEach(m => {
    const v = document.getElementById(`ck-${m.key}`)?.value;
    measurements[m.key] = v ? parseFloat(v) : null;
  });

  if (measurements['bicep_l'] != null && measurements['bicep_r'] == null) measurements['bicep_r'] = measurements['bicep_l'];
  if (measurements['bicep_r'] != null && measurements['bicep_l'] == null) measurements['bicep_l'] = measurements['bicep_r'];
  if (measurements['thigh_l'] != null && measurements['thigh_r'] == null) measurements['thigh_r'] = measurements['thigh_l'];
  if (measurements['thigh_r'] != null && measurements['thigh_l'] == null) measurements['thigh_l'] = measurements['thigh_r'];
  if (measurements['calf_l'] != null && measurements['calf_r'] == null) measurements['calf_r'] = measurements['calf_l'];
  if (measurements['calf_r'] != null && measurements['calf_l'] == null) measurements['calf_l'] = measurements['calf_r'];

  showToast('💾 Salvataggio...', 'info');

  const photoUrls = [];
  const files = document.getElementById('ck-photos')?.files;
  if (files?.length) {
    for (const file of files) {
      try {
        const storRef = ref(storage, `users/${USER_ID}/checks/${date}_${Date.now()}_${file.name}`);
        await uploadBytes(storRef, file);
        const url = await getDownloadURL(storRef);
        photoUrls.push(url);
      } catch(e) { console.warn('Photo upload failed:', e); }
    }
  }

  const id = `check_${date.replace(/-/g,'')}`;
  const prev = checks[0];
  const data = {
    date, weight,
    notes: document.getElementById('ck-notes').value.trim(),
    measurements,
    photos: photoUrls,
    previous: prev ? { weight: prev.weight, measurements: prev.measurements || {} } : null
  };

  try {
    await setDoc(doc(db,'users',USER_ID,'checks',id), data);
    showToast('✅ Check salvato!');
    closeCheckForm();
    await loadChecks();
  } catch(e) {
    showToast('Errore salvataggio', 'err');
  }
};

loadChecks();
