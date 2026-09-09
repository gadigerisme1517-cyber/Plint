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

/* TWO THINGS PASS 6 ADDED THAT A DATABASE SEEDED BEFORE IT WILL NOT HAVE.

   Both are gated on their own absence, separately from the tables below,
   because a database can need one and not the other - and the deployed demo
   needs exactly these two and none of the rest. */
async function ensurePass6(c) {
  const out = [];

  /* A rate nobody quoted. Off the panel there is no quote, and the buyer's
     bank screen was printing 9.00 per cent against six lenders that had said
     nothing at all. Migration 016 lets the column be null; this empties the
     figures that are already there. */
  const fake = await c.query(
    `UPDATE lenders SET rate_bp = NULL WHERE on_panel = false AND rate_bp IS NOT NULL`);
  if (fake.rowCount) out.push(fake.rowCount + ' off-panel rates cleared');

  /* A receipt for every demand this history shows as settled. Without it a
     demo that has taken money for five stages shows the buyer no receipt for
     any of them, and the office's Payments in screen is empty. Same derivation
     as db/seed.js, so a database seeded fresh and one topped up here carry the
     same numbers. */
  const settled = (await c.query(
    `SELECT dm.id, dm.paid_at, u.code,
            (SELECT count(*)::int FROM demands d2
               JOIN unit_stages s2 ON s2.id = d2.unit_stage_id
              WHERE s2.unit_id = u.id AND d2.raised_at <= dm.raised_at) seq
       FROM demands dm
       JOIN unit_stages s ON s.id = dm.unit_stage_id
       JOIN units u ON u.id = s.unit_id
      WHERE dm.paid_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.demand_id = dm.id)
      ORDER BY u.code, dm.raised_at`)).rows;
  const MODES = ['neft', 'rtgs', 'imps', 'cheque', 'upi'];
  for (const d of settled) {
    const i = d.seq - 1;
    const mode = MODES[i % MODES.length];
    const flat = d.code.replace('-', '');
    const day = new Date(d.paid_at).toISOString().slice(0, 10).replace(/-/g, '');
    const ref = mode === 'cheque'
      ? 'Cheque 4' + String(10000 + i * 37 + d.code.charCodeAt(2)).slice(0, 5)
      : mode === 'upi' ? flat.toLowerCase() + '@okhdfcbank ' + day
      : 'UTR' + day + flat + String(d.seq).padStart(2, '0');
    await c.query(
      `INSERT INTO receipts (id, demand_id, receipt_no, mode, reference,
                             received_on, issued_by, issued_at)
       VALUES ($1,$2,$3,$4,$5,$6,'u-office',$7) ON CONFLICT DO NOTHING`,
      ['rc-' + d.id, d.id, 'RC/' + flat + '/' + String(d.seq).padStart(2, '0'),
       mode, ref, d.paid_at, d.paid_at]);
  }
  if (settled.length) out.push(settled.length + ' receipts written');

  /* A visit is a day, not a minute. The server writes ten in the morning IST
     and the engineer's list prints the time, but rows seeded before that was
     true carry whatever minute the seed happened to run at - the deployed
     demo was offering buyers a site visit at 8:44 in the morning. Idempotent:
     a slot already at ten o'clock is not touched. */
  const slots = await c.query(
    `UPDATE visits SET slot_at = (date_trunc('day', slot_at AT TIME ZONE 'Asia/Kolkata')
                                  + interval '10 hours') AT TIME ZONE 'Asia/Kolkata'
      WHERE slot_at <> (date_trunc('day', slot_at AT TIME ZONE 'Asia/Kolkata')
                        + interval '10 hours') AT TIME ZONE 'Asia/Kolkata'`);
  if (slots.rowCount) out.push(slots.rowCount + ' visit slots moved to ten in the morning');
  return out;
}

async function topUp(c) {
  const staff = await ensureStaff(c);
  const pass6 = await ensurePass6(c);

  const already = (await c.query('SELECT count(*)::int n FROM lenders')).rows[0].n;
  if (already > 0) {
    return { skipped: 'lenders already present (' + already + ')', staff, pass6 };
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
  return { filled: villas.length + ' villas, ' + engineers.length + ' engineers', pass6 };
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
    (out.pass6 || []).forEach(line => console.log('  ' + line));
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
