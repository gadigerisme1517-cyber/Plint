'use strict';
/* ============================================================================
   The shared state added by migrations 011 and 012.

   Two things are being held here. First that the seed actually produced the
   rows the screens will need, because a worklist with nothing in it looks
   identical to a worklist that is broken. Second, and the reason any of this
   is in the database rather than in a session, that every new table obeys the
   same isolation rule as the old ones: a buyer reaches his own unit and no
   other, an engineer reaches the site and not a loan file, and a session with
   no identity reaches nothing at all.
   ========================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pool, asUser } = require('../src/db');

after(() => pool.end());

/** Every table 011 and 012 created, with the roles that may read it. */
const TABLES = {
  lenders:          { buyer: 'all',  engineer: 'all',  office: 'all' },
  loan_applicants:  { buyer: 'own',  engineer: 'none', office: 'all' },
  loan_documents:   { buyer: 'own',  engineer: 'none', office: 'all' },
  agreements:       { buyer: 'own',  engineer: 'all',  office: 'all' },
  choices:          { buyer: 'own',  engineer: 'all',  office: 'all' },
  possessions:      { buyer: 'own',  engineer: 'all',  office: 'all' },
  visits:           { buyer: 'own',  engineer: 'all',  office: 'all' },
  queries:          { buyer: 'own',  engineer: 'all',  office: 'all' },
  query_messages:   { buyer: 'own',  engineer: 'all',  office: 'all' },
  snags:            { buyer: 'own',  engineer: 'all',  office: 'all' },
  site_log:         { buyer: 'none', engineer: 'all',  office: 'all' },
  handoffs:         { buyer: 'none', engineer: 'none', office: 'all' },
  pack_queries:     { buyer: 'none', engineer: 'all',  office: 'all' },
  escrow_movements: { buyer: 'none', engineer: 'none', office: 'all' },
  qpr_filings:      { buyer: 'none', engineer: 'all',  office: 'all' },
  notifications:    { buyer: 'own',  engineer: 'own',  office: 'own' },
};

const AS = {
  buyer:    { id: 'u-buyer-b14', role: 'buyer' },
  engineer: { id: 'u-eng-ram',   role: 'engineer' },
  office:   { id: 'u-office',    role: 'office' },
};

const count = (table, role) =>
  asUser(AS[role], c =>
    c.query('SELECT count(*)::int n FROM ' + table).then(r => r.rows[0].n));

// ------------------------------------------------------ the seed produced rows

test('every screen the office opens has something behind it', async () => {
  const want = {
    lenders: 11, loan_applicants: 1, loan_documents: 1, agreements: 48,
    choices: 144, visits: 3, queries: 3, query_messages: 5, snags: 5,
    site_log: 5, handoffs: 3, escrow_movements: 12, qpr_filings: 2, notifications: 5,
  };
  for (const [table, atLeast] of Object.entries(want)) {
    const n = await count(table, 'office');
    assert.ok(n >= atLeast,
      table + ' has ' + n + ' rows, wanted at least ' + atLeast +
      ' - an empty worklist and a broken one look the same on screen');
  }
});

test('the loan panel is v21\'s, with APF codes only where there is a panel', async () => {
  const rows = await asUser(AS.office, c =>
    c.query('SELECT name, apf_code, on_panel, rate_bp FROM lenders ORDER BY seq').then(r => r.rows));
  const panel = rows.filter(r => r.on_panel);
  assert.strictEqual(panel.length, 5, 'v21 lists five banks that have vetted this project');
  for (const r of panel) {
    assert.match(r.apf_code, /^APF\//, r.name + ' is on the panel with no APF code');
    assert.ok(r.rate_bp > 0 && r.rate_bp < 2000, r.name + ' has an implausible rate');
  }
  for (const r of rows.filter(r => !r.on_panel)) {
    assert.strictEqual(r.apf_code, null, r.name + ' is off panel but carries an APF code');
    /* And no rate. A lender that has not approved this project has quoted
       nothing on it, and a number in this column is printed to the buyer as
       though a bank had said it. */
    assert.strictEqual(r.rate_bp, null, r.name + ' is off panel but carries a rate nobody quoted');
  }
});

test('every villa has an engineer who can be reassigned away', async () => {
  const rows = await asUser(AS.office, c => c.query(
    `SELECT count(*)::int total,
            count(assigned_engineer_id)::int assigned,
            count(DISTINCT assigned_engineer_id)::int engineers FROM units`).then(r => r.rows[0]));
  assert.strictEqual(rows.assigned, rows.total, 'a villa with no engineer appears on nobody\'s list');
  assert.ok(rows.engineers >= 2, 'work must sit with more than one person for reassignment to mean anything');
});

// -------------------------------------------------------------- isolation

/* Reference data, readable by any session, the same as `projects` and
   `stage_templates` already are. `lenders` joins them: which banks have vetted
   this project, and at what rate, is the sort of thing a builder prints on a
   brochure. It earns that only by carrying nothing about a person, which is
   the next test rather than an assurance here. */
const REFERENCE = new Set(['lenders']);

test('a session with no identity reads none of the new state', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const table of Object.keys(TABLES)) {
      if (REFERENCE.has(table)) continue;
      const n = (await c.query('SELECT count(*)::int n FROM ' + table)).rows[0].n;
      assert.strictEqual(n, 0, table + ' is readable with no identity set');
    }
    await c.query('ROLLBACK');
  } finally { c.release(); }
});

test('the tables readable without an identity hold nothing about anybody', async () => {
  /* The exemption above is only safe while it stays true. A column pointing at
     a unit or a user on one of these would publish a buyer's position to an
     unauthenticated request. */
  for (const table of REFERENCE) {
    const cols = await asUser(AS.office, c => c.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'plint' AND table_name = $1`, [table]).then(r => r.rows.map(x => x.column_name)));
    for (const col of cols) {
      assert.ok(!/unit|user|buyer|applicant|_by$/.test(col),
        table + '.' + col + ' looks personal, and ' + table + ' is readable with no identity');
    }
  }
});

test('no role can read a table it has no business in', async () => {
  /* Only the negative direction is asserted here. "Reads at least one row" is
     a fact about the seed, not about the policy, and it lives in the seed test
     above - a table that is legitimately empty for a role (no buyer has a
     notification yet, nobody has taken possession) is not a policy failure. */
  for (const [table, byRole] of Object.entries(TABLES)) {
    for (const [role, expect] of Object.entries(byRole)) {
      if (expect !== 'none') continue;
      const n = await count(table, role);
      assert.strictEqual(n, 0,
        role + ' can read ' + table + ' (' + n + ' rows) and should read none');
    }
  }
});

test('a notification reaches one role and stays there', async () => {
  const forOffice = await asUser(AS.office, c => c.query(
    `SELECT count(*)::int n FROM notifications`).then(r => r.rows[0].n));
  assert.ok(forOffice > 0, 'the office feed is empty');

  for (const role of ['buyer', 'engineer']) {
    const rows = await asUser(AS[role], c => c.query(
      `SELECT DISTINCT for_role FROM notifications`).then(r => r.rows.map(x => x.for_role)));
    assert.ok(rows.every(x => x === role),
      role + ' can read notifications addressed to ' + rows.join(', '));
  }
});

test('a buyer reaches his own loan file and not his neighbour\'s', async () => {
  const mine = await asUser(AS.buyer, c => c.query(
    `SELECT DISTINCT unit_id FROM loan_applicants`).then(r => r.rows.map(x => x.unit_id)));
  assert.deepStrictEqual(mine, ['unit-B-14'], 'the buyer sees applicants on ' + mine.join(', '));

  const docs = await asUser(AS.buyer, c => c.query(
    `SELECT count(*)::int n FROM loan_documents`).then(r => r.rows[0].n));
  const all = await asUser(AS.office, c => c.query(
    `SELECT count(*)::int n FROM loan_documents`).then(r => r.rows[0].n));
  assert.ok(docs > 0 && docs < all, 'the buyer sees ' + docs + ' of ' + all + ' documents');
});

test('a buyer reaches his own visits, queries, snags and choices only', async () => {
  for (const [table, col] of [['visits', 'unit_id'], ['queries', 'unit_id'],
                              ['snags', 'unit_id'], ['choices', 'unit_id']]) {
    const units = await asUser(AS.buyer, c =>
      c.query(`SELECT DISTINCT ${col} u FROM ${table}`).then(r => r.rows.map(x => x.u)));
    for (const u of units) {
      assert.strictEqual(u, 'unit-B-14', table + ' leaked ' + u + ' to the B-14 buyer');
    }
  }
});

test('the site cannot open a loan file', async () => {
  /* Not an oversight. An engineer needs the villa, the stage and the
     photographs; he has no business knowing what a buyer earns, and the
     document list says exactly that about a person. */
  for (const table of ['loan_applicants', 'loan_documents', 'handoffs', 'escrow_movements']) {
    const n = await count(table, 'engineer');
    assert.strictEqual(n, 0, 'the engineer can read ' + table);
  }
});

/* A write that must be refused, attempted for real and then always rolled
   back.

   `asUser` commits when the callback returns, so a straight `assert.rejects`
   around an INSERT leaves the row behind on the day the policy is wrong - and
   that is exactly the day this test runs. It happened: a mutation run that
   made the policy permissive left a snag titled "Forged" in the development
   database, raised in the head office's name, and it sat on the engineer's
   screen until it was spotted by eye. The test caught the mutation and still
   made a mess. Throwing a sentinel forces the ROLLBACK either way. */
const ROLLBACK = Symbol('rollback');
async function mustBeRefused(who, sql, params) {
  let allowed = false;
  let refusal = null;
  await asUser(who, async c => {
    try { await c.query(sql, params); allowed = true; }
    catch (e) { refusal = e.message; }
    throw ROLLBACK;
  }).catch(e => { if (e !== ROLLBACK) throw e; });
  return { allowed, refusal };
}

test('a buyer cannot write a snag as somebody else', async () => {
  const r = await mustBeRefused(AS.buyer,
    `INSERT INTO snags VALUES ('snag-forged','unit-B-14','Forged','u-office','office',now(),'open',null,null,null)`);
  assert.ok(!r.allowed, 'a buyer signed a snag in the office\'s name');
  assert.match(r.refusal, /row-level security|violates/i);
});

test('a buyer cannot raise a query against a villa that is not his', async () => {
  const r = await mustBeRefused(AS.buyer,
    `INSERT INTO queries VALUES ('q-forged','unit-A-04','query','Nosy','u-buyer-b14',now(),'open',null)`);
  assert.ok(!r.allowed, 'a buyer raised a query on a neighbour\'s villa');
  assert.match(r.refusal, /row-level security|violates/i);
});

test('nothing a refused write attempted is left in the database', async () => {
  /* The point of the rollback above. If this ever finds a row, the suite is
     writing the very thing it exists to forbid. */
  const left = await asUser(AS.office, c => c.query(
    `SELECT id FROM snags WHERE id = 'snag-forged'
      UNION ALL SELECT id FROM queries WHERE id = 'q-forged'`).then(r => r.rows));
  assert.deepStrictEqual(left, [], 'a refused write was committed: ' + JSON.stringify(left));
});

test('the runtime role cannot delete any of it', async () => {
  /* Asked directly of the role the application actually connects as. The first
     version of this queried role_table_grants with `grantee <> current_user`,
     which excluded the only grantee that matters - it passed happily while a
     DELETE grant sat on snags. */
  const rows = await asUser(AS.office, c => c.query(
    `SELECT t, has_table_privilege(current_user, 'plint.' || t, 'DELETE') AS can_delete
       FROM unnest($1::text[]) AS t`, [Object.keys(TABLES)]).then(r => r.rows));
  const bad = rows.filter(r => r.can_delete).map(r => r.t);
  assert.deepStrictEqual(bad, [], 'the runtime role can DELETE from ' + bad.join(', '));

  // And the same for everything that was already here, so the claim is whole.
  const older = await asUser(AS.office, c => c.query(
    `SELECT tablename t, has_table_privilege(current_user, 'plint.' || tablename, 'DELETE') AS can_delete
       FROM pg_tables WHERE schemaname = 'plint'`).then(r => r.rows));
  const badOlder = older.filter(r => r.can_delete).map(r => r.t);
  assert.deepStrictEqual(badOlder, [], 'the runtime role can DELETE from ' + badOlder.join(', '));
});
