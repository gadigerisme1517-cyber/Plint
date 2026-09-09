'use strict';
/* ============================================================================
   PUTTING A CUSTOMER ON PLINT.

   Until this existed the only way a builder's data reached the product was
   db/seed.js, which is the line between a demonstration and a thing a signed
   customer can be served on. These tests hold that line open: a project is
   created, given a schedule, loaded from a file and given buyers, entirely
   through the routes the office uses, and the isolation that the rest of the
   suite asserts for the seeded project is asserted again for the new one.

   WHAT IS BEING GUARDED, AND WHY EACH ONE MATTERS:

     * only the office. A buyer or an engineer posting to these routes is
       refused by the route AND by the database function behind it, and both
       are checked, because one of them will be edited one day.
     * a schedule adds to a hundred. A villa priced against ninety-five per
       cent bills ninety-five per cent of the money, for ever, quietly.
     * a schedule is fixed once villas exist. Every unit_stage row and every
       priced demand hangs off those percentages.
     * the preview writes nothing. It is the whole promise of the screen.
     * a bad row is skipped whole, never half-created. The row that matters
       most here is a rupee figure written "2,80,00,000" with no quotes: it
       parses as four cells, and without the width check it becomes a villa
       worth two rupees with the wrong buyer's name on it.
     * the same file twice creates nothing the second time.
     * a buyer on the new project sees their own villa and nothing else, and
       the forty-eight on the seeded project are untouched.
   ========================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { asUser, pool } = require('../src/db');
const VILLAFILE = require('../src/villafile');

const PORT = 3246, BASE = 'http://127.0.0.1:' + PORT;
const server = require('../src/server');

const PROJECT = 'harbour-p1';
const CSV = [
  'code,unit_type,agreement_value,buyer_name,bank,site_engineer',
  'H-01,"4 BHK, 3,100 sq ft","2,60,00,000",R. Iyer,SBI,S. Kumar',
  'H-02,"3 BHK, 2,400 sq ft",21000000,M. Fernandes,HDFC Ltd,S. Kumar',
  'H-03,3 BHK 2400 sq ft,2,10,00,000,Unquoted Number,SBI,S. Kumar',
  'H-01,4 BHK 3100 sq ft,26000000,Someone Else,SBI,S. Kumar',
  'H-04,3 BHK 2400 sq ft,,No Value Given,SBI,S. Kumar',
  ',4 BHK 3100 sq ft,30000000,No Code,SBI,S. Kumar',
  'H-05,"2 BHK, 1,750 sq ft",15250000,A. Dsouza,,S. Kumar',
].join('\n');

const cookies = {};
before(async () => {
  await new Promise(r => server.listen(PORT, r));
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
  await new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  await pool.end();
});

const post = async (path, role, fields) => {
  const r = await fetch(BASE + path, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: cookies[role], 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  const loc = r.headers.get('location') || '';
  const m = /[?&]m=([^&]*)/.exec(loc);
  return { status: r.status, loc, msg: m ? decodeURIComponent(m[1]) : null,
           html: await r.text() };
};
const get = async (path, role) => {
  const r = await fetch(BASE + path, { headers: { cookie: cookies[role] } });
  return { status: r.status, html: await r.text() };
};
const OFFICE = { id: 'u-office', role: 'office' };
const count = sql => asUser(OFFICE, c => c.query(sql)).then(r => Number(r.rows[0].n));

// --------------------------------------------------------------- the reader

test('the file reader skips a row rather than shifting its columns', () => {
  const rows = VILLAFILE.parse(CSV).rows;
  /* The FIRST row with each code: H-01 appears twice on purpose, and the
     second one is the duplicate this test is also about. */
  const by = {};
  for (const r of rows) { const k = r.code || '(blank)'; if (!(k in by)) by[k] = r; }

  assert.strictEqual(by['H-01'].why, undefined, 'H-01 is a good row');
  assert.strictEqual(by['H-01'].agreement_value_paise, 26000000 * 100,
    'a quoted "2,60,00,000" is two crore sixty lakh');
  assert.strictEqual(by['H-02'].agreement_value_paise, 21000000 * 100);

  /* The one that matters. Unquoted, it is four cells, and without the width
     check it lands as a two-rupee villa named after a number. */
  assert.match(by['H-03'].why, /columns where the file declares/,
    'an unquoted Indian-format number was not caught');

  assert.match(rows.filter(r => r.code === 'H-01')[1].why, /same code twice/);
  assert.match(by['H-04'].why, /no agreement value/);
  assert.match(by['(blank)'].why, /no villa code/);
  assert.strictEqual(by['H-05'].why, undefined);
  assert.strictEqual(rows.filter(r => !r.why).length, 3, 'three rows are creatable');
});

// ------------------------------------------------------------ only the office

test('nobody but the office can put a project on this console', async () => {
  for (const role of ['buyer', 'engineer']) {
    const r = await post('/office/project', role,
      { id: 'sneaky-p1', name: 'Sneaky', phase: 'One', location: 'Nowhere', builder: 'Nobody' });
    assert.notStrictEqual(r.status, 302, role + ' was allowed to post a project');
    assert.strictEqual(await count(`SELECT count(*) n FROM projects WHERE id='sneaky-p1'`), 0,
      role + ' created a project');
  }
  /* And the database refuses on its own account, so a route edited badly one
     day does not become the only thing standing there. */
  for (const sess of [{ id: 'u-b14', role: 'buyer' }, { id: 'u-eng-ram', role: 'engineer' }]) {
    await assert.rejects(
      asUser(sess, c => c.query(`SELECT project_create('sneaky-p2','S','1','X','Y',NULL)`)),
      /only head office/, sess.role + ' was not refused by the function');
  }
});

// ------------------------------------------------------------- the schedule

test('a schedule that does not add to a hundred is refused', async () => {
  const made = await post('/office/project', 'office', {
    id: PROJECT, name: 'Harbour Greens', phase: 'Phase 1',
    location: 'Panvel, Navi Mumbai', builder: 'Harbour Estates',
    builder_ref: 'P52000012345',
  });
  assert.strictEqual(made.status, 302, 'the project was not created');
  assert.strictEqual(await count(`SELECT count(*) n FROM projects WHERE id='${PROJECT}'`), 1);

  const short = await post('/office/schedule', 'office',
    { project: PROJECT, stages: 'Booking, 20\nFoundation, 30\nHandover, 40' });
  assert.match(short.msg, /not 100/, 'ninety per cent was accepted: ' + short.msg);
  assert.strictEqual(await count(
    `SELECT count(*) n FROM stage_templates WHERE project_id='${PROJECT}'`), 0,
    'a refused schedule left rows behind');
});

test('a schedule that adds up is set, in the order it was written', async () => {
  const r = await post('/office/schedule', 'office', {
    project: PROJECT,
    stages: [
      'Booking, 20, On agreement of sale',
      'Foundation, 20, Excavation and footing',
      'Structure, 25, Frame to roof level',
      'Blockwork and plaster, 15, Walls inside and out',
      'Finishes, 15, Flooring, joinery and paint',
      'Handover, 5, Snag clearance and keys',
    ].join('\n'),
  });
  assert.match(r.msg, /6 stages set/, r.msg);
  const rows = await asUser(OFFICE, c => c.query(
    `SELECT seq, code, name, pct_bp FROM stage_templates
      WHERE project_id = $1 ORDER BY seq`, [PROJECT])).then(x => x.rows);
  assert.deepStrictEqual(rows.map(x => x.name),
    ['Booking', 'Foundation', 'Structure', 'Blockwork and plaster', 'Finishes', 'Handover']);
  assert.strictEqual(rows.reduce((t, x) => t + x.pct_bp, 0), 10000, 'the stages do not add up');
});

// --------------------------------------------------------------- the preview

test('the preview says what would happen and writes nothing', async () => {
  const before = await count(`SELECT count(*) n FROM units WHERE project_id='${PROJECT}'`);
  const r = await post('/office/villas/preview', 'office', { project: PROJECT, pasted: CSV });
  assert.strictEqual(r.status, 200, 'the preview did not render');
  assert.match(r.html, /Nothing has been written yet/);
  for (const code of ['H-01', 'H-02', 'H-05']) {
    assert.ok(r.html.includes('<b>' + code + '</b>'), code + ' is not named in the preview');
  }
  assert.match(r.html, /columns where the file declares/, 'the shifted row is not explained');
  assert.match(r.html, /the same code twice in this file/);
  assert.match(r.html, /no agreement value/);
  assert.match(r.html, /no villa code/);
  assert.strictEqual(
    await count(`SELECT count(*) n FROM units WHERE project_id='${PROJECT}'`), before,
    'the preview wrote something');
});

// ---------------------------------------------------------------- the import

test('the import creates the good rows whole and skips the rest', async () => {
  const r = await post('/office/villas/import', 'office', { project: PROJECT, csv: CSV });
  assert.match(r.msg, /3 villas created/, r.msg);

  const units = await asUser(OFFICE, c => c.query(
    `SELECT code, agreement_value_paise, buyer_name, bank,
            (SELECT count(*)::int FROM unit_stages s WHERE s.unit_id = u.id) stages
       FROM units u WHERE project_id = $1 ORDER BY code`, [PROJECT])).then(x => x.rows);
  assert.deepStrictEqual(units.map(u => u.code), ['H-01', 'H-02', 'H-05']);

  /* Whole, or not at all: every created villa carries one row per stage on the
     project's schedule. A villa with no stages is a villa that can never be
     certified, demanded or paid. */
  for (const u of units) {
    assert.strictEqual(u.stages, 6, u.code + ' has ' + u.stages + ' stages, not six');
    assert.ok(u.agreement_value_paise > 0, u.code + ' has no agreement value');
    assert.ok(u.buyer_name && u.buyer_name.trim(), u.code + ' has no buyer name');
  }
  assert.strictEqual(units[0].agreement_value_paise, 26000000 * 100);

  /* And nothing from the rows that were skipped. */
  assert.strictEqual(await count(
    `SELECT count(*) n FROM units WHERE project_id='${PROJECT}' AND code IN ('H-03','H-04')`), 0,
    'a skipped row was created anyway');
  assert.strictEqual(await count(
    `SELECT count(*) n FROM units WHERE buyer_name = 'Unquoted Number'`), 0,
    'the shifted row became a villa');
});

test('the same file a second time creates nothing', async () => {
  const before = await count(`SELECT count(*) n FROM units WHERE project_id='${PROJECT}'`);
  const r = await post('/office/villas/import', 'office', { project: PROJECT, csv: CSV });
  assert.match(r.msg, /0 villas created/, r.msg);
  assert.strictEqual(
    await count(`SELECT count(*) n FROM units WHERE project_id='${PROJECT}'`), before);
});

test('the schedule is fixed once the project has villas', async () => {
  const r = await post('/office/schedule', 'office',
    { project: PROJECT, stages: 'One, 50\nTwo, 50' });
  assert.match(r.msg, /already has villas/, r.msg);
  assert.strictEqual(await count(
    `SELECT count(*) n FROM stage_templates WHERE project_id='${PROJECT}'`), 6,
    'the schedule was changed under live villas');
});

// ---------------------------------------------------------------- the buyer

let issued = null;
test('a buyer gets a login, once, and the email cannot be reused', async () => {
  const unit = await asUser(OFFICE, c => c.query(
    `SELECT id FROM units WHERE project_id = $1 AND code = 'H-01'`, [PROJECT]))
    .then(r => r.rows[0].id);

  const r = await post('/office/buyer', 'office',
    { project: PROJECT, unit, name: 'R. Iyer', email: 'r.iyer@harbour.test' });
  const pw = (/password is (\S+)/.exec(r.msg || '') || [])[1];
  assert.ok(pw, 'no password was shown: ' + r.msg);
  issued = { email: 'r.iyer@harbour.test', pw, unit };

  const again = await post('/office/buyer', 'office',
    { project: PROJECT, unit, name: 'Someone Else', email: 'else@harbour.test' });
  assert.match(again.msg, /already has a buyer/, again.msg);

  const other = await asUser(OFFICE, c => c.query(
    `SELECT id FROM units WHERE project_id = $1 AND code = 'H-02'`, [PROJECT]))
    .then(x => x.rows[0].id);
  const dup = await post('/office/buyer', 'office',
    { project: PROJECT, unit: other, name: 'R. Iyer', email: 'r.iyer@harbour.test' });
  assert.match(dup.msg, /already signs somebody in/, dup.msg);
});

test('the new buyer sees exactly one villa, and it is theirs', async () => {
  const r = await fetch(BASE + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: issued.email, pw: issued.pw }),
  });
  const c = r.headers.get('set-cookie');
  assert.ok(c, 'the issued login does not work');
  cookies.newbuyer = c.split(';')[0];

  /* The same property isolation.test.js asserts for the seeded buyer, asserted
     for one created through the screens: row-level security, not a filter. */
  const sess = await asUser(OFFICE, c2 => c2.query(
    `SELECT buyer_user_id id FROM units WHERE id = $1`, [issued.unit])).then(x => x.rows[0]);
  const mine = await asUser({ id: sess.id, role: 'buyer' },
    c2 => c2.query('SELECT code FROM units'));
  assert.deepStrictEqual(mine.rows.map(x => x.code), ['H-01'],
    'the new buyer can see ' + mine.rows.length + ' villas');

  const journey = await get('/journey', 'newbuyer');
  assert.strictEqual(journey.status, 200);
  const steps = [...journey.html.matchAll(/<span class="tlt">([^<]*)/g)].map(m => m[1].trim());
  assert.deepStrictEqual(steps.slice(0, 6),
    ['Booking', 'Foundation', 'Structure', 'Blockwork and plaster', 'Finishes', 'Handover'],
    'the journey does not draw this project’s own schedule');

  assert.strictEqual((await get('/villa/H-01', 'newbuyer')).status, 200, 'their own villa');
  assert.strictEqual((await get('/villa/H-02', 'newbuyer')).status, 404,
    'a villa on their own project that is not theirs');
  assert.strictEqual((await get('/villa/B-14', 'newbuyer')).status, 404,
    'a villa on the seeded project');
  assert.strictEqual((await get('/office', 'newbuyer')).status, 404, 'the office console');
});

test('the project that was already here is untouched', async () => {
  assert.strictEqual(await count(`SELECT count(*) n FROM units WHERE project_id='eterna-p1'`), 48,
    'the seeded project changed size');
  assert.strictEqual(await count(
    `SELECT count(*) n FROM stage_templates WHERE project_id='eterna-p1'`), 10,
    'the seeded schedule changed');
  assert.strictEqual(await count(
    `SELECT count(*) n FROM unit_stages s JOIN units u ON u.id = s.unit_id
      WHERE u.project_id = 'eterna-p1'`), 480,
    'the seeded stage rows changed');

  /* And the seeded buyer still sees exactly their own villa, with a second
     project now on the console. */
  const b14 = await asUser({ id: 'u-buyer-b14', role: 'buyer' },
    c => c.query('SELECT code FROM units'));
  assert.deepStrictEqual(b14.rows.map(x => x.code), ['B-14']);
});

test('every write here left an audit row naming who did it', async () => {
  const rows = await asUser(OFFICE, c => c.query(
    `SELECT action, target_id FROM audit_log
      WHERE action IN ('project_created','schedule_set','villas_imported','buyer_created')
        AND (target_id = $1 OR target_id LIKE 'u-' || $1 || '%')
      ORDER BY at`, [PROJECT])).then(r => r.rows);
  const actions = rows.map(r => r.action);
  for (const a of ['project_created', 'schedule_set', 'villas_imported', 'buyer_created']) {
    assert.ok(actions.includes(a), 'nothing was logged for ' + a);
  }
});
