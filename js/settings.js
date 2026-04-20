import { db, USER_ID, doc, getDoc, setDoc } from './firebase-config.js';
import { showToast } from './app.js';

let settings = {
  auto_save: false,
  auto_save_minutes: 5,
  profile: { name: '', weight_target: null, height: null }
};

async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, 'users', USER_ID, 'settings', 'app'));
    if (snap.exists()) settings = { ...settings, ...snap.data() };
  } catch(e) { console.error('loadSettings', e); }

  const toggle   = document.getElementById('auto-save-toggle');
  const interval = document.getElementById('auto-save-interval');
  const wrap     = document.getElementById('interval-wrap');

  if (toggle)   toggle.checked = !!settings.auto_save;
  if (interval) interval.value = settings.auto_save_minutes || 5;
  if (wrap)     wrap.style.display = settings.auto_save ? 'block' : 'none';

  const name   = document.getElementById('profile-name');
  const weight = document.getElementById('profile-weight');
  const height = document.getElementById('profile-height');

  const profile = settings.profile || {};
  if (name   && profile.name)          name.value   = profile.name;
  if (weight && profile.weight_target) weight.value = profile.weight_target;
  if (height && profile.height)        height.value = profile.height;
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
    auto_save:         toggle?.checked || false,
    auto_save_minutes: +(interval?.value || 5),
    profile: {
      name:          name?.value.trim() || '',
      weight_target: weight?.value ? +weight.value : null,
      height:        height?.value ? +height.value : null
    }
  };

  try {
    await setDoc(doc(db, 'users', USER_ID, 'settings', 'app'), settings, { merge: true });
    showToast('Impostazioni salvate! ✅');
  } catch(e) {
    console.error('saveSettings', e);
    showToast('Errore nel salvataggio', 'err');
  }
};

loadSettings();
