'use strict';
/* ============================================================================
   RECEIPTS, THE ENGINEER'S OUTBOX, AND WHAT PLINT HOLDS ABOUT A BUYER.

   The three things Pass 6 added to the record, and what each one has to keep
   being true about.

   RECEIPTS. Plint could raise a demand and could mark one settled, and nothing
   in the product ever called the function that does it. Money arrived and the
   buyer's screen went on saying it was owed. The receipt is the buyer's proof
   it was paid, and the one rule it is built to is that it holds NO MONEY: the
   table has no amount column, every figure comes from the demand it points at,
   and the two therefore cannot drift apart. These tests assert that as a
   property of the schema, not of a screen, because a column added later is
   exactly how it would be lost.

   THE OUTBOX. Four writes an engineer makes on a site with no signal are held
   on the phone. The half of that which lives on the server is small and
   testable: those four routes answer JSON, with an explicit yes or no, when
   the write carries `x-plint-queued`. Without the explicit no, a refusal and a
   success are the same 302 and a refused write would vanish as though it had
   been filed. The other half - IndexedDB, ordering, the force quit - is in a
   real browser, in browser.test.js.

   WHAT PLINT HOLDS. The buyer can read an inventory of their own personal
   data and take a copy of it. It must never contain a password hash, and it
   must be bounded by the same policies as every other buyer screen.
   ========================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { asUser, pool } = require('../src/db');
const M = require('../src/money');

const PORT = 3251, BASE = 'http://127.0.0.1:' + PORT;
const server = require('../src/server');

const OFFICE = { id: 'u-office', role: 'office' };
const BUYER = { id: 'u-buyer-b14', role: 'buyer', unit: 'B-14' };
const ENGINEER = { id: 'u-eng-ram', role: 'engineer' };

const cookies = {};
before(async () => {
  await new Promise(r => server.listen(PORT, r));
  for (const [role, email] of [['office', 'priya@nvt.in'],
                               ['engineer', 'ramachandran@nvt.in'],
                               ['buyer', 'arjun@example.in']]) {
    const r = await fetch(BASE + '/login', {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, pw: 'plint' }),
    });
    const c = r.headers.get('set-cookie');
    assert.ok(c, role + ' could not sign in');
    cookies[role] = c.split(';')[0];
  }
});
after(async () => {
  await new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  await pool.end();
});

const post = async (path, role, fields, headers = {}) => {
  const r = await fetch(BASE + path, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: cookies[role], 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields),
  });
  const loc = r.headers.get('location') || '';
  const m = /[?&]m=([^&]*)/.exec(loc);
  return { status: r.status, loc, msg: m ? decodeURIComponent(m[1]) : null,
           text: await r.text() };
};
const get = async (path, role) => {
  const r = await fetch(BASE + path, { headers: { cookie: cookies[role] } });
  return { status: r.status, html: await r.text(), type: r.headers.get('content-type') };
};
const rows = (who, sql, args) => asUser(who, c => c.query(sql, args).then(r => r.rows));

/** An unpaid demand on B-14, which is the villa the buyer in this suite holds. */
const owed = () => rows(OFFICE,
  `SELECT dm.id, dm.doc_no, dm.total_paise FROM demands dm
     JOIN unit_stages s ON s.id = dm.unit_stage_id
     JOIN units u ON u.id = s.unit_id
    WHERE u.code = 'B-14' AND dm.paid_at IS NULL
    ORDER BY dm.due_at LIMIT 1`).then(r => r[0]);

const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

// ------------------------------------------------------ the shape of the table

test('a receipt holds no money at all', async () => {
  const cols = (await rows(OFFICE,
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'plint' AND table_name = 'receipts'`)).map(r => r.column_name);
  assert.ok(cols.length, 'there is no receipts table');
  /* The whole design. A receipt that carried its own figure would disagree
     with the demand the first time a credit was raised against it. */
  const money = cols.filter(c => /paise|amount|total|gst|rupee/.test(c));
  assert.deepStrictEqual(money, [],
    'the receipt carries its own money columns: ' + money.join(', '));
});

test('the application role cannot write a receipt directly', async () => {
  const dm = await owed();
  await assert.rejects(
    () => asUser(OFFICE, c => c.query(
      `INSERT INTO receipts (id, demand_id, receipt_no, mode, reference, received_on, issued_by)
       VALUES ('rc-forged', $1, 'RC/FORGE/01', 'cash', 'x', current_date, 'u-office')`, [dm.id])),
    /permission denied|policy/i,
    'plint_app can insert a receipt without going through receipt_issue');
});

test('a receipt is not edited and not deleted, by anybody', async () => {
  const one = (await rows(OFFICE, 'SELECT id FROM receipts LIMIT 1'))[0];
  assert.ok(one, 'no receipt exists to test with');
  await assert.rejects(
    () => asUser(OFFICE, c => c.query(
      `UPDATE receipts SET reference = 'changed' WHERE id = $1`, [one.id])),
    /permission denied|not edited/i, 'a receipt can be edited');
  await assert.rejects(
    () => asUser(OFFICE, c => c.query('DELETE FROM receipts WHERE id = $1', [one.id])),
    /permission denied|not edited/i, 'a receipt can be deleted');
});

// ------------------------------------------------------------- who may issue

test('only the head office records a payment', async () => {
  const dm = await owed();
  for (const role of ['buyer', 'engineer']) {
    const r = await post('/office/receipt', role,
      { demand: dm.id, mode: 'neft', reference: 'UTR-FORGED', received: today() });
    assert.notStrictEqual(r.status, 302,
      role + ' was allowed through the route that records money');
  }
  /* And the function behind it refuses the same thing, because one of the two
     will be edited one day. */
  await assert.rejects(
    () => asUser(ENGINEER, c => c.query(
      'SELECT receipt_issue($1,$2,$3,$4::date)', [dm.id, 'neft', 'UTR-FORGED', today()])),
    /only the head office/i, 'the engineer can issue a receipt in the database');
  const still = await rows(OFFICE, 'SELECT paid_at FROM demands WHERE id = $1', [dm.id]);
  assert.strictEqual(still[0].paid_at, null, 'the demand was settled by a refused attempt');
});

test('what it refuses, rather than allowing with a warning', async () => {
  const dm = await owed();
  const cases = [
    [{ mode: 'neft', reference: '   ', received: today() }, /reference/i],
    [{ mode: 'neft', reference: 'UTR1', received: '2099-01-01' }, /has not happened/i],
    [{ mode: 'barter', reference: 'UTR1', received: today() }, /not a way money arrives/i],
    [{ mode: 'neft', reference: 'UTR1', received: 'the 9th' }, /not a date/i],
  ];
  for (const [fields, why] of cases) {
    const r = await post('/office/receipt', 'office', { demand: dm.id, ...fields });
    assert.match(r.msg || '', why, JSON.stringify(fields) + ' was not refused');
  }
  const still = await rows(OFFICE, 'SELECT paid_at FROM demands WHERE id = $1', [dm.id]);
  assert.strictEqual(still[0].paid_at, null, 'a refused payment settled the demand anyway');
});

// ------------------------------------------------------------ the one act

test('recording the money settles the demand and issues the receipt, together', async () => {
  const dm = await owed();
  const r = await post('/office/receipt', 'office',
    { demand: dm.id, mode: 'rtgs', reference: 'UTR20260909TEST', received: today() });
  assert.match(r.msg || '', /RC\//, 'no receipt number came back: ' + r.msg);

  const after = (await rows(OFFICE,
    `SELECT dm.paid_at, r.receipt_no, r.mode, r.reference
       FROM demands dm LEFT JOIN receipts r ON r.demand_id = dm.id
      WHERE dm.id = $1`, [dm.id]))[0];
  assert.ok(after.paid_at, 'the demand is not settled');
  assert.ok(after.receipt_no, 'the demand is settled with no receipt against it');
  assert.strictEqual(after.reference, 'UTR20260909TEST');

  /* Both audit rows, because they are two different facts: the money layer
     recorded a settlement, and the office issued a document. */
  const log = await rows(OFFICE,
    `SELECT action, target_id FROM audit_log
      WHERE action IN ('demand_settled','receipt_issued') AND at > now() - interval '2 minutes'`);
  assert.ok(log.some(x => x.action === 'demand_settled' && x.target_id === dm.id),
    'the settlement wrote no audit row');
  assert.ok(log.some(x => x.action === 'receipt_issued'),
    'the receipt wrote no audit row');
});

test('the same demand cannot be paid twice', async () => {
  const paid = (await rows(OFFICE,
    `SELECT id FROM demands WHERE paid_at IS NOT NULL LIMIT 1`))[0];
  const r = await post('/office/receipt', 'office',
    { demand: paid.id, mode: 'cash', reference: 'AGAIN', received: today() });
  assert.match(r.msg || '', /could not be settled|already/i);
  const n = await rows(OFFICE,
    'SELECT count(*)::int n FROM receipts WHERE demand_id = $1', [paid.id]);
  assert.ok(n[0].n <= 1, 'a demand carries two receipts');
});

// -------------------------------------------------------- what the buyer sees

test('the buyer sees their own receipts and nobody else\'s', async () => {
  const money = await get('/money', 'buyer');
  const links = [...money.html.matchAll(/href="\/receipt\/([^"]+)"/g)].map(m => m[1]);
  assert.ok(links.length, 'the buyer is offered no receipt for anything they have paid');

  const one = await get('/receipt/' + links[0], 'buyer');
  assert.strictEqual(one.status, 200);
  assert.match(one.html, /Receipt RC\//, 'the receipt does not name itself');

  /* Every figure on it is the demand's. Not a copy of one - the same row. */
  const dm = (await rows(BUYER,
    `SELECT dm.total_paise, dm.base_paise, dm.gst_paise FROM receipts r
       JOIN demands dm ON dm.id = r.demand_id WHERE r.receipt_no = $1`, [links[0]]))[0];
  for (const p of [dm.total_paise, dm.base_paise, dm.gst_paise]) {
    assert.ok(one.html.includes(M.money(p)),
      'the receipt does not show ' + M.money(p) + ', which is the demand\'s own figure');
  }

  const other = (await rows(OFFICE,
    `SELECT r.receipt_no FROM receipts r
       JOIN demands d ON d.id = r.demand_id
       JOIN unit_stages s ON s.id = d.unit_stage_id
       JOIN units u ON u.id = s.unit_id
      WHERE u.code <> 'B-14' LIMIT 1`))[0].receipt_no;
  assert.strictEqual((await get('/receipt/' + other, 'buyer')).status, 404,
    'a buyer can open a receipt belonging to another villa');
});

test('the buyer\'s own role can read only their own receipt rows', async () => {
  const mine = (await rows(BUYER, 'SELECT count(*)::int n FROM receipts'))[0].n;
  const all = (await rows(OFFICE, 'SELECT count(*)::int n FROM receipts'))[0].n;
  const theirs = (await rows(OFFICE,
    `SELECT count(*)::int n FROM receipts r
       JOIN demands d ON d.id = r.demand_id
       JOIN unit_stages s ON s.id = d.unit_stage_id
       JOIN units u ON u.id = s.unit_id WHERE u.code = 'B-14'`))[0].n;
  assert.strictEqual(mine, theirs, 'the buyer reads a different set of receipts than their own');
  assert.ok(all > mine, 'this database has only one villa with receipts, so this proves nothing');
});

// ------------------------------------------------ the outbox's server half

test('a queued write is answered yes or no, not with a redirect', async () => {
  /* Every one of these four routes must be able to tell the outbox on the
     phone whether the write was taken. A 302 cannot: it looks identical
     whether the stage was marked or refused. */
  const stage = (await rows(ENGINEER,
    `SELECT id FROM unit_stages WHERE status = 'pending' LIMIT 1`))[0];
  const r = await post('/engineer/mark', 'engineer', { id: stage.id },
    { 'x-plint-queued': '1' });
  assert.strictEqual(r.status, 409, 'a refused queued write did not come back as a refusal');
  const j = JSON.parse(r.text);
  assert.strictEqual(j.ok, false);
  assert.match(j.said, /photograph/i, 'the refusal does not say why: ' + j.said);
  assert.ok(j.to, 'the answer does not say which screen to go back to');
});

test('the same write posted by a browser still gets its redirect', async () => {
  const stage = (await rows(ENGINEER,
    `SELECT id FROM unit_stages WHERE status = 'pending' LIMIT 1`))[0];
  const r = await post('/engineer/mark', 'engineer', { id: stage.id });
  assert.strictEqual(r.status, 302, 'an ordinary form post no longer redirects');
  assert.match(r.loc, /^\/engineer\/villas\?m=/);
});

test('a log entry replayed twice is one entry', async () => {
  /* The one of the four that is not naturally idempotent: a photograph's id
     is derived from its content hash and a stage is marked once, but two
     identical log entries are two rows unless the key says otherwise. */
  const key = 'test-' + Date.now();
  const fields = { kind: 'labour', title: 'Replayed entry', detail: 'once', qkey: key };
  for (let i = 0; i < 3; i++) {
    const r = await post('/engineer/log', 'engineer', fields, { 'x-plint-queued': '1' });
    assert.strictEqual(r.status, 200, 'a replay was refused');
    assert.strictEqual(JSON.parse(r.text).ok, true);
  }
  const n = (await rows(ENGINEER,
    `SELECT count(*)::int n FROM site_log WHERE id = $1`, ['log-q-' + key]))[0].n;
  assert.strictEqual(n, 1, 'three replays of one entry wrote ' + n + ' rows');
});

test('a stage already marked by this engineer replays as done, not as refused', async () => {
  const s = (await rows(ENGINEER,
    `SELECT s.id FROM unit_stages s
      WHERE s.status = 'pending'
        AND (SELECT count(*) FROM evidence e WHERE e.unit_stage_id = s.id) > 0
      LIMIT 1`))[0];
  if (!s) return;   // nothing photographed and unmarked on this database
  const first = await post('/engineer/mark', 'engineer', { id: s.id }, { 'x-plint-queued': '1' });
  assert.strictEqual(JSON.parse(first.text).ok, true, 'the first mark did not take');
  const again = await post('/engineer/mark', 'engineer', { id: s.id }, { 'x-plint-queued': '1' });
  const j = JSON.parse(again.text);
  assert.strictEqual(j.ok, true,
    'a replay of a write that landed came back as a refusal: ' + j.said);
  assert.match(j.said, /already/i);
});

test('the outbox script is served, and only to the engineer', async () => {
  for (const [role, want] of [['engineer', true], ['buyer', false], ['office', false]]) {
    const h = (await get(role === 'engineer' ? '/engineer' : role === 'buyer' ? '/journey' : '/office', role)).html;
    assert.strictEqual(/<script src="\/queue\.[a-f0-9]+\.js"/.test(h), want,
      role + (want ? ' is not served the outbox' : ' is served the outbox and has no use for it'));
    assert.strictEqual(/id="outbox"/.test(h), want,
      role + (want ? ' has nowhere to show what is waiting' : ' has an outbox slot'));
  }
});

// ------------------------------------------------- what Plint holds about you

test('the buyer can read an inventory of their own personal data', async () => {
  const h = (await get('/data', 'buyer')).html;
  assert.match(h, /What Plint holds about you/);
  /* Named by table and by column, which is the whole point of the screen. */
  for (const t of ['users', 'units', 'demands', 'receipts', 'evidence', 'visits']) {
    assert.ok(h.includes(t), 'the inventory does not name the table ' + t);
  }
  for (const c of ['buyer_name', 'agreement_value_paise', 'gps', 'receipt_no']) {
    assert.ok(h.includes(c), 'the inventory does not name the column ' + c);
  }
  assert.match(h, /cannot delete anything/i,
    'the inventory does not say what it cannot do');
});

test('the copy a buyer can take away holds no password hash', async () => {
  const r = await fetch(BASE + '/data.json', { headers: { cookie: cookies.buyer } });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /application\/json/);
  assert.match(r.headers.get('cache-control') || '', /no-store/);
  const text = await r.text();
  /* The FIELD, not the word: the file's own note says a password hash is
     never read into it, and a test that searched for the word failed on the
     sentence promising it was absent. */
  assert.ok(!/"pw_hash"/.test(text), 'the export carries the password hash field');
  const o = JSON.parse(text);
  assert.deepStrictEqual(Object.keys(o.you).sort(), ['display_name', 'email', 'id', 'role'],
    'the buyer\'s own user row is exported with more than the four fields it should be');
  assert.strictEqual(o.villa.code, 'B-14', 'the export is not this buyer\'s villa');
  assert.ok(o.demands.length > 0 && o.photographs.length > 0,
    'the export is empty where the screens are not');
  assert.ok(!o.audit, 'the export claims to carry an audit log a buyer cannot read');
});

test('neither the screen nor the file is reachable by another role', async () => {
  for (const role of ['engineer', 'office']) {
    const a = await get('/data', role);
    const b = await get('/data.json', role);
    assert.notStrictEqual(a.status, 200, role + ' can open a buyer data inventory');
    assert.notStrictEqual(b.status, 200, role + ' can download a buyer data file');
  }
});
