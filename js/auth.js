import { auth, signInWithEmailAndPassword, createUserWithEmailAndPassword, setPersistence, browserLocalPersistence } from './firebase-config.js';

setPersistence(auth, browserLocalPersistence).catch(console.error);

const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const showRegisterBtn = document.getElementById('show-register');
const showLoginBtn = document.getElementById('show-login');
const errorMsg = document.getElementById('error-msg');

if (showRegisterBtn) {
  showRegisterBtn.addEventListener('click', (e) => {
    e.preventDefault();
    loginForm.style.display = 'none';
    registerForm.style.display = 'block';
    errorMsg.textContent = '';
  });
}

if (showLoginBtn) {
  showLoginBtn.addEventListener('click', (e) => {
    e.preventDefault();
    registerForm.style.display = 'none';
    loginForm.style.display = 'block';
    errorMsg.textContent = '';
  });
}

if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    try {
      await signInWithEmailAndPassword(auth, email, password);
      window.location.href = 'index.html' + window.location.search;
    } catch (error) {
      errorMsg.textContent = 'Errore di accesso: ' + error.message;
    }
  });
}

if (registerForm) {
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('register-email').value;
    const password = document.getElementById('register-password').value;
    try {
      await createUserWithEmailAndPassword(auth, email, password);
      window.location.href = 'index.html' + window.location.search;
    } catch (error) {
      errorMsg.textContent = 'Errore di registrazione: ' + error.message;
    }
  });
}
