/* Speedy Agent Portal service worker  v1
   Deliberately minimal. Rules, in order of importance:
   1. NEVER touch /api/ - money, client and commission data are always live.
   2. ONLY portal.html is handled, and it is network-first. A stale portal.html
      could run an old money path, so the network always wins when reachable;
      cache is an offline fallback only.
   3. Precached static assets (icons, logo, offline page) are cache-first.
      They are immutable for a given VERSION.
   4. EVERYTHING ELSE passes straight through, untouched. charge.html and
      carrier.html sit inside this scope and must behave exactly as today.
*/

const VERSION     = 'speedy-portal-v1';
const SHELL_CACHE = VERSION + '-shell';
const PORTAL      = '/admin/portal.html';

const PRECACHE = [
  '/assets/pwa/icon-192.png',
  '/assets/pwa/icon-512.png',
  '/assets/pwa/logo-dark.png',
  '/assets/pwa/offline.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* Kill switch: postMessage({type:'SPEEDY_SW_KILL'}) unregisters and clears. */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SPEEDY_SW_KILL') {
    event.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .then(() => self.registration.unregister())
        .then(() => self.clients.matchAll())
        .then((cs) => cs.forEach((c) => c.navigate(c.url)))
    );
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  // Rule 1: API is never intercepted.
  if (url.pathname.startsWith('/api/')) return;

  // Rule 3: precached static assets, cache-first.
  if (PRECACHE.indexOf(url.pathname) !== -1) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req))
    );
    return;
  }

  // Rule 2: portal.html ONLY, network-first.
  if (url.pathname === PORTAL) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req)
          .then((hit) => hit || caches.match('/assets/pwa/offline.html')))
    );
    return;
  }

  // Rule 4: everything else untouched.
});
