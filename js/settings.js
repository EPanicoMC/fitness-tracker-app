import { db, USER_ID, doc, getDoc, setDoc } from './firebase-config.js';
import { showToast } from './app.js';

async function loadSettings() {
  const snap = await getDoc(doc(db, 'users', USER_ID, 'settings', 'app'));
  if (!snap.exists()) return;
  const s = snap.data();
  if (s.profile?.name)          document.getElementById('s-name').value     = s.profile.name;
  if (s.profile?.height)        document.getElementById('s-height').value   = s.profile.height;
  if (s.profile?.weight_target) document.getElementById('s-wtarget').value  = s.profile.weight_target;
  if (s.auto_save)              document.getElementById('s-autosave').checked = true;
  if (s.auto_save_minutes)      document.getElementById('s-interval').value  = s.auto_save_minutes;
}

window.saveSettings = async function() {
  const data = {
    profile: {
      name:          document.getElementById('s-name').value.trim(),
      height:        parseInt(document.getElementById('s-height').value)  || null,
      weight_target: parseFloat(document.getElementById('s-wtarget').value) || null
    },
    auto_save:         document.getElementById('s-autosave').checked,
    auto_save_minutes: parseInt(document.getElementById('s-interval').value) || 5
  };
  try {
    await setDoc(doc(db, 'users', USER_ID, 'settings', 'app'), data, { merge: true });
    showToast('✅ Impostazioni salvate!');
  } catch(e) {
    showToast('Errore salvataggio', 'err');
  }
};

loadSettings();
