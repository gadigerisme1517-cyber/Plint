-- 004 demands become immutable
--
-- The application role held UPDATE on demands, so a compromised process could
-- have rewritten an issued amount and nothing would have noticed.
--
-- Two independent locks, because one of them is a grant and grants get
-- re-granted by accident:
--
--   1. The UPDATE grant is revoked. A direct UPDATE as the application role
--      raises permission denied before a row is even considered.
--   2. A trigger refuses any change to the money columns, the document number,
--      or the dates - for every role, including the owner and a superuser.
--
-- The one permitted transition, unpaid to paid, goes through a SECURITY
-- DEFINER function that writes paid_at and an audit row and touches nothing
-- else. A correction is a new credit row, never an edit.

SET search_path = plint, public;

-- ---------------------------------------------------------------- lock one
REVOKE UPDATE ON demands FROM plint_app;

-- ---------------------------------------------------------------- lock two
CREATE FUNCTION demands_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.base_paise    IS DISTINCT FROM OLD.base_paise
    OR NEW.gst_paise     IS DISTINCT FROM OLD.gst_paise
    OR NEW.extras_paise  IS DISTINCT FROM OLD.extras_paise
    OR NEW.total_paise   IS DISTINCT FROM OLD.total_paise
    OR NEW.id            IS DISTINCT FROM OLD.id
    OR NEW.unit_stage_id IS DISTINCT FROM OLD.unit_stage_id
    OR NEW.doc_no        IS DISTINCT FROM OLD.doc_no
    OR NEW.raised_at     IS DISTINCT FROM OLD.raised_at
    OR NEW.due_at        IS DISTINCT FROM OLD.due_at THEN
      RAISE EXCEPTION
        'a demand is immutable once issued; a correction is a credit row, not an edit';
    END IF;
    IF OLD.paid_at IS NOT NULL AND NEW.paid_at IS DISTINCT FROM OLD.paid_at THEN
      RAISE EXCEPTION 'a demand can be settled once';
    END IF;
    RETURN NEW;
  END
$$;

CREATE TRIGGER demands_immutable BEFORE UPDATE ON demands
  FOR EACH ROW EXECUTE FUNCTION demands_immutable();

CREATE FUNCTION demands_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'an issued demand is not deleted'; END
$$;
CREATE TRIGGER demands_no_delete BEFORE DELETE ON demands
  FOR EACH ROW EXECUTE FUNCTION demands_no_delete();

-- An UPDATE policy so the definer function below works whether or not the
-- owning role happens to be a superuser. This is NOT what keeps the
-- application role out - the revoked grant above is, and a policy cannot give
-- back a privilege that was never granted. The trigger stands behind both.
CREATE POLICY dm_settle ON demands FOR UPDATE USING (true) WITH CHECK (true);

-- ------------------------------------------------------- the one transition
-- Settles a demand and records who did it with the figures as at that moment.
-- It cannot touch the money columns: it does not name them, and the trigger
-- would refuse if it did.
CREATE FUNCTION demand_settle(p_demand_id text, p_reference text DEFAULT NULL)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    d        plint.demands;
    v_actor  text := plint.current_user_id();
    v_role   text := plint.current_role_name();
  BEGIN
    -- The actor is the transaction identity, never a parameter. A caller
    -- cannot settle a demand in somebody else's name.
    IF v_actor IS NULL OR v_actor = '' OR v_role NOT IN ('engineer','office') THEN
      RAISE EXCEPTION 'only an identified engineer or head office settles a demand';
    END IF;

    SELECT * INTO d FROM plint.demands WHERE id = p_demand_id FOR UPDATE;
    IF NOT FOUND OR d.paid_at IS NOT NULL THEN
      RETURN false;                       -- unknown, or already settled
    END IF;

    UPDATE plint.demands SET paid_at = now() WHERE id = p_demand_id;
    UPDATE plint.unit_stages SET status = 'paid' WHERE id = d.unit_stage_id;

    INSERT INTO plint.audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (v_actor, v_role, 'demand_settled', 'demand', d.id,
            jsonb_build_object(
              'doc_no',       d.doc_no,
              'base_paise',   d.base_paise,
              'gst_paise',    d.gst_paise,
              'extras_paise', d.extras_paise,
              'total_paise',  d.total_paise,
              'raised_at',    d.raised_at,
              'due_at',       d.due_at,
              'reference',    p_reference));
    RETURN true;
  END
$$;

GRANT EXECUTE ON FUNCTION demand_settle(text,text) TO plint_app;

-- ------------------------------------------------------------------ credits
-- The correction mechanism the rule above names. A demand is never edited; a
-- credit is raised against it. Insert-only for the same reason the audit log
-- is: a correction that can be un-corrected is not a record.
CREATE TABLE credits (
  id            text PRIMARY KEY,
  demand_id     text NOT NULL REFERENCES demands(id),
  amount_paise  bigint NOT NULL CHECK (amount_paise > 0),
  reason        text NOT NULL,
  raised_by     text NOT NULL REFERENCES users(id),
  raised_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON credits (demand_id);

ALTER TABLE credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE credits FORCE ROW LEVEL SECURITY;

-- A buyer sees credits against his own demands and nobody else's, by the same
-- ownership test every other buyer-visible table uses.
CREATE POLICY cr_read ON credits FOR SELECT USING (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit((SELECT s.unit_id FROM plint.unit_stages s
                                  JOIN plint.demands d ON d.unit_stage_id = s.id
                                 WHERE d.id = demand_id))
    WHEN 'engineer' THEN true
    WHEN 'office' THEN true
    ELSE false
  END);

CREATE POLICY cr_write ON credits FOR INSERT WITH CHECK (
  current_role_name() IN ('engineer','office') AND raised_by = current_user_id());

GRANT SELECT, INSERT ON credits TO plint_app;
