const CACHE = 'ft-v90';
// Cache separata per librerie CDN con URL versionato (contenuto immutabile):
// non viene svuotata ai bump di CACHE, così l'SDK Firebase non va riscaricato a ogni deploy.
const CDN_CACHE = 'ft-cdn-v1';
// Se la rete non risponde entro questo tempo e abbiamo una copia in cache, usiamo la cache.
const NETWORK_TIMEOUT_MS = 3000;
const BASE = self.location.pathname.substring(0, self.location.pathname.lastIndexOf('/') + 1);
const FILES = [
  '',
  'index.html',
  'session.html',
  'programs.html',
  'diet.html',
  'diary.html',
  'checks.html',
  'export.html',
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
  'js/nutrition-core.js',
  'js/migration.js',
  'js/insights-engine.js',
  'js/export-engine.js',
  'js/checks.js',
  'js/settings.js',
  'js/gemini.js',
  'js/coach_chat.js',
  'js/autocomplete.js',
  'js/ai_coach.js',
  'js/firebase-config.js',
  'js/phase-config.js',
  'js/widgets.js',
  'icon.svg',
  'img/anatomy.png'
].map(path => BASE + path);


self.addEventListener('install', e => e.waitUntil(
  caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())
));

self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== CDN_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

// Rest timer notification scheduling
let restTimerId = null;
self.addEventListener('message', event => {
  if (event.data?.type === 'schedule-rest-done') {
    clearTimeout(restTimerId);
    const ms = event.data.ms || 0;
    const label = event.data.label || '';
    restTimerId = setTimeout(() => {
      self.registration.showNotification('⚡ Recupero terminato!', {
        body: label ? `Prossimo: ${label}` : 'Pronti per la prossima serie? 💪',
        icon: BASE + 'icon.svg',
        vibrate: [300, 150, 300, 150, 400],
        tag: 'rest-timer',
        renotify: true,
        requireInteraction: true
      });
    }, ms);
  }
  if (event.data?.type === 'cancel-rest') {
    clearTimeout(restTimerId);
    restTimerId = null;
  }
});

// Librerie CDN con versione fissa nell'URL → contenuto immutabile → cache-first sicuro.
const IMMUTABLE_CDN_PREFIXES = [
  'https://www.gstatic.com/firebasejs/',
  'https://cdn.jsdelivr.net/npm/remixicon@'
];

function cacheFirstCdn(e) {
  return caches.open(CDN_CACHE).then(cache =>
    cache.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // 'opaque' = foglio CSS caricato via <link> senza CORS: lo salviamo comunque
        if (res.ok || res.type === 'opaque') {
          cache.put(e.request, res.clone()).catch(() => {});
        }
        return res;
      });
    })
  );
}

function matchCached(request) {
  return caches.match(request).then(cached => {
    if (cached) return cached;
    if (request.mode === 'navigate') {
      // es. index.html?steps=1234 (bridge Apple Health): ignora i query param
      return caches.match(request, { ignoreSearch: true })
        .then(c => c || caches.match(BASE + 'index.html'));
    }
    return undefined;
  });
}

// Network-first con timeout: con buona rete identico a prima (si vede sempre la
// versione più recente); con rete lenta/assente, dopo NETWORK_TIMEOUT_MS si usa la
// copia in cache. La risposta di rete, se arriva dopo, aggiorna comunque la cache.
function networkFirstWithTimeout(e) {
  const networkPromise = fetch(e.request).then(res => {
    if (res.ok) {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
    }
    return res;
  });
  // Mantiene vivo il SW finché la rete non ha finito (per aggiornare la cache)
  e.waitUntil(networkPromise.then(() => {}, () => {}));

  return new Promise(resolve => {
    let settled = false;
    const finish = res => { if (!settled && res) { settled = true; resolve(res); } };

    const timer = setTimeout(() => {
      matchCached(e.request).then(cached => {
        // Se non c'è nulla in cache continuiamo ad aspettare la rete
        if (cached) finish(cached);
      });
    }, NETWORK_TIMEOUT_MS);

    networkPromise
      .then(res => { clearTimeout(timer); finish(res); })
      .catch(() => {
        clearTimeout(timer);
        matchCached(e.request).then(cached => {
          if (cached) finish(cached);
          else if (!settled) { settled = true; resolve(Response.error()); }
        });
      });
  });
}

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Skip non-http(s) and chrome-extension requests
  if (!url.startsWith('http')) return;
  // Solo GET: le altre richieste non sono cacheabili
  if (e.request.method !== 'GET') return;

  // Priorità 1: risorse dello stesso dominio (local app files: HTML, CSS, JS locale) -> networkFirstWithTimeout
  const isSameOrigin = url.startsWith(self.location.origin);
  if (isSameOrigin) {
    e.respondWith(networkFirstWithTimeout(e));
    return;
  }

  // Priorità 2: CDN versionati (SDK Firebase, Remixicon) → cache-first
  if (IMMUTABLE_CDN_PREFIXES.some(p => url.startsWith(p))) {
    e.respondWith(cacheFirstCdn(e));
    return;
  }

  // External APIs (Firestore API, Gemini API, Firebase Storage) -> rete diretta
  return;
});
