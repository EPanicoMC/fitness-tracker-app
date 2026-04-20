const CACHE = 'ft-v3';
const FILES = [
  '/fitness-tracker-app/',
  '/fitness-tracker-app/index.html',
  '/fitness-tracker-app/session.html',
  '/fitness-tracker-app/programs.html',
  '/fitness-tracker-app/diet.html',
  '/fitness-tracker-app/diary.html',
  '/fitness-tracker-app/checks.html',
  '/fitness-tracker-app/settings.html',
  '/fitness-tracker-app/css/style.css',
  '/fitness-tracker-app/js/app.js',
  '/fitness-tracker-app/js/home.js',
  '/fitness-tracker-app/js/session.js',
  '/fitness-tracker-app/js/programs.js',
  '/fitness-tracker-app/js/diet.js',
  '/fitness-tracker-app/js/diary.js',
  '/fitness-tracker-app/js/checks.js',
  '/fitness-tracker-app/js/settings.js',
  '/fitness-tracker-app/js/gemini.js',
  '/fitness-tracker-app/js/autocomplete.js',
  '/fitness-tracker-app/js/firebase-config.js',
  '/fitness-tracker-app/icon.svg'
];

self.addEventListener('install', e => e.waitUntil(
  caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())
));

self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

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
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match('/fitness-tracker-app/index.html'));
    })
  );
});
