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

/* ----------------------------------------------------------------- pass 8

   THREE THINGS PASS 8 BUILT THAT A DATABASE SEEDED BEFORE IT WOULD SHOW EMPTY.

   The migrations create the tables and the policies; they cannot create demo
   rows, because on a fresh database they run before there is a project or a
   user to hang one off. So the deployed demo would have got the plans screen
   with one registration on it and nothing else, "What it is built to" blank on
   every villa, a price list where every option reads "included", and the new
   notification reader opening empty on two of the three roles.

   Every insert here is keyed on a fixed id and does nothing on a second run.
   ========================================================================= */
async function ensurePass8(c) {
  const out = [];
  const { CHOICE_SET } = require('./seed-state');

  // --------------------------------------------------- the plans themselves
  const project = (await c.query(
    `SELECT id FROM projects ORDER BY id LIMIT 1`)).rows[0];
  const office = (await c.query(
    `SELECT id FROM users WHERE role = 'office' ORDER BY id LIMIT 1`)).rows[0];
  /* Guarded on the kind rather than on the id: `db/seed.js` writes these with
     ids of its own, and a database that has been through the full seed must
     not get a second copy of a floor plan under a different key. */
  const havePlans = project && (await c.query(
    `SELECT count(*)::int n FROM project_documents
      WHERE project_id = $1 AND kind IN ('approved_plan', 'floor_plan')`,
    [project.id])).rows[0].n > 0;
  if (project && office && !havePlans) {
    /* The unit types are read from the villas rather than named here: a floor
       plan that says "3 BHK, 2,100 sq ft" against a project whose villas say
       something else is a floor plan no buyer is shown. */
    const types = (await c.query(
      `SELECT DISTINCT unit_type FROM units
        WHERE project_id = $1 AND unit_type IS NOT NULL ORDER BY unit_type`,
      [project.id])).rows.map(r => r.unit_type);

    const docs = [
      ['pd-appr-all', 'approved_plan', 'Sanctioned plan, revision C', null,
       'BBMP/ADTP/JD-NORTH/0741/2025-26'],
      ['pd-spec-all', 'specification', 'Specification schedule, phase 1', null,
       'NVT/E1/SPEC/2026-01'],
    ];
    types.forEach((t, i) => docs.push([
      'pd-floor-' + i, 'floor_plan',
      'Floor plan, ' + t.split(',')[0].trim(), t,
      'NVT/E1/FP/' + t.split(',')[0].trim().replace(/\W/g, '') + '/RC']));

    let added = 0;
    for (const [id, kind, label, unitType, ref] of docs) {
      const r = await c.query(
        `INSERT INTO project_documents
           (id, project_id, unit_type, kind, label, reference, url, issued_on, added_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, project.id, unitType, kind, label, ref,
         'https://nvtlifestyle.in/eterna/approvals', '2025-11-14', office.id]);
      added += r.rowCount;
    }
    if (added) out.push(added + ' plans and approvals recorded');
  }

  // ------------------------------------------------ a price on every option
  /* Migration 022 backfilled the option list from `choices.options` at zero,
     because a migration has no business inventing a price. These are the ones
     `db/seed.js` writes, matched by the option's own label, so an option that
     is not on this list keeps the zero it was given. */
  const PRICE = new Map();
  for (const [, , , priced] of CHOICE_SET) {
    for (const [label, rupees] of priced) PRICE.set(label, rupees * 100);
  }
  let priced = 0;
  for (const [label, paise] of PRICE) {
    if (!paise) continue;
    const r = await c.query(
      `UPDATE choice_options SET extra_paise = $2
        WHERE label = $1 AND extra_paise = 0`, [label, paise]);
    priced += r.rowCount;
  }
  if (priced) out.push(priced + ' interior options given their price');

  /* And the price AS SIGNED on a choice that was signed before there were
     prices. `choices_priced_when_signed` requires the column to be set on a
     signed row, so migration 022 set it to zero; this brings it up to what
     the option it names actually costs. Unsigned rows are left alone. */
  const signed = await c.query(
    `UPDATE choices ch SET extra_paise = co.extra_paise
       FROM choice_options co
      WHERE co.choice_id = ch.id AND co.label = ch.selected
        AND ch.signed_at IS NOT NULL AND coalesce(ch.extra_paise, 0) = 0
        AND co.extra_paise > 0 AND ch.billed_demand_id IS NULL`);
  if (signed.rowCount) out.push(signed.rowCount + ' signed choices carry the price they were signed at');

  // ------------------------------- something for the two new readers to read
  const b14 = (await c.query(`SELECT id, project_id FROM units WHERE code = 'B-14'`)).rows[0];
  const b09 = (await c.query(`SELECT id, project_id FROM units WHERE code = 'B-09'`)).rows[0];
  const ago = d => new Date(Date.now() - d * 86400000);
  let notes = 0;
  for (const [id, u, role, sev, title, detail, days] of [
    ['nt-buyer-0', b14, 'buyer', 'warn',
     'Work on your villa has stopped: material not delivered',
     'Blocks ordered 28 August, the vendor now says 12 September. The site '
       + 'engineer reported this and the office has it. Nothing is billed while a '
       + 'stage is stopped.', 2],
    ['nt-buyer-1', b14, 'buyer', 'ok',
     'Two photographs added to first floor slab',
     'Taken on site and stamped. They are on your villa screen.', 6],
    ['nt-engineer-2', b09, 'engineer', 'warn',
     'B-09: the office has asked for a photograph',
     'No photograph has reached the office in three weeks. Priya Menon has asked '
       + 'for one of whatever is standing today.', 1],
  ]) {
    if (!u) continue;
    const r = await c.query(
      `INSERT INTO notifications VALUES ($1,$2,$3,$4,$5,$6,$7,$8,null)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id, u.project_id, role, u.id, sev, title, detail, ago(days)]);
    notes += r.rowCount;
  }
  if (notes) out.push(notes + ' notifications for the site and the buyer');

  return out;
}

async function topUp(c) {
  const staff = await ensureStaff(c);
  const pass6 = await ensurePass6(c);

  const already = (await c.query('SELECT count(*)::int n FROM lenders')).rows[0].n;
  if (already > 0) {
    /* LAST, AND ONLY ON THIS BRANCH.
       Below, `seedState` writes the choices, the option prices and the two new
       notifications itself, with ids of its own and no ON CONFLICT - so
       running the Pass 8 fill first put those rows there and then made
       seedState collide with them. This branch is the one that needs it: a
       database that was seeded before Pass 8 existed. */
    const pass8 = await ensurePass8(c);
    return { skipped: 'lenders already present (' + already + ')', staff,
             pass6: pass6.concat(pass8) };
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
  /* And the plans, which `seedState` does not write - they belong to the
     project rather than to a villa, so `db/seed.js` writes them and this
     branch has just done seedState's half without seed.js's. Everything else
     in `ensurePass8` is a no-op against rows seedState has just written. */
  const pass8 = await ensurePass8(c);
  return { filled: villas.length + ' villas, ' + engineers.length + ' engineers',
           pass6: pass6.concat(pass8) };
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
