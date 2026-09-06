'use strict';
/* ============================================================================
   The audit trail: reading it.

   Nothing in this module writes. The rows are written by triggers in
   db/migrations/008, from the certified_* columns of the stage itself and from
   the demand's own figures, deferred to COMMIT.

   That is deliberate and it is the whole point. An application-level writer is
   a convention: correct while every writer remembers. This one was not
   remembered - the seed fabricated 269 certified stages and wrote no audit row
   for any of them, and a restore drill found it rather than a test. A
   certification that leaves no record is now impossible regardless of who does
   the writing.

   If you find yourself wanting to INSERT into audit_log from here, the
   question to answer first is why the database cannot derive the row itself.
   ========================================================================= */

/** Everything recorded about one thing, newest first. Staff only, by policy. */
function of(c, targetKind, targetId) {
  return c.query(
    `SELECT * FROM audit_log WHERE target_kind=$1 AND target_id=$2 ORDER BY at DESC, id DESC`,
    [targetKind, targetId]).then(r => r.rows);
}

module.exports = { of };
