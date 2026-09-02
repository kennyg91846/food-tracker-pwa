const CACHE_NAME = 'heart-table-shell-v43';
const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './db.js',
  './vendor/dexie.mjs',
  './vendor/html5-qrcode.min.js',
  './api.js',
  './targets.json',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
});

// Cache-first for the app shell, network-first (no caching) for API calls,
// so food search always hits USDA / Open Food Facts fresh.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isApiCall = url.hostname.includes('nal.usda.gov') || url.hostname.includes('openfoodfacts.org');
  if (isApiCall) return; // let it hit the network normally

  const isNavigation = event.request.mode === 'navigate';
  if (isNavigation) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

