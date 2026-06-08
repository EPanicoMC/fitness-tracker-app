const CACHE = 'ft-v64';
const BASE = self.location.pathname.substring(0, self.location.pathname.lastIndexOf('/') + 1);
const FILES = [
  '',
  'index.html',
  'session.html',
  'programs.html',
  'diet.html',
  'diary.html',
  'checks.html',
  'settings.html',
  'auth.html',
  'css/style.css',
  'js/app.js',
  'js/auth.js',
  'js/daily_state.js',
  'js/session.js',
  'js/programs.js',
  'js/diet.js',
  'js/diary.js',
  'js/checks.js',
  'js/settings.js',
  'js/gemini.js',
  'js/coach_chat.js',
  'js/autocomplete.js',
  'js/ai_coach.js',
  'js/firebase-config.js',
  'icon.svg',
  'img/anatomy.png'
].map(path => BASE + path);

self.addEventListener('install', e => e.waitUntil(
  caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())
));

self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

// Rest timer notification scheduling
let restTimerId = null;
self.addEventListener('message', event => {
  if (event.data?.type === 'schedule-rest-done') {
    clearTimeout(restTimerId);
    restTimerId = setTimeout(() => {
      self.registration.showNotification('⚡ Recupero terminato!', {
        body: 'Pronti per la prossima serie? 💪',
        icon: BASE + 'icon.svg',
        vibrate: [200, 100, 200],
        tag: 'rest-timer',
        renotify: true
      });
    }, event.data.ms);
  }
  if (event.data?.type === 'cancel-rest') {
    clearTimeout(restTimerId);
    restTimerId = null;
  }
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Skip non-http(s) and chrome-extension requests
  if (!url.startsWith('http')) return;

  // Skip external APIs — let them go straight to network
  if (
    url.includes('firestore.googleapis.com') ||
    url.includes('firebase') ||
    url.includes('generativelanguage.googleapis.com') ||
    url.includes('gstatic.com') ||
    url.includes('firebaseapp.com') ||
    url.includes('firebasestorage.googleapis.com')
  ) return;

  // Only cache same-origin requests
  const isSameOrigin = url.startsWith(self.location.origin);
  if (!isSameOrigin) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => {
        return caches.match(e.request).then(cached => {
          if (cached) return cached;
          if (e.request.mode === 'navigate') {
            return caches.match(BASE + 'index.html');
          }
        });
      })
  );
});
