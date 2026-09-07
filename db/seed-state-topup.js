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
const { seedState } = require('./seed-state');

async function topUp(c) {
  const already = (await c.query('SELECT count(*)::int n FROM lenders')).rows[0].n;
  if (already > 0) return { skipped: 'lenders already present (' + already + ')' };

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
