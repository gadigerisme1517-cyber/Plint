'use strict';
/* ============================================================================
   The audit trail.

   One row per act, written inside the same transaction as the act itself, so
   an act cannot land without its record and a record cannot survive an act
   that rolled back.

   The figures are copied in as at that moment. A later correction in
   src/money.js changes what the next demand will say; it does not change what
   this one said when it was signed.
   ========================================================================= */

/**
 * @param c   the client inside the open transaction, not the pool
 * @param sess the acting session; the database checks actor_id against the
 *             transaction identity, so a row cannot be attributed elsewhere
 */
function write(c, sess, { action, targetKind, targetId, figures = {} }) {
  return c.query(
    `INSERT INTO audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [sess.id, sess.role, action, targetKind, targetId, JSON.stringify(figures)]);
}

/** Everything recorded about one thing, newest first. Staff only, by policy. */
function of(c, targetKind, targetId) {
  return c.query(
    `SELECT * FROM audit_log WHERE target_kind=$1 AND target_id=$2 ORDER BY at DESC, id DESC`,
    [targetKind, targetId]).then(r => r.rows);
}

module.exports = { write, of };
