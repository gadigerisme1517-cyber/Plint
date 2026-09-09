'use strict';
/* ============================================================================
   Buyer isolation. This runs against the real database as the real application
   role. It is not a mock. Every assertion here is about what Postgres refuses
   to hand back, not about what a route handler remembers to filter.
   ========================================================================= */
const { asUser, pool, login } = require('../src/db');

let pass = 0, fail = 0;
const ok = (cond, what) => { cond ? (pass++, console.log('  pass  ' + what))
                                  : (fail++, console.log('  FAIL  ' + what)); };

const BUYER = { id: 'u-buyer-b14', role: 'buyer' };   // Arjun Nair, villa B-14
const OTHER = { id: 'u-buyer-a07', role: 'buyer' };   // M. Sharma, villa A-07
const ENG   = { id: 'u-eng-ram',   role: 'engineer' };
const OFFICE= { id: 'u-office',    role: 'office' };
const NOBODY = null;

(async () => {
  console.log('\nbuyer isolation');

  const mine = await asUser(BUYER, c => c.query('SELECT code FROM units'));
  ok(mine.rows.length === 1 && mine.rows[0].code === 'B-14',
     'a buyer selecting all units gets exactly his own (' + mine.rows.map(r => r.code) + ')');

  const named = await asUser(BUYER, c =>
    c.query(`SELECT code FROM units WHERE code = 'A-07'`));
  ok(named.rows.length === 0, 'naming another villa directly returns nothing');

  const stages = await asUser(BUYER, c =>
    c.query(`SELECT id FROM unit_stages WHERE unit_id = 'unit-A-07'`));
  ok(stages.rows.length === 0, "another villa's stages are invisible");

  const ev = await asUser(BUYER, c =>
    c.query(`SELECT id FROM evidence WHERE unit_stage_id LIKE 'us-A-07-%'`));
  ok(ev.rows.length === 0, "another villa's evidence photographs are invisible");

  const dm = await asUser(BUYER, c =>
    c.query(`SELECT id FROM demands WHERE unit_stage_id LIKE 'us-A-07-%'`));
  ok(dm.rows.length === 0, "another villa's demand letters are invisible");

  const cnt = await asUser(BUYER, c => c.query('SELECT count(*)::int n FROM demands'));
  const own = await asUser(BUYER, c =>
    c.query(`SELECT count(*)::int n FROM demands d JOIN unit_stages s ON s.id=d.unit_stage_id
             WHERE s.unit_id='unit-B-14'`));
  ok(cnt.rows[0].n === own.rows[0].n && cnt.rows[0].n > 0,
     'an unfiltered count of demands equals his own demands only (' + cnt.rows[0].n + ')');

  const agg = await asUser(BUYER, c =>
    c.query('SELECT coalesce(sum(total_paise),0)::bigint s FROM demands'));
  ok(BigInt(agg.rows[0].s) === BigInt(
      (await asUser(OFFICE, c => c.query(
        `SELECT coalesce(sum(total_paise),0)::bigint s FROM demands d
           JOIN unit_stages t ON t.id=d.unit_stage_id WHERE t.unit_id='unit-B-14'`))).rows[0].s),
     'aggregates cannot be used to total the whole project');

  const other = await asUser(OTHER, c => c.query('SELECT code FROM units'));
  ok(other.rows.length === 1 && other.rows[0].code === 'A-07',
     'the neighbouring buyer sees only A-07, and the isolation is symmetric');

  const users = await asUser(BUYER, c => c.query('SELECT id FROM users'));
  ok(users.rows.length === 1 && users.rows[0].id === BUYER.id,
     'a buyer cannot enumerate other people');

  console.log('\nwrites');

  const upd = await asUser(BUYER, c =>
    c.query(`UPDATE unit_stages SET status='certified' WHERE unit_id='unit-B-14' RETURNING id`));
  ok(upd.rowCount === 0, 'a buyer cannot certify his own stage');

  let insBlocked = false;
  try {
    await asUser(BUYER, c => c.query(
      `INSERT INTO evidence VALUES ('ev-x','us-B-14-brick','forged',now(),'0,0','x')`));
  } catch (e) { insBlocked = /row-level security/i.test(e.message); }
  ok(insBlocked, 'a buyer cannot insert evidence');

  let dmBlocked = false;
  try {
    await asUser(BUYER, c => c.query(
      `INSERT INTO demands VALUES ('dm-x','us-B-14-plast','X',now(),now(),1,1,0,2,null)`));
  } catch (e) { dmBlocked = /row-level security/i.test(e.message); }
  ok(dmBlocked, 'a buyer cannot raise his own demand');

  console.log('\nsession handling');

  const none = await asUser(NOBODY, c => c.query('SELECT count(*)::int n FROM units'));
  ok(none.rows[0].n === 0, 'a request with no identity sees nothing at all');

  // The identity is transaction-local. Two sequential requests on the same
  // pooled connection must not bleed into one another.
  await asUser(OFFICE, c => c.query('SELECT 1'));
  const afterOffice = await asUser(BUYER, c => c.query('SELECT count(*)::int n FROM units'));
  ok(afterOffice.rows[0].n === 1,
     'identity does not leak across pooled connections after a staff request');

  const leak = await asUser(NOBODY, c => c.query('SELECT count(*)::int n FROM units'));
  ok(leak.rows[0].n === 0, 'and the connection returns to seeing nothing');

  console.log('\nstaff');
  const all = await asUser(ENG, c => c.query('SELECT count(*)::int n FROM units'));
  ok(all.rows[0].n === 48, 'the certifying engineer sees all 48 villas');
  /* Head office is not partitioned, so it sees the whole worklist. The count
     is stated as "every villa has one", not as a seed constant: a villa can
     have more than one stage blocked at once, and the seed now carries two
     that do, so a bare `= 48` would be asserting the seed rather than the
     isolation. What matters here is that no villa is hidden from the office
     and that the buyer sees none of it. */
  const ho = await asUser(OFFICE, c => c.query(
    `SELECT count(*)::int n, count(DISTINCT s.unit_id)::int villas
       FROM blockers b JOIN unit_stages s ON s.id = b.unit_stage_id`));
  ok(ho.rows[0].villas === 48 && ho.rows[0].n >= 48,
     'head office sees a blocker on every villa (' + ho.rows[0].n + ' over '
     + ho.rows[0].villas + ' villas)');
  const buyerBlockers = await asUser(BUYER, c => c.query('SELECT count(*)::int n FROM blockers'));
  ok(buyerBlockers.rows[0].n === 0, 'a buyer cannot see the internal worklist');

  console.log('\nprivilege');
  const su = await asUser(OFFICE, c =>
    c.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
  ok(su.rows[0].rolsuper === false && su.rows[0].rolbypassrls === false,
     'the application role is neither superuser nor BYPASSRLS');
  const owner = await asUser(OFFICE, c =>
    c.query(`SELECT tableowner FROM pg_tables WHERE tablename='units'`));
  ok(owner.rows[0].tableowner !== 'plint_app',
     'the application role does not own the tables, so FORCE RLS holds');

  console.log('\nlogins');
  ok(!!(await login('arjun@example.in', 'plint')), 'buyer login works');
  ok(!!(await login('ramachandran@nvt.in', 'plint')), 'engineer login works');
  ok(!!(await login('priya@nvt.in', 'plint')), 'office login works');
  ok(!(await login('arjun@example.in', 'wrong')), 'a wrong password fails');

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
