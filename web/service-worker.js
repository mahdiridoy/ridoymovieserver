/*
 * MovieBox Web service worker.
 *
 * Strategy: stale-while-revalidate for same-origin static assets, network for
 * everything else (providers, images and the optional CORS proxy are never
 * cached — their responses are session-scoped and may be cross-origin).
 * Bump CACHE_VERSION whenever a release changes core shell files.
 */

const CACHE_VERSION = 'moviebox-web-v1';
const SHELL_CACHE = `moviebox-shell-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './assets/icons/favicon.svg',
  './assets/icons/icon-192.png',
  './css/themes.css',
  './css/main.css',
  './css/responsive.css',
  './css/player.css',
  './js/app.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const results = await Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length === SHELL_ASSETS.length) {
      // Nothing cached — let the SW install anyway; runtime fetch handles it.
      return;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('moviebox-') && key !== SHELL_CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // providers / proxy / CDN — always network

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const network = await fetch(request);
        const cache = await caches.open(SHELL_CACHE);
        cache.put('./index.html', network.clone()).catch(() => {});
        return network;
      } catch {
        const cached = await caches.match('./index.html');
        if (cached) return cached;
        throw new Error('Offline and no cached shell');
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    const networkPromise = fetch(request).then((response) => {
      if (response && response.ok) {
        const cache = caches.open(SHELL_CACHE);
        cache.then((c) => c.put(request, response.clone())).catch(() => {});
      }
      return response;
    }).catch(() => cached);
    return cached || networkPromise;
  })());
});
