import { db, USER_ID, doc, getDoc, setDoc } from './firebase-config.js';
import { showToast } from './app.js';

let settings = {
  auto_save: false,
  auto_save_minutes: 5,
  profile_name: '',
  profile_weight: null,
  profile_height: null
};

async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, 'users', USER_ID, 'settings', 'app'));
    if (snap.exists()) settings = { ...settings, ...snap.data() };
  } catch (e) { console.error('loadSettings', e); }

  const toggle   = document.getElementById('auto-save-toggle');
  const interval = document.getElementById('auto-save-interval');
  const wrap     = document.getElementById('interval-wrap');

  if (toggle)   toggle.checked = !!settings.auto_save;
  if (interval) interval.value = settings.auto_save_minutes || 5;
  if (wrap)     wrap.style.display = settings.auto_save ? 'block' : 'none';

  const name   = document.getElementById('profile-name');
  const weight = document.getElementById('profile-weight');
  const height = document.getElementById('profile-height');

  if (name   && settings.profile_name)   name.value   = settings.profile_name;
  if (weight && settings.profile_weight) weight.value = settings.profile_weight;
  if (height && settings.profile_height) height.value = settings.profile_height;
}

window._toggleAutoSave = function(on) {
  const wrap = document.getElementById('interval-wrap');
  if (wrap) wrap.style.display = on ? 'block' : 'none';
};

window.saveSettings = async function() {
  const toggle   = document.getElementById('auto-save-toggle');
  const interval = document.getElementById('auto-save-interval');
  const name     = document.getElementById('profile-name');
  const weight   = document.getElementById('profile-weight');
  const height   = document.getElementById('profile-height');

  settings = {
    auto_save:           toggle?.checked   || false,
    auto_save_minutes:   +(interval?.value || 5),
    profile_name:        name?.value.trim() || '',
    profile_weight:      weight?.value ? +weight.value : null,
    profile_height:      height?.value ? +height.value : null
  };

  try {
    await setDoc(doc(db, 'users', USER_ID, 'settings', 'app'), settings, { merge: true });
    showToast('Impostazioni salvate! ✅');
  } catch (e) {
    console.error('saveSettings', e);
    showToast('Errore nel salvataggio', 'err');
  }
};

loadSettings();
