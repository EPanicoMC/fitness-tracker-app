import { requireAuth } from './app.js';
import { db, getUserId, doc, getDoc, getDocs, collection, setDoc, auth, signOut } from './firebase-config.js';
import { showToast } from './app.js';

let initialFriendEmail = '';

async function loadSettings() {
  // Populate users list
  try {
    const usersSnap = await getDocs(collection(db, 'users'));
    const friendList = document.getElementById('friend-list');
    if (friendList) {
      usersSnap.docs.forEach(d => {
        const email = d.id;
        if (email && email !== getUserId()) {
          const opt = document.createElement('option');
          opt.value = email;
          friendList.appendChild(opt);
        }
      });
    }
  } catch (e) {
    console.warn('Errore caricamento utenti:', e);
  }

  const snap = await getDoc(doc(db, 'users', getUserId(), 'settings', 'app'));
  if (!snap.exists()) return;
  const s = snap.data();
  if (s.profile?.name)          document.getElementById('s-name').value       = s.profile.name;
  if (s.profile?.sex)           document.getElementById('s-sex').value        = s.profile.sex;
  if (s.profile?.dob) {
    document.getElementById('s-dob').value = s.profile.dob;
    calcAndShowAge(s.profile.dob);
  }
  if (s.profile?.height)        document.getElementById('s-height').value     = s.profile.height;
  if (s.profile?.weight_target) document.getElementById('s-wtarget').value    = s.profile.weight_target;
  if (s.steps_goal)             document.getElementById('s-steps-goal').value = s.steps_goal;
  
  if (s.friend_email) {
    initialFriendEmail = s.friend_email;
    document.getElementById('s-friend-email').value = s.friend_email;
  }
  
  await loadGeminiKey();
}

function calcAndShowAge(dobStr) {
  if (!dobStr) return;
  const dob = new Date(dobStr);
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) {
    age--;
  }
  const el = document.getElementById('s-age');
  if (el) {
    el.textContent = `${age} anni`;
    el.style.display = 'block';
  }
}

document.getElementById('s-dob')?.addEventListener('change', (e) => calcAndShowAge(e.target.value));

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
      sex:           document.getElementById('s-sex').value,
      dob:           document.getElementById('s-dob').value,
      height:        parseInt(document.getElementById('s-height').value)  || null,
      weight_target: parseFloat(document.getElementById('s-wtarget').value) || null
    },
    steps_goal: parseInt(document.getElementById('s-steps-goal').value) || null,
    friend_email: document.getElementById('s-friend-email').value || null
  };
  try {
    await setDoc(doc(db, 'users', getUserId(), 'settings', 'app'), data, { merge: true });
    
    // Mutual save: if a new friend is selected, set us as their friend too
    const newFriendEmail = data.friend_email;
    if (newFriendEmail && newFriendEmail !== initialFriendEmail) {
      await setDoc(doc(db, 'users', newFriendEmail, 'settings', 'app'), { friend_email: getUserId() }, { merge: true });
    }
    // If friend was removed or changed, we might optionally clear ourselves from the old friend's settings
    if (initialFriendEmail && initialFriendEmail !== newFriendEmail) {
       // We only clear if they still have us set, to avoid removing their active friend if they changed it
       try {
         const oldFriendSnap = await getDoc(doc(db, 'users', initialFriendEmail, 'settings', 'app'));
         if (oldFriendSnap.exists() && oldFriendSnap.data().friend_email === getUserId()) {
           await setDoc(doc(db, 'users', initialFriendEmail, 'settings', 'app'), { friend_email: null }, { merge: true });
         }
       } catch (e) {}
    }
    
    initialFriendEmail = newFriendEmail;
    
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