-- ============================================================================
-- PUTTING A CUSTOMER ON PLINT.
--
-- Every screen so far reads a project that db/seed.js wrote. That is the line
-- between a demonstration and a product: a builder who signs cannot be served,
-- because there is no way to create their project, load their villas, describe
-- their payment schedule or give their buyers a login.
--
-- This migration is the write side of that, and it is built the way every
-- other privileged write in this schema is built: SECURITY DEFINER functions,
-- executed by plint_app, which check the transaction's own identity and role
-- rather than trusting a parameter. `plint_app` still holds no INSERT on
-- projects, stage_templates, units, unit_stages or users, and this migration
-- does not give it any. Nothing below can be reached by a buyer or an
-- engineer, whatever they post.
--
-- WHAT IS DELIBERATELY REFUSED, RATHER THAN ALLOWED WITH A WARNING:
--   * a schedule whose percentages do not add to a hundred
--   * a schedule changed after a villa exists on the project, because every
--     unit_stage row and every priced demand hangs off it
--   * a villa code that already exists on that project
--   * an email that already signs somebody in
--   * a second buyer on a villa that has one
--
-- WHAT IS DELIBERATELY NOT HERE: no way to delete a project, a villa or a
-- buyer. Removing a villa that has stages, evidence and demands hanging off it
-- is not a form, it is a decision with a paper trail, and nothing in this
-- product deletes money. The absence is the design, not an omission.
-- ============================================================================

SET search_path = plint, public;

-- --------------------------------------------------------------- the project
-- A project needs to say who is building it and where. `phase` was the whole
-- of it, because there was one project and it was known.
ALTER TABLE projects
  ADD COLUMN location      text,
  ADD COLUMN builder_name  text,
  ADD COLUMN builder_ref   text,          -- the builder's own RERA or CIN
  ADD COLUMN created_at    timestamptz,
  ADD COLUMN created_by    text REFERENCES users(id);

/* An id a person can read in a URL and in a log line. Validated here rather
   than trusted, because it becomes part of every unit id on the project. */
CREATE FUNCTION project_create(
  p_id          text,
  p_name        text,
  p_phase       text,
  p_location    text,
  p_builder     text,
  p_builder_ref text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor text := nullif(plint.current_user_id(), '');
    v_role  text := nullif(plint.current_role_name(), '');
  BEGIN
    IF v_actor IS NULL OR v_role <> 'office' THEN
      RAISE EXCEPTION 'only head office creates a project';
    END IF;
    IF p_id !~ '^[a-z0-9][a-z0-9-]{2,40}$' THEN
      RAISE EXCEPTION 'a project id is lower case letters, digits and hyphens';
    END IF;
    IF coalesce(btrim(p_name), '') = '' OR coalesce(btrim(p_phase), '') = ''
       OR coalesce(btrim(p_location), '') = '' OR coalesce(btrim(p_builder), '') = '' THEN
      RAISE EXCEPTION 'a project needs a name, a phase, a location and a builder';
    END IF;
    IF EXISTS (SELECT 1 FROM plint.projects WHERE id = p_id) THEN
      RETURN false;
    END IF;

    INSERT INTO plint.projects (id, name, phase, location, builder_name, builder_ref,
                                created_at, created_by)
    VALUES (p_id, btrim(p_name), btrim(p_phase), btrim(p_location), btrim(p_builder),
            nullif(btrim(coalesce(p_builder_ref, '')), ''), now(), v_actor);

    INSERT INTO plint.audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (v_actor, v_role, 'project_created', 'project', p_id,
            jsonb_build_object('name', btrim(p_name), 'phase', btrim(p_phase),
                               'location', btrim(p_location), 'builder', btrim(p_builder)));
    RETURN true;
  END
$$;

GRANT EXECUTE ON FUNCTION project_create(text,text,text,text,text,text) TO plint_app;

-- -------------------------------------------------------------- the schedule
/* The whole schedule, replaced in one call, because a schedule is one object:
   nine stages that add to a hundred are not nine facts, they are one. It is
   refused once a villa exists on the project - every unit_stage row and every
   priced demand hangs off these percentages, and moving them under live money
   is not something a form should be able to do. */
CREATE FUNCTION stage_schedule_set(p_project text, p_rows jsonb)
  RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor text := nullif(plint.current_user_id(), '');
    v_role  text := nullif(plint.current_role_name(), '');
    v_sum   int;
    v_n     int;
  BEGIN
    IF v_actor IS NULL OR v_role <> 'office' THEN
      RAISE EXCEPTION 'only head office sets a payment schedule';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM plint.projects WHERE id = p_project) THEN
      RAISE EXCEPTION 'no such project';
    END IF;
    IF EXISTS (SELECT 1 FROM plint.units WHERE project_id = p_project) THEN
      RAISE EXCEPTION 'this project already has villas; its schedule cannot be changed';
    END IF;

    SELECT count(*), sum((r->>'pct_bp')::int) INTO v_n, v_sum
      FROM jsonb_array_elements(p_rows) r;
    IF v_n IS NULL OR v_n < 2 THEN
      RAISE EXCEPTION 'a schedule needs at least two stages';
    END IF;
    IF v_sum <> 10000 THEN
      RAISE EXCEPTION 'the stages add to % per cent of the agreement value, not 100',
        to_char(v_sum / 100.0, 'FM990.00');
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r
                WHERE coalesce(btrim(r->>'code'), '') = ''
                   OR coalesce(btrim(r->>'name'), '') = ''
                   OR (r->>'pct_bp')::int <= 0) THEN
      RAISE EXCEPTION 'every stage needs a code, a name and a percentage above zero';
    END IF;

    DELETE FROM plint.stage_templates WHERE project_id = p_project;
    INSERT INTO plint.stage_templates (project_id, seq, code, name, pct_bp, description)
    SELECT p_project, (ord - 1)::int, btrim(r->>'code'), btrim(r->>'name'),
           (r->>'pct_bp')::int, coalesce(nullif(btrim(r->>'description'), ''), btrim(r->>'name'))
      FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(r, ord);

    INSERT INTO plint.audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (v_actor, v_role, 'schedule_set', 'project', p_project,
            jsonb_build_object('stages', v_n, 'total_bp', v_sum));
    RETURN v_n;
  END
$$;

GRANT EXECUTE ON FUNCTION stage_schedule_set(text,jsonb) TO plint_app;

-- ----------------------------------------------------------------- the villas
/* One call, one transaction, one answer.

   Every row is either created whole - the unit and one unit_stage per stage on
   the project's schedule - or skipped with a reason. A row cannot half-land:
   there is no path here that writes a unit and then fails to write its stages,
   because both happen in the same statement pair inside the same function.

   The reasons are returned rather than raised, because the screen shows them
   before anything is written and again after. Only a fault that makes the
   whole call meaningless - no project, no schedule, not the office - raises. */
CREATE FUNCTION units_import(p_project text, p_rows jsonb)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor   text := nullif(plint.current_user_id(), '');
    v_role    text := nullif(plint.current_role_name(), '');
    v_stages  int;
    v_created jsonb := '[]'::jsonb;
    v_skipped jsonb := '[]'::jsonb;
    r         jsonb;
    v_code    text;
    v_value   bigint;
    v_id      text;
    v_seen    text[] := ARRAY[]::text[];
  BEGIN
    IF v_actor IS NULL OR v_role <> 'office' THEN
      RAISE EXCEPTION 'only head office loads villas';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM plint.projects WHERE id = p_project) THEN
      RAISE EXCEPTION 'no such project';
    END IF;
    SELECT count(*) INTO v_stages FROM plint.stage_templates WHERE project_id = p_project;
    IF v_stages = 0 THEN
      RAISE EXCEPTION 'this project has no payment schedule yet; set it before loading villas';
    END IF;

    FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
      v_code := btrim(coalesce(r->>'code', ''));
      v_value := NULL;
      BEGIN
        v_value := (r->>'agreement_value_paise')::bigint;
      EXCEPTION WHEN others THEN
        v_value := NULL;
      END;

      IF v_code = '' THEN
        v_skipped := v_skipped || jsonb_build_object('code', '(blank)', 'why', 'no villa code');
      ELSIF v_code = ANY (v_seen) THEN
        v_skipped := v_skipped || jsonb_build_object('code', v_code, 'why', 'the same code twice in this file');
      ELSIF EXISTS (SELECT 1 FROM plint.units WHERE project_id = p_project AND code = v_code) THEN
        v_skipped := v_skipped || jsonb_build_object('code', v_code, 'why', 'already on this project');
      ELSIF coalesce(btrim(r->>'buyer_name'), '') = '' THEN
        v_skipped := v_skipped || jsonb_build_object('code', v_code, 'why', 'no buyer name');
      ELSIF coalesce(btrim(r->>'unit_type'), '') = '' THEN
        v_skipped := v_skipped || jsonb_build_object('code', v_code, 'why', 'no unit type');
      ELSIF v_value IS NULL OR v_value <= 0 THEN
        v_skipped := v_skipped || jsonb_build_object('code', v_code, 'why', 'the agreement value is not a positive amount');
      ELSE
        v_seen := v_seen || v_code;
        v_id := 'u-' || p_project || '-' || v_code;

        INSERT INTO plint.units (id, project_id, code, buyer_name, unit_type,
                                 agreement_value_paise, bank, channel_partner,
                                 site_engineer, relationship_manager)
        VALUES (v_id, p_project, v_code, btrim(r->>'buyer_name'), btrim(r->>'unit_type'),
                v_value, nullif(btrim(coalesce(r->>'bank', '')), ''),
                nullif(btrim(coalesce(r->>'channel_partner', '')), ''),
                nullif(btrim(coalesce(r->>'site_engineer', '')), ''),
                nullif(btrim(coalesce(r->>'relationship_manager', '')), ''));

        INSERT INTO plint.unit_stages (id, unit_id, stage_code, status)
        SELECT 'us-' || v_id || '-' || t.code, v_id, t.code, 'pending'
          FROM plint.stage_templates t
         WHERE t.project_id = p_project;

        v_created := v_created || jsonb_build_object('code', v_code, 'id', v_id);
      END IF;
    END LOOP;

    IF jsonb_array_length(v_created) > 0 THEN
      INSERT INTO plint.audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
      VALUES (v_actor, v_role, 'villas_imported', 'project', p_project,
              jsonb_build_object('created', jsonb_array_length(v_created),
                                 'skipped', jsonb_array_length(v_skipped),
                                 'stages_each', v_stages));
    END IF;
    RETURN jsonb_build_object('created', v_created, 'skipped', v_skipped);
  END
$$;

GRANT EXECUTE ON FUNCTION units_import(text,jsonb) TO plint_app;

-- ----------------------------------------------------------------- the buyer
/* A login for the person who bought a villa.

   The hash is computed by the application, the way it is at every other place
   a password is set, and the plain text never reaches the database. The unit
   is linked in the same statement, so a buyer cannot exist without the villa
   they were created for. */
CREATE FUNCTION buyer_create(p_unit text, p_email text, p_name text, p_pw_hash text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor text := nullif(plint.current_user_id(), '');
    v_role  text := nullif(plint.current_role_name(), '');
    v_email text := lower(btrim(coalesce(p_email, '')));
    v_id    text;
  BEGIN
    IF v_actor IS NULL OR v_role <> 'office' THEN
      RAISE EXCEPTION 'only head office issues a buyer login';
    END IF;
    IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
      RAISE EXCEPTION 'that is not an email address';
    END IF;
    IF coalesce(btrim(p_name), '') = '' THEN
      RAISE EXCEPTION 'a buyer needs a name';
    END IF;
    IF coalesce(p_pw_hash, '') !~ '^[0-9a-f]+:[0-9a-f]+$' THEN
      RAISE EXCEPTION 'the password was not hashed';
    END IF;
    IF EXISTS (SELECT 1 FROM plint.users WHERE lower(email) = v_email) THEN
      RAISE EXCEPTION 'that email already signs somebody in';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM plint.units WHERE id = p_unit) THEN
      RAISE EXCEPTION 'no such villa';
    END IF;
    IF EXISTS (SELECT 1 FROM plint.units WHERE id = p_unit AND buyer_user_id IS NOT NULL) THEN
      RAISE EXCEPTION 'that villa already has a buyer signed up';
    END IF;

    v_id := 'u-buyer-' || substr(md5(v_email || clock_timestamp()::text), 1, 12);
    INSERT INTO plint.users (id, email, pw_hash, role, display_name)
    VALUES (v_id, v_email, p_pw_hash, 'buyer', btrim(p_name));

    UPDATE plint.units SET buyer_user_id = v_id, buyer_name = btrim(p_name)
     WHERE id = p_unit;

    INSERT INTO plint.audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (v_actor, v_role, 'buyer_created', 'unit', p_unit,
            jsonb_build_object('email', v_email, 'name', btrim(p_name)));
    RETURN v_id;
  END
$$;

GRANT EXECUTE ON FUNCTION buyer_create(text,text,text,text) TO plint_app;

-- ------------------------------------------------------------------ the seed
-- The one project that existed before this migration was written by hand, so
-- it has no builder against it. Naming it here keeps every project on the
-- same footing rather than leaving one with empty columns.
UPDATE projects
   SET location     = coalesce(location, 'Devanahalli, Bengaluru'),
       builder_name = coalesce(builder_name, 'NVT Quality Lifestyle'),
       builder_ref  = coalesce(builder_ref, 'PRM/KA/RERA/1251/446/PR/171021/001234')
 WHERE id = 'eterna-p1';
