'use strict';
/* ============================================================================
   Fills the tables migrations 011 and 012 added, on a database that was
   already seeded before those migrations existed.

   The deployed demo is one of those. `db/seed.js` runs once, on an empty
   database, and refuses thereafter - correctly, because re-running it would
   duplicate 48 villas. So the live project would have gained sixteen empty
   tables and every new screen would have rendered a blank worklist, which
   looks exactly like a broken screen.

   This is the same seedState() the full seed calls, given villa descriptors
   rebuilt from the database rather than from seed.js's generators. It writes
   only when `lenders` is empty, so running it twice is a no-op.
   ========================================================================= */
const { Client } = require('pg');
const config = require('../src/config');
const { hash } = require('../src/db');
const { seedState } = require('./seed-state');

/* v21 names three people on site and only one of them may sign a certificate.
   They were added to db/seed.js, which never runs again on a seeded database -
   so the deployed demo had exactly one engineer, and "reassign this villa" had
   nowhere to move work to. The office screen offered a select with no options
   and the write returned "could not be reassigned".

   Found by running the flow against the live URL, which is the only place it
   was ever going to show. Idempotent and gated on its own absence, separately
   from the tables below, because a database can need one and not the other. */
const STAFF = [
  ['u-eng-suresh', 'suresh@nvt.in',    'engineer', 'Suresh Kumar', 'Site supervisor', null],
  ['u-eng-venkat', 'venkatesh@nvt.in', 'engineer', 'A. Venkatesh', 'B.E. Civil', 'KAR/CE/2019/3311'],
];

async function ensureStaff(c) {
  const added = [];
  for (const [id, email, role, name, qual, reg] of STAFF) {
    const r = await c.query(
      `INSERT INTO users VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id, email, hash('plint'), role, name, qual, reg]);
    if (r.rowCount) added.push(name);
  }

  /* If every villa sits with one person, the round robin ran when there was
     only one engineer to run it over. Spread them now. Guarded on the
     degenerate case so it can never undo a real reassignment somebody made. */
  const spread = (await c.query(
    `SELECT count(DISTINCT assigned_engineer_id)::int n FROM units
      WHERE assigned_engineer_id IS NOT NULL`)).rows[0].n;
  const engineers = (await c.query(
    `SELECT id FROM users WHERE role = 'engineer' ORDER BY id`)).rows.map(r => r.id);
  let spreadOver = 0;
  if (spread <= 1 && engineers.length > 1) {
    const units = (await c.query('SELECT id FROM units ORDER BY code')).rows;
    for (let i = 0; i < units.length; i++) {
      await c.query('UPDATE units SET assigned_engineer_id = $1 WHERE id = $2',
        [engineers[i % engineers.length], units[i].id]);
    }
    spreadOver = engineers.length;
  }
  return { added, spreadOver };
}

async function topUp(c) {
  const staff = await ensureStaff(c);

  const already = (await c.query('SELECT count(*)::int n FROM lenders')).rows[0].n;
  if (already > 0) {
    return { skipped: 'lenders already present (' + already + ')', staff };
  }

  const units = (await c.query('SELECT count(*)::int n FROM units')).rows[0].n;
  if (units === 0) return { skipped: 'no units: the full seed has not run' };

  /* The same descriptor shape seedState() takes from seed.js, rebuilt from
     what is on disk. `packSt` and `packAge` drive the lender-query rows, and
     both are recorded already - the delivery state, and how long the blocker
     on that stage has been sitting. */
  const villas = (await c.query(`
    SELECT u.code,
           u.bank,
           u.buyer_name AS buyer,
           COALESCE(
             (SELECT CASE pd.state
                       WHEN 'queued'    THEN 'Not sent'
                       WHEN 'sending'   THEN 'Awaiting'
                       WHEN 'delivered' THEN 'Disbursed'
                       WHEN 'failed'    THEN 'Query'
                       ELSE 'Not sent' END
                FROM pack_deliveries pd
                JOIN unit_stages s ON s.id = pd.unit_stage_id
               WHERE s.unit_id = u.id
               ORDER BY pd.queued_at DESC LIMIT 1), 'Not sent') AS "packSt",
           COALESCE(
             (SELECT GREATEST(1, (EXTRACT(epoch FROM now() - b.since) / 86400)::int)
                FROM blockers b
                JOIN unit_stages s ON s.id = b.unit_stage_id
               WHERE s.unit_id = u.id
               ORDER BY b.since ASC LIMIT 1), 7) AS "packAge"
      FROM units u
     ORDER BY u.code`)).rows;

  const engineers = (await c.query(
    `SELECT id FROM users WHERE role = 'engineer' ORDER BY id`)).rows.map(r => r.id);
  if (!engineers.length) return { skipped: 'no engineers on file' };

  await seedState(c, villas, engineers);
  return { filled: villas.length + ' villas, ' + engineers.length + ' engineers' };
}

async function main() {
  const c = new Client(config.adminDb());
  await c.connect();
  await c.query('SET search_path = plint, public');
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('plint.user_id','u-office',true),
                          set_config('plint.role','office',true)`);
    const out = await topUp(c);
    await c.query('COMMIT');
    const staff = out.staff || {};
    if (staff.added && staff.added.length) console.log('  staff added: ' + staff.added.join(', '));
    if (staff.spreadOver) console.log('  villas spread over ' + staff.spreadOver + ' engineers');
    console.log('state top-up: ' + (out.skipped ? 'skipped, ' + out.skipped : 'filled ' + out.filled));
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { topUp };
