'use strict';
/* Seed. NVT Eterna, Phase 1, 48 villas. Deterministic: the same generator the
   locked prototype uses, so villa states match the reference screens. */
const { Client } = require('pg');
const crypto = require('crypto');
const { hash } = require('../src/db');
const config = require('../src/config');
const M = require('../src/money');

const PROJECT = 'eterna-p1';
const AGV = 3200000000;              // ₹3.2 Cr in paise, the 4 BHK
const SANCTION = 2400000000;         // ₹2.4 Cr in paise

/* A-07 is a smaller villa on a different agreement value, and a deliberately
   awkward one: ₹2,98,76,543.21 does not divide cleanly by any of the stage
   percentages.

   That is the point. Every other villa is on a figure where all ten stages
   round exactly, so per-stage rounding and residual allocation produce
   identical numbers and a bug in either would be invisible on every screen.
   This villa is the one where they differ, so the seeded data itself exercises
   the residual and any call site that priced a stage on its own would show up
   as a demand that disagrees with the ledger. */
const AGV_A07 = 2987654321;
const SANCTION_A07 = 2200000000;

const agvFor = code => (code === 'A-07' ? AGV_A07 : AGV);

const MILES = [
  ['book',  'Booking',                   1000, 'On agreement of sale'],
  ['agmt',  'Agreement and registration', 1500, 'Within 30 days of booking'],
  ['found', 'Foundation',                1000, 'Excavation and footing'],
  ['plinth','Plinth beam',               1000, 'Plinth level slab'],
  ['gf',    'Ground floor slab',         1000, 'Roof slab, ground level'],
  ['ff',    'First floor slab',          1000, 'Roof slab, first level'],
  ['brick', 'Blockwork',                 1000, 'External and internal walls'],
  ['plast', 'Plastering',                1000, 'Internal and external'],
  ['floor', 'Flooring and joinery',       800, 'Tiles, doors, windows'],
  ['hand',  'Handover',                   700, 'Snag clearance and keys'],
];

// The schedule is priced per villa, because villas are not all on the same
// agreement value. The last stage carries the residual, so this must be the
// whole schedule at once and never a stage at a time.
const BPS = MILES.map(m => m[2]);
const pricedFor = code => M.schedule(agvFor(code), BPS);

const BANKS = ['HDFC Ltd', 'SBI', 'ICICI Bank', 'LIC Housing', 'Axis Bank'];
const CPS = ['Homzn Realty', 'Bricks & Beyond', 'Sarjapur Prop Co', 'Direct'];
const NAMES = ['R. Anand','M. Sharma','K. Iyer','P. Reddy','S. Nair','V. Rao',
  'A. Khanna','D. Menon','T. Bhat','J. Kulkarni','N. Prasad','H. Shetty'];

function lcg(seed) { let s = seed; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

async function main() {
  // Connects as the owning role, which is a superuser in development, because
  // seeding has to write past the row-level security every other path obeys.
  // Development only. Nothing in src/ ever opens this connection.
  const c = new Client(config.adminDb());
  await c.connect();
  await c.query('SET search_path = plint, public');

  /* One transaction for the whole seed. The audit triggers are deferred to
     COMMIT so that a stage certified before its demand is written still
     records the demand's figures; in autocommit each statement would be its
     own transaction and the trigger would fire before the demand existed.

     And an identity, because settling a demand has to name who settled it.
     The seed is head office writing the project's history. */
  await c.query('BEGIN');
  await c.query(`SELECT set_config('plint.user_id','u-office',true),
                        set_config('plint.role','office',true)`);

  /* The columns migration 015 added are filled here too, so the seeded project
     carries what a project created through the screens carries. The migration
     backfills a database that was already seeded; this is for a fresh one. */
  await c.query(
    /* The builder is the Data Fiduciary for the buyers on this project, so
       the person a buyer writes to about their data is the builder's officer
       and it is recorded per project. Migration 020 backfills it on a
       database that already had this project; a fresh one is seeded with it
       here, because the migration runs before the seed. */
    `INSERT INTO projects (id, name, phase, location, builder_name, builder_ref,
                           grievance_name, grievance_email, grievance_phone)
     VALUES ($1,'NVT Eterna','Phase 1','Devanahalli, Bengaluru','NVT Quality Lifestyle',
             'PRM/KA/RERA/1251/446/PR/171021/001234',
             'K. Sridhar','grievance@nvtlifestyle.in','+91 80 4123 7788')`, [PROJECT]);
  for (let i = 0; i < MILES.length; i++) {
    const [code, name, bp, d] = MILES[i];
    await c.query(`INSERT INTO stage_templates VALUES ($1,$2,$3,$4,$5,$6)`,
      [PROJECT, i, code, name, bp, d]);
  }

  // ------------------------------------------------------------ three logins
  const users = [
    ['u-buyer-b14', 'arjun@example.in',      'buyer',    'Arjun Nair',       null, null],
    ['u-eng-ram',   'ramachandran@nvt.in',   'engineer', 'S. Ramachandran',  'B.E. Civil, M.I.E.', 'KAR/CE/2014/8842'],
    ['u-office',    'priya@nvt.in',          'office',   'Priya Menon',      null, null],
    // v21 names three people on site. Only one of them may sign a certificate:
    // Suresh marks work done and is not a qualified engineer, which is the
    // distinction the whole certification rule exists to hold.
    ['u-eng-suresh','suresh@nvt.in',         'engineer', 'Suresh Kumar',     'Site supervisor', null],
    ['u-eng-venkat','venkatesh@nvt.in',      'engineer', 'A. Venkatesh',     'B.E. Civil', 'KAR/CE/2019/3311'],
  ];
  for (const [id, email, role, name, qual, reg] of users) {
    await c.query(`INSERT INTO users VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, email, hash('plint'), role, name, qual, reg]);
  }
  // A second buyer, so isolation is tested against a real neighbour and not a void.
  await c.query(`INSERT INTO users VALUES ('u-buyer-a07','sharma@example.in',$1,'buyer','M. Sharma',null,null)`,
    [hash('plint')]);

  /* THE PROJECT'S OWN REGISTRATION, shown to every buyer on it. Migration 023
     backfills this on a database that already has the project; a fresh one is
     seeded here, because the migration runs before the seed. After the logins,
     because a document records who added it. */
  await c.query(
    `INSERT INTO project_documents (id, project_id, kind, label, reference, url, added_by)
     VALUES ('pd-rera-' || $1, $1, 'rera_certificate',
             'RERA registration, NVT Eterna',
             'PRM/KA/RERA/1251/446/PR/171021/001234',
             'https://rera.karnataka.gov.in/projectViewDetails', 'u-office')`, [PROJECT]);

  /* THE SANCTIONED PLAN AND THE FLOOR PLANS.
     The registration alone left the engineer's "What it is built to" section
     empty on every villa - it deliberately excludes the registration, because
     a certificate is not what somebody builds a slab to - and a section that
     never appears is a section nobody can tell is there. These are the three a
     buyer and an engineer actually open: the sanctioned plan for the project,
     and a floor plan for each of the two unit types on it. */
  for (const [kind, label, unitType, ref] of [
    ['approved_plan', 'Sanctioned plan, revision C', null,
     'BBMP/ADTP/JD-NORTH/0741/2025-26'],
    ['floor_plan', 'Floor plan, 4 BHK lake facing', '4 BHK, 3,640 sq ft, lake facing',
     'NVT/E1/FP/4B-LF/RC'],
    ['floor_plan', 'Floor plan, 3 BHK', '3 BHK, 2,100 sq ft',
     'NVT/E1/FP/3B/RC'],
    ['specification', 'Specification schedule, phase 1', null,
     'NVT/E1/SPEC/2026-01'],
  ]) {
    await c.query(
      `INSERT INTO project_documents
         (id, project_id, kind, label, unit_type, reference, url, issued_on, added_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'u-office')`,
      ['pd-' + kind.slice(0, 4) + '-' + (unitType ? unitType.slice(0, 5).replace(/\W/g, '') : 'all'),
       PROJECT, kind, label, unitType, ref,
       'https://nvtlifestyle.in/eterna/approvals', '2025-11-14']);
  }

  // ------------------------------------------------------------- 48 villas
  const r = lcg(11);
  const villas = [];
  for (const bl of ['A', 'B', 'C']) {
    for (let i = 1; i <= 16; i++) {
      const q = r();
      villas.push({
        code: bl + '-' + String(i).padStart(2, '0'),
        at: q < .16 ? 3 : q < .4 ? 5 : q < .76 ? 6 : q < .92 ? 7 : 8,
        late: r() < .12,
        buyer: NAMES[Math.floor(r() * 12)],
        bank: r() < .86 ? BANKS[Math.floor(r() * 5)] : null,
        cp: CPS[Math.floor(r() * 4)],
        packSt: (() => { const x = r(); return x < .16 ? 'Not sent' : x < .36 ? 'Awaiting' : x < .5 ? 'Query' : 'Disbursed'; })(),
        packAge: Math.floor(r() * 34) + 2,
        silent: Math.floor(r() * 30) + 2,
      });
    }
  }

  /* Which buyers have brought the sanction letter in. Drawn from its own
     generator on purpose: taking it from `r` would consume one more number per
     villa and shift every bank, channel partner and pack state that follows,
     silently rewriting the whole seeded project to add one field. */
  const rsanc = lcg(97);
  for (const v of villas) v.sanctioned = rsanc() > .3;

  const rs = lcg(37);
  for (const v of villas) {
    const isB14 = v.code === 'B-14';
    const buyerId = isB14 ? 'u-buyer-b14' : v.code === 'A-07' ? 'u-buyer-a07' : null;
    const id = 'unit-' + v.code;
    await c.query(
      `INSERT INTO units VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, PROJECT, v.code, buyerId, isB14 ? 'Arjun Nair' : v.code === 'A-07' ? 'M. Sharma' : v.buyer,
       isB14 ? '4 BHK, 3,640 sq ft, lake facing' : '3 BHK, 2,100 sq ft',
       agvFor(v.code), v.bank,
       null,                          // sanction is recorded below, or not at all
       v.cp, 'Suresh Kumar', 'Deepa R.']);

    /* The sanction, for the villas where one has been recorded.
       v21's office carries a "Sanction not recorded" list, so the seed has to
       produce both kinds: a villa with a lender and a recorded sanction, and a
       villa with a lender whose buyer has not brought the letter in yet.
       A villa with no lender is self funded and has nothing to record. */
    if (v.bank && v.sanctioned) {
      const sanction = v.code === 'A-07' ? SANCTION_A07 : SANCTION;
      /* Own contribution is STORED, not a percentage. Seeded as the agreement
         value less the sanction, which is what v21's sanction sheet says it
         is, but from here on it is whatever the office typed off the letter. */
      const own = agvFor(v.code) - sanction;
      await c.query(
        `UPDATE units SET sanction_paise=$2, own_contribution_paise=$3,
                          sanction_letter_ref=$4, sanction_recorded_at=$5,
                          sanction_recorded_by='u-office'
          WHERE id=$1`,
        [id, sanction, own,
         'SL/' + (v.bank.split(' ')[0].toUpperCase()) + '/2026/' + v.code.replace('-', ''),
         new Date(Date.UTC(2026, 0, 18, 6, 0))]);
    }

    // Priced once per villa, from that villa's own agreement value.
    const priced = pricedFor(v.code);

    const at = isB14 ? 6 : v.at;   // B-14 is at blockwork, per the prototype
    for (let i = 0; i < MILES.length; i++) {
      const [code] = MILES[i];
      const sid = 'us-' + v.code + '-' + code;
      let status = 'pending', markedBy = null, markedAt = null,
          certBy = null, certAt = null, certHash = null;

      if (i < at) {                       // history: verified, demanded, paid
        status = i <= at - 2 ? 'paid' : 'demanded';
        markedBy = 'Suresh Kumar';
        markedAt = new Date(Date.UTC(2026, 2 + i, 18, 5, 30));
        certBy = 'u-eng-ram';
        certAt = new Date(Date.UTC(2026, 2 + i, 18, 9, 0));
        certHash = sha(v.code + code + 'cert');
      } else if (i === at) {              // the live stage: marked on site, not yet certified
        status = 'marked';
        markedBy = 'Suresh Kumar';
        markedAt = new Date(Date.UTC(2026, 7, 31, 5, 34));
      }
      await c.query(`INSERT INTO unit_stages VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [sid, id, code, status, markedBy, markedAt, certBy, certAt, certHash]);

      if (status !== 'pending') {
        const shots = isB14 && code === 'brick' ? 2 : (i === at ? Math.floor(rs() * 4) : 2);
        for (let k = 0; k < shots; k++) {
          await c.query(`INSERT INTO evidence VALUES ($1,$2,$3,$4,$5,$6)`, [
            'ev-' + v.code + '-' + code + '-' + k,
            sid,
            isB14 && code === 'brick'
              ? ['External blockwork, north', 'Internal partitions'][k]
              : 'Stage photograph ' + (k + 1),
            markedAt || new Date(Date.UTC(2026, 7, 21, 4, 8)),
            '12.8391, 77.7724',
            sha(v.code + code + k),
          ]);
        }
      }
    }

    // demands already raised for everything up to the live stage
    for (let i = 0; i < at; i++) {
      const [code] = MILES[i];
      // The one calculation layer prices this, exactly as certification will:
      // the whole schedule at once, so the last stage carries the residual.
      // The seed does not get its own arithmetic.
      const { basePaise: base, gstPaise: gst } = priced[i];
      const raised = new Date(Date.UTC(2026, 2 + i, 18));
      const due = new Date(raised.getTime() + 14 * 86400000);
      const demandId = 'dm-' + v.code + '-' + code;
      const docNo = 'PL/' + v.code.replace('-', '') + '/' + String(i + 1).padStart(2, '0');
      const paidAt = i <= at - 2 ? new Date(raised.getTime() + 9 * 86400000) : null;

      await c.query(`INSERT INTO demands VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9)`, [
        demandId, 'us-' + v.code + '-' + code, docNo,
        raised, due, base, gst, base + gst, paidAt,
      ]);

      /* THE RECEIPT FOR A DEMAND THIS HISTORY SHOWS AS SETTLED.

         A buyer five stages in has paid five times and is asked for those
         receipts by their own bank, their accountant and the sub-registrar.
         Seeding the settlement without them would show a product where money
         arrives and nothing acknowledges it.

         No amount is written here, because the table has no column for one:
         every figure on a receipt is read from the demand above. The mode and
         the reference are derived from the villa and the stage index so the
         seed stays byte for byte deterministic, and nothing here draws on the
         generators that would shift every bank and partner after it. */
      if (paidAt) {
        const MODES = ['neft', 'rtgs', 'imps', 'cheque', 'upi'];
        const mode = MODES[i % MODES.length];
        const flat = v.code.replace('-', '');
        const day = paidAt.toISOString().slice(0, 10).replace(/-/g, '');
        const ref = mode === 'cheque' ? 'Cheque 4' + String(10000 + i * 37 + v.code.charCodeAt(2)).slice(0, 5)
          : mode === 'upi' ? flat.toLowerCase() + '@okhdfcbank ' + day
          : 'UTR' + day + flat + String(i + 1).padStart(2, '0');
        await c.query(
          `INSERT INTO receipts (id, demand_id, receipt_no, mode, reference,
                                 received_on, issued_by, issued_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          ['rc-' + demandId, demandId,
           'RC/' + flat + '/' + String(i + 1).padStart(2, '0'),
           mode, ref, paidAt, 'u-office', paidAt]);
      }

      /* No audit rows are written here. Triggers on unit_stages and demands
         write them, from the rows' own columns, at COMMIT. The seed used to
         write them by hand, which made it a second writer of the same record
         and was exactly the arrangement that let 269 certified stages ship
         with no audit trail at all. */

      /* And the pack record for that certification. Certification creates one;
         seeded history that skipped it left the table empty on a fresh
         database, which meant any check counting these rows passed by having
         nothing to count. A paid demand implies the pack reached the lender,
         because that is what released the money. */
      await c.query(
        `INSERT INTO pack_deliveries
           (id, unit_stage_id, lender, state, attempts, last_attempt_at, queued_at, delivered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        ['pk-' + v.code + '-' + code, 'us-' + v.code + '-' + code,
         v.bank,
         !v.bank ? 'not_applicable' : paidAt ? 'delivered' : 'queued',
         v.bank ? 1 : 0,
         v.bank ? raised : null,
         raised,
         v.bank && paidAt ? new Date(raised.getTime() + 86400000) : null]);
    }

    // who is holding the live stage up
    const sid = 'us-' + v.code + '-' + MILES[at][0];
    let holder, role, reason;
    if (!v.bank) { holder = 'Priya Menon'; role = 'office'; reason = 'No lender on file. Pack cannot be sent.'; }
    else if (v.packSt === 'Not sent') { holder = 'S. Ramachandran'; role = 'engineer'; reason = 'Stage marked on site, no signed certificate.'; }
    else if (v.packSt === 'Awaiting') { holder = v.bank; role = 'lender'; reason = 'Pack with the lender, ' + v.packAge + ' days, no response.'; }
    else if (v.packSt === 'Query') { holder = v.bank; role = 'lender'; reason = 'Lender query open, ' + v.packAge + ' days.'; }
    else { holder = v.buyer; role = 'buyer'; reason = 'Disbursed. Awaiting buyer own-contribution.'; }
    if (v.code === 'B-14') { holder = 'S. Ramachandran'; role = 'engineer'; reason = 'Blockwork marked 31 August. Certificate not signed.'; }
    await c.query(`INSERT INTO blockers VALUES ($1,$2,$3,$4,$5)`,
      [sid, holder, role, reason, new Date(Date.now() - v.silent * 86400000)]);
  }

  /* A VILLA CAN HAVE MORE THAN ONE STAGE BLOCKED, AND THE SEED HAS TO SAY SO.

     Every villa above gets exactly one blocker, on its live stage. Forty-eight
     villas, forty-eight blockers, one each - and a seed like that cannot
     reproduce the case where a villa appears twice on the holder board, once
     in each of two columns, because two of its stages are held by different
     people. That bug existed, shipped, and was invisible here; it was the test
     database, which happened to have a villa with two, that caught it.

     So two villas carry a second blocker, on the stage after the live one:

       A-01  live stage held by whoever the rules above chose, and the NEXT
             stage held by THIS OFFICE - a drawing that has not been issued.
             The two are held by different parties, which is the case that
             put one villa in two columns.
       A-04  live stage as above, and the next stage held by THE BUYER, who
             has not chosen the finishes the stage needs.

     The holder board groups by villa and keeps the longest wait, so these two
     must still appear exactly once each. `test/shell.test.js` asserts the
     column counts sum to the villa register, and that assertion is what these
     two rows exist to exercise. */
  const alsoBlocked = [
    ['A-01', 'office', 'Priya Menon',
     'Revised drawing not issued. The next stage cannot start.'],
    ['A-04', 'buyer', null,
     'Finishes not chosen. The next stage cannot be set out.'],
  ];
  for (const [code, role2, who, reason2] of alsoBlocked) {
    const v = villas.find(x => x.code === code);
    if (!v) continue;
    const next = v.at + 1;
    if (next >= MILES.length) continue;          // nothing after the live stage
    const sid2 = 'us-' + code + '-' + MILES[next][0];
    const already = await c.query('SELECT 1 FROM blockers WHERE unit_stage_id = $1', [sid2]);
    if (already.rowCount) continue;              // never write over the first one
    await c.query(`INSERT INTO blockers VALUES ($1,$2,$3,$4,$5)`,
      [sid2, who || v.buyer, role2, reason2,
       new Date(Date.now() - Math.max(1, v.silent - 4) * 86400000)]);
  }

  // Everything migrations 011 and 012 added. Separate file, separate random
  // streams: see its header for why it must not touch the generators above.
  await require('./seed-state').seedState(c, villas,
    ['u-eng-ram', 'u-eng-suresh', 'u-eng-venkat']);

  /* Every evidence row gets an actual file, because from Pass 4 the screens
     render photographs rather than printing their captions. See
     db/seed-photos.js for what a plate is and what it deliberately is not. */
  const shots = await require('./seed-photos').fill(c, { quiet: true });

  const n = await c.query('SELECT count(*) FROM units');
  await c.query('COMMIT');
  console.log('  evidence plates', shots.filled);

  // Read back after COMMIT, so the count includes what the deferred triggers
  // wrote. If these two ever disagree, the trigger is not firing for someone.
  const a = await c.query(
    `SELECT count(*) FILTER (WHERE action='certified')::int certified,
            count(*) FILTER (WHERE action='demand_settled')::int settled
       FROM audit_log`);
  const d = await c.query(
    `SELECT count(*)::int demands,
            count(*) FILTER (WHERE paid_at IS NOT NULL)::int paid FROM demands`);
  console.log('seeded', n.rows[0].count, 'units');
  console.log('  demands', d.rows[0].demands, '-> audit certified', a.rows[0].certified);
  console.log('  settled', d.rows[0].paid, '-> audit settled  ', a.rows[0].settled);
  if (a.rows[0].certified !== d.rows[0].demands || a.rows[0].settled !== d.rows[0].paid) {
    throw new Error('the audit trail does not reconcile with what was seeded');
  }
  await c.end();
}
main().catch(e => { console.error(e); process.exit(1); });
