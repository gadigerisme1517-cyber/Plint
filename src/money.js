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

/** base for a stage = agreement value x stage percentage */
function stageBase(agreementValuePaise, pctBp) {
  return divRound(BigInt(agreementValuePaise) * BigInt(pctBp), 10000n);
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
function priceStage({ agreementValuePaise, pctBp, extrasPaise = 0, raisedAt = new Date() }) {
  const base = stageBase(agreementValuePaise, pctBp);
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
  let paid = 0, demanded = 0, remaining = 0;
  for (const s of stages) {
    const base = stageBase(agreementValuePaise, s.pct_bp);
    const withGst = base + gstOn(base);
    if (s.status === 'paid') paid += withGst;
    else if (s.status === 'demanded') demanded += withGst;
    else remaining += withGst;
  }
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
  priceStage, interestOn, payableNow, ledger, stageBase, gstOn,
  money, crore, longDate,
};
