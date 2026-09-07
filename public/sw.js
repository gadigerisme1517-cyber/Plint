/* ============================================================================
   Plint service worker.

   WHAT THIS DELIBERATELY DOES NOT DO: cache anything a signed-in person sees.

   Every screen here is server-rendered HTML behind a session cookie, and the
   content is one buyer's financial position. A service worker cache is keyed
   by origin, not by session, and it outlives sign-out. Cache a villa page and
   the next person to open this app on this phone - the buyer's spouse, a
   colleague, whoever the device is handed to - can be served it while offline,
   with no session and no way for the server to intervene.

   So the cache holds the shell and nothing else: the stylesheets, the icons,
   the manifest, and one offline page. Every request that could carry data goes
   to the network and fails honestly when there is none.

   That means less works offline than a demo might like. It is the right trade
   for an application whose entire product is an evidence trail about money.
   ========================================================================= */

const VERSION = 'plint-shell-v1';

/* Only these are ever stored. The list is explicit rather than pattern-based
   so that adding a route can never silently make it cacheable. */
const SHELL = [
  '/offline',
  '/plint.css',
  '/app.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon.svg',
];

const CACHEABLE = new Set(SHELL);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // addAll fails the whole install if any one is missing, which is what we
    // want: a half-populated shell is worse than no shell.
    await cache.addAll(SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== VERSION) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;

  // Never interfere with anything that changes state, and never with another
  // origin. A POST to /login or /engineer/certify must always reach the server.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (CACHEABLE.has(url.pathname)) {
    // Static, non-personal, versioned by the cache name. Cache first.
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok) (await caches.open(VERSION)).put(req, res.clone());
      return res;
    })());
    return;
  }

  /* Everything else - every screen, every PDF, every evidence photograph -
     is network only. If the network is not there and the person was trying to
     navigate, show the offline page rather than the browser's error. Nothing
     is written to the cache on this path, ever. */
  event.respondWith((async () => {
    try {
      return await fetch(req);
    } catch (e) {
      if (req.mode === 'navigate') {
        const offline = await caches.match('/offline');
        if (offline) return offline;
      }
      throw e;
    }
  })());
});

/* Sign-out asks us to drop the shell too. It holds nothing personal, but a
   shared device should be able to end a session completely, and this is the
   only storage this app keeps on the client besides the cookie.

   Then put the shell straight back. Without this the cache is refilled lazily,
   one asset at a time, by whatever the next page happens to request - which
   leaves out the offline page, so the first person to lose signal after a
   sign-out would get the browser's error instead. Measured: after a sign-out
   the cache held four of the ten entries and no /offline. */
self.addEventListener('message', event => {
  if (event.data === 'plint:signout') {
    event.waitUntil((async () => {
      for (const key of await caches.keys()) await caches.delete(key);
      await (await caches.open(VERSION)).addAll(SHELL);
    })());
  }
});
