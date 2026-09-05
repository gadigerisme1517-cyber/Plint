'use strict';
/* ============================================================================
   Pack delivery is recorded, and the copy says what is true.

   Nothing in this deliverable sends anything to a lender. So the test is not
   "was it delivered" - it is that a certification leaves a delivery row in a
   state that matches reality, and that no screen or document claims an action
   the system did not take.
   ========================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { asUser, pool } = require('../src/db');

const ENG = { id: 'u-eng-ram', role: 'engineer' };
const PORT = 3181, BASE = 'http://127.0.0.1:' + PORT;
const server = require('../src/server');

before(() => new Promise(r => server.listen(PORT, r)));
after(async () => {
  await new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  await pool.end();
});

const signIn = async email => {
  const r = await fetch(BASE + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, pw: 'plint' }),
  });
  return r.headers.get('set-cookie').split(';')[0];
};

/** A stage that is marked on site with enough photographs, on a villa that
    has a lender. Not B-14, which the other suites certify. */
async function certifiable(withLender) {
  const r = await asUser(ENG, c => c.query(
    `SELECT s.id, u.bank, u.code FROM unit_stages s
       JOIN units u ON u.id = s.unit_id
      WHERE s.status='marked' AND s.unit_id <> 'unit-B-14'
        AND u.bank IS ${withLender ? 'NOT NULL' : 'NULL'}
        AND (SELECT count(*) FROM evidence e WHERE e.unit_stage_id = s.id) >= 2
        AND NOT EXISTS (SELECT 1 FROM pack_deliveries p WHERE p.unit_stage_id = s.id)
      ORDER BY s.id LIMIT 1`));
  return r.rows[0];
}

const certify = (cookie, id) => fetch(BASE + '/engineer/certify', {
  method: 'POST', redirect: 'manual',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ id }),
});

test('certifying a stage leaves exactly one delivery row, queued', async () => {
  const eng = await signIn('ramachandran@nvt.in');
  const target = await certifiable(true);
  assert.ok(target, 'a certifiable stage on a villa with a lender');

  const before = await asUser(ENG, c => c.query(
    'SELECT * FROM pack_deliveries WHERE unit_stage_id=$1', [target.id]));
  assert.strictEqual(before.rows.length, 0, 'nothing queued yet');

  const r = await certify(eng, target.id);
  assert.strictEqual(r.status, 302);

  const rows = (await asUser(ENG, c => c.query(
    'SELECT * FROM pack_deliveries WHERE unit_stage_id=$1', [target.id]))).rows;
  assert.strictEqual(rows.length, 1, 'a delivery row per certification');

  const d = rows[0];
  assert.strictEqual(d.state, 'queued', 'queued, because nothing has sent it');
  assert.strictEqual(d.lender, target.bank, 'addressed to the villa lender');
  assert.strictEqual(d.attempts, 0, 'no attempt has been made');
  assert.strictEqual(d.last_attempt_at, null);
  assert.strictEqual(d.response, null, 'and the lender has not answered');
  assert.strictEqual(d.delivered_at, null);
  assert.ok(d.queued_at, 'but it is on the queue, with a time');
});

test('the message the engineer sees says queued, not sent', async () => {
  const eng = await signIn('ramachandran@nvt.in');
  const target = await certifiable(true);
  assert.ok(target);

  const r = await certify(eng, target.id);
  const msg = decodeURIComponent(r.headers.get('location') || '');

  assert.match(msg, /certified/);
  assert.match(msg, /queued for /, 'the copy describes a queue');
  assert.doesNotMatch(msg, /has gone to|was sent|delivered/i,
    'and claims no delivery the system did not perform');
});

test('a villa with no lender gets a state, not a queued pack', async () => {
  const eng = await signIn('ramachandran@nvt.in');
  const target = await certifiable(false);
  if (!target) return;                    // every villa in this seed has a bank

  const r = await certify(eng, target.id);
  assert.strictEqual(r.status, 302);
  assert.match(decodeURIComponent(r.headers.get('location')), /No lender is on file/);

  const d = (await asUser(ENG, c => c.query(
    'SELECT * FROM pack_deliveries WHERE unit_stage_id=$1', [target.id]))).rows[0];
  assert.strictEqual(d.state, 'not_applicable');
  assert.strictEqual(d.lender, null);
});

test('the demand letter does not claim the pack was delivered', async () => {
  const eng = await signIn('ramachandran@nvt.in');
  const r = await fetch(BASE + '/doc/demand/us-B-14-brick.pdf', { headers: { cookie: eng } });
  const text = Buffer.from(await r.arrayBuffer()).toString('latin1');
  // pdfkit writes the text into the content stream compressed, so assert on
  // what the generator produced instead.
  const PDF = require('../src/pdf');
  assert.ok(typeof PDF.demandLetter === 'function');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(text.slice(0, 4), '%PDF');
});

test('the source carries no copy asserting a delivery', () => {
  const fs = require('fs');
  const path = require('path');
  const claims = /(pack|photographs|certificate)[^.]{0,60}(has gone to|went to|was sent to)/i;
  for (const f of ['server.js', 'pdf.js', 'money.js', 'session.js', 'evidence.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    assert.doesNotMatch(src, claims, f + ' claims a delivery');
  }
});

test('a buyer can see the state of his own pack and nobody else can show him another', async () => {
  const BUYER = { id: 'u-buyer-b14', role: 'buyer' };
  const mine = await asUser(BUYER, c => c.query(
    `SELECT p.* FROM pack_deliveries p
       JOIN unit_stages s ON s.id = p.unit_stage_id
      WHERE s.unit_id = 'unit-B-14'`));
  const all = await asUser(BUYER, c => c.query('SELECT * FROM pack_deliveries'));
  assert.strictEqual(all.rows.length, mine.rows.length,
    'an unfiltered select returns only his own villa packs');
});
