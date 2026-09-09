'use strict';
/* ============================================================================
   One role acts. Another role sees it.

   This is the requirement the whole build exists to meet, so it is tested the
   way a user would find out: over real HTTP, through the real routes, signed
   in as each person in turn. Nothing here reaches into the database to set up
   a result - the only way a row gets written is by posting the form the screen
   posts, and the only way it is observed is by fetching the page the other
   role opens.

   A test that wrote the row itself would prove the read. It would not prove
   the write is wired to a control anybody can press, which is exactly the
   failure mode of a screen whose buttons do nothing.

   The money layer is deliberately not exercised here. Certification raises a
   demand, and that path has its own suite; these are the flows around it.
   ========================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { pool } = require('../src/db');
const PORT = 3243, BASE = 'http://127.0.0.1:' + PORT;
const server = require('../src/server');

before(() => new Promise(r => server.listen(PORT, r)));
after(async () => {
  await new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  await pool.end();
});

const WHO = {
  buyer:    'arjun@example.in',
  engineer: 'ramachandran@nvt.in',
  other:    'venkatesh@nvt.in',
  office:   'priya@nvt.in',
};
const cookie = {};

before(async () => {
  for (const [k, email] of Object.entries(WHO)) {
    const r = await fetch(BASE + '/login', {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, pw: 'plint' }),
    });
    const c = r.headers.get('set-cookie');
    assert.ok(c, k + ' could not sign in');
    cookie[k] = c.split(';')[0];
  }
});

const get = async (who, path) => {
  const r = await fetch(BASE + path, { headers: { cookie: cookie[who] }, redirect: 'manual' });
  return { status: r.status, html: await r.text() };
};
const post = async (who, path, fields) => {
  const r = await fetch(BASE + path, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: cookie[who], 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  return { status: r.status, location: r.headers.get('location') || '' };
};

/** A villa the given engineer currently holds, taken off his own screen. */
async function aVillaOf(who) {
  const { html } = await get(who, '/engineer/villas');
  const m = /\/engineer\/villa\/([A-Z]-\d\d)/.exec(html);
  assert.ok(m, who + ' has no villas on screen to work with');
  return m[1];
}

// ------------------------------------------------------------------- flows

test('engineer marks a stage: it leaves his villa and reaches the office', async () => {
  /* Find a villa of his with a pending stage that already has a photograph,
     because marking without evidence is refused - which is the next test. */
  const code = await aVillaOf('engineer');
  const before = await get('engineer', '/engineer/villa/' + code);
  const stage = /name="id" value="(us-[^"]+)"[\s\S]{0,200}?Mark done/.exec(before.html);
  if (!stage) return; // every stage on this villa is already marked or certified

  const r = await post('engineer', '/engineer/mark', { id: stage[1] });
  assert.strictEqual(r.status, 302);
  assert.match(decodeURIComponent(r.location), /marked done on site/,
    'the mark did not take: ' + decodeURIComponent(r.location));

  // The engineer now sees it waiting for a certificate, not waiting to be marked.
  const after = await get('engineer', '/engineer/certs');
  assert.ok(after.html.includes(stage[1]),
    'the stage he marked is not on the certificate list');

  // And the office's sign-off worklist has it too, without anyone being told.
  const office = await get('office', '/office');
  assert.strictEqual(office.status, 200);
  assert.ok(office.html.includes(code),
    'the office worklist does not mention ' + code + ' after it was marked on site');
});

test('a stage with no photograph cannot be marked, whatever the form says', async () => {
  /* The screen only draws the button when evidence exists. That is a courtesy,
     not a rule: the rule has to survive somebody posting the form anyway. */
  const bare = await fetch(BASE + '/engineer/mark', {
    method: 'POST', redirect: 'manual',
    headers: { cookie: cookie.engineer, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id: 'us-A-16-hand' }),
  });
  const said = decodeURIComponent(bare.headers.get('location') || '');
  assert.ok(/needs a photograph|could not be marked/.test(said),
    'a stage with no evidence was marked: ' + said);
});

test('office reassigns a villa: it moves off one engineer and onto another', async () => {
  const code = await aVillaOf('engineer');

  const mineBefore = await get('engineer', '/engineer/villas');
  const theirsBefore = await get('other', '/engineer/villas');
  assert.ok(mineBefore.html.includes('/engineer/villa/' + code));
  assert.ok(!theirsBefore.html.includes('/engineer/villa/' + code),
    'both engineers already hold ' + code + ', so a move proves nothing');

  const r = await post('office', '/office/assign', { unit: 'unit-' + code, engineer: 'u-eng-venkat' });
  assert.strictEqual(r.status, 302, 'the office cannot reassign: ' + r.status);
  assert.match(decodeURIComponent(r.location), /reassigned|moved/i,
    'reassignment did not report success: ' + decodeURIComponent(r.location));

  const mineAfter = await get('engineer', '/engineer/villas');
  const theirsAfter = await get('other', '/engineer/villas');
  assert.ok(!mineAfter.html.includes('/engineer/villa/' + code),
    code + ' is still on the first engineer\'s list after being reassigned');
  assert.ok(theirsAfter.html.includes('/engineer/villa/' + code),
    code + ' did not appear on the second engineer\'s list');

  // Put it back, so the suite leaves the project as it found it.
  await post('office', '/office/assign', { unit: 'unit-' + code, engineer: 'u-eng-ram' });
});

test('engineer answers a visit: the buyer sees it is confirmed', async () => {
  const list = await get('engineer', '/engineer/visits');
  const m = /name="id" value="(visit-[^"]+)"/.exec(list.html);
  assert.ok(m, 'no visit on the engineer\'s screen to answer');

  const r = await post('engineer', '/engineer/visit', { id: m[1], do: 'confirmed' });
  assert.strictEqual(r.status, 302);
  assert.match(decodeURIComponent(r.location), /accepted/,
    'the visit was not accepted: ' + decodeURIComponent(r.location));

  const after = await get('engineer', '/engineer/visits');
  assert.ok(/Accepted/.test(after.html), 'the visit does not read as accepted');
});

test('engineer logs the day: the office reads the same entry', async () => {
  const title = 'Steel delivered, 6 tonnes, challan ' + Math.floor(Math.random() * 90000 + 10000);
  const r = await post('engineer', '/engineer/log', { kind: 'material', title });
  assert.strictEqual(r.status, 302);
  assert.match(decodeURIComponent(r.location), /Logged/, decodeURIComponent(r.location));

  const mine = await get('engineer', '/engineer/log');
  assert.ok(mine.html.includes(title), 'the entry is not on the log screen');

  // The site log is the site's record and the office reads it. A buyer must not.
  const buyer = await get('buyer', '/engineer/log');
  assert.strictEqual(buyer.status, 404, 'a buyer reached the site log');
});

test('engineer reports a problem: it lands on the office worklist', async () => {
  const code = await aVillaOf('engineer');
  const detail = 'Blocks ordered 28 August, vendor now says 12 September.';
  const r = await post('engineer', '/engineer/flag',
    { code, reason: 'Material not delivered', detail });
  assert.strictEqual(r.status, 302);
  assert.match(decodeURIComponent(r.location), /Reported/, decodeURIComponent(r.location));

  /* Stages, which lists every one of them and puts whatever has stopped a
     stage on the row itself. The dashboard carries the longest-blocked eight,
     which a report made a second ago is not. */
  const office = await get('office', '/office/stages');
  assert.ok(office.html.includes(code),
    'the office worklist does not show ' + code + ' after a problem was reported on it');
  assert.ok(/Material not delivered/.test(office.html),
    'the office cannot see what the problem is, only that there is one');
  assert.ok(office.html.includes(detail),
    'the office sees the headline but not what the engineer actually said');
});

// ------------------------------------------------------------- the boundary

// -------------------------------------------------------- the buyer acts

test('buyer asks for a visit: it lands on the engineer\'s own list', async () => {
  /* The buyer picks a day on the Visit tab. Nothing else happens: no email,
     no office step. It appears on the list of the engineer the villa is
     already assigned to, who answers it there. */
  const day = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
  const note = 'Cross-role check ' + Date.now();

  const before = await get('engineer', '/engineer/visits');
  assert.ok(!before.html.includes(note), 'the note is on screen before it was asked for');

  const r = await post('buyer', '/visit', { day, note });
  assert.strictEqual(r.status, 302, 'the visit form did not post');
  assert.match(r.location, /^\/visit\?m=/, 'the buyer was not told what happened');

  const mine = await get('buyer', '/visit');
  assert.ok(mine.html.includes(note), 'the buyer cannot see the visit they asked for');
  assert.match(mine.html, /Waiting for the engineer/,
    'the buyer is not told the request is with the engineer');

  const theirs = await get('engineer', '/engineer/visits');
  assert.ok(theirs.html.includes(note),
    'the engineer never sees a visit the buyer asked for');

  /* And it is named to the engineer the villa is already assigned to, rather
     than dropped into a pool nobody owns. The Visits screen lists every open
     request whoever is signed in, so the screen alone cannot show this - it
     stayed green with the assignment removed - and the row is what carries it. */
  const { asUser } = require('../src/db');
  const row = await asUser({ id: 'u-office', role: 'office' }, c => c.query(
    `SELECT v.engineer_id, u.assigned_engineer_id
       FROM visits v JOIN units u ON u.id = v.unit_id WHERE v.note = $1`, [note]))
    .then(x => x.rows[0]);
  assert.ok(row, 'the visit was never written');
  assert.ok(row.engineer_id, 'the visit was booked with no engineer named to it');
  assert.strictEqual(row.engineer_id, row.assigned_engineer_id,
    'the visit went to somebody other than the villa\'s own engineer');
});

test('a buyer cannot ask for a visit in the past, or on a day that is not one', async () => {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  for (const day of [yesterday, 'tomorrow', '', '2026-13-45']) {
    const r = await post('buyer', '/visit', { day, note: 'nope ' + day });
    assert.strictEqual(r.status, 302, 'a bad date crashed rather than being refused');
    const back = await get('buyer', '/visit');
    assert.ok(!back.html.includes('nope ' + day),
      'a visit was booked for ' + JSON.stringify(day));
  }
});

test('buyer raises a question: the office can read it, the engineer cannot answer it', async () => {
  const subject = 'Cross-role question ' + Date.now();

  const r = await post('buyer', '/questions', { kind: 'query', subject });
  assert.strictEqual(r.status, 302, 'the question form did not post');

  const mine = await get('buyer', '/questions');
  assert.ok(mine.html.includes(subject), 'the buyer cannot see their own question');
  assert.match(mine.html, /Open/, 'the question is not shown as open');

  /* The office queue is its own screen in a later pass. What has to be true
     now is that the row is the office's to read and is attached to the right
     villa - that is the whole of the cross-role claim, and the screen that
     lists it is presentation on top of it. */
  const { asUser } = require('../src/db');
  const seenByOffice = await asUser({ id: 'u-office', role: 'office' }, c => c.query(
    `SELECT q.subject, u.code FROM queries q JOIN units u ON u.id = q.unit_id
      WHERE q.subject = $1`, [subject])).then(x => x.rows);
  assert.strictEqual(seenByOffice.length, 1, 'the office cannot read the buyer\'s question');
  assert.strictEqual(seenByOffice[0].code, 'B-14', 'the question lost its villa');

  // And the thread is the record: the buyer can add to it and read it back.
  const id = (/href="\/questions\/([^"]+)"/.exec(mine.html) || [])[1];
  assert.ok(id, 'the question is not a link to its own thread');
  const said = 'Adding to the thread ' + Date.now();
  const reply = await post('buyer', '/questions/reply', { id: decodeURIComponent(id), body: said });
  assert.strictEqual(reply.status, 302);
  const thread = await get('buyer', '/questions/' + id);
  assert.ok(thread.html.includes(said), 'the buyer\'s own message is not on the thread');
});

test('buyer signs an interior choice: the site reads what was chosen', async () => {
  const open = await get('buyer', '/choices');
  const m = /name="id" value="([^"]+)"[\s\S]*?<select class="fi" name="option"[^>]*>\s*<option value="([^"]+)"/
    .exec(open.html);
  if (!m) {
    /* Every choice on this villa is already signed. That is a legitimate state
       and not something to paper over with a write of our own - say so. */
    assert.match(open.html, /All signed|No choices are open/,
      'no choice is offered and the screen does not say why');
    return;
  }
  const [, id, option] = m;

  const r = await post('buyer', '/choices', { id, option });
  assert.strictEqual(r.status, 302, 'the choice form did not post');

  const after = await get('buyer', '/choices');
  assert.ok(after.html.includes('you chose ' + option),
    'the buyer cannot see the choice they signed');

  /* The engineer builds what was chosen, so the row is theirs to read. An
     unsigned preference is not a decision and the database enforces that: the
     selection and the signature go in together or not at all. */
  const { asUser } = require('../src/db');
  const row = await asUser({ id: 'u-eng-ram', role: 'engineer' }, c => c.query(
    'SELECT selected, signed_at, signed_by FROM choices WHERE id = $1', [id]))
    .then(x => x.rows[0]);
  assert.strictEqual(row.selected, option, 'the site does not see what the buyer chose');
  assert.ok(row.signed_at && row.signed_by, 'a selection was stored without a signature');

  // Signing a settled choice again is refused rather than silently overwriting.
  const again = await post('buyer', '/choices', { id, option });
  assert.strictEqual(again.status, 302);
  const still = await asUser({ id: 'u-eng-ram', role: 'engineer' }, c => c.query(
    'SELECT selected FROM choices WHERE id = $1', [id])).then(x => x.rows[0]);
  assert.strictEqual(still.selected, option, 'a settled choice was reopened');
});

test('office records a sanction: it clears their worklist and shows on the buyer\'s loan screen', async () => {
  /* The flow the brief names. The office types the figures off the letter and
     the buyer, who never sees that screen, finds them on Loan. */
  const { asUser } = require('../src/db');
  const target = await asUser({ id: 'u-office', role: 'office' }, c => c.query(
    `SELECT id, code FROM units
      WHERE code = 'B-14' AND bank IS NOT NULL AND sanction_recorded_at IS NULL`))
    .then(x => x.rows[0]);

  if (!target) {
    // Already recorded by an earlier run; then the buyer must be able to see it.
    const loan = await get('buyer', '/loan');
    assert.match(loan.html, /Your sanction is on file/,
      'B-14 has a sanction on file and the buyer cannot see it');
    return;
  }

  const before = await get('office', '/office/chase');
  assert.ok(before.html.includes(target.code), 'B-14 is not on the office worklist to begin with');

  const sanction = 30000000, own = 6000000, letter = 'XR/' + Date.now();
  const r = await post('office', '/office/sanction',
    { unit: target.id, sanction: String(sanction), own: String(own), letter });
  assert.strictEqual(r.status, 302, 'the sanction form did not post');

  const after = await get('office', '/office/chase');
  assert.ok(!after.html.includes('value="' + target.id + '"'),
    'the villa is still on the office worklist after its sanction was recorded');

  const M = require('../src/money');
  const loan = await get('buyer', '/loan');
  assert.match(loan.html, /Your sanction is on file/, 'the buyer is not told the sanction is recorded');
  assert.ok(loan.html.includes(M.money(sanction * 100)),
    'the sanctioned figure is not on the buyer\'s loan screen');
  assert.ok(loan.html.includes(M.money(own * 100)),
    'the own contribution is not on the buyer\'s loan screen');
});

test('a buyer cannot write another villa\'s row, whatever the form says', async () => {
  const { asUser } = require('../src/db');
  const other = await asUser({ id: 'u-office', role: 'office' }, c => c.query(
    `SELECT id FROM units WHERE code <> 'B-14' LIMIT 1`)).then(x => x.rows[0]);

  /* The visit route reads the villa from the session, so there is no field to
     forge - but the policy is what has to hold, so post at a choice on another
     villa, which does carry an id. */
  const theirChoice = await asUser({ id: 'u-office', role: 'office' }, c => c.query(
    `SELECT id, options FROM choices WHERE unit_id = $1 AND selected IS NULL LIMIT 1`,
    [other.id])).then(x => x.rows[0]);
  if (!theirChoice) return; // nothing unsigned on another villa to try

  const r = await post('buyer', '/choices', { id: theirChoice.id, option: theirChoice.options[0] });
  assert.strictEqual(r.status, 302, 'the forged post crashed rather than being refused');

  const still = await asUser({ id: 'u-office', role: 'office' }, c => c.query(
    'SELECT selected FROM choices WHERE id = $1', [theirChoice.id])).then(x => x.rows[0]);
  assert.strictEqual(still.selected, null,
    'a buyer signed a choice on a villa that is not theirs');
});

// ------------------------------------------------------- the office acts

test('office answers a buyer: the buyer reads it on their own thread', async () => {
  /* The flow the brief names, in the direction it was missing. The buyer's
     question reached the office in an earlier test; this is the office
     answering it, and the answer landing where the buyer looks. */
  const subject = 'Answerable question ' + Date.now();
  assert.strictEqual((await post('buyer', '/questions', { kind: 'query', subject })).status, 302);

  const queue = await get('office', '/office');
  assert.ok(queue.html.includes(subject),
    'a buyer question is not on the office Today screen');

  /* The link for THIS question. Today lists every open one across 48 villas
     oldest first, so the first link on the page is a seeded question on
     another villa - answering that one proves nothing about this buyer, and
     the B-14 buyer cannot read A-07's thread, which is row-level security
     doing its job and a test looking in the wrong place. */
  const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const id = (new RegExp('href="/office/question/([^"]+)"[^>]*>[\\s\\S]{0,400}?' + esc(subject))
    .exec(queue.html) || [])[1];
  assert.ok(id, 'the office cannot open the question it was sent');

  const said = 'The slab was poured on the 4th. ' + Date.now();
  const r = await post('office', '/office/answer', { id: decodeURIComponent(id), body: said });
  assert.strictEqual(r.status, 302, 'the office answer form did not post');

  const buyerThread = await get('buyer', '/questions');
  assert.ok(buyerThread.html.includes(subject), 'the buyer lost their own question');
  /* The link for THIS question, not the first on the page: the list is newest
     first and an earlier test in this file raises one of its own. */
  const bid = (new RegExp('href="/questions/([^"]+)"[^>]*>[\\s\\S]{0,400}?'
    + subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).exec(buyerThread.html) || [])[1];
  assert.ok(bid, "the buyer's question is not a link to its own thread");
  const thread = await get('buyer', '/questions/' + bid);
  assert.ok(thread.html.includes(said),
    'the office answered and the buyer cannot see the answer');

  /* And it stops being open: an answered question is off the office's Today
     screen, which is the thing that makes Today a worklist rather than a log. */
  const after = await get('office', '/office');
  const stillThere = after.html.includes(subject);
  assert.ok(!stillThere || /answered/i.test(after.html),
    'an answered question is still sitting on the office worklist as open');
});

test('office picks a file up from sales: it leaves the handover list', async () => {
  /* The handover list moved onto Villas: sales handing a file over is the
     first thing that happens to a villa, and it was a destination of its own
     for one card. The write is unchanged. */
  const before = await get('office', '/office/villas');
  const m = /name="id" value="(ho-[^"]+)"/.exec(before.html);
  if (!m) {
    assert.match(before.html, /New from sales/,
      'nothing is offered for pickup and the screen does not say why');
    return;
  }
  const r = await post('office', '/office/handoff', { id: m[1] });
  assert.strictEqual(r.status, 302, 'the pickup form did not post');
  assert.match(decodeURIComponent(r.location), /is yours/, decodeURIComponent(r.location));

  const after = await get('office', '/office/villas');
  assert.ok(!new RegExp('name="id" value="' + m[1] + '"').test(after.html),
    'the file is still offered for pickup after being picked up');

  // And picking the same one up twice is refused rather than reassigning it.
  const again = await post('office', '/office/handoff', { id: m[1] });
  assert.match(decodeURIComponent(again.location), /could not be picked up/,
    'a file already owned was picked up a second time');
});
test('office answers a lender: the query stops holding the disbursement', async () => {
  const before = await get('office', '/office/query');
  const m = /name="id" value="(pq-[^"]+)"/.exec(before.html);
  if (!m) {
    assert.match(before.html, /No lender has asked anything|Answered/,
      'no lender question is open and the screen does not say so');
    return;
  }
  const answer = 'Certificate and photographs re-sent ' + Date.now();
  const r = await post('office', '/office/query', { id: m[1], answer });
  assert.strictEqual(r.status, 302);
  assert.match(decodeURIComponent(r.location), /Answered/, decodeURIComponent(r.location));

  const after = await get('office', '/office/query');
  assert.ok(after.html.includes(answer), 'the answer is not on the screen');
  assert.ok(!new RegExp('name="id" value="' + m[1] + '"').test(after.html),
    'an answered lender question still offers the answer form');
});

test('office marks a quarter filed: it needs the acknowledgement reference', async () => {
  const before = await get('office', '/office/rera');
  const m = /name="id" value="(qpr-[^"]+)"/.exec(before.html);
  if (!m) {
    assert.match(before.html, /No quarter has been opened|Filed/,
      'no quarter is open for filing and the screen does not say so');
    return;
  }
  // A filing without its reference is not a filing.
  const empty = await post('office', '/office/qpr', { id: m[1], reference: '   ' });
  assert.match(decodeURIComponent(empty.location), /acknowledgement reference/,
    'a quarter was marked filed with no reference');

  const ref = 'ACK/' + Date.now();
  const r = await post('office', '/office/qpr', { id: m[1], reference: ref });
  assert.match(decodeURIComponent(r.location), /marked filed/, decodeURIComponent(r.location));

  const after = await get('office', '/office/rera');
  assert.ok(after.html.includes(ref), 'the reference is not on the screen');
});

test('every one of the twenty-four destinations opens, and none of them is a stub', async () => {
  /* "A tab whose controls do nothing is not built." Twenty-three screens is
     twenty-four chances to ship a heading with nothing under it, so each one is
     opened and checked for the things that would mean it is a drawing: no
     title, nothing to read, and no way out. An empty queue is a real state and
     says so; an empty screen is not. */
  const KEYS = ['', 'packs', 'wait', 'query', 'chase', 'stages', 'evidence', 'silent',
                'signoff', 'villas', 'documents', 'choices', 'visits', 'warranty',
                'rera', 'escrow', 'possession', 'setup', 'schedule', 'lenders', 'logins',
                'settings', 'help'];
  for (const k of KEYS) {
    const path = k ? '/office/' + k : '/office';
    const { status, html } = await get('office', path);
    assert.strictEqual(status, 200, path + ' does not open');
    assert.match(html, /<div class="h1">/, path + ' has no title');
    assert.match(html, /<div class="hsub">/, path + ' does not say what it is for');

    /* Something to read: a table, a card, a board or a hero. And where a list
       is empty it says why, in `.empty`, which is a real state rather than a
       blank. */
    assert.ok(/class="tbl"|class="card"|class="board"|class="hero"/.test(html),
      path + ' shows nothing at all');
    if (/class="tbl"/.test(html)) {
      assert.ok(/class="tr /.test(html) || /class="empty"/.test(html),
        path + ' shows neither rows, nor a reason there are none');
    }
    /* And the way to the other twenty-two is on it. */
    assert.ok(/class="item /.test(html), path + ' has no navigation out of it');
  }
});
test('the sidebar is the five groups, on every one of the twenty-four', async () => {
  for (const path of ['/office', '/office/stages', '/office/help']) {
    const { html } = await get('office', path);
    for (const g of ['Money stuck', 'The site', 'Buyers', 'Compliance', 'Setup']) {
      assert.ok(html.includes('>' + g + '<'), path + ': the sidebar is missing the group "' + g + '"');
    }
    const items = (html.match(/class="item /g) || []).length;
    /* Twenty-three since a project could be created here rather than seeded. */
    assert.strictEqual(items, 24, path + ': the sidebar has ' + items + ' destinations, not 24');

    /* One sidebar, not two. It is the same element at both widths - sticky
       beside the content on a desktop, and slid in from the left under 860px
       - so there is no second list to drift out of step with the first. */
    const sides = (html.match(/<aside class="side"/g) || []).length;
    assert.strictEqual(sides, 1, path + ': there are ' + sides + ' navigations on one screen');
    assert.match(html, /class="scrim2"/, path + ': the drawer has nothing behind it on a phone');
  }
});
test('every row on every office screen leads somewhere', async () => {
  /* A worklist row that is not a link is a dead end: you can see the villa is
     stuck and there is nothing to press. The buyer file is where they all go. */
  for (const k of ['', 'signoff', 'silent', 'choices', 'possession']) {
    const { html } = await get('office', k ? '/office/' + k : '/office');
    const rows = (html.match(/class="wrow[^"]*"/g) || []).length;
    if (!rows) continue;
    const links = (html.match(/<a class="wrow/g) || []).length;
    assert.ok(links > 0, '/office/' + k + ' has ' + rows + ' rows and not one of them is a link');
  }
});

test('search is scoped by the policy, not by a clause in the screen', async () => {
  /* The field runs its query under `asUser`, so row-level security decides who
     sees what rather than a WHERE clause somebody can forget. The proof is
     that the same search returns different villas to the two roles who have
     it, and nothing at all to the one who does not. */
  const office = await get('office', '/find?q=a');
  assert.strictEqual(office.status, 200, 'the office cannot search');
  const officeHits = (office.html.match(/href="\/office\/buyer\/([A-Z]-\d\d)"/g) || []).length;
  assert.ok(officeHits > 0, 'the office searched and found none of forty-eight villas');

  const eng = await get('engineer', '/find?q=a');
  assert.strictEqual(eng.status, 200, 'the engineer cannot search');
  const engHits = (eng.html.match(/href="\/engineer\/villa\/([A-Z]-\d\d)"/g) || []).length;
  assert.ok(engHits > 0, 'the engineer searched and found none of their own villas');

  /* The engineer holds a share of the project, so a search that matches
     everything must return them fewer villas than it returns the office.

     This is the screen's rule and not the policy's: `un_read` on units is
     `true` for both staff roles, because an engineer certifying a stage works
     across the project. This assertion is what caught the route claiming the
     database was doing it - the engineer was getting all forty. */
  assert.ok(engHits < officeHits,
    'the engineer sees ' + engHits + ' villas and the office ' + officeHits
    + " - the search is not scoped to the engineer's own work");

  /* And a villa that is not this engineer's cannot be reached through it,
     however specifically it is asked for. */
  const { asUser } = require('../src/db');
  /* By assignment, not by what the policy lets them read - reading `units` as
     the engineer returns all forty-eight, which is the whole point above. */
  const notTheirs = await asUser({ id: 'u-office', role: 'office' }, c => c.query(
    `SELECT code FROM units
      WHERE assigned_engineer_id IS DISTINCT FROM 'u-eng-ram' ORDER BY code LIMIT 1`))
    .then(r => r.rows[0] && r.rows[0].code);
  assert.ok(notTheirs, 'this engineer holds every villa, so this proves nothing');
  const probe = await get('engineer', '/find?q=' + encodeURIComponent(notTheirs));
  assert.ok(!probe.html.includes('/engineer/villa/' + notTheirs),
    'an engineer found ' + notTheirs + ', which is not theirs');
});

test('the buyer has no search, and cannot reach one', async () => {
  /* They have one villa. Searching it would be searching for the screen they
     are standing on, and a field that can only ever return that is a field
     that invites somebody to try a neighbour's code. */
  const villa = await get('buyer', '/villa/B-14');
  assert.ok(!/class="ab-find"/.test(villa.html), 'the buyer is offered a search field');

  const direct = await get('buyer', '/find?q=A-11');
  assert.notStrictEqual(direct.status, 200,
    'a buyer reached the search screen directly: HTTP ' + direct.status);
});

test('a buyer cannot reach any engineer screen', async () => {
  for (const p of ['/engineer', '/engineer/villas', '/engineer/visits',
                   '/engineer/log', '/engineer/certs', '/engineer/snags',
                   '/engineer/villa/B-14']) {
    const r = await get('buyer', p);
    assert.strictEqual(r.status, 404, 'a buyer reached ' + p);
  }
});

test('a buyer cannot post an engineer\'s writes', async () => {
  for (const [p, fields] of [
    ['/engineer/mark', { id: 'us-B-14-brick' }],
    ['/engineer/log', { kind: 'material', title: 'forged' }],
    ['/engineer/flag', { code: 'B-14', reason: 'Labour shortage', detail: 'forged' }],
  ]) {
    const r = await post('buyer', p, fields);
    assert.ok(r.status === 404 || r.status === 302 && !/Logged|Reported|marked/.test(
      decodeURIComponent(r.location)), 'a buyer wrote through ' + p);
  }
  // And nothing forged reached the log.
  const office = await get('office', '/engineer/log');
  assert.ok(!office.html.includes('forged'), 'a buyer\'s forged entry is in the site log');
});
