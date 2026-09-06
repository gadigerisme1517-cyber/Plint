'use strict';
/* ============================================================================
   Will this database run Plint?

     DATABASE_URL="postgres://..." node scripts/preflight.js

   Answers the questions that decide it, in ten seconds, before you wire up a
   deploy and find out the hard way. Creates nothing permanent: a probe role
   and a probe table, both dropped before it exits.

   The one that matters is CREATE ROLE. Plint needs two roles - one that owns
   the schema and runs migrations, and one the server connects as, which does
   NOT own the tables and so is bound by row-level security. On a database
   where only one role is possible, the server would have to connect as the
   owner, an owner bypasses RLS, and every buyer would see every villa.
   ========================================================================= */
const { Client } = require('pg');

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  process.stderr.write('\nusage: DATABASE_URL="postgres://..." node scripts/preflight.js\n\n');
  process.exit(2);
}

const ok = s => '  ✓ ' + s;
const no = s => '  ✗ ' + s;
const probe = 'plint_preflight_' + Math.random().toString(36).slice(2, 8);

(async () => {
  const c = new Client({ connectionString: URL_, ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
  } catch (e) {
    console.log(no('cannot connect: ' + e.message));
    console.log('\nVERDICT: unusable.\n');
    process.exit(1);
  }

  let fatal = 0, warn = 0;

  const me = (await c.query(
    `SELECT current_user, current_database(),
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) super,
            (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) bypass,
            (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) createrole,
            version() v`)).rows[0];

  console.log('\nconnected as ' + me.current_user + ' to ' + me.current_database);
  console.log('  ' + me.v.split(',')[0]);
  console.log('  superuser: ' + me.super + '   bypassrls: ' + me.bypass +
              '   createrole: ' + me.createrole);

  // ---- TLS
  const ssl = (await c.query(
    'SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0];
  console.log('\nTLS');
  if (ssl && ssl.ssl) console.log(ok('encrypted, ' + ssl.version));
  else { console.log(no('NOT encrypted on this endpoint')); warn++; }

  // ---- the deciding capability
  console.log('\nTwo roles (the isolation boundary)');
  let madeRole = false;
  try {
    await c.query(`CREATE ROLE ${probe} LOGIN PASSWORD 'probe_pw'`);
    madeRole = true;
    console.log(ok('CREATE ROLE works, so the server can have its own non-owner role'));
  } catch (e) {
    console.log(no('CREATE ROLE refused: ' + e.message.trim()));
    console.log('      Without a second role the server must connect as the owner,');
    console.log('      an owner bypasses row-level security, and buyer isolation is gone.');
    fatal++;
  }

  // ---- does RLS actually bind a non-owner role here?
  if (madeRole) {
    console.log('\nRow-level security binds a non-owner');
    try {
      await c.query(`CREATE TABLE ${probe}_t (id int, owner_tag text)`);
      await c.query(`INSERT INTO ${probe}_t VALUES (1,'mine'),(2,'theirs')`);
      await c.query(`ALTER TABLE ${probe}_t ENABLE ROW LEVEL SECURITY`);
      await c.query(`CREATE POLICY p ON ${probe}_t FOR SELECT
                     USING (owner_tag = current_setting('probe.tag', true))`);
      await c.query(`GRANT SELECT ON ${probe}_t TO ${probe}`);

      /* Build the URL with the probe's credentials substituted in. Passing
         `user` alongside `connectionString` does NOT override it - the string
         wins - which silently reconnects as the owner and makes this check
         report the opposite of the truth. */
      const u = new URL(URL_);
      u.username = probe;
      u.password = 'probe_pw';

      const other = new Client({ connectionString: u.toString(),
                                 ssl: { rejectUnauthorized: false } });
      await other.connect();
      const who = (await other.query('SELECT current_user')).rows[0].current_user;
      const seen = (await other.query(`SELECT count(*)::int n FROM ${probe}_t`)).rows[0].n;
      await other.end();

      if (who !== probe) {
        console.log(no('could not connect as the probe role (got ' + who + ')'));
        warn++;
      } else if (seen === 0) {
        console.log(ok('a non-owner role with no identity sees 0 of 2 rows'));
      } else {
        console.log(no('a non-owner role saw ' + seen + ' of 2 rows with no identity'));
        fatal++;
      }
    } catch (e) {
      console.log(no('could not test: ' + e.message.trim()));
      warn++;
    }
  }

  // ---- schema creation
  console.log('\nSchema');
  try {
    await c.query(`CREATE SCHEMA ${probe}_s`);
    await c.query(`DROP SCHEMA ${probe}_s`);
    console.log(ok('CREATE SCHEMA works, so migrations can run'));
  } catch (e) {
    console.log(no('CREATE SCHEMA refused: ' + e.message.trim())); fatal++;
  }

  // ---- clean up
  try { await c.query(`DROP TABLE IF EXISTS ${probe}_t`); } catch {}
  try { if (madeRole) await c.query(`DROP ROLE IF EXISTS ${probe}`); } catch {}
  await c.end();

  console.log('\n' + '-'.repeat(62));
  if (fatal) {
    console.log('VERDICT: this database CANNOT run Plint safely (' + fatal + ' blocker(s)).\n');
    process.exit(1);
  }
  console.log('VERDICT: usable' + (warn ? ', with ' + warn + ' warning(s) above' : '') + '.\n');
})().catch(e => {
  console.error('\npreflight failed: ' + e.message + '\n');
  process.exit(1);
});
