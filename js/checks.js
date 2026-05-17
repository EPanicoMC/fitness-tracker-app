import { requireAuth } from './app.js';
import {
  db, USER_ID, collection, doc, getDocs, setDoc, deleteDoc, query, orderBy, limit, storage
} from './firebase-config.js';
import { showToast, showModal, formatDateIT } from './app.js';
import {
  ref, uploadBytes, getDownloadURL, deleteObject
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js';
import { analyzeCheckProgress } from './gemini.js';

let checks = [];
let formPhotos = [];

const MEASURES = [
  { key:'weight',    label:'Peso',    unit:'kg', icon:'⚖️' },
  { key:'shoulders', label:'Spalle',  unit:'cm', icon:'🔴' },
  { key:'chest',     label:'Petto',   unit:'cm', icon:'🔴' },
  { key:'waist',     label:'Vita',    unit:'cm', icon:'🔴' },
  { key:'bicep',     label:'Braccia', unit:'cm', icon:'💪' },
  { key:'thigh',     label:'Gambe',   unit:'cm', icon:'🦵' }
];

// Backward-compat lookup: handles old bicep_l/r and thigh_l/r fields
function getMeasure(ms, key) {
  if (!ms) return null;
  if (ms[key] != null) return ms[key];
  if (key === 'bicep') {
    const vals = [ms.bicep_l, ms.bicep_r].filter(v => v != null);
    return vals.length ? vals.reduce((a, b) => a + b) / vals.length : null;
  }
  if (key === 'thigh') {
    const vals = [ms.thigh_l, ms.thigh_r].filter(v => v != null);
    return vals.length ? vals.reduce((a, b) => a + b) / vals.length : null;
  }
  return null;
}

// Photo helpers — supports both legacy string URLs and new { url, view } objects
const photoUrl  = p => typeof p === 'string' ? p : p?.url;
const photoView = p => typeof p === 'object' && p ? p.view : null;

// ── Load & render ──────────────────────────────────────────
async function loadChecks() {
  const el = document.getElementById('checks-list');
  el.innerHTML = '<div class="spin"></div>';
  const snap = await getDocs(
    query(collection(db, 'users', USER_ID, 'checks'), orderBy('date', 'desc'))
  );
  checks = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  renderList();
  try { renderWeightTrend(); } catch(e) { console.warn('renderWeightTrend error:', e); }
}

function renderWeightTrend() {
  const elChart = document.getElementById('vol-chart');
  const elTotal = document.getElementById('vol-total');
  const elTrend = document.getElementById('vol-trend');
  if (!elChart) return;

  const pts = checks.filter(c => c.weight != null).slice(0, 8).reverse();

  if (pts.length === 0) {
    elChart.innerHTML = '<div style="font-size:13px;color:var(--t3);text-align:center;padding-top:30px">Nessun check con peso registrato</div>';
    if (elTotal) elTotal.textContent = '—';
    loadCheckStats();
    return;
  }

  const latest = pts[pts.length - 1];
  const prev   = pts.length > 1 ? pts[pts.length - 2] : null;
  if (elTotal) elTotal.textContent = latest.weight;

  if (prev && elTrend) {
    const delta = (latest.weight - prev.weight).toFixed(1);
    const col   = parseFloat(delta) < 0 ? 'var(--green)' : parseFloat(delta) > 0 ? 'var(--red)' : 'var(--t2)';
    elTrend.innerHTML = `<span style="color:${col};font-weight:700">${parseFloat(delta) > 0 ? '+' : ''}${delta} kg</span> <span style="color:var(--t3)">vs check precedente</span>`;
  } else {
    if (elTrend) elTrend.textContent = 'Primo check registrato';
  }

  if (pts.length < 2) {
    elChart.innerHTML = '<div style="font-size:12px;color:var(--t3);text-align:center;padding-top:30px">Aggiungi almeno 2 check per vedere il trend</div>';
    loadCheckStats();
    return;
  }

  const W = 300, H = 100, PAD = 14;
  const weights = pts.map(p => p.weight);
  const minW = Math.min(...weights) - 1;
  const maxW = Math.max(...weights) + 1;
  const range = maxW - minW || 1;

  const toX = i => PAD + (i / (pts.length - 1)) * (W - PAD * 2);
  const toY = w => H - PAD - ((w - minW) / range) * (H - PAD * 2);

  const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(p.weight).toFixed(1)}`).join(' ');
  const areaD = pathD + ` L${toX(pts.length-1).toFixed(1)},${H} L${toX(0).toFixed(1)},${H} Z`;

  const dots = pts.map((p, i) => {
    const x = toX(i), y = toY(p.weight);
    const lbl = new Date(p.date + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
    const isLast = i === pts.length - 1;
    return `
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${isLast ? 4 : 3}" fill="${isLast ? 'var(--accent)' : 'rgba(255,255,255,0.5)'}" stroke="${isLast ? '#fff' : 'none'}" stroke-width="1.5"/>
      ${isLast ? `<text x="${x.toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle" fill="rgba(255,255,255,0.8)" font-size="9" font-weight="700">${p.weight}kg</text>` : ''}
      <text x="${x.toFixed(1)}" y="${(H + 2).toFixed(1)}" text-anchor="middle" fill="rgba(255,255,255,0.3)" font-size="7">${lbl}</text>`;
  }).join('');

  elChart.innerHTML = `
    <svg viewBox="0 0 ${W} ${H + 14}" xmlns="http://www.w3.org/2000/svg" style="width:100%;overflow:visible">
      <defs>
        <linearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${areaD}" fill="url(#wg)"/>
      <path d="${pathD}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
    </svg>`;

  loadCheckStats();
}

async function loadCheckStats() {
  if (checks.length === 0) return;
  const latest = checks[0];
  const prev = checks.length > 1 ? checks[1] : null;
  const ms = latest.measurements || {};
  const pm = prev?.measurements || {};

  // Map: legend id -> { measureKey, label }
  const groups = {
    chest:     { measureKey: 'chest',     label: 'PETTO' },
    shoulders: { measureKey: 'shoulders', label: 'SPALLE' },
    waist:     { measureKey: 'waist',     label: 'VITA' },
    arms:      { measureKey: 'bicep',     label: 'BRACCIA' },
    legs:      { measureKey: 'thigh',     label: 'GAMBE' }
  };

  // Collect values for bar scaling
  const allVals = Object.values(groups).map(g => getMeasure(ms, g.measureKey)).filter(v => v != null);
  const maxVal = Math.max(...allVals, 1);

  Object.keys(groups).forEach(key => {
    const g = groups[key];
    const avg = getMeasure(ms, g.measureKey);
    const prevAvg = getMeasure(pm, g.measureKey);

    const valEl = document.getElementById(`val-${key}`);
    const barEl = document.getElementById(`bar-${key}`);

    if (avg != null) {
      let deltaHtml = '';
      if (prevAvg != null) {
        const diff = (avg - prevAvg).toFixed(1);
        const col = diff > 0 ? 'var(--green)' : diff < 0 ? 'var(--red)' : 'var(--t3)';
        deltaHtml = ` <span style="font-size:10px;color:${col}">${diff > 0 ? '+' : ''}${diff}</span>`;
      }
      if (valEl) valEl.innerHTML = `<span style="color:var(--t1)">${avg.toFixed(1)} cm</span>${deltaHtml}`;
      
      // Bar width proportional to max measurement
      const pct = Math.round((avg / maxVal) * 100);
      if (barEl) {
        barEl.style.width = pct + '%';
        barEl.style.background = 'var(--accent)';
      }
    } else {
      if (valEl) valEl.textContent = '—';
    }
  });

  // Highlight overlay zones based on improvement
  const ovHighlight = { chest: ['ov-chest'], shoulders: ['ov-shoulders'], waist: ['ov-waist'], arms: ['ov-bicep_l','ov-bicep_r'], legs: ['ov-thigh_l','ov-thigh_r'] };
  Object.keys(groups).forEach(key => {
    const avg = getMeasure(ms, groups[key].measureKey);
    const prevAvg = getMeasure(pm, groups[key].measureKey);
    if (avg == null || !ovHighlight[key]) return;
    const improved = prevAvg != null && (key === 'waist' ? avg < prevAvg : avg > prevAvg);
    ovHighlight[key].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.style.fill = `rgba(255,106,0,${improved ? 0.4 : 0.2})`;
        el.style.stroke = `rgba(255,106,0,${improved ? 0.7 : 0.4})`;
        if (improved) el.style.filter = 'drop-shadow(0 0 8px rgba(255,106,0,0.6))';
      }
    });
  });
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
          ${c.photos.map(p => {
            const u = photoUrl(p); const v = photoView(p);
            return `<div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex-shrink:0">
              <img src="${u}" style="width:80px;height:80px;object-fit:cover;border-radius:10px">
              ${v ? `<span style="font-size:9px;color:var(--t3);font-weight:700;text-transform:uppercase">${v}</span>` : ''}
            </div>`;
          }).join('')}
        </div>` : ''}
        ${c.ai_analysis ? `<div style="margin-top:10px;padding:10px 12px;background:rgba(124,111,255,0.08);border-radius:10px;border:1px solid rgba(124,111,255,0.2)">
          <div style="font-size:10px;font-weight:800;color:var(--purple);letter-spacing:0.5px;margin-bottom:5px">🤖 ANALISI AI</div>
          <div style="font-size:12px;color:var(--t2);line-height:1.55">${c.ai_analysis}</div>
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
  const rows = MEASURES.filter(m => m.key !== 'weight' && getMeasure(ms, m.key) != null);
  if (!rows.length) return '';
  return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:10px">
    ${rows.map(m => {
      const val  = getMeasure(ms, m.key);
      const pval = getMeasure(pm, m.key);
      const diff = pval != null ? parseFloat((val - pval).toFixed(1)) : null;
      const col  = diff === null ? 'var(--t2)' : diff > 0 ? 'var(--green)' : diff < 0 ? 'var(--red)' : 'var(--t2)';
      return `<div style="font-size:12px;color:var(--t2)">${m.icon} ${m.label}:
        <span style="color:var(--t1);font-weight:700">${val.toFixed(1)} ${m.unit}</span>
        ${diff !== null ? `<span style="color:${col}">${diff>0?'+':''}${diff}</span>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

window.deleteCheck = function(id) {
  showModal({
    title: 'Elimina check-in',
    text: 'Vuoi eliminare questo check-in? Verranno cancellate anche le foto dal cloud.',
    confirmLabel: 'Elimina',
    onConfirm: async () => {
      try {
        const checkData = checks.find(c => c.id === id);
        if (checkData?.photos?.length) {
          for (const photo of checkData.photos) {
            try {
              const u = photoUrl(photo);
              const urlObj = new URL(u);
              const pathEncoded = urlObj.pathname.split('/o/')[1];
              if (pathEncoded) {
                const photoPath = decodeURIComponent(pathEncoded.split('?')[0]);
                await deleteObject(ref(storage, photoPath));
              }
            } catch(e) { console.warn('Errore eliminazione foto Storage:', e); }
          }
        }
        await deleteDoc(doc(db, 'users', USER_ID, 'checks', id));
        showToast('✅ Check eliminato');
        await loadChecks();
      } catch(e) {
        showToast('Errore eliminazione', 'err');
        console.error(e);
      }
    }
  });
};

// ── Body Map UI ────────────────────────────────────────────
window.showZone = function(key, label) {
  document.querySelectorAll('.ov-zone').forEach(el => el.classList.remove('active'));
  // Highlight matching overlay zones
  const ovMap = { chest: ['ov-chest'], shoulders: ['ov-shoulders'], waist: ['ov-waist'], bicep: ['ov-bicep_l','ov-bicep_r'], bicep_l: ['ov-bicep_l','ov-bicep_r'], bicep_r: ['ov-bicep_l','ov-bicep_r'], thigh: ['ov-thigh_l','ov-thigh_r'], thigh_l: ['ov-thigh_l','ov-thigh_r'], thigh_r: ['ov-thigh_l','ov-thigh_r'], weight: [] };
  (ovMap[key] || []).forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('active'); });

  const getVal = (c) => key === 'weight' ? c.weight : getMeasure(c.measurements, key);
  const history = checks.filter(c => getVal(c) != null);
  if (!history.length) {
    document.getElementById('zone-info').innerHTML = `
      <div style="font-size:16px;font-weight:800;color:var(--t1);margin-bottom:4px">${label}</div>
      <div style="font-size:13px;color:var(--t3)">Nessun dato registrato.</div>`;
    return;
  }

  const latest = getVal(history[0]);
  const unit = key === 'weight' ? 'kg' : 'cm';

  let listHtml = history.slice(0, 5).map((c, i) => {
    const val = getVal(c);
    const prevC = history[i+1];
    const pval = prevC ? getVal(prevC) : null;
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
          <div><div class="s-lbl">${m.icon} ${m.label} (cm)</div></div>
          <input type="number" class="fi-in" id="ck-${m.key}" step="0.5" placeholder="—"> cm
        </div>`).join('')}
    </div>
    <div class="card">
      <span class="clabel">📸 Foto</span>
      <div style="font-size:11px;color:var(--t3);margin-bottom:8px">Seleziona le foto e indica la posa di ciascuna.</div>
      <input type="file" id="ck-photos" multiple accept="image/*" class="fi" style="padding:8px">
      <div id="photo-preview" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px"></div>
    </div>
    <div class="grid2" style="margin-bottom:30px">
      <button class="btn btn-flat" onclick="closeCheckForm()">Annulla</button>
      <button class="btn btn-v" onclick="saveCheck()">💾 Salva</button>
    </div>`;

  document.getElementById('ck-photos').addEventListener('change', function() {
    const prev = document.getElementById('photo-preview');
    prev.innerHTML = '';
    formPhotos = [];
    Array.from(this.files).forEach((f, i) => {
      formPhotos.push({ file: f, view: 'frontale' });
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:5px';
      const img = document.createElement('img');
      img.style.cssText = 'width:80px;height:80px;object-fit:cover;border-radius:10px';
      img.src = URL.createObjectURL(f);
      const sel = document.createElement('select');
      sel.style.cssText = 'font-size:10px;background:var(--bg3);color:var(--t2);border:1px solid var(--border2);border-radius:6px;padding:3px 5px;width:82px;text-align:center';
      ['frontale','laterale','schiena'].forEach(v => {
        const opt = document.createElement('option');
        opt.value = v; opt.textContent = v.charAt(0).toUpperCase() + v.slice(1);
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => { formPhotos[i].view = sel.value; });
      wrap.appendChild(img);
      wrap.appendChild(sel);
      prev.appendChild(wrap);
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

  showToast('💾 Salvataggio...', 'info');

  const photoUrls = [];
  for (const { file, view } of formPhotos) {
    try {
      const storRef = ref(storage, `users/${USER_ID}/checks/${date}_${Date.now()}_${file.name}`);
      await uploadBytes(storRef, file);
      const url = await getDownloadURL(storRef);
      photoUrls.push({ url, view });
    } catch(e) { console.warn('Photo upload failed:', e); }
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

    showToast('🤖 Analisi AI in corso...', 'info');
    try {
      const aiResult = await analyzeCheckProgress({
        prevCheck: prev || null,
        newCheck: { date, weight, measurements, photos: photoUrls }
      });
      if (aiResult.success) {
        await setDoc(doc(db,'users',USER_ID,'checks',id), { ai_analysis: aiResult.analysis }, { merge: true });
        checks = checks.map(c => c.id === id ? { ...c, ai_analysis: aiResult.analysis } : c);
        renderList();
        showToast('🤖 Analisi AI completata!');
      }
    } catch(e) { console.warn('AI analysis failed:', e); }
  } catch(e) {
    showToast('Errore salvataggio', 'err');
  }
};

loadChecks();
