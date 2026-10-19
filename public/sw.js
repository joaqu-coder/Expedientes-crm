/*
 * Service Worker — Expedientes CRM
 *
 * Estrategia (igual que Boletín Oficial):
 *   - HTML: network-first (siempre intenta versión nueva)
 *   - Assets: stale-while-revalidate
 *
 * Cambiar CACHE_VERSION cuando hay cambios incompatibles.
 */
const CACHE_VERSION = 'expedientes-crm-v7';
const ASSETS = ['/manifest.json'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // /api/* nunca se cachea: son datos dinámicos (sync con GitHub),
  // siempre deben ir a la red.
  if (url.pathname.startsWith('/api/')) return;

  const isHTML =
    req.mode === 'navigate' ||
    req.headers.get('accept')?.includes('text/html') ||
    url.pathname.endsWith('.html') ||
    url.pathname === '/' ||
    url.pathname === '';

  // header.js y ui-kit.css van con la misma estrategia que el HTML, no con la
  // de los assets: son el header, el menú, el botón de alta y los botones de
  // acción de las cuatro apps, así que una copia vieja servida desde el cache
  // deja la pantalla sin cabecera o con los botones sin estilo. Network-first
  // = siempre la última si hay red, y la cacheada solo cuando no la hay.
  const esCritico = isHTML || url.pathname === '/header.js' || url.pathname === '/ui-kit.css';

  if (esCritico) {
    // Network-first: intenta red, si falla usa cache
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req, { cache: 'no-store' });
          const cache = await caches.open(CACHE_VERSION);
          cache.put(req, fresh.clone());
          return fresh;
        } catch (_err) {
          const cached = await caches.match(req);
          if (cached) return cached;
          const fallback = await caches.match('/index.html');
          if (fallback) return fallback;
          throw _err;
        }
      })()
    );
    return;
  }

  // Assets: stale-while-revalidate
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(req);
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })()
  );
});
