export function getTodayString() {
  return new Date().toISOString().split('T')[0];
}

export function getDayOfWeek(dateStr) {
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  if (dateStr) {
    const [y,m,d] = dateStr.split('-').map(Number);
    return days[new Date(y, m-1, d).getDay()];
  }
  return days[new Date().getDay()];
}

export function formatDateIT(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m-1, d).toLocaleDateString('it-IT', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}

export function formatDateShort(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m-1, d).toLocaleDateString('it-IT', {
    day: 'numeric', month: 'short', year: 'numeric'
  });
}

export function addDays(str, n) {
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(y, m-1, d);
  dt.setDate(dt.getDate() + n);
  return dt.toISOString().split('T')[0];
}

export function formatTimer(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

export function showToast(msg, type = 'ok') {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast' + (type === 'err' ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 2800);
}

export function showModal({ title, text, confirmLabel = 'Conferma', confirmClass = 'btn-r', onConfirm, onCancel } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal">
      <div class="modal-handle"></div>
      <h3>${title}</h3>
      ${text ? `<p>${text}</p>` : ''}
      <div class="grid2" style="margin-top:8px">
        <button class="btn btn-ghost" id="_m_cancel">Annulla</button>
        <button class="btn ${confirmClass}" id="_m_ok">${confirmLabel}</button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  bg.querySelector('#_m_cancel').onclick = () => { bg.remove(); onCancel?.(); };
  bg.querySelector('#_m_ok').onclick     = () => { bg.remove(); onConfirm?.(); };
  bg.addEventListener('click', e => { if (e.target === bg) { bg.remove(); onCancel?.(); } });
}

export function setWidth(id, pct) {
  const el = document.getElementById(id);
  if (el) el.style.width = Math.min(100, Math.max(0, pct)) + '%';
}

export function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

export const DEFAULT_TARGETS = {
  kcal_on: 2700, pro_on: 180,  carb_on: 300,  fat_on: 75,
  kcal_off:2400, pro_off:185,  carb_off:220,  fat_off:80
};

export const DAYS_IT = {
  monday:'Lunedì', tuesday:'Martedì', wednesday:'Mercoledì',
  thursday:'Giovedì', friday:'Venerdì', saturday:'Sabato', sunday:'Domenica'
};

export const DAYS_ORDER = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
