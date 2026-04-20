export function getTodayString() {
  return new Date().toISOString().split('T')[0];
}

export function formatDateDisplay(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString('it-IT', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

export function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function setProgress(elementId, value, max) {
  const el = document.getElementById(elementId);
  if (el) el.style.width = clamp((value / max) * 100, 0, 100) + '%';
}

export function setText(elementId, text) {
  const el = document.getElementById(elementId);
  if (el) el.textContent = text;
}

export const DEFAULT_TARGETS = {
  kcal_on: 2500,
  protein_on: 150,
  carbs_on: 250,
  fats_on: 70,
  kcal_off: 2200,
  protein_off: 130,
  carbs_off: 200,
  fats_off: 65
};
