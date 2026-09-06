'use strict';
/* ============================================================================
   Login rate limiting.

   Runs last, because it deliberately blocks a key and blocking is the point.
   It clears what it blocked afterwards, so the suite is re-runnable against a
   development database.
   ========================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { pool } = require('../src/db');
const T = require('../src/throttle');

const PORT = 3191, BASE = 'http://127.0.0.1:' + PORT;
const server = require('../src/server');

const VICTIM = 'arjun@example.in';

before(() => new Promise(r => server.listen(PORT, r)));
after(async () => {
  // Leave nothing blocked behind us.
  for (const k of ['email:' + VICTIM, 'addr:127.0.0.1', 'addr:::ffff:127.0.0.1']) {
    await pool.query('SELECT plint.login_cleared($1)', [k]).catch(() => {});
  }
  await new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  await pool.end();
});

const attempt = (email, pw) => fetch(BASE + '/login', {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ email, pw }),
});

test('a wrong password is refused without blocking straight away', async () => {
  const r = await attempt(VICTIM, 'wrong');
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /do not match/);
});

test('repeated failures block the account, correct password and all', async () => {
  // Up to the limit, still the ordinary refusal.
  for (let i = 1; i < T.EMAIL_LIMIT; i++) {
    const r = await attempt(VICTIM, 'wrong-' + i);
    assert.strictEqual(r.status, 200, `attempt ${i} should still be answered normally`);
  }

  // Past it, a 429 that names a wait.
  let blocked = null;
  for (let i = 0; i < 4 && !blocked; i++) {
    const r = await attempt(VICTIM, 'wrong-more-' + i);
    if (r.status === 429) blocked = await r.text();
  }
  assert.ok(blocked, 'the account blocks after the limit is passed');
  assert.match(blocked, /Too many sign-in attempts/);
  assert.match(blocked, /minute/);

  // And the block is real: the CORRECT password is refused too. If it were
  // not, the limiter would only be slowing down the guesses that were wrong.
  const good = await attempt(VICTIM, 'plint');
  assert.strictEqual(good.status, 429, 'a blocked key is not let through by a right answer');
  assert.strictEqual(good.headers.get('set-cookie'), null, 'and no session is issued');
});

test('the block does not leak whether the account exists', async () => {
  const real = await attempt(VICTIM, 'plint');
  const fake = await attempt('nobody-at-all@example.in', 'plint');
  // The blocked account and an unknown one are both refused; neither response
  // says which of the two it is.
  assert.match(await real.text(), /Too many sign-in attempts|do not match/);
  assert.match(await fake.text(), /Too many sign-in attempts|do not match/);
});

test('a different account is unaffected by another one being blocked', async () => {
  // The address counter is far higher than the email counter, so one blocked
  // account does not take the whole office offline.
  const r = await attempt('priya@nvt.in', 'plint');
  assert.strictEqual(r.status, 302, 'head office signs in normally');
  assert.ok(r.headers.get('set-cookie'), 'and gets a session');
});

test('a successful sign-in clears the counter, so only failures accumulate', async () => {
  const email = 'ramachandran@nvt.in';

  // Some failures, short of the limit.
  for (let i = 0; i < T.EMAIL_LIMIT - 1; i++) await attempt(email, 'wrong');

  // Then a success, which should reset the count to zero.
  const ok = await attempt(email, 'plint');
  assert.strictEqual(ok.status, 302);

  // The same number of failures again must therefore still not block: if the
  // counter had not been cleared, this would tip past the limit.
  for (let i = 0; i < T.EMAIL_LIMIT - 1; i++) {
    const r = await attempt(email, 'wrong');
    assert.strictEqual(r.status, 200, 'the counter was cleared by the success');
  }

  const still = await attempt(email, 'plint');
  assert.strictEqual(still.status, 302, 'and a good password still works');
});

test('a block survives a restart, because it is not held in this process', async () => {
  const email = 'sharma@example.in';
  const path = require('path');
  const SERVER = path.join(__dirname, '..', 'src', 'server.js');

  // Block the account.
  let blocked = false;
  for (let i = 0; i < T.EMAIL_LIMIT + 3 && !blocked; i++) {
    const r = await attempt(email, 'wrong-' + i);
    blocked = r.status === 429;
  }
  assert.ok(blocked, 'the account is blocked to begin with');

  // Throw the server module away and load a fresh one, on a new port. An
  // in-process counter would be gone with it and the block would lift.
  await new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  delete require.cache[require.resolve(SERVER)];
  const fresh = require(SERVER);
  const PORT2 = PORT + 1;
  await new Promise(r => fresh.listen(PORT2, r));

  try {
    const r = await fetch('http://127.0.0.1:' + PORT2 + '/login', {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, pw: 'plint' }),
    });
    assert.strictEqual(r.status, 429,
      'the restarted instance still refuses: the counter is in the database');
  } finally {
    await new Promise(r => { fresh.closeAllConnections?.(); fresh.close(r); });
    await new Promise(r => server.listen(PORT, r));
    await pool.query('SELECT plint.login_cleared($1)', ['email:' + email]).catch(() => {});
  }
});

test('the application role cannot read or edit the attempt counters', async () => {
  await assert.rejects(
    () => pool.query('SELECT * FROM plint.login_attempts'),
    /permission denied/i,
    'no grant on the table; the functions are the whole vocabulary');
});
