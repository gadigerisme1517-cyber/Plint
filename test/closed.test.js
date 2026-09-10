'use strict';
/* ============================================================================
   THE OPEN LIST, CLOSED.

   Six things this product had been carrying, each named in its own pass report
   and each left half-built. A half-built thing is worse than an absent one: it
   reads as finished from the outside, and the report that named it stops being
   read after the second pass.

     * `notifications` had a policy, an insert path and TWO LIVE WRITERS - the
       engineer reporting a delay, this console asking a quiet villa for a
       photograph - and no reader on any of the three surfaces. Both writers
       told the person pressing the button that somebody would see it.
     * `src/audit.js` was referenced by one test and by nothing in the product:
       the record that protects everybody could not be read from any screen.
     * Loan disbursement was untracked. `units.sanction_paise` said what a
       lender had agreed and nothing said what they had released.
     * An interior option had no price, and `demands.extras_paise` - a column
       since the first migration, with GST charged on it since the money layer
       was written - was zero on every demand this product had ever raised.
     * There was no plan, no floor plan and no RERA registration anywhere, on
       any screen, for anybody.
     * Three questions were named as the builder's and then simply absent,
       which on screen is indistinguishable from nobody having thought of them.

   These tests are what stops each one going quiet again.
   ========================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');

const { asUser, pool } = require('../src/db');
const config = require('../src/config');
const M = require('../src/money');
const AUDIT = require('../src/audit');

const PORT = 3253, BASE = 'http://127.0.0.1:' + PORT;
const server = require('../src/server');

const OFFICE = { id: 'u-office', role: 'office', name: 'Priya Menon' };
const BUYER = { id: 'u-buyer-b14', role: 'buyer', unit: 'B-14' };
const ENGINEER = { id: 'u-eng-ram', role: 'engineer', name: 'S. Ramachandran' };

let owner;
const cookies = {};
before(async () => {
  await new Promise(r => server.listen(PORT, r));
  owner = new Client(config.adminDb());
  await owner.connect();
  await owner.query('SET search_path = plint, public');
  for (const [role, email] of [['office', 'priya@nvt.in'],
                               ['engineer', 'ramachandran@nvt.in'],
                               ['buyer', 'arjun@example.in']]) {
    const r = await fetch(BASE + '/login', {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, pw: 'plint' }),
    });
    const c = r.headers.get('set-cookie');
    assert.ok(c, role + ' could not sign in');
    cookies[role] = c.split(';')[0];
  }
});
after(async () => {
  /* THIS FILE IS THE ONLY THING IN THE SUITE THAT RECORDS A POLICY DECISION,
     and all three topics are unanswered in the shipped product. It clears up
     here rather than at the end of the test that makes them, so a failure
     anywhere in between still leaves the database as it found it - otherwise
     the next run finds a decision nobody made, which is exactly what the first
     test in that section exists to catch. */
  await owner.query("DELETE FROM policy_decisions").catch(() => {});
  await owner.end().catch(() => {});
  await new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  await pool.end();
});

const get = async (p, role) => {
  const r = await fetch(BASE + p, { headers: { cookie: cookies[role] } });
  return { status: r.status, html: await r.text() };
};
const post = async (p, role, fields) => {
  const r = await fetch(BASE + p, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: cookies[role], 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  const m = /[?&]m=([^&]*)/.exec(r.headers.get('location') || '');
  return { status: r.status, loc: r.headers.get('location') || '',
           msg: m ? decodeURIComponent(m[1]) : null };
};
const rows = (who, sql, args) => asUser(who, c => c.query(sql, args).then(r => r.rows));

// ------------------------------------------------------ 1. notifications

test('every role has a screen that reads its own notifications', async () => {
  for (const [role, path] of [['buyer', '/news'], ['engineer', '/engineer/news'],
                              ['office', '/office/news']]) {
    const r = await get(path, role);
    assert.strictEqual(r.status, 200, role + ' has no reader at ' + path);
    /* Not merely a 200: the component has to be on the page, either with rows
       in it or with the empty state that says what would appear there. */
    assert.ok(/class="ntl"|class="empty"/.test(r.html),
      role + "'s notification screen renders neither a notice nor an empty state");
  }
});

test('the office reads what the site sends it, and the site does not', async () => {
  const mine = await rows(OFFICE, "SELECT count(*)::int n FROM notifications");
  assert.ok(mine[0].n > 0, 'the seed holds no office notification, so this proves nothing');
  const h = (await get('/office/news', 'office')).html;
  const shown = (h.match(/class="nt(?: ntread)?"/g) || []).length;
  assert.strictEqual(shown, mine[0].n,
    'the office is shown ' + shown + ' of ' + mine[0].n + ' notifications');
  /* And a notification reaches one role and stays there. The site now has
     notifications of its own, so "the engineer reads nothing" is no longer the
     property - the property is that everything the engineer reads is addressed
     to the engineer, and that the office's own rows are not among them. */
  const theirs = await rows(ENGINEER, 'SELECT for_role FROM notifications');
  assert.ok(theirs.length, 'the site has no notifications, so this proves nothing');
  assert.deepStrictEqual([...new Set(theirs.map(r => r.for_role))], ['engineer'],
    'the site can read what was addressed to somebody else');
});

test('reporting a delay tells the buyer, which is what the screen has always claimed',
  async () => {
    /* The engineer's Problem tab says "<buyer> is told the stage has moved and
       why, the same day". The delay went to `blockers`, which a buyer's policy
       does not let them read, and to a notification addressed to the office.
       The buyer was told nothing at all. */
    const before = (await rows(BUYER, 'SELECT count(*)::int n FROM notifications'))[0].n;
    const r = await post('/engineer/flag', 'engineer', {
      code: 'B-14', reason: 'Material not delivered',
      detail: 'Blocks ordered 28 August, vendor now says 12 September.',
    });
    assert.match(r.msg || '', /reported/i, 'the delay was not reported: ' + r.msg);

    const after = await rows(BUYER,
      `SELECT title, detail FROM notifications ORDER BY created_at DESC LIMIT 1`);
    assert.strictEqual(
      (await rows(BUYER, 'SELECT count(*)::int n FROM notifications'))[0].n, before + 1,
      'the buyer was not told their own stage had stopped');
    assert.match(after[0].title, /stopped/i);
    /* In the buyer's words, not the site's: they are not told which trade is
       short, they are told their villa has stopped and that nothing is billed. */
    assert.match(after[0].detail, /nothing is billed/i);

    const h = (await get('/news', 'buyer')).html;
    assert.ok(h.includes('stopped'), "the buyer's own screen does not show it");
  });

test('marking one read is a write that works, and only on your own', async () => {
  const one = (await rows(OFFICE,
    'SELECT id FROM notifications WHERE read_at IS NULL LIMIT 1'))[0];
  assert.ok(one, 'nothing unread to mark');
  const r = await post('/notice/read', 'office', { id: one.id });
  assert.match(r.msg || '', /marked read/i);
  const still = await rows(OFFICE, 'SELECT read_at FROM notifications WHERE id = $1', [one.id]);
  assert.ok(still[0].read_at, 'it was not marked read');

  /* Another role cannot mark it: the policy is the boundary, not the handler. */
  const theirs = await post('/notice/read', 'buyer', { id: one.id });
  assert.match(theirs.msg || '', /already read, or is not yours/i);
});

// -------------------------------------------------------- 2. the audit log

test('the audit trail is readable from a screen, not only from a test', async () => {
  const trail = await asUser(OFFICE, c => AUDIT.forUnit(c, 'unit-B-14'));
  assert.ok(trail.length > 0, 'B-14 has no audit rows, so this proves nothing');
  const h = (await get('/office/villa/B-14', 'office')).html;
  assert.match(h, /Everything done to this file/,
    'the villa file does not show the trail');
  /* Every kind of row it holds has a sentence, not a database verb. */
  for (const a of trail.slice(0, 10)) {
    assert.ok(AUDIT.SAID[a.action],
      'the audit log records "' + a.action + '" and nothing says what that means');
    assert.ok(h.includes(AUDIT.SAID[a.action]),
      'the villa file does not show "' + AUDIT.SAID[a.action] + '"');
  }
});

test('the trail names the person, not their row id', async () => {
  /* The first render of this screen put "u-eng-ram" in the Who column. The id
     is what the log stores, on purpose; `staff_name` is what turns it into
     something the office recognises, and it has to be used here or the column
     is unreadable to the only people allowed to read it. */
  const trail = await asUser(OFFICE, c => AUDIT.forUnit(c, 'unit-B-14'));
  const staff = trail.filter(a => a.actor_role !== 'buyer');
  assert.ok(staff.length, 'no staff rows on B-14, so this proves nothing');
  for (const a of staff) {
    assert.ok(a.actor_name,
      'staff_name resolved nothing for ' + a.actor_id + ', so the screen shows an id');
  }
  const h = (await get('/office/villa/B-14', 'office')).html;
  assert.ok(h.includes(staff[0].actor_name),
    'the villa file does not name ' + staff[0].actor_name);
  assert.ok(!new RegExp('>' + staff[0].actor_id + '<').test(h),
    'the villa file still prints the raw id ' + staff[0].actor_id);
});

test('a buyer and an engineer cannot reach the trail', async () => {
  /* It is the record that protects the buyer and it is deliberately not
     readable from their session: the policy, not this screen, is what says so. */
  assert.strictEqual((await rows(BUYER, 'SELECT count(*)::int n FROM audit_log'))[0].n, 0);
  assert.notStrictEqual((await get('/office/villa/B-14', 'buyer')).status, 200);
});

// ------------------------------------------------- 3. loan disbursement

test('a disbursement is a receipt with a payer, not a second set of figures', async () => {
  const cols = (await rows(OFFICE,
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'plint' AND table_name = 'receipts'`)).map(r => r.column_name);
  assert.ok(cols.includes('payer'), 'a receipt does not say who paid it');
  assert.deepStrictEqual(cols.filter(c => /paise|amount/.test(c)), [],
    'the receipt has acquired a money column of its own');
  /* And there is no disbursements table holding a second amount. */
  const tables = (await rows(OFFICE,
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'plint'`))
    .map(r => r.table_name);
  assert.ok(!tables.includes('disbursements'),
    'there is a disbursements table, which is a second record of the same money');
});

test('the drawdown is derived from the ledger and adds up', async () => {
  const d = (await rows(OFFICE,
    `SELECT * FROM loan_drawdown WHERE code = 'B-14'`))[0];
  assert.ok(d, 'no drawdown row for B-14');
  const settled = (await rows(OFFICE,
    `SELECT coalesce(sum(dm.total_paise), 0)::bigint n
       FROM receipts r JOIN demands dm ON dm.id = r.demand_id
       JOIN unit_stages s ON s.id = dm.unit_stage_id
       JOIN units u ON u.id = s.unit_id
      WHERE u.code = 'B-14' AND r.payer = 'lender'`))[0].n;
  assert.strictEqual(String(d.disbursed_paise), String(settled),
    'the drawdown disagrees with the demands the lender settled');
});

test('recording a payment says who it came from, and the buyer is shown it', async () => {
  const owed = (await rows(OFFICE,
    `SELECT dm.id FROM demands dm
       JOIN unit_stages s ON s.id = dm.unit_stage_id
       JOIN units u ON u.id = s.unit_id
      WHERE u.code = 'B-14' AND dm.paid_at IS NULL ORDER BY dm.due_at LIMIT 1`))[0];
  if (!owed) return;   // every demand on B-14 is settled on this database
  const before = (await rows(OFFICE,
    `SELECT disbursed_paise FROM loan_drawdown WHERE code = 'B-14'`))[0].disbursed_paise;
  const r = await post('/office/receipt', 'office', {
    demand: owed.id, payer: 'lender', mode: 'rtgs',
    reference: 'UTR-TEST-DISB', received: new Date(Date.now() + 5.5 * 3600e3)
      .toISOString().slice(0, 10),
  });
  assert.match(r.msg || '', /disbursement/i, 'it was not recorded as a disbursement');
  const after = (await rows(OFFICE,
    `SELECT disbursed_paise FROM loan_drawdown WHERE code = 'B-14'`))[0].disbursed_paise;
  assert.ok(Number(after) > Number(before), 'the drawdown did not move');

  const h = (await get('/loan', 'buyer')).html;
  assert.match(h, /Released so far/, "the buyer's loan screen does not say what was released");
  assert.ok(h.includes('UTR-TEST-DISB'), 'the buyer is not shown the release');

  /* And on the receipt itself, which is the page a buyer forwards to their
     lender. It said what was paid and not who paid it. */
  const rec = (await rows(BUYER,
    `SELECT receipt_no FROM receipts WHERE demand_id = $1`, [owed.id]))[0];
  assert.ok(rec, 'no receipt was issued against the demand that was settled');
  const rh = (await get('/receipt/' + encodeURIComponent(rec.receipt_no), 'buyer')).html;
  assert.match(rh, /Who paid it/, 'the receipt does not say who paid it');
  assert.match(rh, /released against this stage/i,
    'the receipt does not name the lender that released it');
});

// -------------------------------------------------- 4. per-option prices

test('an option carries a price and the buyer is shown it before signing', async () => {
  const opts = await rows(BUYER,
    `SELECT co.* FROM choice_options co JOIN choices ch ON ch.id = co.choice_id
      WHERE ch.unit_id = 'unit-B-14' AND ch.selected IS NULL`);
  if (!opts.length) return;    // everything on B-14 is signed
  const h = (await get('/choices', 'buyer')).html;
  const dear = opts.find(o => Number(o.extra_paise) > 0);
  if (dear) {
    assert.ok(h.includes(M.money(dear.extra_paise)),
      'the buyer is not told that ' + dear.label + ' costs '
      + M.money(dear.extra_paise) + ' more');
  }
  assert.match(h, /included/, 'the standard option is not said to be included');
});

test('signing copies the price, and the price cannot come from the browser', async () => {
  const open = (await rows(BUYER,
    `SELECT id FROM choices WHERE unit_id = 'unit-B-14' AND selected IS NULL LIMIT 1`))[0];
  if (!open) return;
  const opt = (await rows(BUYER,
    `SELECT label, extra_paise FROM choice_options
      WHERE choice_id = $1 ORDER BY extra_paise DESC LIMIT 1`, [open.id]))[0];
  const r = await post('/choices', 'buyer', { id: open.id, option: opt.label });
  assert.match(r.msg || '', /signed/i, r.msg);
  const after = (await rows(BUYER,
    'SELECT selected, extra_paise FROM choices WHERE id = $1', [open.id]))[0];
  assert.strictEqual(String(after.extra_paise), String(opt.extra_paise),
    'the signed choice does not carry the price of the option chosen');

  /* An option that is not on the list is refused by the function, not by the
     markup, so a posted price or a posted label cannot get in. */
  const other = (await rows(BUYER,
    `SELECT id FROM choices WHERE unit_id = 'unit-B-14' AND selected IS NULL LIMIT 1`))[0];
  if (other) {
    const bad = await post('/choices', 'buyer', { id: other.id, option: 'Gold leaf' });
    assert.match(bad.msg || '', /not one of the options/i, bad.msg);
  }
});

test('a signed extra reaches the next demand once, with GST on it', async () => {
  const unbilled = Number((await rows(OFFICE,
    "SELECT unbilled_extras('unit-B-14') n"))[0].n);
  const stage = (await rows(ENGINEER,
    `SELECT id FROM unit_stages WHERE unit_id = 'unit-B-14' AND status = 'marked' LIMIT 1`))[0];
  if (!stage || !unbilled) return;

  const r = await post('/engineer/certify', 'engineer', { id: stage.id });
  assert.match(r.msg || '', /certified/i, r.msg);
  const dm = (await rows(OFFICE,
    'SELECT * FROM demands WHERE unit_stage_id = $1', [stage.id]))[0];
  assert.strictEqual(Number(dm.extras_paise), unbilled,
    'the signed extras did not reach the demand');
  assert.strictEqual(Number(dm.gst_paise),
    Math.round((Number(dm.base_paise) + Number(dm.extras_paise)) * 0.05),
    'GST was not charged on the base plus the extras');
  assert.strictEqual(Number(dm.total_paise),
    Number(dm.base_paise) + Number(dm.extras_paise) + Number(dm.gst_paise));

  /* AND ONLY ONCE. Certification runs as the engineer, whose policy does not
     let them edit a buyer's choice - a plain UPDATE here matched nothing,
     silently, and would have billed the same extra on every later stage. */
  assert.strictEqual(Number((await rows(OFFICE,
    "SELECT unbilled_extras('unit-B-14') n"))[0].n), 0,
    'the extras were billed and not marked, so the next stage would bill them again');
});

test('only the office prices an option, and never a signed one', async () => {
  const opt = (await rows(OFFICE,
    `SELECT co.id FROM choice_options co JOIN choices ch ON ch.id = co.choice_id
      WHERE ch.selected IS NULL LIMIT 1`))[0];
  if (opt) {
    for (const who of [BUYER, ENGINEER]) {
      await assert.rejects(
        () => asUser(who, c => c.query('SELECT choice_option_price($1, 100000)', [opt.id])),
        /only the head office/i, who.role + ' can price an interior option');
    }
  }
  const signed = (await rows(OFFICE,
    `SELECT co.id FROM choice_options co JOIN choices ch ON ch.id = co.choice_id
      WHERE ch.selected IS NOT NULL LIMIT 1`))[0];
  if (signed) {
    await assert.rejects(
      () => asUser(OFFICE, c => c.query('SELECT choice_option_price($1, 1)', [signed.id])),
      /already signed/i, 'a signed choice can be re-priced under the buyer');
  }
});

// -------------------------------------------- 5. plans and approvals

test('the plans are on a screen for all three roles', async () => {
  const docs = await rows(BUYER, 'SELECT * FROM project_documents');
  assert.ok(docs.length > 0, 'nothing is on file, so this proves nothing');

  const b = await get('/plans', 'buyer');
  assert.strictEqual(b.status, 200);
  const rera = docs.find(x => x.kind === 'rera_certificate');
  assert.ok(rera && b.html.includes(rera.reference),
    'the buyer is not shown the RERA registration of their own project');

  const o = await get('/office/plans', 'office');
  assert.strictEqual(o.status, 200);
  assert.match(o.html, /Record one/, 'the office cannot record one');

  /* The buyer gets the floor plan of their own unit type and not somebody
     else's. This is the only thing on that screen that is filtered at all,
     and the first version of this test did not check it. */
  const mine = docs.find(x => x.kind === 'floor_plan'
    && x.unit_type === '4 BHK, 3,640 sq ft, lake facing');
  const theirs = docs.find(x => x.kind === 'floor_plan'
    && x.unit_type === '3 BHK, 2,100 sq ft');
  assert.ok(mine && theirs, 'there are not two unit types on file to tell apart');
  assert.ok(b.html.includes(mine.label),
    'B-14 is not shown the floor plan of their own unit type');
  /* The other one is on the screen too, and deliberately: a plan is not
     personal data and its policy is `true`. What has to be true is that the
     two are not in the same list, because "for your villa" would then be a
     heading over somebody else's drawing. */
  const [head1, rest] = b.html.split('Other unit types on this project');
  assert.ok(rest, 'the other unit type’s plans are not separated out at all');
  assert.ok(!head1.includes(theirs.reference),
    'another unit type’s floor plan is listed under "For your villa"');
  assert.ok(rest.includes(theirs.reference),
    'the other unit type’s floor plan is not listed anywhere');

  /* The engineer signs a certificate saying a stage is complete per the
     sanctioned plan, so the sanctioned plan is on the screen that signs it.
     Asserting only status 200 here let that section render empty for a whole
     pass: the query excludes the registration, and the registration was all
     there was. */
  const e = await get('/engineer/villa/B-14', 'engineer');
  assert.strictEqual(e.status, 200);
  const sanctioned = docs.find(x => x.kind === 'approved_plan');
  assert.ok(sanctioned, 'no sanctioned plan on file, so this proves nothing');
  assert.match(e.html, /What it is built to/,
    'the screen that signs the certificate does not show what it was built to');
  assert.ok(e.html.includes(sanctioned.reference),
    'the sanctioned plan is not on the screen that certifies against it');
});

test('a plan is readable by everybody and is not personal data', async () => {
  /* It is the same document for every buyer of a unit type, which is why it is
     a different table from `evidence` and why its policy is `true`. */
  for (const who of [BUYER, ENGINEER, OFFICE]) {
    const n = (await rows(who, 'SELECT count(*)::int n FROM project_documents'))[0].n;
    assert.ok(n > 0, who.role + ' cannot read the plans');
  }
  /* And the copy a buyer takes of their own data does not list the plans as
     something held ABOUT them. The retention policy in the same file does name
     the table - it has to, it says how long a plan is kept - so the thing to
     look at is the inventory of kinds, not the whole document. */
  const f = await fetch(BASE + '/data.json', { headers: { cookie: cookies.buyer } });
  const o = JSON.parse(await f.text());
  const inventory = JSON.stringify(o.kinds || []);
  assert.notStrictEqual(inventory, '[]', 'the copy carries no inventory of kinds');
  assert.ok(!inventory.includes('project_documents'),
    'the plans are listed as personal data held about the buyer, which they are not');
});

test('only the office records a document, and it needs one of the three', async () => {
  await assert.rejects(
    () => asUser(ENGINEER, c => c.query(
      `SELECT project_document_add('eterna-p1','floor_plan','x',null,'r',null,null,null,null,null)`)),
    /only the head office/i, 'the engineer can record a plan');
  await assert.rejects(
    () => asUser(OFFICE, c => c.query(
      `SELECT project_document_add('eterna-p1','floor_plan','x',null,null,null,null,null,null,null)`)),
    /reference, a link or a file/i,
    'a document with no reference, no link and no file was accepted');
});

// -------------------------------------------- 6. the three decisions

test('all three decisions are unset, and nothing defaults them', async () => {
  for (const topic of ['erasure', 'withdrawal', 'breach_process']) {
    const v = (await rows(BUYER, 'SELECT policy_of($1) v', [topic]))[0].v;
    assert.strictEqual(v, null,
      topic + ' has acquired a value that nobody recorded: ' + v);
  }
});

test('the buyer is told a decision has not been made, and whose it is', async () => {
  const h = (await get('/data', 'buyer')).html;
  assert.match(h, /Can I have my data deleted\?/);
  assert.match(h, /has not recorded an answer/i,
    'the screen does not say the question is unanswered');
  const builder = (await rows(BUYER,
    `SELECT p.builder_name FROM projects p JOIN units u ON u.project_id = p.id
      WHERE u.code = 'B-14'`))[0].builder_name;
  assert.ok(h.includes(builder), 'the screen does not name who has to answer it');
  assert.match(h, /will not invent either answer/i);
});

test('a decision is a row with a placer, a time and a reason', async () => {
  const cols = (await rows(OFFICE,
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='plint' AND table_name='policy_decisions'`)).map(r => r.column_name);
  for (const c of ['topic', 'decision', 'reason', 'decided_by', 'decided_at',
                   'superseded_at']) {
    assert.ok(cols.includes(c), 'a decision has no ' + c);
  }
});

test('recording one takes a decision and a reason, and refuses an empty one', async () => {
  const empty = await post('/office/policy', 'office', { topic: 'withdrawal' });
  assert.match(empty.loc, /view=withdrawal/,
    'pressing Record with nothing typed did not open the form');
  assert.match(empty.msg || '', /no suggestion to offer/i);

  await assert.rejects(
    () => asUser(OFFICE, c => c.query(
      `SELECT policy_decide('withdrawal','','because')`)),
    /what was decided and why/i, 'an empty decision was recorded');

  for (const who of [BUYER, ENGINEER]) {
    await assert.rejects(
      () => asUser(who, c => c.query(
        `SELECT policy_decide('withdrawal','yes','because')`)),
      /head office/i, who.role + ' can record a policy decision');
  }
});

test('a decision supersedes rather than overwrites, and the old one stays', async () => {
  const first = await post('/office/policy', 'office', {
    topic: 'breach_process', decision: 'Call the grievance officer within one hour.',
    reason: 'A test decision, recorded by the suite.',
  });
  assert.match(first.msg || '', /recorded/i);
  const second = await post('/office/policy', 'office', {
    topic: 'breach_process', decision: 'Call, then email within two hours.',
    reason: 'A second test decision.',
  });
  assert.match(second.msg || '', /recorded/i);

  const all = await rows(OFFICE,
    `SELECT decision, superseded_at FROM policy_decisions WHERE topic = 'breach_process'
      ORDER BY decided_at`);
  assert.strictEqual(all.length, 2, 'the first decision was overwritten, not superseded');
  assert.ok(all[0].superseded_at, 'the first was not marked superseded');
  assert.strictEqual(all[1].superseded_at, null);
  assert.strictEqual((await rows(OFFICE, "SELECT policy_of('breach_process') v"))[0].v,
    'Call, then email within two hours.');

  /* And the audit log has both, because a policy change is a thing somebody
     will one day be asked about. */
  const log = await rows(OFFICE,
    `SELECT count(*)::int n FROM audit_log WHERE action = 'policy_decided'`);
  assert.ok(log[0].n >= 2, 'a policy decision wrote no audit row');

  /* PUT IT BACK. All three topics are unanswered in the shipped product and
     this file is the only thing in the suite that records one, so it clears up
     after itself - otherwise a second run of this suite against the same
     database finds a decision nobody made, which is the exact thing the first
     test in this section exists to catch. The audit rows stay: they are
     append-only and they are true. */
  await owner.query("DELETE FROM policy_decisions WHERE topic = 'breach_process'");
  assert.strictEqual((await rows(OFFICE, "SELECT policy_of('breach_process') v"))[0].v, null,
    'the suite left a decision behind that nobody made');
});
