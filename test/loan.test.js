'use strict';
/* ============================================================================
   The loan model, as plint-v21 has it.

   The builder does not chase documents. The buyer side is a read-only list of
   the papers his bank will ask for - no upload, no ticking, nothing sent. The
   office side records the sanction when the buyer walks in with the letter,
   and until that is recorded nothing can be disbursed against a stage.

   The assertion that matters most is the last kind: own contribution is a
   stored figure, not a percentage and not the difference between two others.
   ========================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');

const { asUser, pool } = require('../src/db');
const config = require('../src/config');

const OFFICE = { id: 'u-office', role: 'office' };
const BUYER  = { id: 'u-buyer-b14', role: 'buyer' };
const ENG    = { id: 'u-eng-ram', role: 'engineer' };

const PORT = 3221, BASE = 'http://127.0.0.1:' + PORT;
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

const get = (p, cookie) => fetch(BASE + p, { headers: { cookie }, redirect: 'manual' });

// ------------------------------------------------- the buyer side is a list

test('the buyer sees every paper his bank will ask for, from the database', async () => {
  const cookie = await signIn('arjun@example.in');
  const r = await get('/documents', cookie);
  assert.strictEqual(r.status, 200);
  const html = await r.text();

  assert.match(html, /What the bank will ask for/);

  /* The count and the labels used to come from a constant in server.js: two
     applicants invented on the spot and a hard-coded list of papers under
     each, adding to the fourteen v21 draws. The office could tick a paper as
     seen and nothing here moved, because there was nothing here to move.

     So the expectation is read from the same rows the screen reads. If the
     seed gives this buyer one applicant or three, the screen shows one or
     three, and this test still says whether it showed them. */
  const papers = await asUser(BUYER, c => c.query(
    `SELECT d.label, d.seen_at, a.full_name
       FROM loan_documents d JOIN loan_applicants a ON a.id = d.applicant_id
       JOIN units u ON u.id = a.unit_id
      WHERE u.code = 'B-14' ORDER BY a.seq, d.seq`)).then(x => x.rows);
  assert.ok(papers.length > 0, 'the seed gives this buyer no papers to show');

  const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const p of papers) {
    assert.ok(html.includes(esc(p.label)), 'missing from the list: ' + p.label);
  }
  for (const name of new Set(papers.map(p => p.full_name))) {
    assert.ok(html.includes(esc(name)), 'the applicant is not named: ' + name);
  }
  /* The headline figure and the word for it, from the shared summary card.
     It was a `.kpin` each screen drew for itself until the dashboards were
     built from one set of pieces. */
  const cap = /<p class="cap">([^<]*)<\/p>\s*<p class="fig[^"]*">([^<]*)</.exec(html);
  assert.ok(cap, 'the screen has no headline figure at all');
  assert.strictEqual(cap[2].trim(), String(papers.length),
    'the count does not match the ' + papers.length + ' papers on file');
  assert.match(cap[1], /paper/, 'the count is not counting papers');

  /* And the state of each one, which is the part a constant could never show:
     the office marks a paper seen and this screen says so. */
  const seen = papers.filter(p => p.seen_at).length;
  assert.ok(html.includes(seen + ' of ' + papers.length + ' seen by the office'),
    'the screen does not say how many the office has seen');
});

test('the list is read-only: nothing to upload, nothing to tick', async () => {
  const cookie = await signIn('arjun@example.in');
  const html = await (await get('/documents', cookie)).text();

  // This is the whole point of the v21 model. A file input or a checkbox here
  // would mean the builder is collecting papers, which it does not do.
  assert.doesNotMatch(html, /<input[^>]*type="file"/i, 'no upload');
  assert.doesNotMatch(html, /<input[^>]*type="checkbox"/i, 'nothing to tick');
  assert.doesNotMatch(html, /<form/i, 'nothing to submit at all');
  assert.match(html, /sends nothing to any bank/, 'and it says so');
});

test('a buyer cannot reach the office sanction screen', async () => {
  const cookie = await signIn('arjun@example.in');
  assert.strictEqual((await get('/office/chase', cookie)).status, 404);
  const r = await fetch(BASE + '/office/sanction', {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ unit: 'unit-B-14', sanction: '1', own: '1', letter: 'x' }),
  });
  assert.strictEqual(r.status, 404);
});

// ------------------------------------------------- the office side records it

const unrecorded = () => asUser(OFFICE, c => c.query(
  `SELECT id, code, agreement_value_paise FROM units
    WHERE bank IS NOT NULL AND sanction_recorded_at IS NULL ORDER BY code LIMIT 1`))
  .then(r => r.rows[0]);

test('the office lists the buyers with no sanction on file', async () => {
  const cookie = await signIn('priya@nvt.in');
  const html = await (await get('/office/chase', cookie)).text();

  assert.match(html, /Sanction not recorded/);
  const n = (await asUser(OFFICE, c => c.query(
    `SELECT count(*)::int n FROM units WHERE bank IS NOT NULL AND sanction_recorded_at IS NULL`)))
    .rows[0].n;
  assert.ok(n > 0, 'the seed leaves some unrecorded, or this screen proves nothing');
  /* Count the forms, not the phrase: the sub-heading says "sanction" too, and
     the head office console draws one card per file with the lender's name in
     a `.p-due` pill and the form to record the letter under it. */
  assert.strictEqual((html.match(/name="unit"/g) || []).length, n,
    'one record form per buyer without a sanction');
  assert.strictEqual((html.match(/class="pill p-due"/g) || []).length, n,
    'and one lender named per row');
  /* The three the handler reads. The form asked for `amount` and `ref`, which
     the handler does not read at all, so recording a sanction could never
     succeed however carefully it was filled in. */
  assert.match(html, /name="sanction"/, 'there is nowhere to type the sanctioned amount');
  assert.match(html, /name="own"/, "there is nowhere to type the buyer's own contribution");
  assert.match(html, /name="letter"/, 'there is nowhere to type the letter reference');
});

test('recording a sanction stores the amount, the contribution and the letter', async () => {
  const cookie = await signIn('priya@nvt.in');
  const u = await unrecorded();
  assert.ok(u, 'a villa to record against');

  /* Deliberately NOT the agreement value less the sanction, and deliberately
     not twenty per cent of anything. A buyer may put in more than the
     difference and a lender may sanction against a valuation rather than the
     agreement value, so the figure has to survive being its own number. */
  const sanctionRupees = 21000000;      // Rs 2.10 Cr
  const ownRupees      =  9500000;      // Rs 95 L, which is neither of the above
  const letter = 'SL/TEST/2026/001';

  const r = await fetch(BASE + '/office/sanction', {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      unit: u.id, sanction: String(sanctionRupees), own: String(ownRupees), letter }),
  });
  assert.strictEqual(r.status, 302);
  assert.match(decodeURIComponent(r.headers.get('location')), /Sanction recorded/);

  const row = (await asUser(OFFICE, c => c.query(
    `SELECT * FROM units WHERE id=$1`, [u.id]))).rows[0];

  assert.strictEqual(row.sanction_paise, sanctionRupees * 100);
  assert.strictEqual(row.own_contribution_paise, ownRupees * 100);
  assert.strictEqual(row.sanction_letter_ref, letter);
  assert.strictEqual(row.sanction_recorded_by, OFFICE.id);
  assert.ok(row.sanction_recorded_at, 'and when');

  // The figure is stored, not derived: it is neither the difference nor a fifth.
  assert.notStrictEqual(row.own_contribution_paise,
    Number(row.agreement_value_paise) - row.sanction_paise,
    'own contribution must not be recomputed as agreement less sanction');
  assert.notStrictEqual(row.own_contribution_paise,
    Math.round(Number(row.agreement_value_paise) * 0.2),
    'nor assumed to be twenty per cent');
});

test('recording a sanction leaves an audit row naming who recorded it', async () => {
  const u = (await asUser(OFFICE, c => c.query(
    `SELECT id FROM units WHERE sanction_letter_ref='SL/TEST/2026/001'`))).rows[0];
  assert.ok(u, 'the villa recorded above');

  const rows = (await asUser(OFFICE, c => c.query(
    `SELECT * FROM audit_log WHERE target_kind='unit' AND target_id=$1
        AND action='sanction_recorded'`, [u.id]))).rows;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].actor_id, OFFICE.id);
  assert.strictEqual(Number(rows[0].figures.own_contribution_paise), 9500000 * 100);
});

test('a sanction is recorded once', async () => {
  const cookie = await signIn('priya@nvt.in');
  const u = (await asUser(OFFICE, c => c.query(
    `SELECT id FROM units WHERE sanction_letter_ref='SL/TEST/2026/001'`))).rows[0];

  const r = await fetch(BASE + '/office/sanction', {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ unit: u.id, sanction: '1', own: '1', letter: 'again' }),
  });
  assert.match(decodeURIComponent(r.headers.get('location')), /already has a sanction/);

  const row = (await asUser(OFFICE, c => c.query('SELECT * FROM units WHERE id=$1', [u.id]))).rows[0];
  assert.strictEqual(row.sanction_letter_ref, 'SL/TEST/2026/001', 'the first record stands');
});

test('an engineer cannot record a sanction', async () => {
  await assert.rejects(
    () => asUser(ENG, c => c.query(
      `SELECT record_sanction($1,$2,$3,$4)`, ['unit-B-14', 100, 100, 'x'])),
    /only head office records a sanction/);
});

test('a sanction with no letter behind it is refused', async () => {
  const u = await unrecorded();
  if (!u) return;
  for (const [s, o, l, why] of [
    [0, 100, 'x', 'a sanction needs an amount'],
    [100, null, 'x', 'a sanction needs the buyer own contribution'],
    [100, 100, '   ', 'a sanction needs the letter'],
  ]) {
    await assert.rejects(
      () => asUser(OFFICE, c => c.query('SELECT record_sanction($1,$2,$3,$4)', [u.id, s, o, l])),
      new RegExp(why.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('half a sanction cannot be written even by the owning role', async () => {
  const admin = new Client(config.adminDb());
  await admin.connect();
  try {
    const u = (await admin.query(
      `SELECT id FROM plint.units WHERE sanction_recorded_at IS NULL LIMIT 1`)).rows[0];
    await assert.rejects(
      () => admin.query(
        'UPDATE plint.units SET sanction_paise = 100 WHERE id = $1', [u.id]),
      /units_sanction_complete/,
      'an amount with no letter and nobody name against it is not a record');
  } finally { await admin.end(); }
});

test('the buyer screen reflects whether his sanction is recorded', async () => {
  /* On its own screen since the buyer got five tabs. It used to sit two thirds
     of the way down one long villa page with the ledger and the schedule; the
     figure that decides whether any money can move at all is worth a screen. */
  const cookie = await signIn('arjun@example.in');
  const html = await (await get('/loan', cookie)).text();
  const u = (await asUser(BUYER, c => c.query('SELECT * FROM units'))).rows[0];

  if (u.sanction_recorded_at) {
    assert.match(html, /Your sanction is on file/);
    assert.ok(html.includes(require('../src/money').money(u.sanction_paise)),
      'the sanctioned figure is not on the screen');
    assert.ok(html.includes(require('../src/money').money(u.own_contribution_paise)),
      'the own contribution is not on the screen');
  } else {
    assert.match(html, /No sanction on file/);
    assert.match(html, /Bring your sanction letter to the sales office/);
  }
});
