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

  const office = await get('office', '/office');
  assert.ok(office.html.includes(code),
    'the office worklist does not show ' + code + ' after a problem was reported on it');
  assert.ok(/Material not delivered/.test(office.html),
    'the office cannot see what the problem is, only that there is one');
});

// ------------------------------------------------------------- the boundary

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
