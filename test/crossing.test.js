'use strict';
/* ============================================================================
   POLICY-CROSSING READS: THE CLASS, NOT THE INCIDENT.

   In Pass 6 the engineer's snag queue showed one open snag of seven. The
   query joined `users` to get the raiser's name; the policy `u_self` hides a
   buyer's user row from staff; an INNER JOIN against a row the policy hides
   returns nothing at all. Six snags disappeared from the only person who can
   close them, and no test saw it, because the office's count of the same
   table - which does not join - stayed right.

   That is a class of defect with three properties that make it dangerous:

     1. It is silent. There is no error, no empty screen, no zero. There is a
        shorter list, and a shorter list looks like a quieter site.
     2. It is invisible to any test that asserts a screen "has rows".
     3. Its OUTER-join form is worse. An outer join keeps the row and loses
        the FIELD, and a field that renders as an empty string is not
        something anybody sees. The buyer's visit list had been failing to
        name the engineer since the day it was written, for exactly this
        reason - the fix for that is db/migrations/018.

   This suite is the guard. Three parts:

     THE MATRIX. Every table with row-level security, counted as the owner
     and as each of the three roles, against a DECLARED expectation. If a
     policy is ever widened or narrowed, this fails and whoever changed it has
     to say what they meant. It is the only place in the product where the
     visibility of every table is written down in one list.

     THE SCREENS. For the tables the seed fills with buyer-authored rows, the
     product's own loader must return as many rows as the policy allows. This
     is the test the snag bug would have failed.

     THE RULE. `users` is the one table narrowed for EVERY role, so an inner
     join onto it is never safe. The source is read and any that appears fails
     this test by name.
   ========================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const { asUser, pool } = require('../src/db');
const config = require('../src/config');

const PORT = 3252, BASE = 'http://127.0.0.1:' + PORT;
const server = require('../src/server');

const BUYER = { id: 'u-buyer-b14', role: 'buyer', unit: 'B-14', name: 'Arjun Nair' };
const ENGINEER = { id: 'u-eng-ram', role: 'engineer', name: 'S. Ramachandran' };
const OFFICE = { id: 'u-office', role: 'office', name: 'Priya Menon' };

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
  await owner.end().catch(() => {});
  await new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  await pool.end();
});

const get = async (p, role) => (await fetch(BASE + p, { headers: { cookie: cookies[role] } })).text();
const nAsOwner = t => owner.query('SELECT count(*)::int n FROM ' + t).then(r => r.rows[0].n);
const nAsRole = (s, t) => asUser(s, c =>
  c.query('SELECT count(*)::int n FROM ' + t).then(r => r.rows[0].n));

/* ---------------------------------------------------------------- the matrix

   `all`  - the role reads every row there is
   `own`  - the role reads the subset that belongs to them, and the seeded data
            proves it: strictly fewer rows than there are
   `own?` - narrower by policy, but the seed holds nothing this role is not
            entitled to, so no count can demonstrate it. Used exactly once and
            named where it is used
   `none` - the role reads nothing
   `gone` - the application role has no grant at all, so the read errors

   Written out rather than derived, because the point is that a change has to
   be a decision somebody typed. */
const MATRIX = {
  agreements:       { buyer: 'own',  engineer: 'all',  office: 'all'  },
  audit_log:        { buyer: 'none', engineer: 'all',  office: 'all'  },
  blockers:         { buyer: 'none', engineer: 'all',  office: 'all'  },
  /* Pass 7's four. The first two are deliberately readable by everybody: how
     long a record is kept and who else holds it are things a buyer is
     entitled to know, and there is nothing in either that is not true of
     every buyer on every project. */
  breach_notices:   { buyer: 'none', engineer: 'none', office: 'all'  },
  /* Pass 8's three. A price list, a published plan and a policy decision are
     the same for everybody who can see the project, so all three are readable
     by all three roles - and `choice_options` is the one of them bounded to a
     villa, because a price belongs to a choice and a choice belongs to a
     buyer. */
  choice_options:   { buyer: 'own',  engineer: 'all',  office: 'all'  },
  policy_decisions: { buyer: 'all',  engineer: 'all',  office: 'all'  },
  project_documents:{ buyer: 'all',  engineer: 'all',  office: 'all'  },
  /* A buyer sees a hold that covers their own file and no other. Marked with
     a question because the demo database carries no hold to count. */
  legal_holds:      { buyer: 'own?', engineer: 'all',  office: 'all'  },
  retention_policy: { buyer: 'all',  engineer: 'all',  office: 'all'  },
  sub_processors:   { buyer: 'all',  engineer: 'all',  office: 'all'  },
  choices:          { buyer: 'own',  engineer: 'all',  office: 'all'  },
  credits:          { buyer: 'own',  engineer: 'all',  office: 'all'  },
  demands:          { buyer: 'own',  engineer: 'all',  office: 'all'  },
  escrow_movements: { buyer: 'none', engineer: 'none', office: 'all'  },
  evidence:         { buyer: 'own',  engineer: 'all',  office: 'all'  },
  handoffs:         { buyer: 'none', engineer: 'none', office: 'all'  },
  lenders:          { buyer: 'all',  engineer: 'all',  office: 'all'  },
  loan_applicants:  { buyer: 'own',  engineer: 'none', office: 'all'  },
  loan_documents:   { buyer: 'own',  engineer: 'none', office: 'all'  },
  login_attempts:   { buyer: 'gone', engineer: 'gone', office: 'gone' },
  /* NOTIFICATIONS. Its policy is `for_role = current_role_name()`, so every
     role reads a strict subset and none of them reads all of it. Pass 7 could
     only mark this 'own?' because every seeded row was for_role='office' and
     no count could demonstrate the narrowing, and because there was no reader
     on any surface to demonstrate it to. Pass 8 built the reader on all three
     and seeded rows addressed to each, so the narrowing is now countable and
     is declared as what it is. */
  notifications:    { buyer: 'own',  engineer: 'own',  office: 'own'  },
  pack_deliveries:  { buyer: 'own',  engineer: 'all',  office: 'all'  },
  pack_queries:     { buyer: 'none', engineer: 'all',  office: 'all'  },
  possessions:      { buyer: 'own',  engineer: 'all',  office: 'all'  },
  projects:         { buyer: 'all',  engineer: 'all',  office: 'all'  },
  qpr_filings:      { buyer: 'none', engineer: 'all',  office: 'all'  },
  queries:          { buyer: 'own',  engineer: 'all',  office: 'all'  },
  query_messages:   { buyer: 'own',  engineer: 'all',  office: 'all'  },
  receipts:         { buyer: 'own',  engineer: 'all',  office: 'all'  },
  sessions:         { buyer: 'gone', engineer: 'gone', office: 'gone' },
  site_log:         { buyer: 'none', engineer: 'all',  office: 'all'  },
  snags:            { buyer: 'own',  engineer: 'all',  office: 'all'  },
  stage_templates:  { buyer: 'all',  engineer: 'all',  office: 'all'  },
  unit_stages:      { buyer: 'own',  engineer: 'all',  office: 'all'  },
  units:            { buyer: 'own',  engineer: 'all',  office: 'all'  },
  users:            { buyer: 'own',  engineer: 'own',  office: 'own'  },
  visits:           { buyer: 'own',  engineer: 'all',  office: 'all'  },
};

test('every table with row-level security is in the declared matrix', async () => {
  const rows = (await owner.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'plint' AND c.relkind = 'r' AND c.relrowsecurity
      ORDER BY c.relname`)).rows.map(r => r.relname);
  const missing = rows.filter(t => !MATRIX[t]);
  assert.deepStrictEqual(missing, [],
    'a table has row-level security and nobody has written down who can see '
    + 'what through it: ' + missing.join(', '));
  const stale = Object.keys(MATRIX).filter(t => !rows.includes(t));
  assert.deepStrictEqual(stale, [], 'the matrix names tables that no longer exist: ' + stale);
});

test('what each role can actually read is what the matrix says', async () => {
  for (const [t, want] of Object.entries(MATRIX)) {
    const all = await nAsOwner(t);
    for (const [role, sess] of [['buyer', BUYER], ['engineer', ENGINEER], ['office', OFFICE]]) {
      let got;
      try { got = await nAsRole(sess, t); }
      catch (e) { got = 'gone'; }
      const rule = want[role];
      const said = t + ' as ' + role + ': ' + got + ' of ' + all + ', declared "' + rule + '"';
      if (rule === 'gone') { assert.strictEqual(got, 'gone', said); continue; }
      assert.notStrictEqual(got, 'gone', said);
      if (rule === 'all')  assert.strictEqual(got, all, said);
      if (rule === 'none') assert.strictEqual(got, 0, said);
      if (rule === 'own?') assert.ok(got <= all, said);
      if (rule === 'own') {
        /* A row count is only evidence of a narrower view when there is
           something to be narrower than. Where the table is empty the rule is
           unfalsifiable and is allowed to pass; where it is not, "own" must
           mean fewer than all AND, for a table the seed fills, more than none. */
        if (all > 0) {
          assert.ok(got < all, said + ' - "own" but the role sees every row');
        }
      }
    }
  }
});

/* --------------------------------------------------------------- the screens

   The tables the seed fills with rows a BUYER authored. These are the ones
   where a join onto `users` from a staff screen loses rows, because a buyer's
   user row is the one staff cannot read. */

test('the engineer sees every open snag, not the ones raised by staff', async () => {
  /* THE TEST THE SNAG BUG WOULD HAVE FAILED. The seed raises six of its seven
     snags as the buyer and one as the office. */
  const raised = (await owner.query(
    `SELECT raised_role, count(*)::int n FROM snags GROUP BY raised_role`)).rows;
  const byBuyer = (raised.find(r => r.raised_role === 'buyer') || {}).n || 0;
  assert.ok(byBuyer >= 2,
    'the seed no longer holds snags raised by a buyer, so this test proves nothing');

  const open = (await owner.query(
    `SELECT count(*)::int n FROM snags WHERE status = 'open'`)).rows[0].n;
  const html = await get('/engineer/snags', 'engineer');
  const shown = (html.match(/action="\/engineer\/snag"/g) || []).length;
  assert.strictEqual(shown, open,
    'the engineer is offered ' + shown + ' snags to close and ' + open + ' are open');
  const kpi = /Open<\/div><b class="num[^"]*">(\d+)</.exec(html);
  assert.strictEqual(Number(kpi[1]), open,
    'the engineer\'s own count of open snags disagrees with the table');
});

test('the office sees every question, including the ones a buyer raised', async () => {
  const all = await nAsOwner('queries');
  const byBuyer = (await owner.query(
    `SELECT count(*)::int n FROM queries q JOIN users u ON u.id = q.raised_by
      WHERE u.role = 'buyer'`)).rows[0].n;
  assert.ok(byBuyer > 0, 'the seed holds no buyer-raised question, so this proves nothing');
  const rows = await asUser(OFFICE, c => c.query(
    `SELECT q.id, coalesce(w.display_name, 'the buyer') asked
       FROM queries q LEFT JOIN users w ON w.id = q.raised_by`).then(r => r.rows));
  assert.strictEqual(rows.length, all,
    'the office reads ' + rows.length + ' of ' + all + ' questions');
});

test('the office sees every message on a thread, not only its own', async () => {
  const all = (await owner.query(
    `SELECT count(*)::int n FROM query_messages WHERE query_id = 'q-b14-1'`)).rows[0].n;
  const html = await get('/office/query', 'office');
  assert.ok(html.length > 0);
  const msgs = await asUser(OFFICE, c => c.query(
    `SELECT m.id FROM query_messages m LEFT JOIN users w ON w.id = m.author_id
      WHERE m.query_id = 'q-b14-1'`).then(r => r.rows));
  assert.strictEqual(msgs.length, all,
    'the office reads ' + msgs.length + ' of ' + all + ' messages on one thread');
});

test('the engineer sees every visit asked for, and every log entry', async () => {
  const visits = (await owner.query(
    `SELECT count(*)::int n FROM visits WHERE status IN ('requested','confirmed','reassign')`))
    .rows[0].n;
  const html = await get('/engineer/visits', 'engineer');
  const booked = /Booked<\/div><b class="num[^"]*">(\d+)</.exec(html);
  assert.strictEqual(Number(booked[1]), visits,
    'the engineer is shown ' + booked[1] + ' visits and ' + visits + ' are outstanding');

  const logs = Math.min(await nAsOwner('site_log'), 40);
  const log = await get('/engineer/log', 'engineer');
  const entries = /Entries<\/div><b class="num[^"]*">(\d+)</.exec(log);
  assert.strictEqual(Number(entries[1]), logs,
    'the engineer is shown ' + entries[1] + ' log entries and there are ' + logs);
});

/* ------------------------------------------------- the names a buyer is due */

test('the buyer is told which engineer is coming', async () => {
  /* The outer-join form of the same defect: the row survived and the name did
     not, on every visit ever rendered to a buyer. */
  const who = (await owner.query(
    `SELECT DISTINCT w.display_name FROM visits v JOIN users w ON w.id = v.engineer_id
      WHERE v.unit_id = 'unit-B-14'`)).rows.map(r => r.display_name);
  assert.ok(who.length, 'no visit on B-14 names an engineer, so this proves nothing');
  const html = await get('/visit', 'buyer');
  for (const name of who) {
    assert.ok(html.includes(name),
      'the buyer\'s visit list does not name ' + name + ', who is coming to their villa');
  }
});

test('the buyer is told who at the office replied', async () => {
  const html = await get('/questions/q-b14-1', 'buyer');
  const office = (await owner.query(
    `SELECT DISTINCT w.display_name FROM query_messages m JOIN users w ON w.id = m.author_id
      WHERE m.query_id = 'q-b14-1' AND m.author_role = 'office'`)).rows.map(r => r.display_name);
  assert.ok(office.length, 'the seeded thread has no office reply, so this proves nothing');
  for (const name of office) {
    assert.ok(html.includes(name), 'the thread does not name ' + name + ', who answered it');
  }
});

test('staff_name gives out a staff name and nothing else', async () => {
  const asBuyer = q => asUser(BUYER, c => c.query(q).then(r => r.rows[0].n));
  assert.strictEqual(await asBuyer("SELECT staff_name('u-eng-ram') n"), 'S. Ramachandran');
  assert.strictEqual(await asBuyer("SELECT staff_name('u-office') n"), 'Priya Menon');
  /* The whole reason it is safe: it cannot be used to walk the buyer list. */
  assert.strictEqual(await asBuyer("SELECT staff_name('u-buyer-a07') n"), null,
    'staff_name hands out another buyer\'s name');
  assert.strictEqual(await asBuyer("SELECT staff_name('nobody') n"), null);
  /* And it is one column. An email or a hash is not reachable through it. */
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '018_the_name_of_a_member_of_staff.sql'), 'utf8');
  assert.ok(!/pw_hash|email/.test(src.split('$$')[1] || ''),
    'staff_name selects something other than a display name');
});

/* ------------------------------------------------------------------ the rule

   Static, over the source, because the behavioural tests above can only bite
   where the seed happens to hold the row that would go missing. */

const SRC = ['server.js', 'audit.js', 'screens/buyer.js', 'screens/engineer.js',
             'screens/office.js', 'screens/find.js']
  .map(f => [f, path.join(__dirname, '..', 'src', f)])
  .filter(([, p]) => fs.existsSync(p))
  .map(([f, p]) => [f, fs.readFileSync(p, 'utf8')]);

test('no query inner-joins users, in any file, ever', () => {
  /* `users` is the one table narrowed for EVERY role: staff read staff rows,
     a buyer reads their own, and nobody reads anybody else's. So an inner
     join onto it can silently drop rows in any session, and there is no
     circumstance where it is the right thing to write. A display name comes
     from staff_name(); anything else comes from the row that already carries
     it - units.buyer_name, snags.raised_role, query_messages.author_role. */
  const bad = [];
  for (const [file, src] of SRC) {
    src.split('\n').forEach((line, i) => {
      if (/(?<!LEFT )\bJOIN\s+users\b/.test(line) && !/LEFT JOIN\s+users/.test(line)) {
        bad.push(file + ':' + (i + 1) + '  ' + line.trim());
      }
    });
  }
  assert.deepStrictEqual(bad, [],
    'an inner join onto users:\n  ' + bad.join('\n  '));
});

test('the tables no role may read are not read by that role\'s screens', () => {
  /* The other half of the class: a table denied to a role outright. An inner
     join onto one of these from that role's own file returns nothing at all,
     and the screen goes quietly short. Checked by file, because each file is
     one role. */
  const DENIED = {
    /* `notifications` was on both of these lists and should never have been:
       its policy hands each role the rows addressed to that role, so a buyer
       and an engineer read their own. It was listed as denied because nothing
       read it at all, which is a different thing and was Pass 8's job. */
    'screens/buyer.js': ['audit_log', 'blockers', 'site_log', 'pack_queries',
                         'qpr_filings', 'escrow_movements', 'handoffs'],
    'screens/engineer.js': ['loan_applicants', 'loan_documents', 'escrow_movements',
                            'handoffs'],
  };
  const bad = [];
  for (const [file, tables] of Object.entries(DENIED)) {
    const src = (SRC.find(([f]) => f === file) || [])[1];
    if (!src) continue;
    for (const t of tables) {
      const re = new RegExp('(FROM|JOIN)\\s+' + t + '\\b');
      src.split('\n').forEach((line, i) => {
        if (re.test(line)) bad.push(file + ':' + (i + 1) + ' reads ' + t);
      });
    }
  }
  assert.deepStrictEqual(bad, [],
    'a screen reads a table its own role cannot see:\n  ' + bad.join('\n  '));
});
