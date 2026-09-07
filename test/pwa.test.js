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

// ------------------------------------------------ what must never be cached

/** The shell list the worker precaches, read out of the worker itself. */
function shellList() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
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
  const forbidden = ['/', '/villa/B-14', '/office', '/office/sanctions', '/engineer',
                     '/documents', '/doc/demand/us-B-14-brick.pdf',
                     '/evidence/' + 'a'.repeat(64), '/login', '/logout', '/health'];
  for (const p of forbidden) {
    assert.ok(!shell.includes(p), p + ' must never be precached');
  }

  for (const p of shell) {
    assert.ok(!/^\/(villa|office|engineer|doc|evidence|documents|login|logout)\b/.test(p),
      p + ' is under a route that serves buyer data');
    assert.ok(p === '/offline' || /\.(css|js|png|svg|webmanifest)$/.test(p),
      p + ' is not a static asset');
  }
});

test('the worker cache list and the server static list agree', async () => {
  /* Two lists in two files that have to match: anything the worker precaches
     must be something the server actually serves as a static file. They drift
     silently otherwise, and install fails on a file that moved. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const block = /const STATIC = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, 'could not find the STATIC map in server.js');
  const served = new Set([...block[1].matchAll(/'(\/[^']*)':/g)].map(m => m[1]));

  for (const p of shellList()) {
    assert.ok(served.has(p), p + ' is precached by sw.js but is not in the server static map');
  }
});

test('the worker refuses to touch anything but same-origin GETs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(src, /req\.method !== 'GET'/, 'state-changing requests must go straight to the network');
  assert.match(src, /url\.origin !== self\.location\.origin/, 'other origins must be left alone');
  // The only cache write must be guarded by the allowlist.
  const puts = [...src.matchAll(/\.put\(/g)].length;
  assert.strictEqual(puts, 1, 'expected exactly one cache write, found ' + puts);
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

    const again = await fetch(BASE + p, { headers: { 'if-none-match': etag } });
    assert.strictEqual(again.status, 304, p + ' ignored If-None-Match');
    assert.strictEqual((await again.arrayBuffer()).byteLength, 0);
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
