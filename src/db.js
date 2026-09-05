'use strict';
const { Pool, types } = require('pg');

// bigint paise arrive as strings by default, which silently turns addition into
// string concatenation. Parse them to Number here, once, for every query.
types.setTypeParser(20, v => parseInt(v, 10));
types.setTypeParser(1700, v => parseFloat(v));
const crypto = require('crypto');

const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  database: process.env.PGDATABASE || 'plint',
  user: process.env.PGUSER || 'plint_app',
  password: process.env.PGPASSWORD || 'plint_app_dev',
  max: 8,
});

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
