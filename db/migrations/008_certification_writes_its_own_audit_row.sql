-- 008 a certification cannot happen without its audit row
--
-- The audit row used to be written by the route handler. That made it a
-- convention: correct as long as every writer remembered. It was not
-- remembered - db/seed.js fabricated 269 certified stages and wrote no audit
-- rows at all, and a restore drill found it rather than any test.
--
-- Writing the row from the seed as well would have made two writers and the
-- same convention twice. This makes it structural: the database writes the
-- row, so a certification that leaves no audit row is impossible regardless of
-- who does the writing - route handler, seed, migration, or a psql prompt.
--
-- WHICH TRANSITION. There is no `status = 'certified'` to hook. The status
-- enum carries the value but no code path ever sets it: certify() moves a
-- stage from 'marked' straight to 'demanded' in one statement, and the seed
-- inserts 'demanded' and 'paid' rows directly. What actually marks a
-- certification is certified_by, certified_at and certificate_hash going from
-- null to not-null, so that is what fires the trigger. A trigger on the status
-- value would have fired zero times against all 269 certified stages.
--
-- WHY DEFERRED. certify() updates the stage first and inserts the demand
-- second. An immediate AFTER trigger would run before the demand existed and
-- record a certification with no figures. A deferred constraint trigger fires
-- at COMMIT, by which time everything the row refers to is in place, whatever
-- order the writer chose.

SET search_path = plint, public;

-- ------------------------------------------------------- half a certification
-- A certified_at with no certified_by is a signature nobody signed.
ALTER TABLE unit_stages ADD CONSTRAINT unit_stages_certification_complete CHECK (
  (certified_by IS NULL AND certified_at IS NULL AND certificate_hash IS NULL)
  OR
  (certified_by IS NOT NULL AND certified_at IS NOT NULL AND certificate_hash IS NOT NULL)
);

-- ------------------------------------------------- a certification is a fact
-- Once made it cannot be altered or erased. Otherwise the audit row below
-- could be made to describe something that is no longer what the row says.
CREATE FUNCTION certification_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF OLD.certified_at IS NOT NULL AND (
         NEW.certified_at     IS DISTINCT FROM OLD.certified_at
      OR NEW.certified_by     IS DISTINCT FROM OLD.certified_by
      OR NEW.certificate_hash IS DISTINCT FROM OLD.certificate_hash) THEN
      RAISE EXCEPTION
        'a certification cannot be altered or withdrawn once signed (stage %)', OLD.id;
    END IF;
    RETURN NEW;
  END
$$;

CREATE TRIGGER certification_immutable BEFORE UPDATE ON unit_stages
  FOR EACH ROW EXECUTE FUNCTION certification_immutable();

-- --------------------------------------------------------- the single writer
CREATE FUNCTION certification_audit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    d      plint.demands;
    ctx    record;
    shots  integer;
    v_role text;
  BEGIN
    -- Only the moment a stage acquires its certification.
    IF NEW.certified_at IS NULL THEN RETURN NULL; END IF;
    IF TG_OP = 'UPDATE' AND OLD.certified_at IS NOT NULL THEN RETURN NULL; END IF;

    SELECT u.code, u.agreement_value_paise, t.name AS stage_name, t.pct_bp
      INTO ctx
      FROM plint.units u
      JOIN plint.stage_templates t
        ON t.code = NEW.stage_code AND t.project_id = u.project_id
     WHERE u.id = NEW.unit_id;

    -- The demand this certification raised, if the writer raised one. A
    -- certification with no demand is still a certification and is still
    -- recorded; it simply has no figures to carry.
    SELECT * INTO d FROM plint.demands WHERE unit_stage_id = NEW.id;

    SELECT count(*) INTO shots FROM plint.evidence WHERE unit_stage_id = NEW.id;
    SELECT role INTO v_role FROM plint.users WHERE id = NEW.certified_by;

    INSERT INTO plint.audit_log (at, actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (
      NEW.certified_at,
      NEW.certified_by,
      coalesce(v_role, 'engineer'),
      'certified',
      'unit_stage',
      NEW.id,
      jsonb_strip_nulls(jsonb_build_object(
        'unit',                  ctx.code,
        'stage',                 NEW.stage_code,
        'stage_name',            ctx.stage_name,
        'pct_bp',                ctx.pct_bp,
        'agreement_value_paise', ctx.agreement_value_paise,
        'demand_id',             d.id,
        'doc_no',                d.doc_no,
        'base_paise',            d.base_paise,
        'gst_paise',             d.gst_paise,
        'extras_paise',          d.extras_paise,
        'total_paise',           d.total_paise,
        'raised_at',             d.raised_at,
        'due_at',                d.due_at,
        'photographs',           shots,
        'certificate_hash',      NEW.certificate_hash)));
    RETURN NULL;
  END
$$;

-- Deferred: fires at COMMIT, so the demand and the photographs the row refers
-- to are visible whatever order the writer inserted them in.
CREATE CONSTRAINT TRIGGER certification_audit
  AFTER INSERT OR UPDATE ON unit_stages
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION certification_audit();

-- ------------------------------------------------------------- settlement too
-- The same fault existed one table over: demand_settle() wrote the audit row,
-- and the seed wrote 221 settlements straight into demands, bypassing it.
CREATE FUNCTION settlement_audit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor text := nullif(plint.current_user_id(), '');
    v_role  text := nullif(plint.current_role_name(), '');
  BEGIN
    IF NEW.paid_at IS NULL THEN RETURN NULL; END IF;
    IF TG_OP = 'UPDATE' AND OLD.paid_at IS NOT NULL THEN RETURN NULL; END IF;

    -- Money moving must name who moved it. There is no settled_by column to
    -- read, so the transaction identity is the only answer, and the absence of
    -- one is an error rather than a row attributed to nobody.
    IF v_actor IS NULL THEN
      RAISE EXCEPTION
        'a demand cannot be settled without an identified actor (demand %)', NEW.id;
    END IF;

    INSERT INTO plint.audit_log (at, actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (NEW.paid_at, v_actor, coalesce(v_role, 'office'),
            'demand_settled', 'demand', NEW.id,
            jsonb_build_object(
              'doc_no',       NEW.doc_no,
              'base_paise',   NEW.base_paise,
              'gst_paise',    NEW.gst_paise,
              'extras_paise', NEW.extras_paise,
              'total_paise',  NEW.total_paise,
              'raised_at',    NEW.raised_at,
              'due_at',       NEW.due_at));
    RETURN NULL;
  END
$$;

CREATE CONSTRAINT TRIGGER settlement_audit
  AFTER INSERT OR UPDATE ON demands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION settlement_audit();

-- demand_settle no longer writes the row itself: the trigger above does, and
-- two writers is the thing this migration exists to remove. Everything else
-- about the function is unchanged.
CREATE OR REPLACE FUNCTION demand_settle(p_demand_id text, p_reference text DEFAULT NULL)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    d        plint.demands;
    v_actor  text := plint.current_user_id();
    v_role   text := plint.current_role_name();
  BEGIN
    IF v_actor IS NULL OR v_actor = '' OR v_role NOT IN ('engineer','office') THEN
      RAISE EXCEPTION 'only an identified engineer or head office settles a demand';
    END IF;

    SELECT * INTO d FROM plint.demands WHERE id = p_demand_id FOR UPDATE;
    IF NOT FOUND OR d.paid_at IS NOT NULL THEN
      RETURN false;
    END IF;

    UPDATE plint.demands SET paid_at = now() WHERE id = p_demand_id;
    UPDATE plint.unit_stages SET status = 'paid' WHERE id = d.unit_stage_id;
    RETURN true;
  END
$$;
