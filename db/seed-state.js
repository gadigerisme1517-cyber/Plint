'use strict';
/* ============================================================================
   Seeds everything migrations 011 and 012 added: the loan file, the agreement,
   the interior choices, visits, queries, snags, the site log, sales handoffs,
   lender queries, escrow, the RERA filing and the office's notifications.

   WHY THIS IS A SEPARATE FILE. db/seed.js draws the whole project from three
   seeded generators, and its own comment records what happens if you touch
   them: taking one extra number from `r` shifts every bank, channel partner
   and pack state after it and silently rewrites the project. So nothing here
   reads those generators. Every value below comes from its own stream, and
   the 48 villas, their stages, demands and audit rows come out byte for byte
   the same as before this file existed.

   The values themselves are plint-v21's own constants wherever v21 has them.
   ========================================================================= */

const PROJECT = 'eterna-p1';
const lcg = seed => { let s = seed; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; };
const day = 86400000;
const ago = d => new Date(Date.now() - d * day);
const ahead = d => new Date(Date.now() + d * day);

/* v21's lender panel, verbatim: each bank vets the project once and issues an
   APF code. Rates are basis points. The six after them are banks a buyer may
   bring that have no APF here, which is allowed and slower. */
const PANEL = [
  ['SBI',          'APF/SBI/BLR/2024/11872',   840, 4, 6],
  ['HDFC Ltd',     'APF/HDFC/KA/9931',         855, 3, 5],
  ['ICICI Bank',   'APF/ICICI/SBLR/40219',     860, 4, 7],
  ['LIC Housing',  'APF/LICHFL/BG/7714',       835, 6, 9],
  ['Axis Bank',    'APF/AXIS/BLR/20551',       865, 5, 8],
];
const OUTSIDE = ['Canara Bank', 'Bank of Baroda', 'Kotak Mahindra',
                 'Federal Bank', 'Bajaj Housing', 'Someone else'];

/* The papers each kind of earner is asked for. v21's DOCS, verbatim. */
const DOCS = {
  salaried: [['pan', 'PAN card'], ['aadhaar', 'Aadhaar'], ['addr', 'Address proof'],
             ['slips', 'Last 3 salary slips'], ['form16', 'Form 16'],
             ['bank6', '6 months bank statement']],
  self:     [['pan', 'PAN card'], ['aadhaar', 'Aadhaar'], ['addr', 'Address proof'],
             ['itr', 'Last 3 years ITR'], ['pnl', 'P&L and balance sheet'],
             ['gst', 'GST returns, 12 months'], ['bizproof', 'Business registration proof'],
             ['bank12', '12 months bank statement']],
};

/* Interior selections that stop the site if they are not made. */
const CHOICE_SET = [
  ['floor',   'Flooring, living and bedrooms', 'Vitrified tile or engineered wood.',
   ['Vitrified tile, 800x800', 'Engineered wood, oak', 'Vitrified tile, 600x600'], 20],
  ['kitchen', 'Kitchen counter',               'Granite or quartz, edge profile included.',
   ['Black granite', 'White quartz', 'Grey quartz'], 34],
  ['bath',    'Bathroom fittings',             'The full set, one manufacturer.',
   ['Jaquar', 'Kohler', 'Grohe'], 48],
];

const LOG_SEED = [
  ['material', '120 bags OPC 53, Ultratech', 'challan 44219 · B-block store', 0],
  ['labour',   '18 on site: 6 mason, 8 helper, 4 bar bender', 'morning head count', 0],
  ['drawing',  'Rev C, ground floor electrical layout', 'supersedes Rev B', 1],
  ['weather',  'Rain, 2 hours lost', '14:00 to 16:00 · slab pour deferred', 1],
  ['rework',   'A-11 lintel level reset, 40mm out', 'checked and passed after reset', 5],
];

/* v21's MYSNAGS, plus two on B-14. v21's own notification feed says "Arjun Nair
   raised 2 flags on site", and B-14 is the villa every demo signs into: without
   these the buyer's snag list is empty and looks broken rather than clear. */
const SNAG_SEED = [
  ['B-14', 'Damp patch below the utility window', 'buyer', 4],
  ['B-14', 'Window frame not square, second bedroom', 'buyer', 4],
  ['B-03', 'Hairline crack, master bedroom wall', 'buyer', 3],
  ['B-03', 'Bathroom door does not close flush',  'buyer', 3],
  ['A-11', 'Kitchen tile chipped near the sink',  'office', 8],
  ['A-11', 'Balcony drain slow',                  'buyer', 8],
  ['C-09', 'Paint uneven above the entry door',   'buyer', 11],
];

const NOTIF_SEED = [
  ['hot',  'Lender query on B-07',            'HDFC asked for the revised payment schedule', 0],
  ['ok',   'C-02 certified by S. Ramachandran','Slab stage. Pack is ready to send.',          0],
  ['hot',  'A-11 pack is 22 days at the lender','Sent 14 August. No response.',               0],
  ['warn', 'Arjun Nair raised 2 flags on site','Damp patch and window frame.',                1],
  ['ok',   'M. Sharma uploaded 3 documents',   'Form 16, salary slips, bank statement',       1],
];

/* v21's HANDOFF: sales has taken a token and nobody owns the file yet. */
const HANDOFF_SEED = [
  ['C-07', 450000, 'Kiran (sales)', 'Ready to move, wants our bank. Both spouses on the loan.', 0],
  ['A-11', 300000, 'Ravi (sales)',  'Self-employed, has own CA. Will bring own bank.', 1],
  ['B-03', 600000, 'Kiran (sales)', 'NRI co-applicant (Dubai). Needs guidance on documents.', 2],
];

/**
 * @param c        an open, in-transaction client with an office identity set
 * @param villas   the seed's villa descriptors, read only
 * @param engineers ids of the users with role 'engineer'
 */
async function seedState(c, villas, engineers) {
  const byName = {};

  // --------------------------------------------------------------- lenders
  let seq = 0;
  for (const [name, apf, rate, lo, hi] of PANEL) {
    const id = 'lender-' + name.toLowerCase().replace(/[^a-z]+/g, '');
    byName[name] = id;
    await c.query(
      `INSERT INTO lenders VALUES ($1,$2,$3,$4,$5,$6,true,$7)`,
      [id, name, apf, rate, lo, hi, seq++]);
  }
  for (const name of OUTSIDE) {
    const id = 'lender-' + name.toLowerCase().replace(/[^a-z]+/g, '');
    byName[name] = id;
    await c.query(
      `INSERT INTO lenders VALUES ($1,$2,null,$3,$4,$5,false,$6)`,
      [id, name, 900, 10, 21, seq++]);
  }

  // ------------------------------------------------- who is on which villa
  // Round robin, so every engineer has a list and reassignment has somewhere
  // to move work to.
  for (let i = 0; i < villas.length; i++) {
    await c.query(`UPDATE units SET assigned_engineer_id = $1 WHERE id = $2`,
      [engineers[i % engineers.length], 'unit-' + villas[i].code]);
  }

  // ------------------------------------------------------------ loan files
  const rl = lcg(211);
  for (const v of villas) {
    const unit = 'unit-' + v.code;
    if (!v.bank) continue;                    // self funded, no loan file

    await c.query(
      `UPDATE units SET lender_id = $1, lender_chosen_at = $2, lender_chosen_by = 'u-office'
        WHERE id = $3`,
      [byName[v.bank], ago(60 + Math.floor(rl() * 40)), unit]);

    // One or two people on the file.
    const people = rl() < .45
      ? [[v.code === 'B-14' ? 'Arjun Nair' : v.buyer, 'salaried', 'Main applicant'],
         [(v.code === 'B-14' ? 'Priya Nair' : 'Co-applicant'), rl() < .5 ? 'self' : 'salaried', 'Co-applicant, spouse']]
      : [[v.code === 'B-14' ? 'Arjun Nair' : v.buyer, rl() < .62 ? 'salaried' : 'self', 'Main applicant']];

    for (let i = 0; i < people.length; i++) {
      const [name, earns, rel] = people[i];
      const aid = 'la-' + v.code + '-' + i;
      await c.query(`INSERT INTO loan_applicants VALUES ($1,$2,$3,$4,$5,$6)`,
        [aid, unit, name, earns, rel, i]);

      const set = DOCS[earns];
      for (let j = 0; j < set.length; j++) {
        const [key, label] = set[j];
        // v21 shows most papers seen and a handful outstanding, which is what
        // makes "Sanction not recorded" a worklist rather than a list.
        const seen = rl() < .62;
        await c.query(
          `INSERT INTO loan_documents VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [aid + '-' + key, aid, key, label, j,
           seen ? ago(5 + Math.floor(rl() * 50)) : null, seen ? 'u-office' : null]);
      }
    }
  }

  // ------------------------------------------------------------ agreements
  const ra = lcg(307);
  for (const v of villas) {
    const unit = 'unit-' + v.code;
    const x = ra();
    // Almost every villa past booking is registered; a few are still out for
    // signature, which is what the buyer's Agreement screen has to show.
    if (x < .08) {
      await c.query(`INSERT INTO agreements VALUES ($1,$2,null,null,null,'u-office')`,
        [unit, ago(6 + Math.floor(ra() * 10))]);
    } else if (x < .14) {
      const sent = ago(20 + Math.floor(ra() * 14));
      await c.query(`INSERT INTO agreements VALUES ($1,$2,$3,null,null,'u-office')`,
        [unit, sent, new Date(sent.getTime() + 4 * day)]);
    } else {
      const sent = ago(80 + Math.floor(ra() * 60));
      const signed = new Date(sent.getTime() + 5 * day);
      const reg = new Date(signed.getTime() + 9 * day);
      await c.query(`INSERT INTO agreements VALUES ($1,$2,$3,$4,$5,'u-office')`,
        [unit, sent, signed, reg,
         'KA/BLR/' + v.code.replace('-', '') + '/' + (2400 + Math.floor(ra() * 900))]);
    }
  }

  // --------------------------------------------------------------- choices
  const rc = lcg(401);
  for (const v of villas) {
    const unit = 'unit-' + v.code;
    for (const [key, label, detail, options, dueIn] of CHOICE_SET) {
      const made = rc() < .58;
      await c.query(
        `INSERT INTO choices VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [ 'ch-' + v.code + '-' + key, unit, key, label, detail, options,
          ahead(dueIn - Math.floor(rc() * 30)),
          made ? options[Math.floor(rc() * options.length)] : null,
          made ? ago(Math.floor(rc() * 40)) : null,
          made ? (v.code === 'B-14' ? 'u-buyer-b14' : 'u-office') : null ]);
    }
  }

  // ---------------------------------------------------------------- visits
  // v21's MYVISITS, against the buyers who actually hold those villas here.
  const VISITS = [
    ['B-14', 'u-buyer-b14', 2, 'First visit since slab. Wants to see the terrace level.', 'confirmed'],
    ['A-07', 'u-buyer-a07', 2, 'Raised two flags last visit. Both closed, wants to confirm.', 'requested'],
    ['B-14', 'u-buyer-b14', 9, 'Bringing his own contractor to look at the plumbing runs.', 'requested'],
  ];
  for (let i = 0; i < VISITS.length; i++) {
    const [code, who, inDays, note, status] = VISITS[i];
    const eng = (await c.query(`SELECT assigned_engineer_id FROM units WHERE id = $1`,
      ['unit-' + code])).rows[0].assigned_engineer_id;
    await c.query(
      `INSERT INTO visits VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,null)`,
      ['visit-' + i, 'unit-' + code, ahead(inDays), note, who, ago(3), eng, status,
       status === 'requested' ? null : ago(2)]);
  }

  // --------------------------------------------------------------- queries
  // v21's THREADSEED: a real exchange on B-14, so the buyer's More tab and the
  // office queue both have something true in them on first load.
  await c.query(`INSERT INTO queries VALUES ('q-b14-1','unit-B-14','query',
    'When will the plastering start?','u-buyer-b14',$1,'answered',null)`, [ago(5)]);
  const thread = [
    ['u-buyer-b14', 'buyer',  'When will the plastering start? I was told September.', 5],
    ['u-office',    'office', 'Brickwork finished on 28 August. Plastering starts once the electrical conduits are in, which is this week. I will send photographs when it begins.', 4],
    ['u-buyer-b14', 'buyer',  'Thank you. And the demand letter I received, does that include the GST?', 4],
  ];
  for (let i = 0; i < thread.length; i++) {
    const [who, role, body, d] = thread[i];
    await c.query(`INSERT INTO query_messages VALUES ($1,'q-b14-1',$2,$3,$4,$5)`,
      ['qm-b14-' + i, who, role, body, ago(d)]);
  }
  // An open one, so the office queue is not empty.
  await c.query(`INSERT INTO queries VALUES ('q-a07-1','unit-A-07','query',
    'Is the car park allocation fixed?','u-buyer-a07',$1,'open',null)`, [ago(2)]);
  await c.query(`INSERT INTO query_messages VALUES ('qm-a07-0','q-a07-1','u-buyer-a07','buyer',
    'Is the car park allocation fixed, or can I ask for the corner slot?',$1)`, [ago(2)]);
  // And a warranty claim, which is the same object on a different screen.
  await c.query(`INSERT INTO queries VALUES ('q-b14-w','unit-B-14','warranty',
    'Damp patch, utility wall','u-buyer-b14',$1,'open',null)`, [ago(9)]);
  await c.query(`INSERT INTO query_messages VALUES ('qm-b14-w','q-b14-w','u-buyer-b14','buyer',
    'Damp patch appearing on the utility wall after the rain last week.',$1)`, [ago(9)]);

  // ----------------------------------------------------------------- snags
  for (let i = 0; i < SNAG_SEED.length; i++) {
    const [code, title, role, age] = SNAG_SEED[i];
    // Whoever raised it has to be a real person against that villa, not a
    // stand-in: the row records who said the wall was damp.
    const buyerOf = { 'B-14': 'u-buyer-b14', 'A-07': 'u-buyer-a07' }[code] || 'u-buyer-a07';
    const who = role === 'buyer' ? buyerOf : 'u-office';
    await c.query(`INSERT INTO snags VALUES ($1,$2,$3,$4,$5,$6,'open',null,null,null)`,
      ['snag-' + i, 'unit-' + code, title, who, role, ago(age)]);
  }

  // -------------------------------------------------------------- site log
  for (let i = 0; i < LOG_SEED.length; i++) {
    const [kind, title, detail, d] = LOG_SEED[i];
    await c.query(`INSERT INTO site_log VALUES ($1,$2,null,$3,$4,$5,$6,$7)`,
      ['log-' + i, PROJECT, kind, title, detail, engineers[0], ago(d)]);
  }

  // -------------------------------------------------------------- handoffs
  for (let i = 0; i < HANDOFF_SEED.length; i++) {
    const [code, token, sp, note, d] = HANDOFF_SEED[i];
    await c.query(`INSERT INTO handoffs VALUES ($1,$2,$3,$4,$5,$6,null,null)`,
      ['ho-' + i, 'unit-' + code, token * 100, sp, note, ago(d)]);
  }

  // -------------------------------------------------- lender queries on packs
  // Every villa the seed marked 'Query' has an actual question behind it now,
  // rather than a status string with nothing under it.
  const rq = lcg(503);
  let nq = 0;
  for (const v of villas) {
    if (v.packSt !== 'Query') continue;
    const s = await c.query(
      `SELECT id FROM unit_stages WHERE unit_id = $1 AND status IN ('demanded','paid')
        ORDER BY stage_code LIMIT 1`, ['unit-' + v.code]);
    if (!s.rows.length) continue;
    const qs = ['Revised payment schedule, signed by the buyer.',
                'Latest photograph of the certified stage.',
                'Encumbrance certificate, current date.',
                'Architect certificate for the stage claimed.'];
    await c.query(`INSERT INTO pack_queries VALUES ($1,$2,$3,$4,null,null,null)`,
      ['pq-' + (nq++), s.rows[0].id, ago(v.packAge), qs[Math.floor(rq() * qs.length)]]);
  }

  // ---------------------------------------------------------------- escrow
  const re = lcg(601);
  for (let i = 0; i < 12; i++) {
    const inbound = re() < .62;
    await c.query(`INSERT INTO escrow_movements VALUES ($1,$2,null,$3,$4,$5,$6,'u-office')`,
      ['esc-' + i, PROJECT, inbound ? 'in' : 'out',
       Math.floor((re() * 40 + 5)) * 10000000,
       ago(Math.floor(re() * 90)),
       inbound ? 'Disbursement received' : 'Construction drawdown']);
  }

  // ------------------------------------------------------------ RERA filing
  await c.query(`INSERT INTO qpr_filings VALUES ('qpr-q2',$1,'Q2 FY26',$2,$3,'u-office','RERA/KA/QPR/26Q2/8841')`,
    [PROJECT, new Date(Date.now() - 80 * day), ago(78)]);
  await c.query(`INSERT INTO qpr_filings VALUES ('qpr-q3',$1,'Q3 FY26',$2,null,null,null)`,
    [PROJECT, new Date(Date.now() + 12 * day)]);

  // ----------------------------------------------------------- notifications
  for (let i = 0; i < NOTIF_SEED.length; i++) {
    const [sev, title, detail, d] = NOTIF_SEED[i];
    await c.query(`INSERT INTO notifications VALUES ($1,$2,'office',null,$3,$4,$5,$6,null)`,
      ['nt-' + i, PROJECT, sev, title, detail, ago(d)]);
  }
}

module.exports = { seedState, PANEL, OUTSIDE, DOCS, CHOICE_SET };
