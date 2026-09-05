'use strict';
/* ============================================================================
   Demands are immutable, and every act leaves a row.

   These run as the real application role against the real database, in the
   same spirit as isolation.test.js: the question is what Postgres refuses,
   not what a route handler remembers.
   ========================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');

const { asUser, pool } = require('../src/db');
const config = require('../src/config');
const AUDIT = require('../src/audit');

const ENG    = { id: 'u-eng-ram', role: 'engineer' };
const OFFICE = { id: 'u-office',  role: 'office' };
const BUYER  = { id: 'u-buyer-b14', role: 'buyer' };

const PORT = 3161, BASE = 'http://127.0.0.1:' + PORT;
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

// --------------------------------------------------------------- immutability

test('a direct UPDATE of total_paise as the application role does not land', async () => {
  const before = await asUser(OFFICE, c =>
    c.query('SELECT total_paise FROM demands ORDER BY id LIMIT 1'));
  const id = (await asUser(OFFICE, c =>
    c.query('SELECT id FROM demands ORDER BY id LIMIT 1'))).rows[0].id;

  let raised = null, rowsHit = null;
  try {
    const r = await asUser(OFFICE, c =>
      c.query('UPDATE demands SET total_paise = 1 WHERE id = $1', [id]));
    rowsHit = r.rowCount;
  } catch (e) { raised = e.message; }

  assert.ok(raised !== null || rowsHit === 0,
    'the update either raises or affects zero rows; it did neither');
  if (raised) assert.match(raised, /permission denied/i);

  const after = await asUser(OFFICE, c =>
    c.query('SELECT total_paise FROM demands ORDER BY id LIMIT 1'));
  assert.strictEqual(after.rows[0].total_paise, before.rows[0].total_paise,
    'and the figure is unchanged');
});

test('the money columns are refused even to the owning role', async () => {
  // The grant keeps the application out. This is the second lock, which holds
  // for a superuser too: no privilege level makes an issued demand editable.
  const admin = new Client(config.adminDb());
  await admin.connect();
  try {
    const id = (await admin.query('SELECT id FROM plint.demands ORDER BY id LIMIT 1')).rows[0].id;
    await assert.rejects(
      () => admin.query('UPDATE plint.demands SET total_paise = 1 WHERE id = $1', [id]),
      /immutable once issued/,
      'the trigger refuses');
    await assert.rejects(
      () => admin.query('DELETE FROM plint.demands WHERE id = $1', [id]),
      /not deleted/);
  } finally { await admin.end(); }
});

test('unpaid to paid is the one transition, and it happens once', async () => {
  const open = (await asUser(OFFICE, c =>
    c.query(`SELECT id, total_paise FROM demands WHERE paid_at IS NULL ORDER BY id LIMIT 1`))).rows[0];
  assert.ok(open, 'an unpaid demand to work with');

  const first = await asUser(OFFICE, c =>
    c.query('SELECT demand_settle($1,$2) ok', [open.id, 'NEFT/TEST/1']));
  assert.strictEqual(first.rows[0].ok, true, 'settles');

  const again = await asUser(OFFICE, c =>
    c.query('SELECT demand_settle($1,$2) ok', [open.id, 'NEFT/TEST/2']));
  assert.strictEqual(again.rows[0].ok, false, 'and cannot be settled twice');

  const row = await asUser(OFFICE, c =>
    c.query('SELECT paid_at, total_paise FROM demands WHERE id=$1', [open.id]));
  assert.ok(row.rows[0].paid_at, 'paid_at is set');
  assert.strictEqual(row.rows[0].total_paise, open.total_paise,
    'and settling did not move the money');

  const log = await asUser(OFFICE, c => AUDIT.of(c, 'demand', open.id));
  const settled = log.filter(r => r.action === 'demand_settled');
  assert.strictEqual(settled.length, 1, 'exactly one settlement row');
  assert.strictEqual(Number(settled[0].figures.total_paise), open.total_paise,
    'carrying the figures as at that moment');
  assert.strictEqual(settled[0].actor_id, OFFICE.id);
});

test('a buyer cannot settle his own demand', async () => {
  const open = (await asUser(OFFICE, c =>
    c.query(`SELECT id FROM demands WHERE paid_at IS NULL ORDER BY id LIMIT 1`))).rows[0];
  await assert.rejects(
    () => asUser(BUYER, c => c.query('SELECT demand_settle($1)', [open.id])),
    /only an identified engineer or head office/);
});

// --------------------------------------------------------------- audit trail

test('certifying a stage writes exactly one audit row', async () => {
  const eng = await signIn('ramachandran@nvt.in');

  // A stage that is marked on site, has enough photographs, and is not B-14
  // (which other suites certify).
  const target = (await asUser(ENG, c => c.query(
    `SELECT s.id FROM unit_stages s
      WHERE s.status='marked' AND s.unit_id <> 'unit-B-14'
        AND (SELECT count(*) FROM evidence e WHERE e.unit_stage_id = s.id) >= 2
      ORDER BY s.id LIMIT 1`))).rows[0];
  assert.ok(target, 'a certifiable stage exists');

  const before = await asUser(ENG, c => AUDIT.of(c, 'unit_stage', target.id));
  assert.strictEqual(before.length, 0, 'nothing recorded against it yet');

  const r = await fetch(BASE + '/engineer/certify', {
    method: 'POST', redirect: 'manual',
    headers: { cookie: eng, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id: target.id }),
  });
  assert.strictEqual(r.status, 302);
  assert.match(decodeURIComponent(r.headers.get('location')), /certified/);

  const after = await asUser(ENG, c => AUDIT.of(c, 'unit_stage', target.id));
  assert.strictEqual(after.length, 1, 'exactly one audit row for the act');

  const row = after[0];
  assert.strictEqual(row.action, 'certified');
  assert.strictEqual(row.actor_id, ENG.id);
  assert.strictEqual(row.actor_role, 'engineer');

  // The figures as at that moment, matching the demand the act created.
  const d = (await asUser(ENG, c =>
    c.query('SELECT * FROM demands WHERE unit_stage_id=$1', [target.id]))).rows[0];
  assert.ok(d, 'the act raised a demand');
  assert.strictEqual(Number(row.figures.total_paise), d.total_paise);
  assert.strictEqual(Number(row.figures.base_paise), d.base_paise);
  assert.strictEqual(Number(row.figures.gst_paise), d.gst_paise);
  assert.strictEqual(row.figures.doc_no, d.doc_no);
  assert.ok(row.figures.certificate_hash, 'and the certificate hash it signed');
});

test('the application role cannot amend or remove an audit row', async () => {
  const row = (await asUser(ENG, c =>
    c.query('SELECT id FROM audit_log ORDER BY id LIMIT 1'))).rows[0];
  assert.ok(row, 'a row to attack');

  let updRaised = null, updRows = null;
  try {
    const r = await asUser(ENG, c =>
      c.query(`UPDATE audit_log SET action='tampered' WHERE id=$1`, [row.id]));
    updRows = r.rowCount;
  } catch (e) { updRaised = e.message; }
  assert.ok(updRaised !== null || updRows === 0, 'UPDATE does not land');
  if (updRaised) assert.match(updRaised, /permission denied|append-only/i);

  let delRaised = null, delRows = null;
  try {
    const r = await asUser(ENG, c => c.query('DELETE FROM audit_log WHERE id=$1', [row.id]));
    delRows = r.rowCount;
  } catch (e) { delRaised = e.message; }
  assert.ok(delRaised !== null || delRows === 0, 'DELETE does not land');
});

test('history cannot be rewritten by the owning role either', async () => {
  const admin = new Client(config.adminDb());
  await admin.connect();
  try {
    const id = (await admin.query('SELECT id FROM plint.audit_log ORDER BY id LIMIT 1')).rows[0].id;
    await assert.rejects(
      () => admin.query(`UPDATE plint.audit_log SET action='tampered' WHERE id=$1`, [id]),
      /append-only/);
    await assert.rejects(
      () => admin.query('DELETE FROM plint.audit_log WHERE id=$1', [id]),
      /append-only/);
  } finally { await admin.end(); }
});

test('an actor cannot write an audit row in another name', async () => {
  await assert.rejects(
    () => asUser(ENG, c => c.query(
      `INSERT INTO audit_log (actor_id, actor_role, action, target_kind, target_id)
       VALUES ('u-office','office','forged','unit_stage','us-B-14-brick')`)),
    /row-level security/i);
});

test('a buyer cannot read the audit log at all', async () => {
  const r = await asUser(BUYER, c => c.query('SELECT count(*)::int n FROM audit_log'));
  assert.strictEqual(r.rows[0].n, 0);
});

test('a correction is a credit row, and it is insert-only', async () => {
  const d = (await asUser(OFFICE, c =>
    c.query('SELECT id FROM demands ORDER BY id LIMIT 1'))).rows[0];

  // A fresh id each run: a credit cannot be cleaned up afterwards, which is
  // the property under test.
  const id = 'cr-test-' + require('crypto').randomBytes(8).toString('hex');

  await asUser(OFFICE, c => c.query(
    `INSERT INTO credits (id, demand_id, amount_paise, reason, raised_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, d.id, 100000, 'Measurement corrected after re-survey', OFFICE.id]));

  const back = await asUser(OFFICE, c =>
    c.query('SELECT * FROM credits WHERE id=$1', [id]));
  assert.strictEqual(back.rows.length, 1);
  assert.strictEqual(back.rows[0].amount_paise, 100000);

  let raised = null, hit = null;
  try {
    const r = await asUser(OFFICE, c =>
      c.query(`UPDATE credits SET amount_paise=1 WHERE id=$1`, [id]));
    hit = r.rowCount;
  } catch (e) { raised = e.message; }
  assert.ok(raised !== null || hit === 0, 'a credit cannot be edited either');

  await asUser(OFFICE, c => c.query('DELETE FROM credits WHERE id=$1', [id]))
    .then(r => assert.strictEqual(r.rowCount, 0, 'nor deleted'))
    .catch(e => assert.match(e.message, /permission denied/i));
});
