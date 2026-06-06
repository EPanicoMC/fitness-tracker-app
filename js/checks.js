import { requireAuth } from './app.js';
import {
  db, getUserId, collection, doc, getDoc, getDocs, setDoc, deleteDoc, query, orderBy, limit, where, storage
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
  
  const [checksSnap, logsSnap] = await Promise.all([
    getDocs(query(collection(db, 'users', getUserId(), 'checks'), orderBy('date', 'desc'))),
    getDocs(query(collection(db, 'users', getUserId(), 'daily_logs'), orderBy('date', 'desc'), limit(30)))
  ]);
  
  checks = checksSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const logs = logsSnap.docs.map(d => d.data());

  renderList();
  try { renderCharts(logs); } catch(e) { console.warn('renderCharts error:', e); }
  try { await loadTargets(); } catch(e) { console.warn('loadTargets error:', e); }
}

async function loadTargets() {
  try {
    const sSnap = await getDoc(doc(db, 'users', getUserId(), 'settings', 'app'));
    if (!sSnap.exists()) return;
    const s = sSnap.data();
    const profile = s.profile || {};
    
    const weightTarget = profile.weight_target || null;
    const fatTarget = profile.fat_target || null;
    
    const latestCheck = checks.length ? checks[0] : null;
    const currentWeight = latestCheck ? latestCheck.weight : null;
    const currentFat = latestCheck ? latestCheck.body_fat : null;
    
    let showCard = false;
    
    const card = document.getElementById('target-tracker-card');
    const wContainer = document.getElementById('target-weight-container');
    const fContainer = document.getElementById('target-fat-container');
    
    if (weightTarget && currentWeight) {
      showCard = true;
      wContainer.style.display = 'block';
      document.getElementById('current-weight-lbl').textContent = currentWeight;
      document.getElementById('target-weight-lbl').textContent = weightTarget;
      
      const firstCheck = checks.length > 1 ? checks[checks.length - 1] : null;
      let pct = 0;
      if (firstCheck && firstCheck.weight !== weightTarget) {
        const totalDiff = firstCheck.weight - weightTarget;
        const currentDiff = currentWeight - weightTarget;
        pct = Math.round(((totalDiff - currentDiff) / totalDiff) * 100);
      } else {
        pct = currentWeight <= weightTarget ? Math.round((currentWeight / weightTarget) * 100) : Math.round((weightTarget / currentWeight) * 100);
      }
      pct = Math.max(0, Math.min(100, pct));
      document.getElementById('weight-pct-lbl').textContent = `${pct}%`;
      document.getElementById('pb-weight-target').style.width = `${pct}%`;
    } else if (wContainer) {
      wContainer.style.display = 'none';
    }
    
    if (fatTarget && currentFat) {
      showCard = true;
      fContainer.style.display = 'block';
      document.getElementById('current-fat-lbl').textContent = currentFat;
      document.getElementById('target-fat-lbl').textContent = fatTarget;
      
      const firstCheck = checks.length > 1 ? checks.find(c => c.body_fat != null && c !== latestCheck) : null;
      let pct = 0;
      if (firstCheck && firstCheck.body_fat !== fatTarget) {
        const totalDiff = firstCheck.body_fat - fatTarget;
        const currentDiff = currentFat - fatTarget;
        pct = Math.round(((totalDiff - currentDiff) / totalDiff) * 100);
      } else {
        pct = currentFat <= fatTarget ? Math.round((currentFat / fatTarget) * 100) : Math.round((fatTarget / currentFat) * 100);
      }
      pct = Math.max(0, Math.min(100, pct));
      document.getElementById('fat-pct-lbl').textContent = `${pct}%`;
      document.getElementById('pb-fat-target').style.width = `${pct}%`;
    } else if (fContainer) {
      fContainer.style.display = 'none';
    }
    
    if (showCard && card) {
      card.style.display = 'block';
    } else if (card) {
      card.style.display = 'none';
    }
  } catch(e) {
    console.warn('Error loading targets:', e);
  }
}

let weightChartInstance = null;
let compChartInstance = null;
let volumeChartInstance = null;

function renderCharts(logs) {
  const canvasW = document.getElementById('weight-chart-canvas');
  const elTotal = document.getElementById('vol-total');
  const elTrend = document.getElementById('vol-trend');

  const pts = checks.filter(c => c.weight != null).slice(0, 10).reverse();

  if (pts.length === 0) {
    if (elTotal) elTotal.textContent = '—';
    if (elTrend) elTrend.textContent = 'Nessun check registrato';
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

  if (canvasW && pts.length >= 2) {
    if (weightChartInstance) weightChartInstance.destroy();
    
    const ctx = canvasW.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 160);
    gradient.addColorStop(0, 'rgba(124, 111, 255, 0.4)');
    gradient.addColorStop(1, 'rgba(124, 111, 255, 0.0)');
    
    weightChartInstance = new Chart(canvasW, {
      type: 'line',
      data: {
        labels: pts.map(p => new Date(p.date + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })),
        datasets: [{
          label: 'Peso (kg)',
          data: pts.map(p => p.weight),
          borderColor: '#7c6fff',
          borderWidth: 3,
          backgroundColor: gradient,
          fill: true,
          tension: 0.35,
          pointBackgroundColor: '#7c6fff',
          pointBorderColor: '#fff',
          pointBorderWidth: 1.5,
          pointRadius: 4,
          pointHoverRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1c1c1e',
            titleColor: '#fff',
            bodyColor: '#fff',
            borderColor: 'rgba(255,255,255,0.08)',
            borderWidth: 1,
            displayColors: false,
            callbacks: {
              label: (context) => ` ${context.parsed.y} kg`
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: 'rgba(255,255,255,0.4)', font: { size: 10 } }
          },
          y: {
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: 'rgba(255,255,255,0.4)', font: { size: 10 } }
          }
        }
      }
    });
  }

  // 2. Composition Chart
  const canvasC = document.getElementById('comp-chart-canvas');
  const compCard = document.getElementById('comp-card');
  const compPts = checks.filter(c => c.body_fat != null || c.muscle_mass != null).slice(0, 10).reverse();
  
  if (compPts.length >= 2 && canvasC && compCard) {
    compCard.style.display = 'block';
    if (compChartInstance) compChartInstance.destroy();
    
    compChartInstance = new Chart(canvasC, {
      type: 'line',
      data: {
        labels: compPts.map(p => new Date(p.date + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })),
        datasets: [
          {
            label: 'Massa Grassa (%)',
            data: compPts.map(p => p.body_fat),
            borderColor: '#ff6a00',
            borderWidth: 2,
            tension: 0.35,
            fill: false,
            pointBackgroundColor: '#ff6a00',
            pointRadius: 3
          },
          {
            label: 'Massa Muscolare (%)',
            data: compPts.map(p => p.muscle_mass),
            borderColor: '#00dc78',
            borderWidth: 2,
            tension: 0.35,
            fill: false,
            pointBackgroundColor: '#00dc78',
            pointRadius: 3
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            labels: { color: 'rgba(255,255,255,0.6)', boxWidth: 12, font: { size: 10 } }
          },
          tooltip: {
            backgroundColor: '#1c1c1e',
            titleColor: '#fff',
            bodyColor: '#fff',
            borderColor: 'rgba(255,255,255,0.08)',
            borderWidth: 1
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: 'rgba(255,255,255,0.4)', font: { size: 10 } }
          },
          y: {
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: 'rgba(255,255,255,0.4)', font: { size: 10 } }
          }
        }
      }
    });
  } else if (compCard) {
    compCard.style.display = 'none';
  }

  // 3. Training Volume Chart
  const canvasV = document.getElementById('volume-chart-canvas');
  const volumeCard = document.getElementById('volume-card');
  const volPts = logs ? logs.filter(l => l.workout && l.workout.total_volume > 0).slice(0, 10).reverse() : [];
  
  if (volPts.length >= 1 && canvasV && volumeCard) {
    volumeCard.style.display = 'block';
    if (volumeChartInstance) volumeChartInstance.destroy();
    
    const ctx = canvasV.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 160);
    gradient.addColorStop(0, 'rgba(255, 106, 0, 0.4)');
    gradient.addColorStop(1, 'rgba(255, 106, 0, 0.0)');
    
    volumeChartInstance = new Chart(canvasV, {
      type: 'bar',
      data: {
        labels: volPts.map(p => new Date(p.date + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })),
        datasets: [{
          label: 'Volume (kg)',
          data: volPts.map(p => p.workout.total_volume),
          borderColor: '#ff6a00',
          borderWidth: 2,
          backgroundColor: gradient,
          borderRadius: 6,
          borderSkipped: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1c1c1e',
            titleColor: '#fff',
            bodyColor: '#fff',
            borderColor: 'rgba(255,255,255,0.08)',
            borderWidth: 1,
            callbacks: {
              label: (context) => ` ${context.parsed.y} kg`
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: 'rgba(255,255,255,0.4)', font: { size: 10 } }
          },
          y: {
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: 'rgba(255,255,255,0.4)', font: { size: 10 } }
          }
        }
      }
    });
  } else if (volumeCard) {
    volumeCard.style.display = 'none';
  }

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
        ${c.ai_analysis ? renderAIAnalysis(c.ai_analysis) : ''}
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-flat btn-sm" onclick="deleteCheck('${c.id}')">🗑️ Elimina</button>
        </div>
      </div>`;
  }).join('');
}

function renderAIAnalysis(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch(e) {
    return `<div style="margin-top:10px;padding:10px 12px;background:rgba(124,111,255,0.08);border-radius:10px;border:1px solid rgba(124,111,255,0.2)">
      <div style="font-size:10px;font-weight:800;color:var(--purple);letter-spacing:0.5px;margin-bottom:5px">🤖 ANALISI AI</div>
      <div style="font-size:12px;color:var(--t2);line-height:1.55">${raw}</div>
    </div>`;
  }

  const a = data.analisi || {};
  const and = data.andamento || {};
  const p = data.piano || {};

  const giudizioColor = {
    'ottimo': '#00dc78', 'buono': '#7c6fff', 'attenzione': '#ff6a00', 'critico': '#ff3b30',
    'baseline': 'var(--t3)'
  };

  const aderenzaColor = {
    'eccellente': '#00dc78', 'buona': '#7c6fff', 'sufficiente': '#ff6a00',
    'scarsa': '#ff3b30', 'insufficiente': '#ff3b30'
  };

  const verdettoEmoji = {
    'PROSEGUI': '✅', 'MODIFICA DIETA': '🍽️', 'MODIFICA SCHEDA': '🏋️',
    'MODIFICA ENTRAMBI': '🔄'
  };

  // 1. Analisi Corpo
  let misureFocusHtml = '';
  if (a.misure_focus?.length) {
    misureFocusHtml = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px">
      ${a.misure_focus.map(m => {
        const col = giudizioColor[m.giudizio] || 'var(--t2)';
        return `<div style="padding:8px 10px;background:rgba(255,255,255,0.03);border-radius:8px;border-left:3px solid ${col}">
          <div style="font-size:11px;font-weight:800;color:var(--t1)">${m.zona}</div>
          <div style="font-size:13px;font-weight:700;color:${col}">${m.valore} <span style="font-size:10px;color:var(--t3)">${m.delta || ''}</span></div>
          <div style="font-size:9px;color:var(--t3);margin-top:2px">${m.trend || ''}</div>
        </div>`;
      }).join('')}
    </div>`;
  }

  const scoreHtml = a.body_score != null ? `
    <div style="display:flex;align-items:center;gap:10px;margin-top:12px;padding:10px 12px;background:rgba(124,111,255,0.06);border-radius:10px">
      <div style="font-size:28px;font-weight:900;color:var(--purple)">${a.body_score}<span style="font-size:14px;color:var(--t3)">/10</span></div>
      <div style="flex:1">
        <div style="font-size:9px;font-weight:800;color:var(--t3);text-transform:uppercase;letter-spacing:0.5px">Body Score</div>
        <div style="height:4px;background:rgba(255,255,255,0.08);border-radius:2px;margin-top:4px;overflow:hidden">
          <div style="width:${a.body_score * 10}%;height:100%;background:linear-gradient(90deg,#7c6fff,#00dc78);border-radius:2px"></div>
        </div>
      </div>
      ${a.tempo_valutazione ? `<div style="font-size:10px;color:var(--t3);text-align:right">${a.tempo_valutazione}</div>` : ''}
    </div>` : '';

  const analisiCard = `<div style="margin-top:12px;padding:14px;background:rgba(124,111,255,0.06);border-radius:14px;border:1px solid rgba(124,111,255,0.15)">
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
      <span style="font-size:14px">🔬</span>
      <span style="font-size:10px;font-weight:800;color:var(--purple);letter-spacing:0.5px;text-transform:uppercase">Analisi Dettagliata</span>
    </div>
    ${a.titolo ? `<div style="font-size:15px;font-weight:900;color:var(--t1);margin-bottom:8px">${a.titolo}</div>` : ''}
    <div style="font-size:12px;color:var(--t2);line-height:1.65">${a.body_review || ''}</div>
    ${misureFocusHtml}
    ${scoreHtml}
  </div>`;

  // 2. Andamento
  const posHtml = (and.positivi || []).map(p =>
    `<div style="display:flex;gap:6px;align-items:flex-start;margin-bottom:4px"><span style="color:#00dc78;font-size:12px;flex-shrink:0">▲</span><span style="font-size:12px;color:var(--t2);line-height:1.5">${p}</span></div>`
  ).join('');
  const negHtml = (and.negativi || []).map(n =>
    `<div style="display:flex;gap:6px;align-items:flex-start;margin-bottom:4px"><span style="color:#ff3b30;font-size:12px;flex-shrink:0">▼</span><span style="font-size:12px;color:var(--t2);line-height:1.5">${n}</span></div>`
  ).join('');
  const aderCol = aderenzaColor[and.aderenza_giudizio] || 'var(--t2)';

  const andamentoCard = `<div style="margin-top:8px;padding:14px;background:rgba(0,220,120,0.04);border-radius:14px;border:1px solid rgba(0,220,120,0.12)">
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px">
      <span style="font-size:14px">📊</span>
      <span style="font-size:10px;font-weight:800;color:#00dc78;letter-spacing:0.5px;text-transform:uppercase">Andamento</span>
      ${and.aderenza_giudizio ? `<span style="margin-left:auto;font-size:10px;font-weight:800;color:${aderCol};background:${aderCol}15;padding:3px 8px;border-radius:20px;text-transform:uppercase">${and.aderenza_giudizio}</span>` : ''}
    </div>
    ${posHtml ? `<div style="margin-bottom:8px">${posHtml}</div>` : ''}
    ${negHtml ? `<div style="margin-bottom:8px">${negHtml}</div>` : ''}
    ${and.nota_allenamento ? `<div style="font-size:11px;color:var(--t3);line-height:1.5;padding-top:6px;border-top:1px solid rgba(255,255,255,0.05)">🏋️ ${and.nota_allenamento}</div>` : ''}
  </div>`;

  // 3. Piano d'Azione
  const vEmoji = verdettoEmoji[p.verdetto] || '📋';
  const vColor = p.verdetto === 'PROSEGUI' ? '#00dc78' : '#ff6a00';
  const azioniHtml = (p.azioni || []).map((a, i) =>
    `<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:5px"><span style="font-size:11px;font-weight:800;color:var(--orange);flex-shrink:0">${i + 1}.</span><span style="font-size:12px;color:var(--t2);line-height:1.5">${a}</span></div>`
  ).join('');

  const pianoCard = `<div style="margin-top:8px;padding:14px;background:rgba(255,106,0,0.04);border-radius:14px;border:1px solid rgba(255,106,0,0.12)">
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px">
      <span style="font-size:14px">🎯</span>
      <span style="font-size:10px;font-weight:800;color:var(--orange);letter-spacing:0.5px;text-transform:uppercase">Piano d'Azione</span>
    </div>
    ${p.verdetto ? `<div style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:${vColor}15;border-radius:20px;margin-bottom:10px">
      <span style="font-size:14px">${vEmoji}</span>
      <span style="font-size:13px;font-weight:900;color:${vColor}">${p.verdetto}</span>
    </div>` : ''}
    ${p.motivazione ? `<div style="font-size:12px;color:var(--t2);line-height:1.55;margin-bottom:10px">${p.motivazione}</div>` : ''}
    ${azioniHtml}
    ${p.prossimo_check_consigliato ? `<div style="margin-top:8px;padding:8px 10px;background:rgba(255,255,255,0.03);border-radius:8px;font-size:11px;color:var(--t3)">📅 Prossimo check consigliato: <b style="color:var(--t1)">${p.prossimo_check_consigliato}</b></div>` : ''}
  </div>`;

  return analisiCard + andamentoCard + pianoCard;
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
        await deleteDoc(doc(db, 'users', getUserId(), 'checks', id));
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
      <div class="grid2" style="margin-top:12px">
        <div class="fg" style="margin:0"><label class="fl">% Massa Grassa</label>
          <input type="number" class="fi" id="ck-body-fat" step="0.1" placeholder="15.0"></div>
        <div class="fg" style="margin:0"><label class="fl">% Massa Muscolare</label>
          <input type="number" class="fi" id="ck-muscle-mass" step="0.1" placeholder="40.0"></div>
      </div>
      <div class="fg" style="margin-top:12px"><label class="fl">📝 Note per il Coach</label>
        <textarea class="fi" id="ck-notes" rows="3" placeholder="Infortuni, problemi, contesto rilevante (es: settimana stressante, viaggio, malattia, cambio abitudini...)"></textarea>
        <div style="font-size:10px;color:var(--t3);margin-top:4px">Più contesto dai, più l'analisi sarà accurata e personalizzata.</div></div>
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
  const body_fat = parseFloat(document.getElementById('ck-body-fat')?.value) || null;
  const muscle_mass = parseFloat(document.getElementById('ck-muscle-mass')?.value) || null;
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
      const storRef = ref(storage, `users/${getUserId()}/checks/${date}_${Date.now()}_${file.name}`);
      await uploadBytes(storRef, file);
      const url = await getDownloadURL(storRef);
      photoUrls.push({ url, view });
    } catch(e) { console.warn('Photo upload failed:', e); }
  }

  const id = `check_${date.replace(/-/g,'')}`;
  const prev = checks[0];
  const data = {
    date, weight, body_fat, muscle_mass,
    notes: document.getElementById('ck-notes').value.trim(),
    measurements,
    photos: photoUrls,
    previous: prev ? { weight: prev.weight, body_fat: prev.body_fat || null, muscle_mass: prev.muscle_mass || null, measurements: prev.measurements || {} } : null
  };

  try {
    await setDoc(doc(db,'users',getUserId(),'checks',id), data);
    showToast('✅ Check salvato!');
    closeCheckForm();
    await loadChecks();

    showToast('🤖 Analisi AI in corso...', 'info');
    try {
      const uid = getUserId();
      const prevCheck = checks.find(c => c.date < date);
      const logsFrom = prevCheck ? prevCheck.date : null;

      const fetches = [
        getDoc(doc(db, 'users', uid, 'settings', 'app')).catch(() => null),
        getDocs(query(collection(db, 'users', uid, 'programs'), limit(1))).catch(() => null),
        getDocs(query(collection(db, 'users', uid, 'diet_plans'), limit(1))).catch(() => null),
      ];
      if (logsFrom) {
        fetches.push(
          getDocs(query(
            collection(db, 'users', uid, 'daily_logs'),
            where('date', '>=', logsFrom),
            where('date', '<=', date),
            orderBy('date', 'desc')
          )).catch(() => null)
        );
      }

      const [settingsSnap, progSnap, dietSnap, logsSnap] = await Promise.all(fetches);
      const profile = settingsSnap?.data()?.profile || {};
      const activeProgram = progSnap?.docs?.[0]?.data() || null;
      const activeDiet = dietSnap?.docs?.[0]?.data() || null;
      const dailyLogs = logsSnap?.docs?.map(d => d.data()) || [];

      const aiResult = await analyzeCheckProgress({
        newCheck: { date, weight, body_fat, muscle_mass, measurements, photos: photoUrls, notes: data.notes },
        allChecks: checks,
        profile,
        dailyLogs,
        activeProgram,
        activeDiet
      });
      if (aiResult.success) {
        await setDoc(doc(db,'users',getUserId(),'checks',id), { ai_analysis: aiResult.analysis }, { merge: true });
        checks = checks.map(c => c.id === id ? { ...c, ai_analysis: aiResult.analysis } : c);
        renderList();
        showToast('🤖 Analisi AI completata!');
      }
    } catch(e) { console.warn('AI analysis failed:', e); }
  } catch(e) {
    showToast('Errore salvataggio', 'err');
  }
};

(async function() {
  await requireAuth();
  loadChecks();
})();
