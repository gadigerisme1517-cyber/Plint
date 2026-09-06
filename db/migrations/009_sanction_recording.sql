-- 009 sanction recording
--
-- The loan model in plint-v21 is narrower than the one this repo was built
-- against. The builder does not chase documents. The buyer side is a read-only
-- list of the papers his bank will ask for - no upload, no ticking, nothing
-- sent anywhere. The office side has one job: when the buyer walks in with his
-- sanction letter, record it.
--
-- So a unit either has a recorded sanction or it does not, and until it does,
-- nothing can be disbursed against a stage.
--
-- OWN CONTRIBUTION IS STORED, NOT DERIVED. v21 is inconsistent about this: its
-- receipt hardcodes 20 per cent (`const own=amt*0.2`) while its own sanction
-- sheet says "agreement value less sanction". Neither is safe to assume. A
-- buyer may put in more than the difference, a lender may sanction against a
-- valuation rather than the agreement value, and the two figures come off the
-- letter separately. It is entered at the desk and kept.

SET search_path = plint, public;

ALTER TABLE units
  ADD COLUMN own_contribution_paise bigint CHECK (own_contribution_paise >= 0),
  ADD COLUMN sanction_letter_ref    text,
  ADD COLUMN sanction_recorded_at   timestamptz,
  ADD COLUMN sanction_recorded_by   text REFERENCES users(id);

-- A sanction is recorded whole or not at all. Half a sanction - an amount with
-- no letter behind it, or a letter with nobody's name against it - is the kind
-- of record that looks like evidence and is not.
ALTER TABLE units ADD CONSTRAINT units_sanction_complete CHECK (
  (sanction_paise IS NULL AND own_contribution_paise IS NULL
   AND sanction_letter_ref IS NULL AND sanction_recorded_at IS NULL
   AND sanction_recorded_by IS NULL)
  OR
  (sanction_paise IS NOT NULL AND own_contribution_paise IS NOT NULL
   AND sanction_letter_ref IS NOT NULL AND sanction_recorded_at IS NOT NULL
   AND sanction_recorded_by IS NOT NULL)
);

CREATE INDEX ON units (sanction_recorded_at);

/* Recording a sanction is a write to units, and units carries a SELECT policy
   and no UPDATE policy at all. Rather than add one - the isolation model is
   not mine to widen for a new screen - this goes through a SECURITY DEFINER
   function, which is how every other privileged write in this schema is done:
   login_lookup, session_open, demand_settle, login_attempt.

   The actor is the transaction identity, never a parameter, for the same
   reason demand_settle takes it that way. */
CREATE FUNCTION record_sanction(
  p_unit_id        text,
  p_sanction_paise bigint,
  p_own_paise      bigint,
  p_letter_ref     text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor text := nullif(plint.current_user_id(), '');
    v_role  text := nullif(plint.current_role_name(), '');
    v_found boolean;
  BEGIN
    IF v_actor IS NULL OR v_role <> 'office' THEN
      RAISE EXCEPTION 'only head office records a sanction';
    END IF;
    IF p_sanction_paise IS NULL OR p_sanction_paise <= 0 THEN
      RAISE EXCEPTION 'a sanction needs an amount';
    END IF;
    IF p_own_paise IS NULL OR p_own_paise < 0 THEN
      RAISE EXCEPTION 'a sanction needs the buyer own contribution';
    END IF;
    IF p_letter_ref IS NULL OR btrim(p_letter_ref) = '' THEN
      RAISE EXCEPTION 'a sanction needs the letter it came from';
    END IF;

    SELECT true INTO v_found FROM plint.units
     WHERE id = p_unit_id AND sanction_recorded_at IS NULL FOR UPDATE;
    IF v_found IS NULL THEN
      RETURN false;                 -- unknown unit, or already recorded
    END IF;

    UPDATE plint.units
       SET sanction_paise         = p_sanction_paise,
           own_contribution_paise = p_own_paise,
           sanction_letter_ref    = btrim(p_letter_ref),
           sanction_recorded_at   = now(),
           sanction_recorded_by   = v_actor
     WHERE id = p_unit_id;

    -- Recorded like any other act. This does not touch the certification or
    -- settlement triggers; it is a third kind of row alongside them.
    INSERT INTO plint.audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (v_actor, v_role, 'sanction_recorded', 'unit', p_unit_id,
            jsonb_build_object(
              'sanction_paise',         p_sanction_paise,
              'own_contribution_paise', p_own_paise,
              'letter_ref',             btrim(p_letter_ref)));
    RETURN true;
  END
$$;

GRANT EXECUTE ON FUNCTION record_sanction(text,bigint,bigint,text) TO plint_app;
