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

/**
 * Everything recorded about one VILLA, newest first.
 *
 * The trail for a villa is not one target: a certification is written against
 * the unit_stage, a settlement against the demand, a receipt against the
 * receipt, and creating the buyer against the unit itself. Somebody asking
 * "what has been done to B-14" wants all four in one column, in time order,
 * which is what this returns.
 *
 * WHY IT IS HERE AND NOT IN A SCREEN. It reads the audit log, and the rule
 * this file exists to hold is that the audit log has exactly one reader and
 * no writer outside the database. A screen composing its own audit query is
 * the first step to a screen writing one.
 */
function forUnit(c, unitId) {
  /* THE NAME, NOT THE ID.
     The log stores an actor id because a name changes and an id does not, and
     the first render of this screen showed a column of "u-eng-ram" to a person
     whose job is to know who certified a stage. `staff_name` is the sanctioned
     way to turn one into a display name: it is SECURITY DEFINER, it answers
     only for staff rows, and it returns NULL for a buyer's id, so it cannot be
     used to enumerate buyers. Joining `users` here instead would be the exact
     policy-crossing fault Pass 7 catalogued - `u_self` narrows that table for
     every role, and an inner join onto it would silently drop rows. */
  return c.query(
    `SELECT a.*, plint.staff_name(a.actor_id) AS actor_name FROM plint.audit_log a
      WHERE (a.target_kind = 'unit'       AND a.target_id = $1)
         OR (a.target_kind = 'unit_stage' AND a.target_id IN
               (SELECT s.id FROM plint.unit_stages s WHERE s.unit_id = $1))
         OR (a.target_kind = 'demand'     AND a.target_id IN
               (SELECT d.id FROM plint.demands d
                  JOIN plint.unit_stages s ON s.id = d.unit_stage_id
                 WHERE s.unit_id = $1))
         OR (a.target_kind = 'receipt'    AND a.target_id IN
               (SELECT r.id FROM plint.receipts r
                  JOIN plint.demands d ON d.id = r.demand_id
                  JOIN plint.unit_stages s ON s.id = d.unit_stage_id
                 WHERE s.unit_id = $1))
      ORDER BY a.at DESC, a.id DESC LIMIT 60`, [unitId]).then(r => r.rows);
}

/** What an action means, in the words the office uses for it. */
const SAID = {
  certified:        'Stage certified',
  demand_settled:   'Demand settled',
  receipt_issued:   'Receipt issued',
  buyer_created:    'Buyer sign-in issued',
  project_created:  'Project created',
  schedule_set:     'Payment schedule set',
  villas_imported:  'Villas loaded from a file',
  hold_placed:      'Legal hold placed',
  hold_released:    'Legal hold released',
  breach_notified:  'Breach notified to the builder',
  grievance_contact_set: 'Grievance officer recorded',
  sanction_recorded:'Sanction recorded',
  lender_chosen:    'Lender chosen',
  option_priced:    'Interior option priced',
  document_added:   'Plan or approval recorded',
  document_superseded: 'Document superseded',
  policy_decided:   'Policy decision recorded',
  engineer_assigned:'Engineer assigned',
};

module.exports = { of, forUnit, SAID };
