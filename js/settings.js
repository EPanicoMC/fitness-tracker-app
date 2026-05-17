import { requireAuth } from './app.js';
import { db, getUserId, doc, getDoc, setDoc, auth, signOut } from './firebase-config.js';
import { showToast } from './app.js';

async function loadSettings() {
  const snap = await getDoc(doc(db, 'users', getUserId(), 'settings', 'app'));
  if (!snap.exists()) return;
  const s = snap.data();
  if (s.profile?.name)          document.getElementById('s-name').value       = s.profile.name;
  if (s.profile?.height)        document.getElementById('s-height').value     = s.profile.height;
  if (s.profile?.weight_target) document.getElementById('s-wtarget').value    = s.profile.weight_target;
  if (s.steps_goal)             document.getElementById('s-steps-goal').value = s.steps_goal;
  await loadGeminiKey();
}

async function loadGeminiKey() {
  try {
    const snap = await getDoc(doc(db, 'users', getUserId(), 'settings', 'gemini'));
    if (snap.exists() && snap.data().api_key) {
      const el = document.getElementById('gemini-key-status');
      if (el) el.textContent = '✅ Key configurata';
      const input = document.getElementById('gemini-key-input');
      if (input) input.placeholder = '••••••••••••••••••••••';
    }
  } catch(e) {}
}

window.saveSettings = async function() {
  const data = {
    profile: {
      name:          document.getElementById('s-name').value.trim(),
      height:        parseInt(document.getElementById('s-height').value)  || null,
      weight_target: parseFloat(document.getElementById('s-wtarget').value) || null
    },
    steps_goal: parseInt(document.getElementById('s-steps-goal').value) || null
  };
  try {
    await setDoc(doc(db, 'users', getUserId(), 'settings', 'app'), data, { merge: true });
    showToast('✅ Impostazioni salvate!');
  } catch(e) {
    showToast('Errore salvataggio', 'err');
  }
};

window.saveGeminiKey = async function() {
  const input = document.getElementById('gemini-key-input');
  const status = document.getElementById('gemini-key-status');
  const key = input?.value?.trim();

  if (!key) {
    if (status) status.textContent = '⚠️ Inserisci una key valida';
    return;
  }

  try {
    await setDoc(
      doc(db, 'users', getUserId(), 'settings', 'gemini'),
      { api_key: key },
      { merge: true }
    );
    if (status) status.textContent = '✅ Key salvata!';
    if (input) input.value = '';
    if (input) input.placeholder = '••••••••••••••••••••••';
    showToast('🤖 Gemini key salvata!');
  } catch(e) {
    if (status) status.textContent = '❌ Errore: ' + e.message;
  }
};


  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        await signOut(auth);
        window.location.href = 'auth.html';
      } catch (error) {
        showToast('Errore durante il logout', 'err');
      }
    });
  }

(async function() {
  await requireAuth();
  loadSettings();
})();