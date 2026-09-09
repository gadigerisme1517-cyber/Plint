'use strict';
/* ============================================================================
   ONE FIGURE, ONE NUMBER.

   The Lenders KPI "Owed to us" and the dashboard's "Receivable from lenders"
   are the same quantity - what the lenders have been billed and have not paid.
   For one build they read Rs 20.39 Cr and Rs 20.38 Cr, because one was summed
   from what its rows print and the other was a single SQL total. A lakh apart,
   on two screens, one click from each other.

   Nothing in the suite would have caught it. This does.

   THE RULE IT HOLDS: a quantity that appears on more than one screen carries
   the same number on all of them, and a total printed above its own rows
   equals those rows. Where two screens genuinely show different quantities
   they must not share a label - that is checked too.

   Every figure covered is named below. Adding a shared figure without adding
   it here is the way this test goes quietly out of date, so the list is the
   point of the file.
   ========================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../src/db');

const PORT = 3244, BASE = 'http://127.0.0.1:' + PORT;
const server = require('../src/server');

let cookie;
before(async () => {
  await new Promise(r => server.listen(PORT, r));
  const r = await fetch(BASE + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'priya@nvt.in', pw: 'plint' }),
  });
  const raw = r.headers.get('set-cookie');
  assert.ok(raw, 'the office could not sign in');
  cookie = raw.split(';')[0];
});
after(async () => {
  await new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  await pool.end();
});

const get = async p => {
  const r = await fetch(BASE + p, { headers: { cookie } });
  assert.strictEqual(r.status, 200, p + ' -> HTTP ' + r.status);
  return r.text();
};

/** A printed rupee figure, in rupees, with Cr and L expanded. */
function rupees(s) {
  const m = /₹([\d,]+(?:\.\d+)?)\s*(Cr|L)?/.exec(String(s));
  if (!m) return null;
  let v = Number(m[1].replace(/,/g, ''));
  if (m[2] === 'Cr') v *= 10000000;
  else if (m[2] === 'L') v *= 100000;
  /* To the rupee. "2.51 Cr" times ten million is 25099999.999999996 in binary
     floating point, so an exact comparison against 1.27 Cr + 1.24 Cr failed on
     an escrow account that balances perfectly. The figures on the screen are
     whole rupees; the test compares whole rupees. */
  return Math.round(v);
}

/** The value of a named KPI tile on a screen. */
function kpi(html, label) {
  const m = new RegExp('<\\/svg> ' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + '<\\/div><b class="num">([^<]*)<').exec(html);
  return m ? { shown: m[1].trim(), value: rupees(m[1]) } : null;
}

/** Every figure printed in a table's bold money column. */
const columnOf = html =>
  [...html.matchAll(/<span class="num" style="font-weight:700">(₹[^<]*)<\/span>/g)]
    .map(m => rupees(m[1])).filter(v => v !== null);

/* ---------------------------------------------------------------------------
   THE SHARED FIGURES. Each entry is one quantity, and every screen that
   prints it, by the label it prints it under.
   ------------------------------------------------------------------------ */
const SHARED = [
  {
    quantity: 'billed to lenders and not yet paid',
    on: [
      ['/office', 'Receivable from lenders'],
      ['/office/lenders', 'Owed to us'],
    ],
  },
  {
    quantity: 'marked on site, not yet certified, and therefore not billable',
    on: [
      ['/office/signoff', 'Value held up'],
      ['/office', null],   // the dashboard hero, which has no KPI label
    ],
  },
];

test('a figure on two screens carries the same number on both', async () => {
  const pages = {};
  for (const p of ['/office', '/office/lenders', '/office/signoff']) pages[p] = await get(p);

  // billed to lenders and not yet paid
  const a1 = kpi(pages['/office'], 'Receivable from lenders');
  const a2 = kpi(pages['/office/lenders'], 'Owed to us');
  assert.ok(a1 && a2, 'one of the two lender figures is no longer on its screen');
  assert.strictEqual(a1.shown, a2.shown,
    'the same money reads "' + a1.shown + '" on the dashboard and "' + a2.shown
    + '" on Lenders');

  // marked on site and not yet certified
  const hero = /<div class="big num">([^<]*)</.exec(pages['/office']);
  const held = kpi(pages['/office/signoff'], 'Value held up');
  assert.ok(hero && held, 'the waiting-on-evidence figure is no longer on both screens');
  assert.strictEqual(hero[1].trim(), held.shown,
    'the money waiting on evidence reads "' + hero[1].trim() + '" on the dashboard and "'
    + held.shown + '" on the sign-off queue');
});

test('a total printed above its own rows equals those rows', async () => {
  /* This is the half a shared-figure check cannot see: a headline can agree
     with the other screen and still disagree with the column underneath it.

     WHAT "EQUALS" MEANS HERE, AND WHY IT IS NOT "TO THE RUPEE".

     This test first demanded the headline equal the sum of its rows to the
     rupee, and Ready to send failed it: forty-seven packs printed in lakhs to
     two decimals sum to Rs 15,74,74,000, and no figure printed in crores to
     two decimals can say that - the nearest it can say is Rs 15.75 Cr. The
     assertion was arithmetically impossible, not the code broken; Lenders only
     passed it because every one of its rows is already a whole number of lakhs.

     So the rule is stated at the precision the product prints: TAKE THE ROWS
     AS THEY ARE SHOWN, ADD THEM, PRINT THAT THE WAY THE HEADLINE IS PRINTED,
     AND YOU MUST GET THE HEADLINE. A lakh of drift still fails it, which is
     the fault this file exists for. */
  const M = require('../src/money');
  const asHeadline = rupeeSum => M.crore(Math.round(rupeeSum) * 100);

  const lenders = await get('/office/lenders');
  const owed = kpi(lenders, 'Owed to us');
  const rows = columnOf(lenders);
  assert.ok(rows.length > 1, 'the lenders table has ' + rows.length + ' money rows to sum');
  const summed = rows.reduce((a, b) => a + b, 0);
  assert.strictEqual(owed.shown, asHeadline(summed),
    'Owed to us is ' + owed.shown + ' over ' + rows.length + ' rows that print '
    + asHeadline(summed) + ' when added up');

  /* No screen is allowed to be skipped for having no rows: the count beside
     the money says how many rows there should be, and it is checked. An empty
     Ready to send is a real state and it still has to print zero. */
  const count = (html, label) => {
    const m = new RegExp('<\\/svg> ' + label + '<\\/div><b class="num">(\\d+)<').exec(html);
    assert.ok(m, 'the "' + label + '" count is no longer on its screen');
    return Number(m[1]);
  };

  for (const [path, total, counted] of [['/office/packs', 'Value in them', 'Packs waiting'],
                                        ['/office/wait', 'Money out there', 'Packs out']]) {
    const html = await get(path);
    const headline = kpi(html, total);
    const rows = columnOf(html);
    assert.ok(headline, total + ' is no longer on ' + path);
    assert.strictEqual(rows.length, count(html, counted),
      path + ' says ' + counted + ' ' + count(html, counted) + ' and prints '
      + rows.length + ' money rows');
    const sum = rows.reduce((a, b) => a + b, 0);
    assert.strictEqual(headline.shown, asHeadline(sum),
      total + ' is ' + headline.shown + ' over ' + rows.length + ' rows on ' + path
      + ' that print ' + asHeadline(sum) + ' when added up');
  }
});

test('the escrow account balances on its own screen', async () => {
  const h = await get('/office/escrow');
  const held = kpi(h, 'Held now'), inn = kpi(h, 'Paid in'), out = kpi(h, 'Drawn down');
  assert.ok(held && inn && out, 'one of the three escrow figures has gone');
  assert.strictEqual(inn.value - out.value, held.value,
    'paid in ' + inn.shown + ' minus drawn down ' + out.shown + ' is not held now '
    + held.shown);
});

test('two screens showing different quantities do not share a label', async () => {
  /* The other way this goes wrong: not two numbers under one label, but one
     label over two different things. Every money KPI label in the console is
     collected, and a label used on more than one screen must be a quantity
     listed in SHARED - which means somebody decided the two are the same. */
  const SCREENS = ['/office', '/office/packs', '/office/wait', '/office/query',
                   '/office/chase', '/office/stages', '/office/signoff', '/office/villas',
                   '/office/escrow', '/office/lenders', '/office/schedule',
                   '/office/documents', '/office/silent', '/office/evidence'];
  const seen = new Map();
  for (const p of SCREENS) {
    const h = await get(p);
    for (const m of h.matchAll(/<\/svg> ([^<]+)<\/div><b class="num">([^<]*)</g)) {
      const label = m[1].trim(), shown = m[2].trim();
      if (rupees(shown) === null) continue;              // a count, not money
      if (!seen.has(label)) seen.set(label, []);
      seen.get(label).push({ screen: p, shown });
    }
  }
  const agreed = new Set(SHARED.flatMap(s => s.on.map(o => o[1])).filter(Boolean));
  const clashes = [];
  for (const [label, uses] of seen) {
    if (uses.length < 2) continue;
    const distinct = new Set(uses.map(u => u.shown));
    if (distinct.size === 1) continue;                   // same label, same number
    if (agreed.has(label)) continue;                     // a decided pair
    clashes.push(label + ': ' + uses.map(u => u.screen + ' ' + u.shown).join(' vs '));
  }
  assert.deepStrictEqual(clashes, [],
    'one label over two different figures:\n  ' + clashes.join('\n  '));
});
