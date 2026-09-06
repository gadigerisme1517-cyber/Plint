'use strict';
/* ============================================================================
   Database TLS.

   The claim being tested is not "the client asks for TLS" - a client can ask
   for anything. It is that the server refuses a plaintext connection, so a
   misconfigured client cannot silently fall back to sending scram and every
   row in the clear.

   pg_hba.conf carries `hostnossl ... reject` ahead of `hostssl`, which is what
   makes the refusal a fact rather than a preference.
   ========================================================================= */
const { test, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

const { pool } = require('../src/db');
const config = require('../src/config');

after(() => pool.end());

test('a plaintext connection to the database is refused by the server', async () => {
  const c = new Client({ ...config.appDb(), ssl: false });
  await assert.rejects(
    () => c.connect(),
    err => {
      // The server names the reason: no encryption. Not a timeout, not auth.
      assert.match(err.message, /no encryption|SSL (is )?required|pg_hba\.conf rejects/i,
        `refused, but for the wrong reason: ${err.message}`);
      return true;
    },
    'the server must refuse an unencrypted connection outright');
  await c.end().catch(() => {});
});

test('the connection the application actually uses is encrypted', async () => {
  const r = await pool.query(
    'SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
  assert.strictEqual(r.rows[0].ssl, true, 'the pool is on TLS, not merely willing to be');
  assert.ok(r.rows[0].version, 'and reports a TLS version: ' + r.rows[0].version);
});

test('a connection that demands a verified certificate fails against a self-signed one', async () => {
  // Proves rejectUnauthorized is doing something: the development cluster's
  // certificate is self-signed, so verification must fail rather than pass
  // quietly. If this ever succeeds, verification is not happening.
  const c = new Client({ ...config.appDb(), ssl: { rejectUnauthorized: true } });
  await assert.rejects(() => c.connect(), /self.signed|unable to verify|certificate/i);
  await c.end().catch(() => {});
});

// ------------------------------------------------------- the defaults matter

/** Reads config in a clean child process, with no .env file in the way. */
function sslModeUnder(env) {
  const code = "console.log(require('./src/config').sslMode())";
  return execFileSync(process.execPath, ['-e', code], {
    env: { ...process.env, PLINT_ENV_FILE: '/nonexistent-on-purpose',
           PGSSLMODE: '', ...env },
    cwd: require('path').join(__dirname, '..'),
    encoding: 'utf8',
  }).trim();
}

test('TLS is required by default outside development', () => {
  assert.strictEqual(sslModeUnder({ NODE_ENV: 'production' }), 'require');
  assert.strictEqual(sslModeUnder({ NODE_ENV: 'staging' }), 'require');
  assert.strictEqual(sslModeUnder({ NODE_ENV: '' }), 'require',
    'an environment that has not said what it is gets the production answer');
});

test('only an explicit development environment relaxes it', () => {
  assert.strictEqual(sslModeUnder({ NODE_ENV: 'development' }), 'disable');
  // And an explicit setting still wins over the default, in both directions.
  assert.strictEqual(sslModeUnder({ NODE_ENV: 'development', PGSSLMODE: 'require' }), 'require');
  assert.strictEqual(sslModeUnder({ NODE_ENV: 'production', PGSSLMODE: 'disable' }), 'disable');
});

test('verify-ca and verify-full refuse to start without a root certificate', () => {
  for (const mode of ['verify-ca', 'verify-full']) {
    let failed = false, output = '';
    try {
      execFileSync(process.execPath, ['-e', "require('./src/config').appDb()"], {
        env: { ...process.env, PLINT_ENV_FILE: '/nonexistent-on-purpose',
               NODE_ENV: 'production', PGSSLMODE: mode, PGSSLROOTCERT: '',
               PGHOST: '127.0.0.1', PGDATABASE: 'x', PGUSER: 'x', PGPASSWORD: 'x' },
        cwd: require('path').join(__dirname, '..'),
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      failed = true;
      output = String(e.stderr || '');
    }
    assert.ok(failed, mode + ' must not start without PGSSLROOTCERT');
    assert.match(output, /PGSSLROOTCERT/, mode + ' must name the missing variable');
  }
});

test('an unknown sslmode is refused rather than guessed at', () => {
  let failed = false, output = '';
  try {
    execFileSync(process.execPath, ['-e', "require('./src/config').appDb()"], {
      env: { ...process.env, PLINT_ENV_FILE: '/nonexistent-on-purpose',
             PGSSLMODE: 'sort-of', PGHOST: '127.0.0.1', PGDATABASE: 'x',
             PGUSER: 'x', PGPASSWORD: 'x' },
      cwd: require('path').join(__dirname, '..'),
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) { failed = true; output = String(e.stderr || ''); }
  assert.ok(failed);
  assert.match(output, /not one of disable, require/);
});
