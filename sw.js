const CACHE = 'ft-v2';
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
  '/fitness-tracker-app/js/autocomplete.js'
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
  if (e.request.url.includes('firestore') ||
      e.request.url.includes('firebase') ||
      e.request.url.includes('googleapis')) return;
  e.respondWith(
    caches.match(e.request).then(r =>
      r || fetch(e.request).then(res => {
        if (res.ok) {
          const c = res.clone();
          caches.open(CACHE).then(ca => ca.put(e.request, c));
        }
        return res;
      }).catch(() => caches.match('/fitness-tracker-app/index.html'))
    )
  );
});
