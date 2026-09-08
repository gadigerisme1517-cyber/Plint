'use strict';
/* ============================================================================
   The progressive web app: installable, and deliberately almost useless
   offline.

   The assertions that matter most here are the negative ones. A service worker
   cache is keyed by origin, not by session, and it outlives sign-out. If a
   buyer's villa page were ever cached, the next person to open this app on
   that phone could be served it while offline, with no session and no way for
   the server to intervene. So the cache list is an allowlist of static files,
   and these tests exist to stop anything else joining it.
   ========================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { pool } = require('../src/db');

const PORT = 3241, BASE = 'http://127.0.0.1:' + PORT;
const server = require('../src/server');

before(() => new Promise(r => server.listen(PORT, r)));
after(async () => {
  await new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  await pool.end();
});

const get = p => fetch(BASE + p, { redirect: 'manual' });

// ------------------------------------------------------------- installable

test('the manifest is served, valid, and asks to be installed', async () => {
  const r = await get('/manifest.webmanifest');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/manifest\+json/);

  const m = await r.json();
  assert.strictEqual(m.name, 'Plint');
  assert.ok(m.short_name, 'a short name for the home screen');
  assert.strictEqual(m.start_url, '/');
  assert.strictEqual(m.scope, '/');
  assert.strictEqual(m.display, 'standalone', 'opens without browser chrome');
  assert.match(m.theme_color, /^#[0-9A-Fa-f]{6}$/);
  assert.match(m.background_color, /^#[0-9A-Fa-f]{6}$/);
});

test('the icons a phone needs are all present and are really images', async () => {
  const m = await (await get('/manifest.webmanifest')).json();

  // Chrome will not offer to install without both of these sizes.
  for (const size of ['192x192', '512x512']) {
    assert.ok(m.icons.some(i => i.sizes === size && i.purpose === 'any'),
      'missing an "any" icon at ' + size);
    assert.ok(m.icons.some(i => i.sizes === size && i.purpose === 'maskable'),
      'missing a "maskable" icon at ' + size + ', so Android would crop the mark');
  }

  for (const icon of m.icons) {
    const r = await get(icon.src);
    assert.strictEqual(r.status, 200, icon.src + ' is listed but not served');
    assert.strictEqual(r.headers.get('content-type'), 'image/png');
    const b = Buffer.from(await r.arrayBuffer());
    assert.strictEqual(b.subarray(1, 4).toString(), 'PNG', icon.src + ' is not a PNG');
    assert.ok(b.length > 500, icon.src + ' is suspiciously small');
  }

  // iOS ignores the manifest for its home-screen icon.
  const apple = await get('/icons/apple-touch-icon.png');
  assert.strictEqual(apple.status, 200);
});

test('every page links the manifest and registers the worker', async () => {
  for (const p of ['/', '/offline']) {
    const html = await (await get(p)).text();
    assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/, p + ': no manifest link');
    assert.match(html, /apple-touch-icon/, p + ': no iOS icon');
    assert.match(html, /name="theme-color"/, p + ': no theme colour');
  }
  const html = await (await get('/')).text();
  assert.match(html, /serviceWorker/, 'the sign-in page does not register the worker');
});

test('the installed window has no strip across the top of it', async () => {
  /* An installed app paints its title bar with the manifest's `theme_color`,
     and the app bar sits directly under it. At #0A2540 that put a near-black
     strip above a white bar with a hard seam between them, across the top of
     every window - the one part of an installed app that is meant to
     disappear. It was reported from a desktop install.

     So the invariant is not "the theme colour is white", it is that the title
     bar and the bar it sits on are the same colour. Both sides are read here:
     the manifest, every page's meta tag, and `.appbar`'s own background. */
  const manifest = JSON.parse(await (await get('/manifest.webmanifest')).text());

  const norm = c => {
    const h = c.trim().toLowerCase().replace('#', '');
    return h.length === 3 ? h.split('').map(x => x + x).join('') : h;
  };

  /* `.appbar` is painted with a token, so the token's value is what actually
     reaches the screen. Both stylesheets are searched: `--paper` is v21's. */
  const css = await (await get('/plint.css')).text() + await (await get('/app.css')).text();
  const bg = /\.appbar\s*\{[^}]*background:\s*var\((--[a-z0-9-]+)\)/.exec(css);
  assert.ok(bg, 'the app bar does not paint itself with a token');
  const token = new RegExp('\\' + bg[1] + ':\\s*(#[0-9a-fA-F]{3,8})').exec(css);
  assert.ok(token, bg[1] + ' has no value in either stylesheet');

  assert.strictEqual(norm(manifest.theme_color), norm(token[1]),
    'the installed title bar is ' + manifest.theme_color + ' and the app bar under it is '
    + token[1] + ', so there is a strip across the top of the window');

  // And every page agrees with the manifest, including the offline one.
  for (const p of ['/', '/offline']) {
    const meta = /<meta name="theme-color" content="([^"]+)"/.exec(await (await get(p)).text());
    assert.ok(meta, p + ' declares no theme colour');
    assert.strictEqual(norm(meta[1]), norm(manifest.theme_color),
      p + ' declares ' + meta[1] + ' where the manifest says ' + manifest.theme_color);
  }

  /* `black-translucent` draws the page under the status bar and paints its
     text white. On a white app bar that is white on white - invisible, on the
     one strip that carries the time and the battery. */
  for (const p of ['/', '/offline']) {
    const style = /<meta name="apple-mobile-web-app-status-bar-style" content="([^"]+)"/
      .exec(await (await get(p)).text());
    assert.ok(style, p + ' does not say how iOS should draw the status bar');
    assert.notStrictEqual(style[1], 'black-translucent',
      p + ': white status bar text on a white app bar is invisible');
  }
});

test('the worker is served as script, and never from a stale cache', async () => {
  const r = await get('/sw.js');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  // It is the update channel for an installed app, so it must not be cached.
  assert.match(r.headers.get('cache-control') || '', /no-cache/);
});

test('the offline page is reachable and explains itself', async () => {
  const r = await get('/offline');
  assert.strictEqual(r.status, 200);
  const html = await r.text();
  assert.match(html, /Offline/i);
  assert.match(html, /needs the network/i);
});

test('the offline page belongs to all three roles', async () => {
  const html = await (await get('/offline')).text();
  const words = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ');

  /* The worker hands this page to whoever loses signal. It was written for a
     buyer - "your villa, your demands or your photographs", "one buyer's
     position" - which is the buyer's screen described to an engineer standing
     on a site road with no bars. */
  for (const role of ['buyer', 'engineer', 'office', 'villa owner']) {
    assert.ok(!new RegExp('\\b' + role + '\\b', 'i').test(words),
      'the offline page addresses one role by name: "' + role + '"');
  }

  /* And it must say something at the top on a phone. The bar carried its
     label in `.ab-ctx`, which the phone layer hides in favour of
     `.ab-screen`, so at 375px it was an empty strip with a logo in it. */
  assert.match(html, /class="ab-screen">[^<]+</,
    'the offline app bar has no label the phone layer will show');

  // Same install head as every other screen, or iOS opens it in Safari chrome.
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/,
    'the offline page is not an installed-app screen on iOS');
  assert.match(html, /viewport-fit=cover/, 'the offline page ignores the notch');
});

// ------------------------------------------------ what must never be cached

/** The shell list the worker precaches, as the browser receives it - so with
    `__BUILD__` already substituted, which is what the server actually serves. */
function shellList() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8')
    .split('__BUILD__').join(server.BUILD);
  const block = /const SHELL = \[([\s\S]*?)\];/.exec(src);
  assert.ok(block, 'could not find the SHELL list in sw.js');
  return [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
}

test('the worker caches only static files, and every one of them exists', async () => {
  const shell = shellList();
  assert.ok(shell.length > 0);
  for (const p of shell) {
    const r = await get(p);
    assert.strictEqual(r.status, 200, p + ' is precached but not served, so install would fail');
  }
});

test('nothing a signed-in person sees is in the cache list', () => {
  const shell = shellList();

  /* The specific paths that carry one buyer's money, and the prefixes they
     live under. If any of these is ever added to the shell, a cached copy
     survives sign-out on a shared phone. */
  const forbidden = ['/', '/villa/B-14', '/office', '/office/chase', '/engineer',
                     '/documents', '/doc/demand/us-B-14-brick.pdf',
                     '/evidence/' + 'a'.repeat(64), '/login', '/logout', '/health'];
  for (const p of forbidden) {
    assert.ok(!shell.includes(p), p + ' must never be precached');
  }

  for (const p of shell) {
    /* `/office.<build>.css` is the head office console's stylesheet, not a
       screen under /office: content-addressed, holding no data, and the second
       of the product's two visual systems. Everything else beginning with one
       of these names serves somebody's file. */
    if (/^\/office\.[a-f0-9]+\.css$/.test(p)) continue;
    assert.ok(!/^\/(villa|office|engineer|doc|evidence|documents|login|logout)\b/.test(p),
      p + ' is under a route that serves buyer data');
    assert.ok(p === '/offline' || /\.(css|js|png|svg|webmanifest)$/.test(p),
      p + ' is not a static asset');
  }
});

test('the worker cache list and the server static list agree', async () => {
  /* Two lists that have to match: anything the worker precaches must be
     something the server actually serves as a static file. They drift silently
     otherwise, and `addAll` fails the whole install on one file that moved. */
  const served = new Set(server.ASSET_ROUTES);
  for (const p of shellList()) {
    assert.ok(served.has(p), p + ' is precached by sw.js but the server serves no such route');
  }
});

test('the stylesheets are addressed by content, and pages link that address', async () => {
  /* `no-cache` keeps a browser honest from the moment it sees it. It cannot
     reach a browser that already holds a copy: these files went out for about
     an hour as `public, max-age=604800` with no version in the URL, and a
     browser told that is entitled to keep them for a week without asking. It
     stranded a real browser on the deployed URL, which then drew the new
     markup with the old stylesheet. A URL that changes with the bytes is the
     only fix that reaches a client that is not going to ask again. */
  assert.match(server.CSS.plint, /^\/plint\.[0-9a-f]{12}\.css$/);
  assert.match(server.CSS.app, /^\/app\.[0-9a-f]{12}\.css$/);
  assert.ok(server.CSS.plint.includes(server.BUILD), 'the stylesheet URL is not the build hash');

  for (const url of Object.values(server.CSS)) {
    const r = await get(url);
    assert.strictEqual(r.status, 200, url + ' is linked but not served');
    assert.match(r.headers.get('content-type'), /text\/css/);
    // Safe to hold for ever: the URL changes when the bytes do.
    assert.match(r.headers.get('cache-control'), /max-age=604800/,
      url + ' is content-addressed but still asks to be revalidated');
  }

  // Every page must link the versioned URL, not the bare one.
  for (const p of ['/', '/offline']) {
    const html = await (await get(p)).text();
    assert.ok(html.includes(server.CSS.plint), p + ' does not link the versioned plint.css');
    assert.ok(html.includes(server.CSS.app), p + ' does not link the versioned app.css');
    assert.ok(!/href="\/plint\.css"/.test(html), p + ' still links the unversioned plint.css');
    assert.ok(!/href="\/app\.css"/.test(html), p + ' still links the unversioned app.css');
  }
});

test('the worker refuses to touch anything but same-origin GETs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(src, /req\.method !== 'GET'/, 'state-changing requests must go straight to the network');
  assert.match(src, /url\.origin !== self\.location\.origin/, 'other origins must be left alone');
  /* Every cache write must be inside a branch that has already decided the URL
     is on the allowlist. Counting them is not the rule - the rule is that the
     path everything else falls through to, which is where a villa page or an
     evidence photograph arrives, never writes. So that stretch of the file is
     what gets checked: from the fall-through comment to the end of the fetch
     handler, there is no write at all. */
  const from = src.indexOf('is network only');
  const to = src.indexOf("'plint:signout'");
  assert.ok(from > 0 && to > from, 'could not find the fall-through path in sw.js');
  const fallThrough = src.slice(from, to);
  assert.ok(!/\.put\(|\.addAll\(/.test(fallThrough),
    'the path that serves screens and photographs writes to the cache');

  // And every write that does exist is inside a guarded branch.
  const guards = [...src.matchAll(/(CACHEABLE\.has\(url\.pathname\)|url\.pathname === '\/[^']*')[\s\S]{0,600}?\.put\(/g)].length;
  const puts = [...src.matchAll(/\.put\(/g)].length;
  assert.strictEqual(guards, puts,
    puts + ' cache writes but only ' + guards + ' of them behind an allowlist check');
});

// ------------------------------------------ the cache name has to move

test('the worker ships with a real build hash, not the placeholder', async () => {
  const src = await (await get('/sw.js')).text();
  assert.ok(!src.includes('__BUILD__'), 'the server served the template, unsubstituted');
  const v = /const VERSION = '(plint-shell-[0-9a-f]{12})'/.exec(src);
  assert.ok(v, 'no versioned cache name in the served worker');
  assert.strictEqual(v[1], 'plint-shell-' + server.BUILD);
});

test('the build hash moves when any shell asset changes', () => {
  /* The whole point of the hash. If it were a constant - as it was when this
     first shipped - an installed app would keep the stylesheet it cached on
     the day it was installed, through every later deploy, for ever: the cache
     is keyed by URL, the URL carries no version, and cache-first never asks. */
  const css = path.join(__dirname, '..', 'public', 'app.css');
  const before = fs.readFileSync(css);
  const read = () => JSON.parse(execFileSync(process.execPath,
    ['-e', 'const s=require("./src/server");console.log(JSON.stringify(s.BUILD));process.exit(0)'],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim());

  const first = read();
  assert.strictEqual(first, server.BUILD, 'a child of the same tree hashes differently');
  try {
    fs.writeFileSync(css, Buffer.concat([before, Buffer.from('\n/* one byte */\n')]));
    assert.notStrictEqual(read(), first, 'a changed stylesheet left the cache name alone');
  } finally {
    fs.writeFileSync(css, before);
  }
  assert.strictEqual(read(), first, 'the hash did not come back when the file did');
});

test('the shell is filled past the browser HTTP cache', () => {
  /* A source assertion, because no Node process can observe a browser's HTTP
     cache. Without `cache: 'reload'` a new VERSION opens a new cache and then
     fills it from the same week-old icon the HTTP cache is still holding,
     which makes versioning the name pointless. Confirmed by hand in Chrome:
     an edited stylesheet reached an already-installed worker. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(src, /new Request\(url, \{ cache: 'reload' \}\)/,
    'the shell must be fetched with cache: reload');
  const fills = [...src.matchAll(/addAll\(SHELL[^)]*\)/g)].map(m => m[0]);
  assert.strictEqual(fills.length, 2, 'expected two shell fills: install, and sign-out');
  for (const f of fills) {
    assert.match(f, /\.map\(fresh\)/, 'a shell fill that does not bypass the HTTP cache: ' + f);
  }
});

test('the stylesheets revalidate instead of claiming to be immutable', async () => {
  for (const p of ['/plint.css', '/app.css']) {
    const r = await get(p);
    assert.strictEqual(r.headers.get('cache-control'), 'no-cache',
      p + ' has no version in its URL, so it must not be held without asking');
    const etag = r.headers.get('etag');
    assert.match(etag || '', /^"[0-9a-f]{16}"$/, p + ' has no ETag, so revalidation costs a download');

    /* Every form a real client sends. The weak one is not hypothetical: the
       proxy in front of the deployed app compresses text and rewrites the
       ETag to `W/"..."`, so that is what the browser sends back. A strict
       `===` shipped, and on the live URL it meant a full 45KB stylesheet on
       every navigation - which `no-cache` guarantees happens every time. */
    for (const sent of [etag, 'W/' + etag, '"other", ' + etag, etag + ' , "other"', '*']) {
      const again = await fetch(BASE + p, { headers: { 'if-none-match': sent } });
      assert.strictEqual(again.status, 304, p + ' re-sent the body for If-None-Match: ' + sent);
      assert.strictEqual((await again.arrayBuffer()).byteLength, 0);
    }

    const stale = await fetch(BASE + p, { headers: { 'if-none-match': '"0000000000000000"' } });
    assert.strictEqual(stale.status, 200, p + ' claimed 304 for an ETag it never issued');
  }

  // The icons genuinely may be held: a stale mark for a week is cosmetic.
  const icon = await get('/icons/icon-192.png');
  assert.match(icon.headers.get('cache-control'), /max-age=604800/);
});

test('sign-out clears the cache and then restores the shell', () => {
  /* Clearing alone leaves the cache to refill lazily from whatever the next
     page requests, which does not include /offline. Verified in Chrome: after
     a sign-out the cache held four of ten entries and the offline fallback
     was gone. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  const handler = /'plint:signout'\)? *\{?([\s\S]*?)\n\}\);/.exec(src);
  assert.ok(handler, 'no sign-out handler in sw.js');
  assert.match(handler[1], /caches\.delete/, 'sign-out must clear the cache');
  assert.match(handler[1], /addAll\(SHELL/, 'sign-out must put the shell back');
  assert.ok(handler[1].indexOf('caches.delete') < handler[1].indexOf('addAll(SHELL'),
    'the shell is restored before it is deleted, which deletes it');
});
