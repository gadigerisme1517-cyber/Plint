'use strict';
/* ============================================================================
   Sessions.

   The cookie carries a random 32-byte token. The database stores only
   HMAC-SHA256(token, PLINT_SECRET). Reading the sessions table therefore
   yields no usable cookie, and rotating PLINT_SECRET signs everyone out
   without touching a row.

   Nothing is held in process. A restart does not sign anyone out and a second
   instance authenticates cookies the first one issued.
   ========================================================================= */
const crypto = require('crypto');
const { pool } = require('./db');
const config = require('./config');

const TTL_HOURS = Number(config.optional('PLINT_SESSION_HOURS', '12'));

/** The lookup key. Never leaves the server; never appears in a cookie. */
const keyOf = token =>
  crypto.createHmac('sha256', config.sessionSecret()).update(token).digest('hex');

/* These three run outside asUser() on purpose. A session has to be resolved
   before an identity exists, so there is no identity to set. They reach the
   database only through SECURITY DEFINER functions; the application role
   holds no grant on the sessions table itself. */

async function open(user) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('SELECT plint.session_open($1,$2,$3,$4,$5,$6)',
    [keyOf(token), user.id, user.role, user.name, user.unit || null, TTL_HOURS + ' hours']);
  return token;
}

async function lookup(token) {
  if (!token) return null;
  const r = await pool.query('SELECT * FROM plint.session_lookup($1)', [keyOf(token)]);
  if (!r.rows.length) return null;
  const s = r.rows[0];
  return { id: s.user_id, role: s.role, name: s.display_name, unit: s.unit_code };
}

const revoke = token => token
  ? pool.query('SELECT plint.session_revoke($1)', [keyOf(token)])
  : Promise.resolve();

const sweep = () => pool.query('SELECT plint.session_sweep() n').then(r => r.rows[0].n);

// ------------------------------------------------------------------- cookies
const NAME = 'plint';

/* Secure is on unless the operator has explicitly said this is a local http
   run. HttpOnly and SameSite=Lax always. Max-Age matches the row's lifetime,
   so the browser and the database agree on when the session ends. */
function setCookie(token) {
  const bits = [`${NAME}=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax',
                `Max-Age=${TTL_HOURS * 3600}`];
  if (config.secureCookies()) bits.push('Secure');
  return bits.join('; ');
}

function clearCookie() {
  const bits = [`${NAME}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (config.secureCookies()) bits.push('Secure');
  return bits.join('; ');
}

/** Reads our cookie out of the header without tripping over its neighbours. */
function tokenFrom(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === NAME) return part.slice(i + 1).trim();
  }
  return null;
}

module.exports = { open, lookup, revoke, sweep, setCookie, clearCookie, tokenFrom, TTL_HOURS };
