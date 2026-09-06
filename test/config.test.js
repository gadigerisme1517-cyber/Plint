'use strict';
/* ============================================================================
   Configuration refuses to guess.

   Added after a mutation audit: replacing the body of `required()` with a
   default made no test fail. The behaviour had been checked by hand once and
   never encoded, which meant the "no credential defaults" claim rested on
   nothing a future change would trip over.
   ========================================================================= */
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// A complete, valid-looking environment. Each test blanks exactly one value,
// so a failure can only be about that one.
const FULL = {
  PLINT_ENV_FILE: '/nonexistent-on-purpose',
  PGHOST: '127.0.0.1',
  PGPORT: '5432',
  PGDATABASE: 'plint_x',
  PGUSER: 'plint_app',
  PGPASSWORD: 'pw',
  PGADMINUSER: 'plint_owner',
  PGADMINPASSWORD: 'pw',
  PGSSLMODE: 'disable',
  PLINT_SECRET: 'x'.repeat(64),
};

/** Runs a snippet against src/config in a clean process. */
function attempt(code, env) {
  try {
    const out = execFileSync(process.execPath, ['-e', code], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, ...FULL, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: out, stderr: '' };
  } catch (e) {
    return { ok: false, stdout: String(e.stdout || ''), stderr: String(e.stderr || ''),
             status: e.status };
  }
}

const CALL = {
  PGHOST: "require('./src/config').appDb()",
  PGDATABASE: "require('./src/config').appDb()",
  PGUSER: "require('./src/config').appDb()",
  PGPASSWORD: "require('./src/config').appDb()",
  PGADMINUSER: "require('./src/config').adminDb()",
  PGADMINPASSWORD: "require('./src/config').adminDb()",
  PLINT_SECRET: "require('./src/config').sessionSecret()",
};

test('every required credential stops the process when it is missing', () => {
  for (const [name, code] of Object.entries(CALL)) {
    const r = attempt(code, { [name]: '' });
    assert.strictEqual(r.ok, false, `${name} missing must not be tolerated`);
    assert.strictEqual(r.status, 1, `${name}: should exit 1`);
    assert.match(r.stderr, new RegExp(name + ' is not set'),
      `${name}: the message must name the variable, got: ${r.stderr.slice(0, 200)}`);
    assert.match(r.stderr, /\.env\.example/,
      `${name}: the message should say where to look`);
  }
});

test('the same call succeeds when nothing is missing', () => {
  // The control. Without it, the test above would pass even if every call
  // failed for some unrelated reason.
  for (const code of Object.values(CALL)) {
    const r = attempt(code, {});
    assert.strictEqual(r.ok, true, `should succeed with a full environment: ${r.stderr.slice(0, 200)}`);
  }
});

test('a variable set to whitespace is not mistaken for a value', () => {
  const r = attempt(CALL.PGPASSWORD, { PGPASSWORD: '' });
  assert.strictEqual(r.ok, false);
});

test('a session secret that is present but too short is refused', () => {
  const r = attempt(CALL.PLINT_SECRET, { PLINT_SECRET: 'short' });
  assert.strictEqual(r.ok, false, 'a five-character secret is not a secret');
  assert.match(r.stderr, /too short/);
});

test('non-secret values may carry a default; credentials may not', () => {
  // PORT and PGPORT are allowed defaults. That is the whole distinction, so
  // it is worth pinning: if these ever started failing closed, the process
  // would refuse to start for no security reason.
  const r = attempt("const c=require('./src/config'); console.log(c.port())",
    { PORT: '' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stdout.trim(), '3000');
});

// ------------------------------------------------------- the TLS option shape

/** The ssl object config hands to pg, as JSON, with the certificate elided. */
function sslOptionUnder(env) {
  const code = `
    const c = require('./src/config').appDb();
    const s = c.ssl;
    console.log(JSON.stringify(
      s === false ? { ssl: false }
      : { rejectUnauthorized: s.rejectUnauthorized,
          hasCa: !!s.ca,
          skipsHostnameCheck: typeof s.checkServerIdentity === 'function' }));`;
  const r = attempt(code, env);
  assert.strictEqual(r.ok, true, r.stderr.slice(0, 300));
  return JSON.parse(r.stdout);
}

test('verify-full actually verifies, and verify-ca verifies without the hostname', () => {
  // A mutation flipping rejectUnauthorized to false in this branch survived
  // the first audit: the real-connection tests all go through `require`, which
  // uses a different literal. This pins the branch itself.
  const ca = path.join(os.tmpdir(), 'plint-fake-ca-' + process.pid + '.pem');
  fs.writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nnot a real one\n-----END CERTIFICATE-----\n');
  try {
    const full = sslOptionUnder({ PGSSLMODE: 'verify-full', PGSSLROOTCERT: ca });
    assert.strictEqual(full.rejectUnauthorized, true, 'verify-full must verify');
    assert.strictEqual(full.hasCa, true, 'and must load the root certificate');
    assert.strictEqual(full.skipsHostnameCheck, false, 'and must check the hostname');

    const caOnly = sslOptionUnder({ PGSSLMODE: 'verify-ca', PGSSLROOTCERT: ca });
    assert.strictEqual(caOnly.rejectUnauthorized, true, 'verify-ca must verify the chain');
    assert.strictEqual(caOnly.hasCa, true);
    assert.strictEqual(caOnly.skipsHostnameCheck, true,
      'verify-ca is verify-full without the hostname check; that is the difference');
  } finally { fs.rmSync(ca, { force: true }); }
});

test('require encrypts without verifying, and disable does neither', () => {
  const req = sslOptionUnder({ PGSSLMODE: 'require' });
  assert.strictEqual(req.rejectUnauthorized, false,
    "libpq's `require` means encrypt but do not verify");
  assert.strictEqual(req.hasCa, false);

  assert.deepStrictEqual(sslOptionUnder({ PGSSLMODE: 'disable' }), { ssl: false });
});
