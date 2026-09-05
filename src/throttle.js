'use strict';
/* ============================================================================
   Login rate limiting.

   Two counters per attempt. The email key stops one account being ground
   down; the address key stops one source working through many accounts. Both
   live in the database, so a second instance does not double the budget and a
   restart does not clear it.

   Only failures accumulate: a sign-in that works clears both counters.
   ========================================================================= */
const { pool } = require('./db');
const config = require('./config');

const EMAIL_LIMIT = Number(config.optional('PLINT_LOGIN_LIMIT_EMAIL', '5'));
const ADDR_LIMIT = Number(config.optional('PLINT_LOGIN_LIMIT_ADDR', '50'));
const WINDOW = config.optional('PLINT_LOGIN_WINDOW', '15 minutes');
const BLOCK = config.optional('PLINT_LOGIN_BLOCK', '15 minutes');

/* Whether to believe X-Forwarded-For. Off unless the operator says a proxy is
   in front, because a spoofed header would otherwise let one source present
   itself as thousands and evade the address counter entirely. */
const TRUST_PROXY = config.optional('PLINT_TRUST_PROXY', '') === '1';

function addressOf(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

const keysFor = (req, email) => [
  'email:' + String(email || '').trim().toLowerCase(),
  'addr:' + addressOf(req),
];

/**
 * Records the attempt. Returns null when it may proceed, or { until, minutes }
 * when it may not. The password is not checked when this refuses, so a blocked
 * key costs an attacker a round trip and no scrypt.
 */
async function check(req, email) {
  const [emailKey, addrKey] = keysFor(req, email);
  const blocks = [];
  for (const [key, limit] of [[emailKey, EMAIL_LIMIT], [addrKey, ADDR_LIMIT]]) {
    const r = await pool.query('SELECT plint.login_attempt($1,$2,$3,$4) until',
      [key, limit, WINDOW, BLOCK]);
    if (r.rows[0].until) blocks.push(new Date(r.rows[0].until));
  }
  if (!blocks.length) return null;
  const until = new Date(Math.max(...blocks.map(d => d.getTime())));
  return { until, minutes: Math.max(1, Math.ceil((until - Date.now()) / 60000)) };
}

/** A sign-in that worked. Both counters go back to zero. */
async function clear(req, email) {
  for (const key of keysFor(req, email)) {
    await pool.query('SELECT plint.login_cleared($1)', [key]);
  }
}

const sweep = () =>
  pool.query('SELECT plint.login_attempts_sweep() n').then(r => r.rows[0].n);

module.exports = { check, clear, sweep, addressOf, EMAIL_LIMIT, ADDR_LIMIT };
