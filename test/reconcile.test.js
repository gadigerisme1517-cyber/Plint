'use strict';
/* ============================================================================
   Do the stored demands and the screens agree?

   This is the test that catches a call site the residual refactor missed. A
   stage priced on its own and a stage priced within its schedule differ only
   on the last stage, and only when the agreement value does not divide
   cleanly. Every villa but one is on 3,20,00,000 paise, where they are
   identical and a bug is invisible.

   A-07 is on 2,98,76,543.21, which drifts by a paise under per-stage rounding.
   It is the probe. If any screen, document or seeded row priced a stage alone,
   A-07's last stage is where it shows.
   ========================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const M = require('../src/money');
const { asUser, pool } = require('../src/db');

const OFFICE = { id: 'u-office', role: 'office' };
const PORT = 3201, BASE = 'http://127.0.0.1:' + PORT;
const server = require('../src/server');

before(() => new Promise(r => server.listen(PORT, r)));
after(async () => {
  await new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  await pool.end();
});

const signIn = async email => {
  const r = await fetch(BASE + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, pw: 'plint' }),
  });
  return r.headers.get('set-cookie').split(';')[0];
};

/** The project schedule, ordered, exactly as every screen loads it. */
const bpsFor = c => c.query(
  'SELECT pct_bp FROM stage_templates WHERE project_id=$1 ORDER BY seq', ['eterna-p1'])
  .then(r => r.rows.map(x => x.pct_bp));

// --------------------------------------------------------------- the probe

test('the seed carries an agreement value that actually exercises the residual', async () => {
  const u = (await asUser(OFFICE, c =>
    c.query(`SELECT agreement_value_paise v FROM units WHERE code='A-07'`))).rows[0];
  const bps = await asUser(OFFICE, bpsFor);

  const naive = bps.map(bp => M.stageBase(u.v, bp));
  const naiveSum = naive.reduce((a, b) => a + b, 0);

  assert.notStrictEqual(naiveSum, Number(u.v),
    'A-07 must be on a value where per-stage rounding drifts, or this suite proves nothing');
  assert.strictEqual(M.stageBases(u.v, bps).reduce((a, b) => a + b, 0), Number(u.v),
    'and the residual must close that drift');
});

// ------------------------------------------------- seed against the layer

test('every stored demand equals what the calculation layer prices today', async () => {
  const { units, stages, demands, bps } = await asUser(OFFICE, async c => ({
    units: (await c.query('SELECT id, code, agreement_value_paise FROM units')).rows,
    stages: (await c.query(
      `SELECT s.id, s.unit_id, t.seq FROM unit_stages s
         JOIN stage_templates t ON t.code = s.stage_code`)).rows,
    demands: (await c.query(
      `SELECT unit_stage_id, base_paise, gst_paise, extras_paise, total_paise, raised_at
         FROM demands`)).rows,
    bps: await bpsFor(c),
  }));

  const seqOf = new Map(stages.map(s => [s.id, s.seq]));
  const unitOf = new Map(stages.map(s => [s.id, s.unit_id]));
  const priced = new Map(units.map(u =>
    [u.id, M.schedule(u.agreement_value_paise, bps)]));
  const codeOf = new Map(units.map(u => [u.id, u.code]));
  const valueOf = new Map(units.map(u => [u.id, u.agreement_value_paise]));

  assert.ok(demands.length > 100, `${demands.length} seeded demands to reconcile`);

  for (const d of demands) {
    const unitId = unitOf.get(d.unit_stage_id);
    const seq = seqOf.get(d.unit_stage_id);
    const want = priced.get(unitId)[seq];
    const where = `${codeOf.get(unitId)} stage ${seq}`;

    /* THE BASE IS THE SCHEDULE'S, ALWAYS. Extras are not part of it: they are
       what the buyer signed for above the allowance, they belong to the villa
       and not to the stage's percentage, and the schedule must still sum to
       the agreement value with them excluded. */
    assert.strictEqual(d.base_paise, want.basePaise, `${where}: stored base disagrees`);

    /* GST AND THE TOTAL ARE PRICED ON BASE PLUS EXTRAS, which is what
       `priceStage` has always done and what nothing ever gave it a non-zero
       value for until interior options had prices. A demand that carries an
       extra is re-priced here with that extra, from the demand's own column -
       so this still compares the stored figure against the layer and not
       against itself. */
    const withExtras = M.priceStage({
      agreementValuePaise: valueOf.get(unitId),
      scheduleBps: bps, index: seq,
      extrasPaise: Number(d.extras_paise),
      raisedAt: new Date(d.raised_at),
    });
    assert.strictEqual(d.gst_paise, withExtras.gstPaise, `${where}: stored GST disagrees`);
    assert.strictEqual(d.total_paise, withExtras.totalPaise, `${where}: stored total disagrees`);
    assert.strictEqual(d.total_paise,
      Number(d.base_paise) + Number(d.extras_paise) + Number(d.gst_paise),
      `${where}: the stored figures do not add up to their own total`);
  }
});

test('every villa schedules to its own agreement value, to the paise', async () => {
  const { units, bps } = await asUser(OFFICE, async c => ({
    units: (await c.query('SELECT code, agreement_value_paise v FROM units')).rows,
    bps: await bpsFor(c),
  }));
  for (const u of units) {
    const sum = M.stageBases(u.v, bps).reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, Number(u.v), `${u.code} schedules to ${sum}, not ${u.v}`);
  }
});

// ------------------------------------------------- screens against the layer

/* The stage amounts a buyer screen renders, in schedule order.

   Scoped to the stage rows on purpose. The same `.amt` class carries the
   agreement value and the ledger lines, so an unscoped match picks those up
   too and silently compares the wrong numbers. Every stage row is a link to
   its own screen, so the href is the anchor: take the figure in the `.tlr`
   after each `/stage/` link. (It was `class="stage "` on one long villa page,
   then a shared `.wrow` card; it is a step on the journey's timeline now.) */
const amountsOn = html =>
  [...html.matchAll(/<a class="tls[^"]*" href="\/stage\/[^"]*"[\s\S]*?class="tlr"><span class="num">([^<]+)</g)]
    .map(m => m[1]);

/* "Paid so far" is a KPI tile on the money screen now, not a worklist row in
   the retired system's markup. Same figure, read where it is printed. */
const paidSoFarOn = html =>
  (/<\/svg> Paid so far<\/div><b class="num[^"]*">([^<]+)</.exec(html) || [])[1];

/* The schedule is the Journey tab and the ledger is the Money tab since the
   buyer got v21's five. They used to be two blocks of one page. */
async function buyerScreenOf(email, path) {
  const cookie = await signIn(email);
  const r = await fetch(BASE + path, { headers: { cookie }, redirect: 'follow' });
  assert.strictEqual(r.status, 200, path + ' did not open');
  return r.text();
}

test('B-14: the screen, the ledger and the stored demands all agree', async () => {
  const { u, stages, bps } = await asUser(OFFICE, async c => ({
    u: (await c.query(`SELECT * FROM units WHERE code='B-14'`)).rows[0],
    stages: (await c.query(
      `SELECT s.status, t.pct_bp, t.seq FROM unit_stages s
         JOIN stage_templates t ON t.code = s.stage_code
        WHERE s.unit_id='unit-B-14' ORDER BY t.seq`)).rows,
    bps: await bpsFor(c),
  }));

  const priced = M.schedule(u.agreement_value_paise, bps);
  const led = M.ledger({ agreementValuePaise: u.agreement_value_paise, stages });

  assert.strictEqual(paidSoFarOn(await buyerScreenOf('arjun@example.in', '/money')),
    M.money(led.paidPaise), 'the screen prints the ledger figure it was given');

  const shown = amountsOn(await buyerScreenOf('arjun@example.in', '/journey'));
  assert.strictEqual(shown.length, 10, 'ten stage rows');

  /* WHAT A STAGE COSTS, AND WHAT IT COST.
     The schedule says what a stage will cost. Once a demand exists that stage
     HAS a cost, and since a signed interior choice reaches the demand it is
     billed on, the two legitimately differ - the demand is bigger by the extra
     and the GST on it. The screen must show the letter that went out, not the
     schedule it was priced from, so the stronger property is asserted here:
     where there is a demand the screen matches the demand, and the demand
     itself re-derives from the money layer given its own extras and its own
     raised date. Where there is no demand, the schedule still governs. */
  const dems = await asUser(OFFICE, c => c.query(
    `SELECT d.total_paise, d.extras_paise, d.raised_at, t.seq
       FROM demands d JOIN unit_stages s ON s.id = d.unit_stage_id
       JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = 'eterna-p1'
      WHERE s.unit_id = 'unit-B-14'`).then(r => r.rows));
  const demAt = i => dems.find(x => Number(x.seq) === i);   // seq is 0-based here

  priced.forEach((p, i) => {
    const dm = demAt(i);
    const want = dm ? Number(dm.total_paise) : p.totalPaise;
    assert.strictEqual(shown[i], M.money(want),
      `stage ${i} on screen is ${shown[i]}, the record says ${M.money(want)}`);
    if (dm) {
      const re = M.priceStage({
        agreementValuePaise: u.agreement_value_paise, scheduleBps: bps, index: i,
        extrasPaise: Number(dm.extras_paise || 0), raisedAt: new Date(dm.raised_at),
      });
      assert.strictEqual(re.totalPaise, Number(dm.total_paise),
        `stage ${i}'s stored demand does not re-price from the layer`);
    }
  });

  // And the ledger accounts for the whole schedule, nothing lost or double
  // counted between the three buckets.
  const total = led.paidPaise + led.demandedPaise + led.remainingPaise;
  assert.strictEqual(total, priced.reduce((n, p) => n + p.totalPaise, 0));
});

test('A-07: the awkward value reconciles too, and the last stage carries the paise', async () => {
  const { u, stages, bps, demands } = await asUser(OFFICE, async c => ({
    u: (await c.query(`SELECT * FROM units WHERE code='A-07'`)).rows[0],
    stages: (await c.query(
      `SELECT s.status, t.pct_bp, t.seq FROM unit_stages s
         JOIN stage_templates t ON t.code = s.stage_code
        WHERE s.unit_id='unit-A-07' ORDER BY t.seq`)).rows,
    bps: await bpsFor(c),
    demands: (await c.query(
      `SELECT d.total_paise, d.base_paise, t.seq FROM demands d
         JOIN unit_stages s ON s.id = d.unit_stage_id
         JOIN stage_templates t ON t.code = s.stage_code
        WHERE s.unit_id='unit-A-07' ORDER BY t.seq`)).rows,
  }));

  const priced = M.schedule(u.agreement_value_paise, bps);
  const led = M.ledger({ agreementValuePaise: u.agreement_value_paise, stages });
  assert.strictEqual(paidSoFarOn(await buyerScreenOf('sharma@example.in', '/money')),
    M.money(led.paidPaise));

  const shown = amountsOn(await buyerScreenOf('sharma@example.in', '/journey'));
  assert.strictEqual(shown.length, 10);
  /* THE SCREEN SHOWS WHAT WAS BILLED WHERE ANYTHING WAS BILLED, and the
     schedule's figure where nothing has been. Those are the same number until
     a stage's demand carries an interior extra the buyer signed for, and then
     the demand is the truth: it is the letter that went out. */
  const billed = new Map(demands.map(d => [d.seq, Number(d.total_paise)]));
  priced.forEach((p, i) => {
    const want = billed.has(i) ? billed.get(i) : p.totalPaise;
    assert.strictEqual(shown[i], M.money(want), `A-07 stage ${i} disagrees`);
  });

  // The last stage is the one that differs from pricing alone. If any call
  // site had been missed, this is the assertion that fails.
  const alone = M.stageBase(u.agreement_value_paise, bps[9]);
  assert.strictEqual(priced[9].basePaise, alone + 1,
    'the last stage carries the paise the first nine left behind');

  // Stored demands agree with what the screen shows, which is themselves.
  for (const d of demands) {
    assert.strictEqual(M.money(d.total_paise), shown[d.seq],
      `A-07 stored demand for stage ${d.seq} disagrees with the screen`);
    /* And the stage's own base is still exactly its share of the schedule:
       an extra is added to a demand, never blended into the percentage. */
    assert.strictEqual(Number(d.base_paise), priced[d.seq].basePaise,
      `A-07 stage ${d.seq}: an extra has been blended into the base`);
  }

  const total = led.paidPaise + led.demandedPaise + led.remainingPaise;
  assert.strictEqual(total, priced.reduce((n, p) => n + p.totalPaise, 0));

  // The bases sum to the agreement value exactly. The GSTs do not have to:
  // GST is rounded per invoice and is not residualised. Recorded here so the
  // difference is a documented property rather than a surprise.
  assert.strictEqual(priced.reduce((n, p) => n + p.basePaise, 0),
    Number(u.agreement_value_paise));
  const gstSum = priced.reduce((n, p) => n + p.gstPaise, 0);
  assert.strictEqual(gstSum - M.gstOn(u.agreement_value_paise), 2,
    'per-stage GST rounding differs from GST on the whole by two paise, as documented');
});

test('the demand letter prints the stored figure, which is the ledger figure', async () => {
  const cookie = await signIn('ramachandran@nvt.in');

  for (const code of ['B-14', 'A-07']) {
    const row = (await asUser(OFFICE, c => c.query(
      `SELECT d.unit_stage_id, d.total_paise, d.extras_paise, d.raised_at,
              t.seq, u.agreement_value_paise
         FROM demands d
         JOIN unit_stages s ON s.id = d.unit_stage_id
         JOIN units u ON u.id = s.unit_id
         JOIN stage_templates t ON t.code = s.stage_code
        WHERE u.code = $1 ORDER BY t.seq DESC LIMIT 1`, [code]))).rows[0];
    assert.ok(row, code + ' has a demand');

    const bps = await asUser(OFFICE, bpsFor);
    /* Priced with the demand's own extras, for the reason given above: an
       interior option signed above the allowance is part of what that letter
       asks for, and the letter prints the stored total either way. */
    const want = M.priceStage({
      agreementValuePaise: row.agreement_value_paise,
      scheduleBps: bps, index: row.seq,
      extrasPaise: Number(row.extras_paise),
      raisedAt: new Date(row.raised_at),
    }).totalPaise;
    assert.strictEqual(row.total_paise, want,
      code + ': the stored demand the PDF prints disagrees with the layer');

    const r = await fetch(BASE + '/doc/demand/' + row.unit_stage_id + '.pdf',
      { headers: { cookie } });
    assert.strictEqual(r.status, 200, code + ' demand letter renders');
    const pdf = Buffer.from(await r.arrayBuffer());
    assert.strictEqual(pdf.subarray(0, 4).toString(), '%PDF');
  }
});

// ------------------------------------------------- the layer refuses to guess

test('pricing a stage without its schedule is an error, not a quiet fallback', () => {
  const bps = [1000, 1500, 1000, 1000, 1000, 1000, 1000, 1000, 800, 700];

  // An index with no schedule: what a failed schedule load would look like.
  assert.throws(() => M.priceStage({ agreementValuePaise: 2987654321, index: 9 }),
    /index but no schedule/);

  // A schedule with a hole in it, which is what a missing seq would produce.
  const holed = [...bps]; delete holed[4];
  assert.throws(() => M.stageBases(2987654321, holed), /not a positive basis point/);

  assert.throws(() => M.stageBases(2987654321, []), /needs the whole schedule/);
  assert.throws(() => M.priceStage({ agreementValuePaise: 1, scheduleBps: bps, index: 99 }),
    /outside a schedule/);
});

test('sharp resolves from this repo, not from a parent directory', () => {
  const path = require('path');
  const here = path.resolve(__dirname, '..');
  const resolved = require.resolve('sharp');
  assert.ok(resolved.startsWith(path.join(here, 'node_modules') + path.sep),
    `sharp resolved to ${resolved}, which is outside ${here}`);

  const pkg = require('../package.json');
  assert.strictEqual(pkg.dependencies.sharp, '0.35.4',
    'pinned exactly, because it is a native dependency');
});
