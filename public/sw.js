/*
 * Service Worker — Expedientes CRM
 *
 * Estrategia (igual que Boletín Oficial):
 *   - HTML: network-first (siempre intenta versión nueva)
 *   - Assets: stale-while-revalidate
 *
 * Cambiar CACHE_VERSION cuando hay cambios incompatibles.
 */
const CACHE_VERSION = 'expedientes-crm-v9';
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

  // header.js, design-system.css y ui-kit.css van con la misma estrategia que
  // el HTML, no con la de los assets: son el header, el menú, el botón de alta
  // y TODOS los colores y medidas de las cuatro apps, así que una copia vieja
  // servida desde el cache deja la pantalla sin cabecera, sin estilo en los
  // botones o —desde que las páginas no declaran sus propios colores— con los
  // tokens sin resolver. Network-first = siempre la última si hay red, y la
  // cacheada solo cuando no la hay.
  // manifest.json va acá y no con los assets: de él salen theme_color y
  // background_color, o sea el color de la franja de arriba. Servido
  // stale-while-revalidate (como estaba hasta el 2026-10-19) el navegador
  // seguía leyendo el theme_color VIEJO —el índigo #667eea— de la copia
  // cacheada. Entre dos documentos hay un instante en que el <meta
  // name="theme-color"> del que se va ya no aplica y el del que entra todavía
  // no se parseó: ahí el navegador cae al manifest, y ese es el "línea fina
  // índigo de unos milisegundos" al cambiar de pantalla. No estaba en la
  // página —se grabó la navegación cuadro por cuadro y no hay un solo pixel
  // azulado en el viewport—, estaba en el manifest cacheado.
  const CRITICOS = ['/header.js', '/design-system.css', '/ui-kit.css', '/manifest.json'];
  const esCritico = isHTML || CRITICOS.includes(url.pathname);

  if (esCritico) {
    // Network-first: intenta red, si falla usa cache
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req, { cache: 'no-store' });
          // Solo se guarda una respuesta buena. Sin este chequeo —que la rama
          // de abajo sí tenía— un 500 o un 404 servido durante un deploy a
          // medio terminar quedaba cacheado y después se devolvía como
          // "fallback offline", que es peor que no tener nada.
          if (fresh.ok) {
            const cache = await caches.open(CACHE_VERSION);
            cache.put(req, fresh.clone());
          }
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
