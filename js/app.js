export function getTodayString() {
  return new Date().toISOString().split('T')[0];
}

export function getDayOfWeek() {
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  return days[new Date().getDay()];
}

export function formatDateIT(str) {
  const [y, m, d] = str.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('it-IT', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}

export function showToast(msg, type = 'ok') {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

export function showModal(title, text, confirmLabel, onConfirm) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal">
      <h3>${title}</h3>
      <p>${text}</p>
      <div class="modal-btns">
        <button class="btn btn-ghost" id="_m_cancel">Annulla</button>
        <button class="btn btn-del" id="_m_ok"
          style="border-radius:var(--r);padding:15px;font-size:15px;width:100%">
          ${confirmLabel}
        </button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  bg.querySelector('#_m_cancel').onclick = () => bg.remove();
  bg.querySelector('#_m_ok').onclick    = () => { bg.remove(); onConfirm(); };
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
  kcal_on: 2500, pro_on: 160,  carb_on: 260,  fat_on: 72,
  kcal_off:2200, pro_off:140,  carb_off:200,  fat_off:65
};

export const DAYS_IT = {
  monday:'Lunedì', tuesday:'Martedì', wednesday:'Mercoledì',
  thursday:'Giovedì', friday:'Venerdì', saturday:'Sabato', sunday:'Domenica'
};

export const DAYS_ORDER = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
