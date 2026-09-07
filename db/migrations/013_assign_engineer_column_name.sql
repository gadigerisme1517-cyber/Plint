-- 013 assign_engineer named a column that does not exist
--
-- 012 wrote `SELECT full_name INTO v_name FROM plint.users`. The column is
-- `display_name`. The function parsed, created and deployed cleanly, because
-- PL/pgSQL resolves column names when the body runs and not when it is
-- defined - so the fault was invisible until somebody actually reassigned a
-- villa, which is the one flow the office screen exists to perform.
--
-- Found the same day by the engineer's screens failing on the same mistake in
-- their own SQL, which is the only reason this was caught before the office
-- pass rather than during it.
--
-- Forward-only, because 012 has run on the deployed database. It is replaced
-- rather than patched: CREATE OR REPLACE keeps the signature and the grant.

SET search_path = plint, public;

CREATE OR REPLACE FUNCTION assign_engineer(p_unit_id text, p_engineer_id text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor text := nullif(plint.current_user_id(), '');
    v_role  text := nullif(plint.current_role_name(), '');
    v_name  text;
    v_prev  text;
    v_found boolean;
  BEGIN
    IF v_actor IS NULL OR v_role <> 'office' THEN
      RAISE EXCEPTION 'only the head office may reassign a villa';
    END IF;

    SELECT display_name INTO v_name FROM plint.users
     WHERE id = p_engineer_id AND role = 'engineer';
    IF v_name IS NULL THEN RAISE EXCEPTION 'no such engineer'; END IF;

    -- `IF NOT FOUND` after SELECT INTO reports on the SELECT, but the previous
    -- version relied on it after assigning a nullable column, so a villa whose
    -- engineer was NULL looked like a villa that did not exist. Ask directly.
    SELECT true, assigned_engineer_id INTO v_found, v_prev
      FROM plint.units WHERE id = p_unit_id FOR UPDATE;
    IF v_found IS NULL THEN RETURN false; END IF;

    UPDATE plint.units
       SET assigned_engineer_id = p_engineer_id,
           site_engineer        = v_name
     WHERE id = p_unit_id;

    INSERT INTO plint.audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (v_actor, v_role, 'engineer_assigned', 'unit', p_unit_id,
            jsonb_build_object('from', v_prev, 'to', p_engineer_id, 'name', v_name));
    RETURN true;
  END
$$;
