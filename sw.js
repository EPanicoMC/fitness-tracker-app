const CACHE = 'fittracker-v3';
const STATIC = [
  '/fitness-tracker-app/',
  '/fitness-tracker-app/index.html',
  '/fitness-tracker-app/programs.html',
  '/fitness-tracker-app/diet.html',
  '/fitness-tracker-app/checks.html',
  '/fitness-tracker-app/session.html',
  '/fitness-tracker-app/settings.html',
  '/fitness-tracker-app/css/style.css',
  '/fitness-tracker-app/js/app.js',
  '/fitness-tracker-app/js/home.js',
  '/fitness-tracker-app/js/programs.js',
  '/fitness-tracker-app/js/diet.js',
  '/fitness-tracker-app/js/checks.js',
  '/fitness-tracker-app/js/session.js',
  '/fitness-tracker-app/js/settings.js',
  '/fitness-tracker-app/js/autocomplete.js',
  '/fitness-tracker-app/js/food-search.js',
  '/fitness-tracker-app/js/firebase-config.js',
  '/fitness-tracker-app/manifest.json',
  '/fitness-tracker-app/icon-192.png',
  '/fitness-tracker-app/icon-512.png'
];

const BYPASS = ['firestore.googleapis.com', 'firebase.googleapis.com', 'gstatic.com', 'openfoodfacts.org'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC.map(u => new Request(u, { cache: 'reload' })))).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (BYPASS.some(d => url.includes(d))) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached || new Response('Offline', { status: 503 }));
    })
  );
});
