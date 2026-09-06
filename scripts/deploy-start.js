'use strict';
/* ============================================================================
   The container entrypoint.

   Brings the database up to date and then starts the server, in one process,
   in order. The service is single-instance because it has a disk attached, so
   there is no second copy to race with.

     1. bootstrap   the runtime role, idempotent
     2. migrate     forward-only, a no-op when already applied
     3. seed        ONLY when PLINT_SEED_DEMO=1 and the database is empty
     4. assert      the connection is actually encrypted
     5. serve

   Step 4 is not decoration. "Managed Postgres with TLS" is a claim about the
   running system, and a client asking for TLS is not the same as getting it.
   If the connection is in the clear this refuses to serve rather than carry
   buyers' financial positions over an unencrypted link.
   ========================================================================= */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const run = (label, args) => {
  process.stdout.write('\n── ' + label + '\n');
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (r.status !== 0) {
    process.stderr.write('\ndeploy: ' + label + ' failed. Not starting the server.\n');
    process.exit(1);
  }
};

(async () => {
  run('bootstrap', ['db/bootstrap.js']);
  run('migrate', ['db/migrate.js']);

  /* Again, now that the tables exist. In bootstrap this passes trivially on a
     fresh database because there is nothing yet to own; here it is checking
     the real schema. Since migration 010 dropped FORCE, this is the whole
     isolation boundary and it is worth two seconds at every boot. */
  await require('../db/bootstrap.js').assertIsolationHolds();

  const { Client } = require('pg');
  const config = require('./../src/config');

  // ---------------------------------------------------------------- seed
  if (process.env.PLINT_SEED_DEMO === '1') {
    const c = new Client(config.adminDb());
    await c.connect();
    let already = 0;
    try {
      already = (await c.query('SELECT count(*)::int n FROM plint.units')).rows[0].n;
    } catch { already = 0; }
    await c.end();

    if (already > 0) {
      console.log('\n── seed\n  skipped: ' + already + ' villas already present');
    } else {
      run('seed (demo data)', ['db/seed.js']);
    }
  }

  // ------------------------------------------------------- TLS, verified
  {
    const c = new Client(config.appDb());
    await c.connect();
    const r = await c.query(
      'SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
    await c.end();

    const on = r.rows[0] && r.rows[0].ssl;
    console.log('\n── database TLS\n  ' +
      (on ? 'encrypted, ' + r.rows[0].version : 'NOT ENCRYPTED'));

    if (!on && process.env.PLINT_ALLOW_PLAINTEXT_DB !== '1') {
      process.stderr.write(
        '\ndeploy: the database connection is not encrypted.\n' +
        '  PGSSLMODE is "' + config.sslMode() + '".\n' +
        '  Point PGHOST at an endpoint that speaks TLS, or set\n' +
        '  PLINT_ALLOW_PLAINTEXT_DB=1 if the link is genuinely private\n' +
        '  and you have decided that is acceptable.\n\n');
      process.exit(1);
    }
  }

  console.log('\n── serving\n');
  require('../src/server.js').start();
})().catch(e => {
  process.stderr.write('\ndeploy failed: ' + e.message + '\n');
  process.exit(1);
});
