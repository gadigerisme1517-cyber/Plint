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

  await c.query(`INSERT INTO projects VALUES ($1,'NVT Eterna','Phase 1')`, [PROJECT]);
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
  ];
  for (const [id, email, role, name, qual, reg] of users) {
    await c.query(`INSERT INTO users VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, email, hash('plint'), role, name, qual, reg]);
  }
  // A second buyer, so isolation is tested against a real neighbour and not a void.
  await c.query(`INSERT INTO users VALUES ('u-buyer-a07','sharma@example.in',$1,'buyer','M. Sharma',null,null)`,
    [hash('plint')]);

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
       v.bank ? (v.code === 'A-07' ? SANCTION_A07 : SANCTION) : null,
       v.cp, 'Suresh Kumar', 'Deepa R.']);

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

  const n = await c.query('SELECT count(*) FROM units');
  await c.query('COMMIT');

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
