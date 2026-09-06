'use strict';
/* ============================================================================
   The calculation layer, tested directly.

   Both other suites reach src/money.js only through screens, so a rounding
   change could have passed them while quietly moving every figure. These call
   it as itself.

   Expected values are computed with BigInt inside the test, or written out by
   hand, never by re-running the implementation's own expression.
   ========================================================================= */
const { test, after } = require('node:test');
const assert = require('node:assert');

const M = require('../src/money');
const { asUser, pool } = require('../src/db');

const OFFICE = { id: 'u-office', role: 'office' };

// NVT Eterna Phase 1, from db/seed.js.
const AGV = 3200000000;                       // Rs 3,20,00,000 in paise
const SCHEDULE = [1000, 1500, 1000, 1000, 1000, 1000, 1000, 1000, 800, 700];

after(() => pool.end());

// ------------------------------------------------------------------ rounding

test('rounding is half-up at the half-paise boundary, not to even', () => {
  // agreementValue x 1bp / 10000, chosen so the exact result sits on .4999,
  // .5000 and .5001 of a paise.
  assert.strictEqual(M.stageBase(14999, 1), 1, '1.4999 rounds down');
  assert.strictEqual(M.stageBase(15000, 1), 2, '1.5000 rounds up');
  assert.strictEqual(M.stageBase(15001, 1), 2, '1.5001 rounds up');

  // Banker's rounding would send 2.5 to 2. Half-up sends it to 3.
  assert.strictEqual(M.stageBase(25000, 1), 3, '2.5000 rounds up, not to even');
  assert.strictEqual(M.stageBase(35000, 1), 4, '3.5000 rounds up, not to even');
});

test('the result is always a whole number of paise', () => {
  for (const v of [1, 7, 99, 100000001, 123456789, AGV]) {
    for (const bp of SCHEDULE) {
      const r = M.stageBase(v, bp);
      assert.ok(Number.isInteger(r), `${v} x ${bp}bp gave ${r}`);
    }
  }
});

test('intermediates are exact, not floating point', () => {
  // Verified against BigInt arithmetic done here, independently.
  const half = (num, den) => {           // half-up, in BigInt
    const q = num / den, r = num % den;
    return r * 2n >= den ? q + 1n : q;
  };
  for (const v of [99999999999999, 12345678901234, 100000000000001]) {
    for (const bp of [777, 1500, 800]) {
      const want = half(BigInt(v) * BigInt(bp), 10000n);
      assert.strictEqual(BigInt(M.stageBase(v, bp)), want, `${v} x ${bp}bp`);
    }
  }
});

// ------------------------------------------------------------ stage schedule

test('the ten stages are a hundred per cent of the agreement value', () => {
  assert.strictEqual(SCHEDULE.length, 10);
  assert.strictEqual(SCHEDULE.reduce((a, b) => a + b, 0), 10000,
    'the basis points sum to 10000, which is the schedule being complete');
});

test('stage by stage, the schedule sums to the agreement value to the paise', () => {
  const each = M.stageBases(AGV, SCHEDULE);
  const sum = each.reduce((a, b) => a + b, 0);

  // The acceptance line: no drift across the ten stages.
  assert.strictEqual(sum, AGV,
    `the ten stages summed to ${sum}, the agreement value is ${AGV}`);

  // And the individual figures are the ones the screens show.
  assert.strictEqual(each[0], 320000000, 'booking, 10 per cent, Rs 32,00,000');
  assert.strictEqual(each[1], 480000000, 'agreement, 15 per cent, Rs 48,00,000');
  assert.strictEqual(each[8], 256000000, 'flooring, 8 per cent, Rs 25,60,000');
  assert.strictEqual(each[9], 224000000, 'handover, 7 per cent, Rs 22,40,000');
});

test('every agreement value in the database schedules without drift', async () => {
  // The guard. Every villa in this project is on the same figure today, but a
  // villa seeded on any other value must schedule exactly too.
  const rows = await asUser(OFFICE, c =>
    c.query('SELECT DISTINCT agreement_value_paise v FROM units'));
  assert.ok(rows.rows.length > 0, 'there are villas to check');

  for (const { v } of rows.rows) {
    const sum = M.stageBases(v, SCHEDULE).reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, Number(v),
      `agreement value ${v} schedules to ${sum}, a drift of ${sum - Number(v)} paise`);
  }
});

test('awkward agreement values schedule exactly, because the last stage absorbs', () => {
  // Each of these drifted before the residual was introduced: 100000001 was a
  // paise short, 999999999 a paise over, 333333333 two short. The last stage
  // is now the agreement value minus the other nine, so none of them can.
  const AWKWARD = [
    100000001, 999999999, 333333333, 123456789, 1, 7, 99, 3200000001,
    10000000003, 55555555555, 2, 13, 199999999, 700000001,
  ];
  for (const v of AWKWARD) {
    const bases = M.stageBases(v, SCHEDULE);
    assert.strictEqual(bases.length, 10);
    assert.strictEqual(bases.reduce((a, b) => a + b, 0), v,
      `agreement value ${v} did not schedule exactly`);
  }
});

test('stages one to nine are untouched; only the last one absorbs', () => {
  const v = 100000001;
  const bases = M.stageBases(v, SCHEDULE);

  // The first nine are exactly what pricing a stage on its own gives.
  for (let i = 0; i < 9; i++) {
    assert.strictEqual(bases[i], M.stageBase(v, SCHEDULE[i]),
      `stage ${i + 1} was re-priced when it should not have been`);
  }
  // And the last differs from its isolated figure by exactly the old drift.
  const alone = M.stageBase(v, SCHEDULE[9]);
  assert.strictEqual(bases[9], alone + 1,
    'the residual is the paise the first nine left behind');
});

test('a schedule that already lands exactly is not disturbed', () => {
  // The seeded value divides cleanly, so the residual must equal the figure
  // the last stage had before. Nothing anyone has been billed changes.
  const bases = M.stageBases(AGV, SCHEDULE);
  for (let i = 0; i < SCHEDULE.length; i++) {
    assert.strictEqual(bases[i], M.stageBase(AGV, SCHEDULE[i]),
      `stage ${i + 1} moved on an agreement value that never drifted`);
  }
});

test('a schedule of any length works, not just ten', () => {
  for (const bps of [[10000], [5000, 5000], [3333, 3333, 3334]]) {
    const v = 100000001;
    assert.strictEqual(M.stageBases(v, bps).reduce((a, b) => a + b, 0), v);
  }
});

// ------------------------------------------------------------------ GST

test('GST is five per cent of the base', () => {
  assert.strictEqual(M.gstOn(320000000), 16000000, 'Rs 32,00,000 -> Rs 1,60,000');
  assert.strictEqual(M.GST_BP, 500);
});

test('GST is charged on the base plus the finish upgrades together', () => {
  const base = M.stageBase(AGV, 1000);            // 320000000
  const extras = 45000000;                        // Rs 4,50,000 of upgrades

  const p = M.priceStage({ agreementValuePaise: AGV, pctBp: 1000, extrasPaise: extras });

  assert.strictEqual(p.basePaise, base);
  assert.strictEqual(p.extrasPaise, extras);
  assert.strictEqual(p.gstPaise, M.gstOn(base + extras),
    'GST rides on the upgrades too, because they ride on this demand');
  assert.strictEqual(p.gstPaise, 18250000, 'five per cent of Rs 3,65,00,000');
  assert.strictEqual(p.totalPaise, base + extras + p.gstPaise);
  assert.strictEqual(p.totalPaise, 383250000);
});

test('with no upgrades the total is base plus GST and nothing else', () => {
  const p = M.priceStage({ agreementValuePaise: AGV, pctBp: 1000 });
  assert.strictEqual(p.basePaise, 320000000);
  assert.strictEqual(p.extrasPaise, 0);
  assert.strictEqual(p.gstPaise, 16000000);
  assert.strictEqual(p.totalPaise, 336000000, 'Rs 33,60,000, the figure the smoke test sees');
});

test('a demand falls due on the fourteenth day', () => {
  const raised = new Date('2026-09-06T00:00:00Z');
  const p = M.priceStage({ agreementValuePaise: AGV, pctBp: 1000, raisedAt: raised });
  assert.strictEqual(M.DUE_DAYS, 14);
  assert.strictEqual((p.dueAt - raised) / 86400000, 14);
  assert.strictEqual(p.dueAt.toISOString(), '2026-09-20T00:00:00.000Z');
});

// ------------------------------------------------------------------ interest

test('interest is zero on the due date and before it', () => {
  const due = new Date('2026-09-20T00:00:00Z');
  const d = { total_paise: 336000000, due_at: due };

  assert.strictEqual(M.interestOn(d, new Date('2026-09-06T00:00:00Z')), 0, 'a fortnight early');
  assert.strictEqual(M.interestOn(d, new Date('2026-09-19T23:59:59Z')), 0, 'the day before');
  assert.strictEqual(M.interestOn(d, due), 0, 'on the due date itself');
  assert.strictEqual(M.payableNow(d, due), 336000000, 'so only the principal is payable');
});

test('interest starts the day after the due date', () => {
  const due = new Date('2026-09-20T00:00:00Z');
  const d = { total_paise: 336000000, due_at: due };
  const oneDay = new Date('2026-09-21T00:00:00Z');

  // 336000000 x 1200bp x 1 day / (10000 x 365), half-up.
  //   = 403200000000 / 3650000 = 110465.75...  ->  110466
  assert.strictEqual(M.interestOn(d, oneDay), 110466);
  assert.strictEqual(M.payableNow(d, oneDay), 336000000 + 110466);
  assert.strictEqual(M.INTEREST_BP_PER_YEAR, 1200);
});

test('a part day past due is not yet a day of interest', () => {
  // Added after a mutation audit: floor() could become ceil() and no test
  // noticed, which would have charged a full day's interest to anyone paying
  // an hour late. Whole days only, and never a negative amount.
  const due = new Date('2026-09-20T00:00:00Z');
  const d = { total_paise: 336000000, due_at: due };
  const at = ms => M.interestOn(d, new Date(due.getTime() + ms));

  assert.strictEqual(at(60 * 1000), 0, 'a minute late is not a day');
  assert.strictEqual(at(12 * 3600 * 1000), 0, 'half a day late is not a day');
  assert.strictEqual(at(23 * 3600 * 1000 + 3599 * 1000), 0, 'a second short of a day is not a day');
  assert.strictEqual(at(24 * 3600 * 1000), 110466, 'a full day is a day');
  assert.strictEqual(at(47 * 3600 * 1000), 110466, 'and stays one day until the second');
  assert.strictEqual(at(48 * 3600 * 1000), 220932, 'then two');

  // Never negative, however far before the due date.
  for (const ms of [-1000, -3600 * 1000, -30 * 86400000, -400 * 86400000]) {
    assert.strictEqual(at(ms), 0, `interest at ${ms}ms from due must be zero, never negative`);
  }
});

test('interest is simple, so a year of it is twelve per cent of the total', () => {
  const due = new Date('2026-01-01T00:00:00Z');
  const d = { total_paise: 336000000, due_at: due };
  const year = new Date('2027-01-01T00:00:00Z');   // 365 days

  assert.strictEqual(M.interestOn(d, year), 40320000, 'twelve per cent of Rs 33,60,000');

  // Simple, not compounding. 2026 and 2027 are both common years, so this is
  // 730 days: exactly twice the above, with nothing accruing on the interest.
  const two = new Date('2028-01-01T00:00:00Z');
  assert.strictEqual((two - due) / 86400000, 730);
  assert.strictEqual(M.interestOn(d, two), 40320000 * 2);
});

// ------------------------------------------------------------------- ledger

test('paid plus demanded plus remaining is the agreement value with GST', () => {
  const stages = SCHEDULE.map((pct_bp, i) => ({
    pct_bp,
    status: i < 4 ? 'paid' : i < 6 ? 'demanded' : 'pending',
  }));

  const led = M.ledger({ agreementValuePaise: AGV, stages });
  const total = led.paidPaise + led.demandedPaise + led.remainingPaise;

  const withGst = AGV + M.gstOn(AGV);
  assert.strictEqual(withGst, 3360000000, 'Rs 3.2 Cr plus five per cent');
  assert.strictEqual(total, withGst,
    `the ledger totals ${total}, the agreement value with GST is ${withGst}`);

  // And the split is where the stages say it is.
  const sumOf = idx => idx.reduce((n, i) => {
    const b = M.stageBase(AGV, SCHEDULE[i]);
    return n + b + M.gstOn(b);
  }, 0);
  assert.strictEqual(led.paidPaise, sumOf([0, 1, 2, 3]));
  assert.strictEqual(led.demandedPaise, sumOf([4, 5]));
  assert.strictEqual(led.remainingPaise, sumOf([6, 7, 8, 9]));
});

test('the ledger of the seeded villa balances against its own stages', async () => {
  const u = (await asUser(OFFICE, c => c.query(
    `SELECT id, agreement_value_paise FROM units WHERE code='B-14'`))).rows[0];
  const stages = (await asUser(OFFICE, c => c.query(
    `SELECT s.status, t.pct_bp FROM unit_stages s
       JOIN stage_templates t ON t.code = s.stage_code
      WHERE s.unit_id = $1`, [u.id]))).rows;

  assert.strictEqual(stages.length, 10);
  const led = M.ledger({ agreementValuePaise: u.agreement_value_paise, stages });
  const total = led.paidPaise + led.demandedPaise + led.remainingPaise;
  assert.strictEqual(total, u.agreement_value_paise + M.gstOn(u.agreement_value_paise));
});

// ------------------------------------------------------------------ display

test('money prints in the Indian grouping, with the rupee sign', () => {
  assert.strictEqual(M.money(336000000), '₹33,60,000', 'lakhs group in twos');
  assert.strictEqual(M.money(3200000000), '₹3,20,00,000');
  assert.strictEqual(M.money(0), '₹0');
  assert.strictEqual(M.money(100), '₹1');
});

test('the short form is crores and lakhs, as the prototype writes them', () => {
  // The prototype's own formatter is
  //   n>=1e7 ? (n/1e7).toFixed(2)+' Cr' : (n/1e5).toFixed(1)+' L'
  // so a crore figure carries two decimals. Rs 3.2 Cr prints as 3.20 Cr.
  assert.strictEqual(M.crore(3200000000), '₹3.20 Cr');
  assert.strictEqual(M.crore(336000000), '₹33.6 L');
  assert.strictEqual(M.crore(10000), '₹100', 'below a lakh it falls back to full rupees');
});
