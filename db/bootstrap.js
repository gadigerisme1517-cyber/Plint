'use strict';
/* ============================================================================
   Bootstrap. Cluster-level objects that are not schema and therefore are not
   migrations: the database itself, and the runtime role with its password.

   Idempotent. Safe to run against a populated cluster: it creates what is
   missing and, if the role already exists, re-applies the password from the
   environment so a rotated secret takes effect. It never drops anything.
   ========================================================================= */
const { Client } = require('pg');
const config = require('../src/config');

const APP_ROLE = process.env.PGUSER;

async function ensureDatabase() {
  // Connect to the maintenance database: the target may not exist yet.
  const c = new Client(config.adminDb({ database: 'postgres' }));
  await c.connect();
  try {
    const name = process.env.PGDATABASE;
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!r.rows.length) {
      // Identifiers cannot be parameterised. The name comes from the operator's
      // own environment, not from a request, but quote it properly regardless.
      await c.query(`CREATE DATABASE ${quoteIdent(name)} OWNER ${quoteIdent(process.env.PGADMINUSER)}`);
      console.log('bootstrap: created database ' + name);
    } else {
      console.log('bootstrap: database ' + name + ' already present');
    }
  } finally { await c.end(); }
}

async function ensureAppRole() {
  const c = new Client(config.adminDb());
  await c.connect();
  try {
    const pw = config.required('PGPASSWORD', 'The runtime role password.');
    const r = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    if (!r.rows.length) {
      await c.query(`CREATE ROLE ${quoteIdent(APP_ROLE)} LOGIN PASSWORD ${quoteLiteral(pw)}`);
      console.log('bootstrap: created role ' + APP_ROLE);
    } else {
      await c.query(`ALTER ROLE ${quoteIdent(APP_ROLE)} LOGIN PASSWORD ${quoteLiteral(pw)}`);
      console.log('bootstrap: role ' + APP_ROLE + ' already present, password re-applied');
    }
    // The runtime role must never be able to step around row-level security.
    // Assert it rather than trust it: this is the whole isolation boundary.
    await c.query(`ALTER ROLE ${quoteIdent(APP_ROLE)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await c.query(`GRANT CONNECT ON DATABASE ${quoteIdent(process.env.PGDATABASE)} TO ${quoteIdent(APP_ROLE)}`);
  } finally { await c.end(); }
}

const quoteIdent = s => '"' + String(s).replace(/"/g, '""') + '"';
const quoteLiteral = s => "'" + String(s).replace(/'/g, "''") + "'";

/* The migrations grant to the literal name `plint_app` - twenty references
   across nine files, and migrations are forward-only history that cannot be
   retroactively parameterised. So the runtime role has to carry that name.

   Getting this wrong is quiet and nasty: the role is created, the server
   connects, and then every query returns nothing because the grants and
   policies were written for a role that is not this one. Fail at boot instead. */
function assertRoleName(name) {
  if (name !== 'plint_app') {
    process.stderr.write(
      `\nplint: PGUSER is "${name}", but the migrations grant to "plint_app".\n` +
      '  The runtime role must be named plint_app, or it will connect\n' +
      '  successfully and then see nothing at all.\n\n');
    process.exit(1);
  }
}

async function bootstrap() {
  config.adminDb();                                   // fails loudly if unset
  config.required('PGUSER', 'The runtime role name.');
  assertRoleName(APP_ROLE);
  await ensureDatabase();
  await ensureAppRole();
}

if (require.main === module) {
  bootstrap().then(() => console.log('bootstrap: done'))
    .catch(e => { console.error('bootstrap failed:', e.message); process.exit(1); });
}

module.exports = { bootstrap, ensureDatabase, ensureAppRole, quoteIdent };
