'use strict';
/* ============================================================================
   Configuration.

   Every value comes from the environment. There is not one credential default
   in this file or in any other: a missing variable stops the process at boot
   with a message naming it, rather than silently connecting somewhere the
   operator did not intend.

   Two credential sets, because they are two different privileges:
     app    - PGUSER / PGPASSWORD, the runtime role. Cannot bypass RLS.
     admin  - PGADMINUSER / PGADMINPASSWORD, owns the schema. Migrations and
              the development seed only. The server never uses it.
   ========================================================================= */

const fs = require('fs');
const path = require('path');

// Node's own .env reader. A development convenience: in production the
// variables come from the supervisor and no .env file is present.
const envFile = process.env.PLINT_ENV_FILE || path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

function die(name, why) {
  process.stderr.write(
    `\nplint: ${name} is not set.\n` +
    `  ${why}\n` +
    `  Copy .env.example to .env and fill it in, or export ${name} before starting.\n\n`);
  process.exit(1);
}

function required(name, why) {
  const v = process.env[name];
  if (v === undefined || v === '') die(name, why);
  return v;
}

/** Non-secret values may carry a default. Credentials never may. */
function optional(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

/* Is this a development machine? Only NODE_ENV says so, and only by saying so
   explicitly. An environment that has not identified itself is treated as
   production, because that is the answer that fails safe. */
const isDevelopment = () => process.env.NODE_ENV === 'development';

/**
 * TLS for the database connection, in libpq's vocabulary.
 *
 *   disable      no TLS. Development only.
 *   require      encrypted, certificate not verified. The default outside
 *                development: it stops passive interception, which is the
 *                threat when the database is across a network.
 *   verify-ca    encrypted, certificate chain verified against PGSSLROOTCERT.
 *   verify-full  as verify-ca, and the hostname must match. Use this in
 *                production if you have a CA to verify against.
 *
 * Defaulting to `require` rather than `verify-full` is a deliberate,
 * documented compromise: verify-full needs a root certificate that this
 * deployment does not yet have, and defaulting to it would mean the process
 * would not start. `require` is the strongest setting that works unattended.
 */
function sslFor(mode) {
  switch (mode) {
    case 'disable':
      return false;
    case 'require':
      // Encrypt, do not verify. libpq's `require` means exactly this.
      return { rejectUnauthorized: false };
    case 'verify-ca':
    case 'verify-full': {
      const ca = optional('PGSSLROOTCERT', '');
      if (!ca) die('PGSSLROOTCERT', `PGSSLMODE=${mode} needs a root certificate to verify against.`);
      return {
        rejectUnauthorized: true,
        ca: fs.readFileSync(ca, 'utf8'),
        ...(mode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}),
      };
    }
    default:
      die('PGSSLMODE', `"${mode}" is not one of disable, require, verify-ca, verify-full.`);
  }
}

const sslMode = () => optional('PGSSLMODE', isDevelopment() ? 'disable' : 'require');

/** Connection for the runtime role. Validated the moment src/db.js loads. */
function appDb() {
  return {
    host: required('PGHOST', 'The database host.'),
    port: Number(optional('PGPORT', '5432')),
    database: required('PGDATABASE', 'The database name.'),
    user: required('PGUSER', 'The runtime role. It must not be a superuser.'),
    password: required('PGPASSWORD', 'The runtime role password.'),
    ssl: sslFor(sslMode()),
  };
}

/** Connection for the owning role. Migrations and the seed, nothing else. */
function adminDb(overrides = {}) {
  return {
    host: required('PGHOST', 'The database host.'),
    port: Number(optional('PGPORT', '5432')),
    database: required('PGDATABASE', 'The database name.'),
    user: required('PGADMINUSER', 'The role that owns the schema. Migrations run as this.'),
    password: required('PGADMINPASSWORD', 'The owning role password.'),
    ssl: sslFor(sslMode()),
    ...overrides,
  };
}

/** Signs session cookies. Rotating it invalidates every outstanding session. */
function sessionSecret() {
  const s = required('PLINT_SECRET', 'Signs session cookies. Use 32+ random bytes.');
  if (s.length < 16) die('PLINT_SECRET', 'It is set but too short to be a secret. Use 32+ random bytes.');
  return s;
}

const port = () => Number(optional('PORT', '3000'));

/* Cookies are only sent over TLS unless this is explicitly a local run.
   The insecure setting has to be asked for; it is never the silent default in
   an environment that has not said what it is. */
const secureCookies = () => optional('PLINT_INSECURE_COOKIES', '') !== '1';

/** Where uploaded evidence images are written. Content-addressed underneath. */
const evidenceDir = () =>
  path.resolve(optional('PLINT_EVIDENCE_DIR', path.join(__dirname, '..', 'var', 'evidence')));

module.exports = {
  appDb, adminDb, sessionSecret, port, secureCookies, evidenceDir,
  sslMode, isDevelopment, required, optional,
};
