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

const VERSION     = 'speedy-portal-v2';   /* v2: push notifications (Sep 18) */
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
/* ---- Push notifications (Sep 18). Payloads come from api/_push.js:
     { type, tag, title, body, url, id, claim }   show it (same tag replaces)
     { type: 'withdraw', tag }                     someone else took that chat: close it
   Rule 1 still holds: nothing here touches /api/ except the Claim button, which is the
   agent's own action from the notification. ---- */
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { title: 'Speedy Chat', body: event.data ? event.data.text() : '' }; }
  if (d.type === 'withdraw') {
    event.waitUntil(self.registration.getNotifications({ tag: d.tag }).then((ns) => ns.forEach((n) => n.close())));
    return;
  }
  const opts = {
    body: d.body || '', tag: d.tag || 'speedy-chat', renotify: true,
    icon: '/assets/pwa/icon-192.png', badge: '/assets/pwa/icon-192.png',
    data: { url: d.url || '/admin/chat.html', id: d.id || null, type: d.type || 'alert' },
    actions: d.claim ? [{ action: 'claim', title: 'Claim' }, { action: 'open', title: 'Open' }] : [{ action: 'open', title: 'Open' }],
    requireInteraction: d.type === 'alert' || d.type === 'escalation'
  };
  event.waitUntil(self.registration.showNotification(d.title || 'Speedy Chat', opts));
});

/* the sign-in token, written by chat.html into IndexedDB so the Claim button can act
   without opening the page first. Missing or expired: we open the thread instead. */
function readToken() {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open('speedy', 1);
      open.onupgradeneeded = () => { open.result.createObjectStore('kv'); };
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction('kv', 'readonly'); const req = tx.objectStore('kv').get('tok');
          req.onsuccess = () => resolve(req.result || null); req.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      };
    } catch (e) { resolve(null); }
  });
}

self.addEventListener('notificationclick', (event) => {
  const n = event.notification; n.close();
  const d = n.data || {}; const url = d.url || '/admin/chat.html';
  event.waitUntil((async () => {
    let claimed = false;
    if (event.action === 'claim' && d.id) {
      const tok = await readToken();
      if (tok) {
        try {
          const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-id-token': tok }, body: JSON.stringify({ action: 'claim', id: d.id }) });
          const j = await r.json(); claimed = !!j.ok;
          if (!j.ok && j.error) await self.registration.showNotification('Speedy Chat', { body: j.error, tag: 'c' + d.id, icon: '/assets/pwa/icon-192.png', data: { url, id: d.id } });
        } catch (e) { /* the page will say */ }
      }
    }
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const chat = cs.find((c) => c.url.indexOf('/admin/chat.html') !== -1);
    if (chat) { try { chat.postMessage({ type: 'SPEEDY_OPEN', id: d.id, claimed }); } catch (e) {} return chat.focus(); }
    return self.clients.openWindow(url);
  })());
});
