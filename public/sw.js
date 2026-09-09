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

/* `__BUILD__` is substituted by the server, at boot, with a hash over the
   bytes of every file in the list below. It must not be a constant: the cache
   is keyed by URL, none of these URLs carries a version, and cache-first never
   asks the server a second time - so under a fixed name an app installed today
   would still be running today's stylesheet after every future deploy. The
   server refuses to start if the placeholder is missing. */
const VERSION = 'plint-shell-__BUILD__';

/* Only these are ever stored. The list is explicit rather than pattern-based
   so that adding a route can never silently make it cacheable.

   One stylesheet now: v21's two were retired when the buyer and the engineer
   moved onto the office's system. */
const SHELL = [
  '/offline',
  '/office.__BUILD__.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon.svg',
];

const CACHEABLE = new Set(SHELL);

/* `cache: 'reload'` goes past the browser's own HTTP cache. Without it a new
   VERSION would open a new cache and then fill it from the same week-old copy
   of an icon the HTTP cache is still holding, which defeats the point of
   versioning the name at all. */
const fresh = url => new Request(url, { cache: 'reload' });

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // addAll fails the whole install if any one is missing, which is what we
    // want: a half-populated shell is worse than no shell.
    await cache.addAll(SHELL.map(fresh));
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

  /* The manifest configures the install itself - the icon, the name, and the
     colour the operating system paints the window's own chrome with. Chrome
     re-reads it in the background to notice those changing, and cache-first
     answered every one of those checks with the copy captured at install
     time. An installed app could therefore never learn that any of it had
     changed, which is how a title bar stayed the wrong colour through a
     deploy that fixed it.

     Network first, cache second. It is a few hundred bytes and it is not
     needed to render anything, so the only thing the cache is for here is a
     cold start with no signal. */
  if (url.pathname === '/manifest.webmanifest') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) (await caches.open(VERSION)).put(req, res.clone());
        return res;
      } catch (e) {
        const hit = await caches.match(req);
        if (hit) return hit;
        throw e;
      }
    })());
    return;
  }

  if (CACHEABLE.has(url.pathname)) {
    /* Static, non-personal, and versioned by the cache name rather than by the
       URL, so cache-first is safe: a new build opens a new cache. */
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
      await (await caches.open(VERSION)).addAll(SHELL.map(fresh));
    })());
  }
});
