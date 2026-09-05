'use strict';
/* ============================================================================
   Sessions survive a restart.

   The old implementation kept sessions in a Map inside src/server.js. The test
   that matters is therefore not "close the listener and reopen it" - that would
   keep the Map. It is: throw the module away, load a completely fresh copy of
   the server, and present the cookie the discarded one issued.

   If authentication were still in process, the fresh copy would have an empty
   Map and would bounce the cookie to the login page.
   ========================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { Client } = require('pg');
const { pool } = require('../src/db');
const config = require('../src/config');
const S = require('../src/session');

// The restarted instance takes a second port. Reusing the first would have the
// client's keep-alive pool hand us a socket to the server we just closed.
const PORT = 3151, PORT2 = 3152;
const BASE = 'http://127.0.0.1:' + PORT;
let base = BASE;
const SERVER = path.join(__dirname, '..', 'src', 'server.js');

let server = require(SERVER);
let cookie = null;

const listen = (s, p) => new Promise(r => s.listen(p, r));
const close = s => new Promise(r => { s.closeAllConnections?.(); s.close(r); });

before(() => listen(server, PORT));
after(async () => { await close(server); await pool.end(); });

test('signing in issues a cookie', async () => {
  const r = await fetch(BASE + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'arjun@example.in', pw: 'plint' }),
  });
  const set = r.headers.get('set-cookie');
  assert.ok(set, 'a Set-Cookie header came back');
  cookie = set.split(';')[0];
  assert.match(cookie, /^plint=[0-9a-f]{64}$/, 'the cookie is a 32-byte random token');
});

test('the cookie carries a token, not the key the database stores', async () => {
  const token = cookie.split('=')[1];
  // Read as the owner: the application role has no grant here, which is the
  // point of the test below.
  const admin = new Client(config.adminDb());
  await admin.connect();
  try {
    const r = await admin.query('SELECT id FROM plint.sessions ORDER BY created_at DESC LIMIT 1');
    assert.notStrictEqual(r.rows[0].id, token,
      'the stored id is the HMAC, so reading the table yields no usable cookie');
    assert.match(r.rows[0].id, /^[0-9a-f]{64}$/);
  } finally { await admin.end(); }
});

test('the cookie is HttpOnly, SameSite=Lax and carries a Max-Age', async () => {
  const r = await fetch(BASE + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'arjun@example.in', pw: 'plint' }),
  });
  const set = r.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Max-Age=\d+/);
});

test('the session survives a restart of the server module', async () => {
  // Reachable before the restart.
  const before = await fetch(base + '/', { headers: { cookie }, redirect: 'follow' });
  assert.match(await before.text(), /Villa B-14/, 'signed in before the restart');

  // Restart: drop the listener, evict the module, load a fresh one. Any state
  // the old module held is gone with it.
  const old = server;
  await close(server);
  delete require.cache[require.resolve(SERVER)];
  server = require(SERVER);
  assert.notStrictEqual(server, old, 'a genuinely new module instance');
  await listen(server, PORT2);
  base = 'http://127.0.0.1:' + PORT2;

  const after = await fetch(base + '/', { headers: { cookie }, redirect: 'follow' });
  assert.strictEqual(after.status, 200);
  assert.match(await after.text(), /Villa B-14/,
    'the cookie issued by the discarded instance still authenticates');
});

test('signing out revokes the session in the database, not just the browser', async () => {
  const r = await fetch(base + '/logout', { headers: { cookie }, redirect: 'manual' });
  assert.strictEqual(r.status, 302);

  // Present the same cookie again, ignoring the clearing header entirely.
  const again = await fetch(base + '/', { headers: { cookie }, redirect: 'manual' });
  assert.strictEqual(again.status, 200, 'lands on the login page');
  assert.match(await again.text(), /Sign in/, 'a revoked cookie no longer authenticates');
});

test('a forged token does not authenticate', async () => {
  const forged = 'plint=' + 'a'.repeat(64);
  const r = await fetch(base + '/', { headers: { cookie: forged }, redirect: 'manual' });
  assert.match(await r.text(), /Sign in/);
});

test('the application role cannot read the sessions table directly', async () => {
  await assert.rejects(
    () => pool.query('SELECT * FROM plint.sessions'),
    /permission denied/i,
    'no grant on the table: everything goes through the definer functions');
});

test('a session id that never existed looks the same as a revoked one', async () => {
  assert.strictEqual(await S.lookup('never-issued'), null);
});
