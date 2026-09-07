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

/* The connection username and the database role are not always the same
   string. Supabase's pooler identifies the project from the username, so the
   server connects as `plint_app.<projectref>` while the role inside Postgres
   is plain `plint_app` - which is what every grant and policy names.

   Everything here that speaks SQL uses the role; the connection keeps PGUSER
   whole. */
const APP_ROLE = String(process.env.PGUSER || '').split('.')[0];

async function ensureDatabase() {
  const name = process.env.PGDATABASE;

  /* On a managed platform the database already exists - the platform made it -
     and we may have no rights on the `postgres` maintenance database at all.
     So ask the target directly first. If it answers, there is nothing to do
     and no reason to go looking for privileges we do not need. */
  try {
    const direct = new Client(config.adminDb());
    await direct.connect();
    await direct.end();
    console.log('bootstrap: database ' + name + ' already present');
    return;
  } catch { /* not there, or not reachable: fall through and try to create it */ }

  const c = new Client(config.adminDb({ database: 'postgres' }));
  await c.connect();
  try {
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
    /* Clearing SUPERUSER requires being one, which a managed database will not
       give us. So try to set the attributes, and if the platform refuses, fall
       through to verifying them instead. Either way the process does not
       continue with a runtime role that can step around RLS - see
       assertIsolationHolds below, which is the check that actually decides. */
    try {
      await c.query(`ALTER ROLE ${quoteIdent(APP_ROLE)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    } catch (e) {
      console.log('bootstrap: cannot set role attributes here (' + e.message.trim() +
                  '); they will be verified instead');
    }
    try {
      await c.query(`GRANT CONNECT ON DATABASE ${quoteIdent(process.env.PGDATABASE)} TO ${quoteIdent(APP_ROLE)}`);
    } catch (e) {
      console.log('bootstrap: could not grant CONNECT (' + e.message.trim() + ')');
    }
  } finally { await c.end(); }
}

/**
 * The isolation boundary, checked rather than assumed.
 *
 * Migration 010 dropped FORCE ROW LEVEL SECURITY so that this schema can run
 * on a database whose owner is not a superuser. FORCE was what stopped the
 * OWNER from bypassing RLS; ordinary RLS still binds every role that is not
 * the owner. So the whole boundary now rests on one fact: the role the server
 * connects as is not the owner, is not a superuser, and does not hold
 * BYPASSRLS.
 *
 * If that is not true, every buyer can read every other buyer's villa and
 * nothing would look wrong. This refuses to continue.
 */
async function assertIsolationHolds() {
  const c = new Client(config.adminDb());
  await c.connect();
  try {
    const r = (await c.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`, [APP_ROLE])).rows[0];
    if (!r) fail(`the runtime role ${APP_ROLE} does not exist.`);
    if (r.rolsuper) fail(`the runtime role ${APP_ROLE} is a SUPERUSER, so row-level security does not apply to it.`);
    if (r.rolbypassrls) fail(`the runtime role ${APP_ROLE} holds BYPASSRLS, so row-level security does not apply to it.`);

    const owned = (await c.query(
      `SELECT count(*)::int n FROM pg_class c
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'plint' AND c.relkind = 'r'
          AND pg_get_userbyid(c.relowner) = $1`, [APP_ROLE])).rows[0].n;
    if (owned > 0) {
      fail(`the runtime role ${APP_ROLE} owns ${owned} of the tables, and an owner ` +
           `bypasses row-level security. It must be a separate role from the one ` +
           `that runs migrations.`);
    }

    const rls = (await c.query(
      `SELECT count(*)::int n FROM pg_class c
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'plint' AND c.relkind = 'r' AND NOT c.relrowsecurity
          AND c.relname NOT IN ('schema_migrations')`)).rows[0].n;
    if (rls > 0) fail(`${rls} table(s) in plint have row-level security switched off.`);

    console.log('bootstrap: isolation verified - ' + APP_ROLE +
                ' is not an owner, not a superuser, not BYPASSRLS');
  } finally { await c.end(); }
}

function fail(why) {
  process.stderr.write(
    '\nplint: refusing to start.\n  ' + why +
    '\n  Buyer isolation depends on this and nothing else would look wrong.\n\n');
  process.exit(1);
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
      `\nplint: the database role resolves to "${name}", but the migrations\n` +
      '  grant to "plint_app". PGUSER may carry a pooler suffix such as\n' +
      '  plint_app.projectref, but the part before the first dot must be\n' +
      '  plint_app, or the server will connect and then see nothing at all.\n\n');
    process.exit(1);
  }
}

async function bootstrap() {
  config.adminDb();                                   // fails loudly if unset
  config.required('PGUSER', 'The runtime role name.');
  assertRoleName(APP_ROLE);
  await ensureDatabase();
  await ensureAppRole();
  await assertIsolationHolds();
}

if (require.main === module) {
  bootstrap().then(() => console.log('bootstrap: done'))
    .catch(e => { console.error('bootstrap failed:', e.message); process.exit(1); });
}

module.exports = { bootstrap, ensureDatabase, ensureAppRole, assertIsolationHolds, quoteIdent };
