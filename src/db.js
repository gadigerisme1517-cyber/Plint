'use strict';
const { Pool, types } = require('pg');

// bigint paise arrive as strings by default, which silently turns addition into
// string concatenation. Parse them to Number here, once, for every query.
types.setTypeParser(20, v => parseInt(v, 10));
types.setTypeParser(1700, v => parseFloat(v));

/* A DATE IS A DAY, NOT AN INSTANT.
   1082 is `date`. The driver turns it into a JS Date at the SERVER PROCESS'S
   local midnight, and every date this product prints is formatted in
   Asia/Kolkata - so on a machine east of India, 2026-09-09 rendered as
   "8 Sept 2026". The demo runs in Singapore and this one is in Sydney, and it
   was about to put the wrong day on a buyer's receipt. Handed through as the
   string Postgres sent, `new Date('2026-09-09')` is UTC midnight, which is
   half past five in the morning in Kolkata and the right day everywhere the
   product is read.
   Four columns are affected: blockers.since, choices.needed_by,
   qpr_filings.due_on and receipts.received_on. */
types.setTypeParser(1082, v => v);
const crypto = require('crypto');
const config = require('./config');

// Every connection value comes from the environment. A missing one stops the
// process here, at boot, rather than letting it start and fail per request.
// Pool size is configurable so a test can pin it to a single connection: with
// one backend, any identity that outlives its transaction must show up in the
// next request rather than depending on which connection the pool hands out.
const pool = new Pool({ ...config.appDb(), max: Number(config.optional('PLINT_POOL_MAX', '8')) });

/**
 * Every read and write goes through here. The session identity is set with
 * set_config(..., true) so it is local to this transaction and cannot survive
 * back into the pool. There is no code path that queries without an identity.
 */
async function asUser(session, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT set_config($1,$2,true), set_config($3,$4,true)', [
      'plint.user_id', session ? session.id : '',
      'plint.role', session ? session.role : '',
    ]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// ------------------------------------------------------------------ passwords
function hash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function verify(pw, stored) {
  const [salt, want] = stored.split(':');
  const got = crypto.scryptSync(pw, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex'));
}

async function login(email, pw) {
  const c = await pool.connect();
  try {
    const r = await c.query('SELECT * FROM plint.login_lookup($1)', [email]);
    if (!r.rows.length) return null;
    const u = r.rows[0];
    if (!verify(pw, u.pw_hash)) return null;
    return { id: u.id, role: u.role, name: u.display_name };
  } finally { c.release(); }
}

module.exports = { pool, asUser, login, hash, verify };
