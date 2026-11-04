// Service worker: приложение открывается без интернета (после первого запуска).
// Стратегия «сначала сеть»: всегда свежая версия, а без сети — из кэша.
const CACHE = 'baned-adder-v3';
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/graphics.js',
  'js/engine-browser.js',
  'js/engine-server.js',
  'js/analyze-browser.js',
  'js/timeline.js',
  'js/qr.js',
  'js/segment.js',
  'js/core/util.js',
  'js/core/settings.js',
  'js/core/plan.js',
  'js/core/layout.js',
  'js/core/layers.js',
  'js/core/audio.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
