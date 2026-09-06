'use strict';
/* ============================================================================
   Mutation audit. A development tool, not part of npm test.

   Asks one question of every claim the suite makes: if the behaviour were
   wrong, would a test notice?

   Each mutation below breaks one specific thing, then runs the suites that
   claim to cover it. A mutation that makes a suite fail is KILLED - the test
   was doing work. A mutation that leaves every suite green SURVIVED, and means
   the test passes whether the code is right or not.

     node scripts/mutation-audit.js            all of them
     node scripts/mutation-audit.js money      only ones tagged money

   It edits source files in place and puts them back. It leaves the development
   database reseeded. Do not run it against anything you care about.

   IT MUST NOT RUN ALONGSIDE `npm test`. While a mutation is applied the source
   on disk is deliberately wrong, so a concurrent test run reads broken code and
   reports a failure that has nothing to do with the change under test. It takes
   a lock, and test/run.js refuses to start while that lock is held.
   ========================================================================= */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const R = f => path.join(ROOT, f);

/* The lock. While it exists, source files on disk may be deliberately broken.
   test/run.js checks for it and refuses to start. */
const LOCK = path.join(ROOT, 'var', '.mutation-audit.lock');
function takeLock() {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  } catch {
    console.error('\nA mutation audit is already running (' + LOCK + ').');
    console.error('If that is stale, delete it.\n');
    process.exit(1);
  }
  const drop = () => { try { fs.rmSync(LOCK, { force: true }); } catch {} };
  process.on('exit', drop);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { drop(); process.exit(130); });
  }
}

/* find/replace must match exactly once. `rebuild` means the mutation is in SQL
   that has already been applied, so the database has to be torn down and
   rebuilt for it to take effect. */
const MUTATIONS = [
  // ------------------------------------------------------------- money layer
  { tag: 'money', what: 'rounding becomes truncation instead of half-up',
    file: 'src/money.js',
    find: 'return Number(r * 2n >= den ? q + 1n : q);',
    to:   'return Number(q);',
    suites: ['money.test.js'] },

  { tag: 'money', what: 'the last stage is priced alone, not as the residual',
    file: 'src/money.js',
    find: '      out.push(agv - allocated);',
    to:   '      out.push(stageBase(agv, orderedPctBps[i]));',
    suites: ['money.test.js', 'reconcile.test.js'] },

  { tag: 'money', what: 'GST drops from 5 per cent to 4',
    file: 'src/money.js', find: 'const GST_BP = 500;', to: 'const GST_BP = 400;',
    suites: ['money.test.js', 'smoke.test.js'] },

  { tag: 'money', what: 'interest halves',
    file: 'src/money.js',
    find: 'const INTEREST_BP_PER_YEAR = 1200;', to: 'const INTEREST_BP_PER_YEAR = 600;',
    suites: ['money.test.js'] },

  /* `overdueDays <= 0` -> `< 0` is an EQUIVALENT mutation: zero overdue days
     yields zero interest either way, so no input distinguishes them and no
     test could. Replaced with the two boundaries that are observable. */
  { tag: 'money', what: 'a part day past due is rounded up to a whole day of interest',
    file: 'src/money.js',
    find: 'const overdueDays = Math.floor((asOf - new Date(demand.due_at)) / 86400000);',
    to:   'const overdueDays = Math.ceil((asOf - new Date(demand.due_at)) / 86400000);',
    suites: ['money.test.js'] },

  { tag: 'money', what: 'interest is allowed to go negative before the due date',
    file: 'src/money.js',
    find: 'if (overdueDays <= 0) return 0;', to: 'if (overdueDays === 0) return 0;',
    suites: ['money.test.js'] },

  { tag: 'money', what: 'demands fall due in 30 days, not 14',
    file: 'src/money.js', find: 'const DUE_DAYS = 14;', to: 'const DUE_DAYS = 30;',
    suites: ['money.test.js'] },

  { tag: 'money', what: 'a malformed schedule is priced instead of refused',
    file: 'src/money.js',
    find: "      throw new TypeError(`stage ${i} of the schedule is not a positive basis point: ${bp}`);",
    to:   '      continue;',
    suites: ['reconcile.test.js'] },

  // -------------------------------------------------------------- isolation
  { tag: 'rls', what: 'a buyer may read every villa',
    file: 'db/migrations/001_initial_schema.sql', rebuild: true,
    find: "    WHEN 'buyer' THEN buyer_user_id = current_user_id()\n    WHEN 'engineer' THEN true\n    WHEN 'office' THEN true\n    ELSE false\n  END);\n\nCREATE POLICY us_read",
    to:   "    WHEN 'buyer' THEN true\n    WHEN 'engineer' THEN true\n    WHEN 'office' THEN true\n    ELSE false\n  END);\n\nCREATE POLICY us_read",
    suites: ['isolation.test.js', 'smoke.test.js'] },

  /* The first attempt here set the GUC a second time at session scope, which
     the next transaction overwrote anyway. Nothing leaked, so it survived for
     want of being a real fault rather than for want of a test. These two are
     genuine: the first leaves an unidentified request holding whatever the
     pooled connection last had, the second makes identity outlive its
     transaction. */
  { tag: 'rls', what: 'an unidentified request inherits the pooled connection identity',
    file: 'src/db.js',
    find: "    await c.query('SELECT set_config($1,$2,true), set_config($3,$4,true)', [",
    to:   "    if (session) await c.query('SELECT set_config($1,$2,true), set_config($3,$4,true)', [",
    suites: ['isolation.test.js'], poolMax: '1' },

  { tag: 'rls', what: 'identity is set for the session rather than the transaction',
    file: 'src/db.js',
    find: "await c.query('SELECT set_config($1,$2,true), set_config($3,$4,true)', [",
    to:   "await c.query('SELECT set_config($1,$2,false), set_config($3,$4,false)', [",
    suites: ['isolation.test.js'], poolMax: '1' },

  /* Each half of the identity handling above is individually harmless: a
     transaction-local setting reverts on COMMIT whether or not the next
     request overwrites it, and overwriting it every request makes the scope
     moot. Only both faults together leak, so only both together are a real
     mutation. This is the one that must be caught. */
  { tag: 'rls', what: 'identity is session-scoped AND skipped for unidentified requests',
    file: 'src/db.js',
    find: "    await c.query('SELECT set_config($1,$2,true), set_config($3,$4,true)', [",
    to:   "    if (session) await c.query('SELECT set_config($1,$2,false), set_config($3,$4,false)', [",
    suites: ['isolation.test.js'], poolMax: '1' },

  { tag: 'rls', what: 'a buyer may read another villa evidence row',
    file: 'db/migrations/001_initial_schema.sql', rebuild: true,
    find: "CREATE POLICY ev_read ON evidence FOR SELECT USING (\n  CASE current_role_name()\n    WHEN 'buyer' THEN owns_unit((SELECT unit_id FROM unit_stages s WHERE s.id = unit_stage_id))",
    to:   "CREATE POLICY ev_read ON evidence FOR SELECT USING (\n  CASE current_role_name()\n    WHEN 'buyer' THEN true",
    suites: ['evidence.test.js', 'isolation.test.js'] },

  // --------------------------------------------------------------- sessions
  { tag: 'session', what: 'the cookie token is stored verbatim instead of its HMAC',
    file: 'src/session.js',
    find: "  crypto.createHmac('sha256', config.sessionSecret()).update(token).digest('hex');",
    to:   '  token;',
    suites: ['session.test.js'] },

  { tag: 'session', what: 'the session cookie loses HttpOnly',
    file: 'src/session.js',
    find: "  const bits = [`${NAME}=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax',",
    to:   "  const bits = [`${NAME}=${token}`, 'Path=/', 'SameSite=Lax',",
    suites: ['session.test.js'] },

  { tag: 'session', what: 'signing out stops revoking the session',
    file: 'src/session.js',
    find: "const revoke = token => token\n  ? pool.query('SELECT plint.session_revoke($1)', [keyOf(token)])\n  : Promise.resolve();",
    to:   'const revoke = () => Promise.resolve();',
    suites: ['session.test.js'] },

  // ------------------------------------------------------ demands and audit
  /* The audit row is written by a trigger, not by the route handler, so the
     mutations that matter are on the trigger. The first is the fault that
     actually shipped: a writer that certifies without leaving a record. It
     used to be possible because the route handler was the only writer and the
     seed was not it. */
  { tag: 'audit', what: 'certification stops writing its audit row at all',
    file: 'db/migrations/008_certification_writes_its_own_audit_row.sql', rebuild: true,
    find: '    IF NEW.certified_at IS NULL THEN RETURN NULL; END IF;',
    to:   '    IF true THEN RETURN NULL; END IF;',
    suites: ['ledger.test.js', 'restore.test.js'] },

  { tag: 'audit', what: 'the trigger fires only for the route handler ordering, not on INSERT',
    file: 'db/migrations/008_certification_writes_its_own_audit_row.sql', rebuild: true,
    find: '  AFTER INSERT OR UPDATE ON unit_stages\n  DEFERRABLE INITIALLY DEFERRED',
    to:   '  AFTER UPDATE ON unit_stages\n  DEFERRABLE INITIALLY DEFERRED',
    suites: ['restore.test.js'] },

  { tag: 'audit', what: 'the audit row is attributed to whoever is connected, not to the signer',
    file: 'db/migrations/008_certification_writes_its_own_audit_row.sql', rebuild: true,
    find: '      NEW.certified_by,\n      coalesce(v_role, \'engineer\'),',
    to:   "      coalesce(nullif(plint.current_user_id(), ''), NEW.certified_by),\n      coalesce(v_role, 'engineer'),",
    suites: ['ledger.test.js'] },

  { tag: 'audit', what: 'a certification can be altered after it is signed',
    file: 'db/migrations/008_certification_writes_its_own_audit_row.sql', rebuild: true,
    find: "      RAISE EXCEPTION\n        'a certification cannot be altered or withdrawn once signed (stage %)', OLD.id;",
    to:   '      NULL;',
    suites: ['ledger.test.js'] },

  { tag: 'audit', what: 'a settlement may be made by nobody in particular',
    file: 'db/migrations/008_certification_writes_its_own_audit_row.sql', rebuild: true,
    find: "      RAISE EXCEPTION\n        'a demand cannot be settled without an identified actor (demand %)', NEW.id;",
    to:   "      v_actor := 'u-office';",
    suites: ['ledger.test.js'] },

  { tag: 'audit', what: 'half a certification is allowed',
    file: 'db/migrations/008_certification_writes_its_own_audit_row.sql', rebuild: true,
    find: 'ALTER TABLE unit_stages ADD CONSTRAINT unit_stages_certification_complete CHECK (',
    to:   'ALTER TABLE unit_stages ADD CONSTRAINT unit_stages_certification_complete CHECK (true OR',
    suites: ['ledger.test.js'] },

  { tag: 'audit', what: 'the audit log becomes editable',
    file: 'db/migrations/003_audit_log.sql', rebuild: true,
    find: 'CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log\n  FOR EACH ROW EXECUTE FUNCTION audit_append_only();',
    to:   '',
    suites: ['ledger.test.js'] },

  { tag: 'audit', what: 'an issued demand becomes editable',
    file: 'db/migrations/004_demand_immutability.sql', rebuild: true,
    find: 'CREATE TRIGGER demands_immutable BEFORE UPDATE ON demands\n  FOR EACH ROW EXECUTE FUNCTION demands_immutable();',
    to:   '',
    suites: ['ledger.test.js'] },

  // --------------------------------------------------------------- evidence
  { tag: 'evidence', what: 'anything is accepted as an image',
    file: 'src/evidence.js',
    find: "  if (buf.length >= 3 && buf.subarray(0, 3).equals(JPEG)) return 'image/jpeg';",
    to:   "  if (buf.length >= 0) return 'image/jpeg';",
    suites: ['evidence.test.js'] },

  { tag: 'evidence', what: 'thumbnails go back to embedding the original whole',
    file: 'src/evidence.js',
    find: '  const src = await read(hash);\n  const out = await sharp(src)',
    to:   '  const src = await read(hash);\n  if (src) return src;\n  const out = await sharp(src)',
    suites: ['evidence.test.js'] },

  { tag: 'evidence', what: 'the stored file is never verified after writing',
    file: 'src/evidence.js',
    find: '  const back = await fsp.readFile(file);\n  if (sha256(back) !== hash) {',
    to:   '  const back = buf;\n  if (sha256(back) !== hash) {',
    suites: ['evidence.test.js', 'restore.test.js'] },

  // ------------------------------------------------------------------- pack
  { tag: 'pack', what: 'certification stops recording a pack delivery',
    file: 'src/server.js',
    find: "      `INSERT INTO pack_deliveries (id, unit_stage_id, lender, state)\n       VALUES ($1,$2,$3,$4) ON CONFLICT (unit_stage_id) DO NOTHING`,",
    to:   "      `SELECT $1,$2,$3,$4`,",
    suites: ['pack.test.js'] },

  { tag: 'pack', what: 'the copy claims the pack was sent',
    file: 'src/server.js',
    find: "          + (r.bank ? `The evidence pack is queued for ${r.bank}.`",
    to:   "          + (r.bank ? `The evidence pack has gone to ${r.bank}.`",
    suites: ['pack.test.js'] },

  // -------------------------------------------------------------- throttling
  { tag: 'throttle', what: 'the login limiter never blocks',
    file: 'src/throttle.js',
    find: '  if (!blocks.length) return null;',
    to:   '  if (true) return null;',
    suites: ['ratelimit.test.js'] },

  { tag: 'throttle', what: 'a successful sign-in no longer clears the counter',
    file: 'src/throttle.js',
    find: "  for (const key of keysFor(req, email)) {\n    await pool.query('SELECT plint.login_cleared($1)', [key]);\n  }",
    to:   '  return;',
    suites: ['ratelimit.test.js'] },

  // --------------------------------------------------------------------- TLS
  { tag: 'tls', what: 'TLS stops being the default outside development',
    file: 'src/config.js',
    find: "const sslMode = () => optional('PGSSLMODE', isDevelopment() ? 'disable' : 'require');",
    to:   "const sslMode = () => optional('PGSSLMODE', 'disable');",
    suites: ['tls.test.js'] },

  { tag: 'tls', what: 'verify-full silently stops verifying',
    file: 'src/config.js',
    find: '      return {\n        rejectUnauthorized: true,',
    to:   '      return {\n        rejectUnauthorized: false,',
    suites: ['tls.test.js', 'config.test.js'] },

  { tag: 'tls', what: 'verify-ca stops skipping the hostname check',
    file: 'src/config.js',
    find: "        ...(mode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}),",
    to:   '',
    suites: ['config.test.js'] },

  // ------------------------------------------------------------------ config
  { tag: 'config', what: 'a missing credential gets a default instead of stopping',
    file: 'src/config.js',
    find: '  if (v === undefined || v === \'\') die(name, why);\n  return v;',
    to:   "  if (v === undefined || v === '') return 'x';\n  return v;",
    suites: ['config.test.js'] },

  { tag: 'config', what: 'a too-short session secret is accepted',
    file: 'src/config.js',
    find: "  if (s.length < 16) die('PLINT_SECRET', 'It is set but too short to be a secret. Use 32+ random bytes.');",
    to:   '',
    suites: ['config.test.js'] },
];

// ----------------------------------------------------------------- harness
const only = process.argv[2];
const chosen = MUTATIONS.filter(m => !only || m.tag === only);

const run = (cmd, args, extra = {}) =>
  spawnSync(cmd, args,
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PLINT_LOG: 'silent', ...extra } });

function rebuildDb() {
  for (const s of [['db/reset.js'], ['db/migrate.js'], ['db/seed.js']]) {
    const r = run(process.execPath, s);
    if (r.status !== 0) throw new Error('rebuild failed at ' + s + ': ' + (r.stderr || '').slice(0, 400));
  }
}

function suiteFails(suite, extra) {
  const r = run(process.execPath, [path.join('test', suite)], extra);
  return r.status !== 0;
}

(async () => {
  console.log(`mutation audit: ${chosen.length} mutations\n`);
  rebuildDb();

  const survived = [], killed = [], broken = [];

  for (const m of chosen) {
    const file = R(m.file);
    const original = fs.readFileSync(file, 'utf8');
    const hits = original.split(m.find).length - 1;

    if (hits !== 1) {
      broken.push({ ...m, why: `find matched ${hits} times, expected 1` });
      console.log(`  SKIP   [${m.tag}] ${m.what}  (pattern matched ${hits}x)`);
      continue;
    }

    fs.writeFileSync(file, original.replace(m.find, m.to));
    let caughtBy = null;
    try {
      if (m.rebuild) rebuildDb();
      const extra = m.poolMax ? { PLINT_POOL_MAX: m.poolMax } : {};
      for (const s of m.suites) {
        if (suiteFails(s, extra)) { caughtBy = s; break; }
      }
    } catch (e) {
      // A mutation that stops the database rebuilding is also caught: the
      // suite could not have passed.
      caughtBy = 'rebuild';
    } finally {
      fs.writeFileSync(file, original);
      if (m.rebuild) rebuildDb();
    }

    if (caughtBy) {
      killed.push(m);
      console.log(`  killed [${m.tag}] ${m.what}\n           caught by ${caughtBy}`);
    } else {
      survived.push(m);
      console.log(`  SURVIVED [${m.tag}] ${m.what}\n           ran ${m.suites.join(', ')} and all passed`);
    }
  }

  rebuildDb();

  console.log('\n' + '─'.repeat(70));
  console.log(`killed   ${killed.length}`);
  console.log(`SURVIVED ${survived.length}`);
  console.log(`skipped  ${broken.length}`);
  if (survived.length) {
    console.log('\nmutations no test noticed:');
    for (const m of survived) console.log(`  [${m.tag}] ${m.what}`);
  }
  if (broken.length) {
    console.log('\nmutations that could not be applied:');
    for (const m of broken) console.log(`  [${m.tag}] ${m.what} - ${m.why}`);
  }
  process.exit(survived.length ? 1 : 0);
})();
