'use strict';
/* ============================================================================
   The state top-up: filling migrations 011 and 012 on a database that was
   seeded before they existed.

   The deployed demo is exactly that database. `db/seed.js` runs once, on an
   empty database, and refuses afterwards - so without this the live project
   would have gained sixteen empty tables and every new screen would have drawn
   a blank worklist, which on screen is indistinguishable from a broken one.

   Everything here happens inside a transaction that is rolled back, so the
   suite leaves the database exactly as it found it.
   ========================================================================= */
const { test, after } = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const config = require('../src/config');
const { topUp } = require('../db/seed-state-topup');

/** The tables the top-up is responsible for, child rows first. */
const FILLED = ['loan_documents', 'loan_applicants', 'query_messages', 'queries',
                'visits', 'snags', 'site_log', 'handoffs', 'pack_queries',
                'escrow_movements', 'qpr_filings', 'notifications', 'choices',
                'agreements', 'possessions', 'lenders'];

async function withRollback(fn) {
  const c = new Client(config.adminDb());
  await c.connect();
  await c.query('SET search_path = plint, public');
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('plint.user_id','u-office',true),
                          set_config('plint.role','office',true)`);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}

const counts = async c => {
  const out = {};
  for (const t of FILLED) out[t] = (await c.query('SELECT count(*)::int n FROM ' + t)).rows[0].n;
  return out;
};

test('on an already-filled database it does nothing', async () => {
  await withRollback(async c => {
    const before = await counts(c);
    const r = await topUp(c);
    assert.match(r.skipped || '', /already present/,
      'the top-up ran a second time and would have duplicated every row');
    assert.deepStrictEqual(await counts(c), before);
  });
});

test('it puts the missing site staff on a database that predates them', async () => {
  /* The deployed demo had exactly one engineer: Suresh and Venkatesh were
     added to db/seed.js, which never runs again once villas exist. So the
     office's reassign control offered a select with no options and the write
     answered "could not be reassigned" - a control that did nothing, on the
     one flow that screen exists for. Found by running it against the live URL,
     which is the only place it could have shown. */
  await withRollback(async c => {
    /* Wind the database back to before those two existed. Everything that
       points at them moves to the one engineer who did, which is the state a
       database seeded before they were added is actually in. */
    const GONE = ['u-eng-suresh', 'u-eng-venkat'];
    await c.query(`UPDATE units SET assigned_engineer_id = 'u-eng-ram'`);
    await c.query(`UPDATE visits SET engineer_id = 'u-eng-ram' WHERE engineer_id = ANY($1)`, [GONE]);
    await c.query(`UPDATE site_log SET logged_by = 'u-eng-ram' WHERE logged_by = ANY($1)`, [GONE]);
    await c.query(`UPDATE snags SET fixed_by = 'u-eng-ram' WHERE fixed_by = ANY($1)`, [GONE]);
    await c.query(`DELETE FROM sessions WHERE user_id = ANY($1)`, [GONE]);
    await c.query(`DELETE FROM users WHERE id = ANY($1)`, [GONE]);

    const before = (await c.query(
      `SELECT count(*)::int n FROM users WHERE role = 'engineer'`)).rows[0].n;
    assert.strictEqual(before, 1, 'the setup did not leave a single engineer');

    const r = await topUp(c);
    assert.ok(r.staff.added.length === 2, 'the missing engineers were not added: '
      + JSON.stringify(r.staff));

    const after = (await c.query(
      `SELECT count(*)::int n FROM users WHERE role = 'engineer'`)).rows[0].n;
    assert.ok(after >= 3, 'only ' + after + ' engineers after the top-up');

    // Reassignment is meaningless unless work sits with more than one of them.
    const spread = (await c.query(
      `SELECT count(DISTINCT assigned_engineer_id)::int n FROM units`)).rows[0].n;
    assert.ok(spread > 1, 'every villa is still with one engineer, so nothing can be reassigned');

    // Exactly one of them may sign: v21's supervisor is not a qualified engineer.
    const signers = (await c.query(
      `SELECT display_name FROM users WHERE role = 'engineer' AND engineer_reg IS NULL`)).rows;
    assert.ok(signers.some(s => s.display_name === 'Suresh Kumar'),
      'the site supervisor was given a registration he does not have');
  });
});

test('it does not undo a reassignment somebody made', async () => {
  /* The spread only fires on the degenerate case - every villa with one
     person, which only happens when the round robin ran with one engineer to
     run it over. If the office has moved work about, that is a decision. */
  await withRollback(async c => {
    const two = (await c.query(
      `SELECT id FROM users WHERE role = 'engineer' ORDER BY id LIMIT 2`)).rows;
    assert.strictEqual(two.length, 2, 'need two engineers for this test');
    await c.query(`UPDATE units SET assigned_engineer_id = $1`, [two[0].id]);
    await c.query(`UPDATE units SET assigned_engineer_id = $1 WHERE code = 'B-14'`, [two[1].id]);

    const r = await topUp(c);
    assert.strictEqual(r.staff.spreadOver, 0, 'the top-up redistributed villas it should have left alone');

    const b14 = (await c.query(
      `SELECT assigned_engineer_id a FROM units WHERE code = 'B-14'`)).rows[0].a;
    assert.strictEqual(b14, two[1].id, 'B-14 was moved off the engineer it was assigned to');
  });
});

test('it fills every table from the database alone', async () => {
  await withRollback(async c => {
    // units references lenders, so the columns 011 and 012 added come off
    // first. Clearing them also makes the reconstruction genuinely come from
    // the older data rather than from leftovers.
    await c.query(`UPDATE units SET assigned_engineer_id = NULL,
                     lender_id = NULL, outside_lender = NULL,
                     lender_chosen_at = NULL, lender_chosen_by = NULL`);
    for (const t of FILLED) await c.query('DELETE FROM ' + t);
    const emptied = await counts(c);
    assert.ok(Object.values(emptied).every(n => n === 0), 'the tables did not empty');

    const r = await topUp(c);
    assert.ok(r.filled, 'the top-up skipped a database that needed it: ' + JSON.stringify(r));
    assert.match(r.filled, /48 villas/, 'it did not see all 48 villas: ' + r.filled);

    const after = await counts(c);
    for (const t of ['lenders', 'loan_applicants', 'loan_documents', 'agreements',
                     'choices', 'visits', 'queries', 'query_messages', 'snags',
                     'site_log', 'handoffs', 'escrow_movements', 'qpr_filings',
                     'notifications']) {
      assert.ok(after[t] > 0, t + ' is still empty after the top-up');
    }

    // The reconstruction has to put an engineer on every villa, or "my work"
    // is empty for everyone and reassignment has nothing to move.
    const un = (await c.query(
      `SELECT count(*)::int total, count(assigned_engineer_id)::int assigned FROM units`)).rows[0];
    assert.strictEqual(un.assigned, un.total, 'villas left with no engineer');

    // And a lender on every villa that has a bank, since that is what the
    // buyer's loan screen and the office's sanction list both read.
    const ln = (await c.query(
      `SELECT count(*) FILTER (WHERE bank IS NOT NULL)::int with_bank,
              count(lender_id)::int matched FROM units`)).rows[0];
    assert.strictEqual(ln.matched, ln.with_bank,
      ln.with_bank - ln.matched + ' villas have a bank name that matched no lender row');
  });
});

test('it refuses a database with no villas rather than seeding a void', async () => {
  /* Against a genuinely fresh database, which is the case the guard is for: a
     first deploy where migrations have run and the full seed has not.

     It cannot be faked by emptying this one. Deleting the villas means
     deleting their demands, and `an issued demand is not deleted` stops that -
     the money layer refusing to be unwound, which is the behaviour every other
     suite is there to protect. */
  const name = 'plint_topup_' + crypto.randomBytes(4).toString('hex');
  const admin = new Client(config.adminDb({ database: 'postgres' }));
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" OWNER "${process.env.PGADMINUSER}"`);
  try {
    execFileSync(process.execPath, ['db/migrate.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PGDATABASE: name, PLINT_LOG: 'silent' },
      stdio: 'pipe',
    });
    const c = new Client(config.adminDb({ database: name }));
    await c.connect();
    await c.query('SET search_path = plint, public');
    try {
      const units = (await c.query('SELECT count(*)::int n FROM units')).rows[0].n;
      assert.strictEqual(units, 0, 'the fresh database is not empty');
      const r = await topUp(c);
      assert.match(r.skipped || '', /no units/, 'it seeded state against no villas');
    } finally { await c.end(); }
  } finally {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  }
});
