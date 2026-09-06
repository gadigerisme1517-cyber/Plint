'use strict';
/* ============================================================================
   The calculation layer.

   Every rupee figure shown on any screen, written into any database row, or
   printed into any PDF is produced here. Screens receive formatted strings and
   render them. Documents receive formatted strings and print them. Neither
   multiplies, adds, or rounds anything.

   All arithmetic is in integer paise. No floating point touches money.
   ========================================================================= */

const GST_BP = 500;              // 5% on the construction component
const DUE_DAYS = 14;             // demand is due on the fourteenth day
const INTEREST_BP_PER_YEAR = 1200; // 12% a year after the due date
const DAYS_IN_YEAR = 365;

/**
 * Base for a stage taken in isolation = agreement value x stage percentage.
 *
 * This is the right figure for stages one to nine and the wrong one for the
 * last, because ten independently rounded stages need not sum to the
 * agreement value. Price a whole schedule with stageBases below; this is
 * exported for that function, and for tests that reason about one stage.
 */
function stageBase(agreementValuePaise, pctBp) {
  return divRound(BigInt(agreementValuePaise) * BigInt(pctBp), 10000n);
}

/**
 * Bases for a whole schedule, in schedule order.
 *
 * Stages one to nine are priced as above. The last stage is the residual:
 * the agreement value minus everything already allocated. A buyer therefore
 * pays exactly the value he agreed, whatever the agreement value is and
 * however the percentages round, and the last stage absorbs at most a few
 * paise of difference.
 *
 * ORDER MATTERS. Pass the stages in schedule order, or the residual lands on
 * the wrong one.
 */
function stageBases(agreementValuePaise, orderedPctBps) {
  // A malformed schedule must stop here rather than quietly price a stage on
  // its own. A hole in this array - a missing seq, a project whose templates
  // did not load - would otherwise become a wrong figure on a demand letter,
  // and a wrong figure that looks right is the worst outcome available.
  if (!Array.isArray(orderedPctBps) || orderedPctBps.length === 0) {
    throw new TypeError('stageBases needs the whole schedule, in order');
  }
  // An index loop, not forEach: forEach skips holes, and a hole is precisely
  // what a missing seq produces when a schedule is built by assigning into an
  // array by index. Skipping it would let the hole through to be priced.
  for (let i = 0; i < orderedPctBps.length; i++) {
    const bp = orderedPctBps[i];
    if (!Number.isInteger(bp) || bp <= 0) {
      throw new TypeError(`stage ${i} of the schedule is not a positive basis point: ${bp}`);
    }
  }
  const agv = Number(agreementValuePaise);
  if (!Number.isInteger(agv) || agv <= 0) {
    throw new TypeError(`agreement value is not a positive integer of paise: ${agreementValuePaise}`);
  }

  const out = [];
  let allocated = 0;
  for (let i = 0; i < orderedPctBps.length; i++) {
    if (i === orderedPctBps.length - 1) {
      out.push(agv - allocated);
    } else {
      const b = stageBase(agv, orderedPctBps[i]);
      out.push(b);
      allocated += b;
    }
  }
  return out;
}

/** Every stage's money for one unit, in schedule order. */
function schedule(agreementValuePaise, orderedPctBps) {
  return stageBases(agreementValuePaise, orderedPctBps).map((basePaise, i) => {
    const gstPaise = gstOn(basePaise);
    return { pctBp: orderedPctBps[i], basePaise, gstPaise, totalPaise: basePaise + gstPaise };
  });
}

function gstOn(basePaise) {
  return divRound(BigInt(basePaise) * BigInt(GST_BP), 10000n);
}

/** banker-free, half-up rounding on integers */
function divRound(num, den) {
  const q = num / den, r = num % den;
  return Number(r * 2n >= den ? q + 1n : q);
}

function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

/**
 * The one function that prices a stage. Everything else calls this.
 * extrasPaise: buyer's finish upgrades above allowance, which ride on the next
 * demand rather than a separate bill.
 */
function priceStage({ agreementValuePaise, pctBp, scheduleBps, index,
                      extrasPaise = 0, raisedAt = new Date() }) {
  // Given the whole schedule, the stage is priced within it, so the last one
  // carries the residual. That is the form certification uses. Given a single
  // percentage and no schedule, it is priced alone, which is correct only for
  // a stage genuinely considered on its own.
  //
  // What must never happen is falling from the first form into the second
  // because a schedule failed to load: that silently under- or over-prices the
  // last stage of a villa. So a half-given first form is an error, not a
  // fallback.
  let base;
  if (scheduleBps !== undefined || index !== undefined) {
    if (!Array.isArray(scheduleBps)) {
      throw new TypeError('priceStage was given an index but no schedule');
    }
    if (!Number.isInteger(index) || index < 0 || index >= scheduleBps.length) {
      throw new RangeError(
        `priceStage index ${index} is outside a schedule of ${scheduleBps.length}`);
    }
    base = stageBases(agreementValuePaise, scheduleBps)[index];
  } else {
    if (!Number.isInteger(pctBp) || pctBp <= 0) {
      throw new TypeError('priceStage needs either a schedule and an index, or a pctBp');
    }
    base = stageBase(agreementValuePaise, pctBp);
  }
  const gst = gstOn(base + extrasPaise);
  const total = base + extrasPaise + gst;
  const dueAt = addDays(raisedAt, DUE_DAYS);
  return {
    basePaise: base,
    extrasPaise,
    gstPaise: gst,
    totalPaise: total,
    raisedAt,
    dueAt,
    gstRate: '5%',
    dueDays: DUE_DAYS,
    interestRate: '12% a year',
  };
}

/** interest accrued on an unpaid demand, zero until the day after due date */
function interestOn(demand, asOf = new Date()) {
  const overdueDays = Math.floor((asOf - new Date(demand.due_at)) / 86400000);
  if (overdueDays <= 0) return 0;
  return divRound(
    BigInt(demand.total_paise) * BigInt(INTEREST_BP_PER_YEAR) * BigInt(overdueDays),
    10000n * BigInt(DAYS_IN_YEAR)
  );
}

/** total actually payable today on an open demand, principal plus any interest */
function payableNow(demand, asOf = new Date()) {
  return Number(demand.total_paise) + interestOn(demand, asOf);
}

/** what the buyer has paid, what has been demanded, what is not yet due */
function ledger({ agreementValuePaise, stages }) {
  // stages must arrive in schedule order: the last one carries the residual.
  const priced = schedule(agreementValuePaise, stages.map(s => s.pct_bp));
  let paid = 0, demanded = 0, remaining = 0;
  stages.forEach((s, i) => {
    const withGst = priced[i].totalPaise;
    if (s.status === 'paid') paid += withGst;
    else if (s.status === 'demanded') demanded += withGst;
    else remaining += withGst;
  });
  return { paidPaise: paid, demandedPaise: demanded, remainingPaise: remaining };
}

// ------------------------------------------------------------------ display
const INR = new Intl.NumberFormat('en-IN');

/** ₹1,23,45,678 */
function money(paise) {
  return '\u20B9' + INR.format(Math.round(paise / 100));
}

/** ₹3.2 Cr / ₹4.5 L, the short form the prototype uses in dense lists */
function crore(paise) {
  const r = paise / 100;
  if (r >= 10000000) return '\u20B9' + (r / 10000000).toFixed(r >= 100000000 ? 0 : 2).replace(/\.00$/, '') + ' Cr';
  if (r >= 100000) return '\u20B9' + (r / 100000).toFixed(1).replace(/\.0$/, '') + ' L';
  return money(paise);
}

const DATE = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' };
const longDate = d => new Date(d).toLocaleDateString('en-IN', DATE);

module.exports = {
  GST_BP, DUE_DAYS, INTEREST_BP_PER_YEAR,
  priceStage, interestOn, payableNow, ledger,
  stageBase, stageBases, schedule, gstOn,
  money, crore, longDate,
};
