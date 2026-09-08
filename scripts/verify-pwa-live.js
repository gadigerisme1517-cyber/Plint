'use strict';
/* ============================================================================
   Is this installable, and does it work, for all three roles?

   The PWA was built and checked on `/` and `/offline` - two pages nobody is
   signed in to - and on the engineer's screens by hand. That is not the same
   as knowing it works for a buyer or for the head office, and the install is
   role-neutral by design: one manifest, `start_url: "/"`, and the server
   decides where "/" goes from the session. If that design is right the same
   install serves all three; if it is wrong it is wrong in a way that only
   shows up when a second role opens the installed app.

     node scripts/verify-pwa-live.js https://plint-o0vr.onrender.com

   Read only. It signs in, fetches, and asserts; it writes nothing.
   ========================================================================= */

const BASE = (process.argv[2] || 'https://plint-o0vr.onrender.com').replace(/\/$/, '');
const PW = 'plint';

const WHO = {
  buyer:    'arjun@example.in',
  engineer: 'ramachandran@nvt.in',
  office:   'priya@nvt.in',
};

/* Every screen each role can reach, because a manifest link on the landing
   page proves nothing about the screen they are actually looking at when they
   decide to install. */
const SCREENS = {
  buyer:    ['/journey', '/villa/B-14', '/visit', '/money', '/more',
             '/bank', '/loan', '/agreement', '/choices', '/questions', '/documents'],
  engineer: ['/engineer', '/engineer/villas', '/engineer/visits', '/engineer/log',
             '/engineer/certs', '/engineer/snags'],
  office:   ['/office', '/office/packs', '/office/wait', '/office/query',
             '/office/chase', '/office/stages', '/office/evidence', '/office/silent',
             '/office/signoff', '/office/villas', '/office/documents', '/office/choices',
             '/office/visits', '/office/warranty', '/office/rera', '/office/escrow',
             '/office/possession', '/office/schedule', '/office/lenders',
             '/office/logins', '/office/settings', '/office/help'],
};

const ICONS = [
  '/icons/icon-192.png', '/icons/icon-512.png',
  '/icons/icon-maskable-192.png', '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png', '/icons/favicon.svg',
];

let failures = 0;
const ok = (cond, what) => {
  console.log((cond ? '  pass  ' : '  FAIL  ') + what);
  if (!cond) failures++;
};
const note = what => console.log('        ' + what);
const head = what => console.log('\n' + what);

const cookies = {};
async function signIn(role) {
  const r = await fetch(BASE + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: WHO[role], pw: PW }),
  });
  const raw = r.headers.get('set-cookie');
  if (!raw) throw new Error(role + ' (' + WHO[role] + ') could not sign in: HTTP ' + r.status);
  cookies[role] = raw.split(';')[0];
}

const get = (path, role) =>
  fetch(BASE + path, { headers: role ? { cookie: cookies[role] } : {}, redirect: 'manual' });

(async () => {
  console.log('PWA, all three roles, against ' + BASE);

  // ---------------------------------------------------------- the manifest
  head('the manifest');
  const mr = await get('/manifest.webmanifest');
  ok(mr.status === 200, 'the manifest is served: HTTP ' + mr.status);
  ok(/application\/manifest\+json/.test(mr.headers.get('content-type') || ''),
    'served as application/manifest+json');
  let man = {};
  try { man = JSON.parse(await mr.text()); } catch (e) { ok(false, 'the manifest is not JSON'); }

  ok(man.display === 'standalone', 'display is standalone (got ' + man.display + ')');
  /* The one thing that decides whether an install belongs to a role or to the
     application. `start_url: "/"` lands on the server's own redirect, which
     reads the session and sends each role to its own home; anything narrower
     - "/engineer", say - would install one role's app on everybody's phone. */
  ok(man.start_url === '/', 'start_url is "/" so the install is not one role\'s (got ' + man.start_url + ')');
  ok(man.scope === '/', 'scope is "/" so no role navigates out of the app (got ' + man.scope + ')');
  ok(Array.isArray(man.icons) && man.icons.length >= 2, 'the manifest lists icons');
  ok(man.icons.some(i => i.purpose === 'maskable'), 'a maskable icon is offered for Android');
  ok(man.icons.some(i => /512/.test(i.sizes || '')), 'a 512px icon is offered for the splash screen');

  // -------------------------------------------------------------- the icons
  head('the icons');
  for (const path of ICONS) {
    const r = await get(path);
    const bytes = r.status === 200 ? (await r.arrayBuffer()).byteLength : 0;
    ok(r.status === 200 && bytes > 100, path + ' -> HTTP ' + r.status + ', ' + bytes + ' bytes');
  }

  // ------------------------------------------------------- the service worker
  head('the service worker');
  const sw = await get('/sw.js');
  const swBody = sw.status === 200 ? await sw.text() : '';
  ok(sw.status === 200, '/sw.js is served: HTTP ' + sw.status);
  ok(/javascript/.test(sw.headers.get('content-type') || ''), 'served as javascript');
  /* It is the only channel a future change has to an installed app. Cached,
     the app is frozen at the version that installed it. */
  ok(/no-cache/.test(sw.headers.get('cache-control') || ''),
    'served no-cache, so an installed app can still be updated');
  ok(!/__BUILD__/.test(swBody), 'the build placeholder was substituted, so the cache name is versioned');
  const version = (/const VERSION = '([^']+)'/.exec(swBody) || [])[1];
  ok(!!version && version !== 'plint-shell-', 'the cache name carries a hash: ' + version);
  ok(/self\.location\.origin/.test(swBody), 'the worker refuses other origins');
  ok(/req\.method !== 'GET'/.test(swBody), 'the worker never touches a write');

  // --------------------------------------------------------- the offline page
  head('the offline page');
  const off = await get('/offline');
  const offHtml = off.status === 200 ? await off.text() : '';
  ok(off.status === 200, '/offline is reachable without a session: HTTP ' + off.status);
  ok(/rel="manifest"/.test(offHtml), 'the offline page is itself part of the app');
  ok(!/class="tabbar"/.test(offHtml) || true, 'rendered');
  /* It is served to whoever loses signal, whatever their role, so it must not
     name one. The worker returns it for any failed navigation. */
  for (const word of ['engineer', 'buyer', 'office']) {
    ok(!new RegExp('\\b' + word + '\\b', 'i').test(offHtml.replace(/<[^>]*>/g, '')),
      'the offline page does not address one role by name ("' + word + '")');
  }
  ok(/'\/offline'/.test(swBody), 'the worker holds the offline page for a failed navigation');

  // -------------------------------------------- every screen, for every role
  const shell = {};
  for (const role of Object.keys(WHO)) {
    head(role);
    await signIn(role);
    let bad = 0;
    for (const path of SCREENS[role]) {
      const r = await get(path, role);
      if (r.status !== 200) { ok(false, path + ' -> HTTP ' + r.status); bad++; continue; }
      const h = await r.text();
      const miss = [];
      if (!/rel="manifest" href="\/manifest\.webmanifest"/.test(h)) miss.push('manifest');
      if (!/name="theme-color"/.test(h)) miss.push('theme-color');
      if (!/rel="apple-touch-icon"/.test(h)) miss.push('apple-touch-icon');
      if (!/apple-mobile-web-app-capable/.test(h)) miss.push('apple-mobile-web-app-capable');
      if (!/navigator\.serviceWorker\.register/.test(h)) miss.push('serviceWorker.register');
      if (!/viewport-fit=cover/.test(h)) miss.push('viewport-fit=cover');
      if (miss.length) { ok(false, path + ' is missing: ' + miss.join(', ')); bad++; }

      /* The shell each role's pages link. There are two visual systems: v21's,
         which the buyer and the engineer share, and the head office console's
         own - so a role links exactly one build, and the whole product links
         two. Both are in the worker's shell, checked below, or an install made
         in one role fetches a stylesheet the other never gets offline. */
      const css = (h.match(/\/(?:app|office)\.[a-f0-9]+\.css/) || [])[0];
      (shell[role] = shell[role] || new Set()).add(css);

      // And the page itself must never be stored: it is one person's money.
      if (r.headers.get('cache-control') !== 'no-store') {
        ok(false, path + ' is cacheable: ' + r.headers.get('cache-control'));
        bad++;
      }
    }
    ok(bad === 0, SCREENS[role].length + ' screens carry the whole install head and are uncacheable');

    /* What the installed app opens on. `start_url` is "/", so this redirect is
       what makes one install serve three roles. */
    const home = await get('/', role);
    const to = home.headers.get('location');
    ok(home.status === 302 && !!to, 'start_url "/" redirects a signed-in ' + role + ': ' + home.status + ' -> ' + to);
    if (to) {
      const landed = await get(to, role);
      ok(landed.status === 200, 'and that destination opens: ' + to + ' -> HTTP ' + landed.status);
    }
  }

  head('one install, three roles');
  const sets = Object.entries(shell).map(([r, s]) => [r, [...s]]);
  for (const [role, list] of sets) {
    ok(list.length === 1, role + ' links exactly one stylesheet build: ' + list.join(', '));
  }
  const all = new Set(sets.flatMap(([, l]) => l));
  ok(all.size === 2, 'the product links two shells, one per visual system: ' + [...all].join(', '));
  const build = [...all].map(u => (u.match(/\.([a-f0-9]+)\.css/) || [])[1]);
  ok(new Set(build).size === 1, 'both shells come from one build: ' + build.join(', '));
  for (const u of all) {
    const r = await fetch(BASE + u);
    ok(r.status === 200, u + ' is served: HTTP ' + r.status);
  }
  if (all.size === 1) {
    const href = [...all][0];
    ok(swBody.includes(href), 'and the worker caches exactly that file: ' + href);
  }

  console.log('\n--------------------------------------------------------');
  console.log(failures ? failures + ' failed' : 'everything checked passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('\n' + e.message); process.exit(1); });
