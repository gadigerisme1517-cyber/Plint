-- ============================================================================
-- HOW LONG A RECORD IS KEPT, AND WHAT STOPS IT BEING DELETED ANYWAY.
--
-- Until this migration the answer to "how long do you keep it" was "for good",
-- because nothing had ever decided otherwise. That is not a policy, it is the
-- absence of one, and /data said so in as many words.
--
-- THE PERIOD IS EIGHT YEARS, and it is the longest applicable one rather than
-- the shortest, because a record destroyed on the shortest is unavailable for
-- the longest:
--
--   * Companies Act 2013, s.128(5): books of account and vouchers, eight
--     financial years preceding the current one. THIS IS THE GOVERNING ONE.
--   * Income-tax: six years from the end of the relevant assessment year for
--     ordinary reassessment; TEN where escaped income exceeds fifty lakh,
--     which on a villa at three crore is the ordinary case rather than the
--     exception. Recorded here as a note, not as the baseline: see below.
--   * CGST Act s.36: seventy-two months from the due date of the annual
--     return, which lands past six years from the invoice.
--
-- The ten-year reopening window is deliberately NOT the baseline. It is a
-- reason to place a hold when an assessment is actually open, and holds have
-- no expiry. Writing ten years into every row would be guessing that every
-- villa will be reopened; leaving the baseline at eight and holding what is
-- actually in dispute is the honest shape, and it is the shape the Act's own
-- eight years takes.
--
-- WHAT THIS MIGRATION DOES NOT DO: DELETE ANYTHING. There is no sweep here and
-- no scheduled job. The policy is data, the hold is enforced, and what acts on
-- them is a separate decision that has not been taken. What IS enforced now is
-- the half that cannot wait: a record under a legal hold cannot be deleted by
-- anybody, including the owner of the schema, because the guarantee is
-- worthless if it depends on a future sweep remembering to check.
-- ============================================================================

SET search_path = plint, public;

-- ------------------------------------------------------------- the policy
-- One row per table that holds a record. Read by /data so a buyer is told the
-- period rather than told to ask, and by anything that ever sweeps.
CREATE TABLE retention_policy (
  table_name  text PRIMARY KEY,
  keep_years  int,                    -- NULL: kept while the file is live, no clock
  category    text NOT NULL CHECK (category IN
                ('financial', 'evidentiary', 'contractual', 'correspondence',
                 'operational')),
  basis       text NOT NULL,          -- why this number, in words
  personal    boolean NOT NULL DEFAULT true
);

ALTER TABLE retention_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_policy FORCE ROW LEVEL SECURITY;
-- The policy itself is not a secret. A buyer is entitled to read how long
-- their own records are kept, which is the whole point of writing it down.
CREATE POLICY rp_read ON retention_policy FOR SELECT USING (true);
GRANT SELECT ON retention_policy TO plint_app;

INSERT INTO retention_policy (table_name, keep_years, category, basis) VALUES
  ('demands',         8, 'financial',
   'A demand is a voucher: Companies Act 2013 s.128(5), eight financial years.'),
  ('receipts',        8, 'financial',
   'Proof money was received against a voucher. Same eight years, and the '
   'GST seventy-two months from the annual return falls inside it.'),
  ('credits',         8, 'financial',
   'A correction to a demand is part of the same voucher trail.'),
  ('escrow_movements', 8, 'financial',
   'RERA escrow drawdown against the same project accounts.'),
  ('evidence',        8, 'evidentiary',
   'The photographs a lender released money against. They are the evidence '
   'behind a financial record and are kept as long as it is.'),
  ('unit_stages',     8, 'evidentiary',
   'Certification: who signed, when, and the hash of what they signed.'),
  ('audit_log',       8, 'evidentiary',
   'Who did what to the record. Append-only and never edited.'),
  ('pack_deliveries', 8, 'evidentiary',
   'What was sent to which lender and when.'),
  ('pack_queries',    8, 'evidentiary', 'A lender''s question about a pack, and the answer.'),
  ('qpr_filings',     8, 'evidentiary', 'RERA quarterly filings, against the same accounts.'),
  ('units',           8, 'contractual',
   'The villa, its price and who bought it. The subject of every voucher above.'),
  ('agreements',      8, 'contractual',
   'Sale agreement dates and the registration reference.'),
  ('choices',         8, 'contractual',
   'A signed interior choice is a variation to what was contracted.'),
  ('possessions',     8, 'contractual', 'Handover, and the twelve-month defect period after it.'),
  ('loan_applicants', 8, 'contractual', 'Who is on the loan the stage payments depend on.'),
  ('loan_documents',  8, 'contractual',
   'Which papers the office confirmed it had seen. Plint holds no paper.'),
  ('snags',           8, 'evidentiary',
   'A defect raised and the photograph of its repair. Defect liability runs '
   'twelve months from possession and a dispute can follow it.'),
  ('site_log',        8, 'evidentiary', 'What happened on site on a given day.'),
  ('blockers',        8, 'evidentiary', 'Why a stage stopped, and who was holding it.'),
  ('visits',          8, 'correspondence',
   'A site visit asked for and answered. Kept with the file it concerns.'),
  ('queries',         8, 'correspondence', 'A question asked of the office.'),
  ('query_messages',  8, 'correspondence', 'The exchange on that question.'),
  ('handoffs',        8, 'correspondence', 'The sales handoff that started the file.'),
  ('notifications',   1, 'operational',
   'A prompt to somebody at the office. It records nothing that is not '
   'recorded elsewhere.'),
  ('users',        NULL, 'operational',
   'Kept while the login is live. A login is not a record of anything; what '
   'the person did is in the audit log, which names the id and not the person.'),
  ('sessions',     NULL, 'operational',
   'Swept thirty days after expiry. A dead session is evidence of nothing.'),
  ('login_attempts', NULL, 'operational',
   'Swept a day after the window. A counter, not a record.');

-- ---------------------------------------------------------------- the hold
-- An appeal, an audit, an assessment or an investigation freezes what it
-- touches for as long as it runs, whatever the baseline says. A hold has no
-- expiry by design: it ends when somebody records that the thing it was
-- placed for has ended.
CREATE TABLE legal_holds (
  id          text PRIMARY KEY,
  scope       text NOT NULL CHECK (scope IN ('everything', 'project', 'unit')),
  scope_id    text,                       -- project id, unit id, or NULL for everything
  kind        text NOT NULL CHECK (kind IN
                ('appeal', 'audit', 'assessment', 'investigation', 'dispute')),
  reference   text,                       -- the notice, the case, the file number
  reason      text NOT NULL,
  placed_by   text NOT NULL REFERENCES users(id),
  placed_at   timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by text REFERENCES users(id),
  CHECK (scope = 'everything' OR scope_id IS NOT NULL)
);

CREATE INDEX ON legal_holds (scope, scope_id) WHERE released_at IS NULL;

ALTER TABLE legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_holds FORCE ROW LEVEL SECURITY;
-- A buyer may see that their own file is frozen and why; they should not see
-- another villa's dispute.
CREATE POLICY lh_read ON legal_holds FOR SELECT USING (
  CASE current_role_name()
    WHEN 'buyer' THEN scope = 'everything'
                   OR (scope = 'unit' AND owns_unit(scope_id))
                   OR (scope = 'project' AND EXISTS (
                         SELECT 1 FROM plint.units u
                          WHERE u.project_id = legal_holds.scope_id
                            AND u.buyer_user_id = current_user_id()))
    WHEN 'engineer' THEN true
    WHEN 'office' THEN true
    ELSE false
  END);
GRANT SELECT ON legal_holds TO plint_app;

-- Placed and released through functions, as every other privileged write is.
CREATE FUNCTION hold_place(p_scope text, p_scope_id text, p_kind text,
                           p_reference text, p_reason text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor text := plint.current_user_id();
    v_role  text := plint.current_role_name();
    v_id    text;
  BEGIN
    IF v_actor IS NULL OR v_role <> 'office' THEN
      RAISE EXCEPTION 'only the head office places a legal hold';
    END IF;
    IF coalesce(btrim(p_reason), '') = '' THEN
      RAISE EXCEPTION 'a hold is placed for a stated reason';
    END IF;
    v_id := 'hold-' || substr(md5(p_scope || coalesce(p_scope_id, '') || p_kind
                                  || clock_timestamp()::text), 1, 16);
    INSERT INTO plint.legal_holds (id, scope, scope_id, kind, reference, reason, placed_by)
    VALUES (v_id, p_scope, nullif(p_scope_id, ''), p_kind,
            nullif(btrim(p_reference), ''), btrim(p_reason), v_actor);
    INSERT INTO plint.audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (v_actor, v_role, 'hold_placed', 'legal_hold', v_id,
            jsonb_build_object('scope', p_scope, 'scope_id', p_scope_id,
                               'kind', p_kind, 'reason', btrim(p_reason)));
    RETURN v_id;
  END
$$;

CREATE FUNCTION hold_release(p_id text, p_note text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor text := plint.current_user_id();
    v_role  text := plint.current_role_name();
  BEGIN
    IF v_actor IS NULL OR v_role <> 'office' THEN
      RAISE EXCEPTION 'only the head office releases a legal hold';
    END IF;
    UPDATE plint.legal_holds SET released_at = now(), released_by = v_actor
     WHERE id = p_id AND released_at IS NULL;
    IF NOT FOUND THEN RETURN false; END IF;
    INSERT INTO plint.audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (v_actor, v_role, 'hold_released', 'legal_hold', p_id,
            jsonb_build_object('note', p_note));
    RETURN true;
  END
$$;

GRANT EXECUTE ON FUNCTION hold_place(text,text,text,text,text) TO plint_app;
GRANT EXECUTE ON FUNCTION hold_release(text,text) TO plint_app;

-- Is this villa - or its project, or everything - frozen right now?
CREATE FUNCTION on_hold(p_unit_id text, p_project_id text DEFAULT NULL)
  RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
      SELECT 1 FROM plint.legal_holds h
       WHERE h.released_at IS NULL
         AND (h.scope = 'everything'
              OR (h.scope = 'unit' AND h.scope_id = p_unit_id)
              OR (h.scope = 'project' AND h.scope_id = coalesce(
                    p_project_id, (SELECT u.project_id FROM plint.units u
                                    WHERE u.id = p_unit_id)))))
  $$;
GRANT EXECUTE ON FUNCTION on_hold(text,text) TO plint_app;

-- When the baseline expires for a table, ignoring holds. NULL where there is
-- no clock. The clock starts at the row's own date wherever it has one; this
-- returns the year count so a screen can say it in words.
CREATE FUNCTION retention_years(p_table text)
  RETURNS int LANGUAGE sql STABLE AS $$
    SELECT keep_years FROM plint.retention_policy WHERE table_name = p_table
  $$;
GRANT EXECUTE ON FUNCTION retention_years(text) TO plint_app;

-- ------------------------------------------------ a held row cannot be swept
--
-- The point of a hold is that it survives a mistake. Not a convention the
-- sweeper is asked to observe: a refusal in the database, on the delete
-- itself, that applies to the application role, to the owner, and to anybody
-- with a psql prompt. Nothing sweeps yet, so today this fires only to say no.
CREATE FUNCTION held_row_stays() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE
    v_unit    text;
    v_project text;
    v_how     text := TG_ARGV[0];
  BEGIN
    IF v_how = 'self'    THEN v_unit := OLD.id;      v_project := OLD.project_id;
    ELSIF v_how = 'unit' THEN v_unit := OLD.unit_id;
    ELSIF v_how = 'project' THEN v_project := OLD.project_id;
    ELSIF v_how = 'stage' THEN
      SELECT s.unit_id INTO v_unit FROM plint.unit_stages s WHERE s.id = OLD.unit_stage_id;
    ELSIF v_how = 'demand' THEN
      SELECT s.unit_id INTO v_unit FROM plint.unit_stages s
        JOIN plint.demands d ON d.unit_stage_id = s.id WHERE d.id = OLD.demand_id;
    ELSIF v_how = 'applicant' THEN
      SELECT a.unit_id INTO v_unit FROM plint.loan_applicants a WHERE a.id = OLD.applicant_id;
    ELSIF v_how = 'query' THEN
      SELECT q.unit_id INTO v_unit FROM plint.queries q WHERE q.id = OLD.query_id;
    END IF;

    IF plint.on_hold(v_unit, v_project) THEN
      RAISE EXCEPTION
        'this row is under a legal hold and cannot be deleted (% %)',
        TG_TABLE_NAME, coalesce(v_unit, v_project, 'everything');
    END IF;
    RETURN OLD;
  END
$$;

CREATE TRIGGER hold_units          BEFORE DELETE ON units
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('self');
CREATE TRIGGER hold_unit_stages    BEFORE DELETE ON unit_stages
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('unit');
CREATE TRIGGER hold_evidence       BEFORE DELETE ON evidence
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('stage');
CREATE TRIGGER hold_pack_deliveries BEFORE DELETE ON pack_deliveries
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('stage');
CREATE TRIGGER hold_pack_queries   BEFORE DELETE ON pack_queries
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('stage');
CREATE TRIGGER hold_blockers       BEFORE DELETE ON blockers
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('stage');
CREATE TRIGGER hold_credits        BEFORE DELETE ON credits
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('demand');
CREATE TRIGGER hold_agreements     BEFORE DELETE ON agreements
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('unit');
CREATE TRIGGER hold_choices        BEFORE DELETE ON choices
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('unit');
CREATE TRIGGER hold_possessions    BEFORE DELETE ON possessions
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('unit');
CREATE TRIGGER hold_snags          BEFORE DELETE ON snags
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('unit');
CREATE TRIGGER hold_visits         BEFORE DELETE ON visits
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('unit');
CREATE TRIGGER hold_queries        BEFORE DELETE ON queries
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('unit');
CREATE TRIGGER hold_query_messages BEFORE DELETE ON query_messages
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('query');
CREATE TRIGGER hold_loan_applicants BEFORE DELETE ON loan_applicants
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('unit');
CREATE TRIGGER hold_loan_documents BEFORE DELETE ON loan_documents
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('applicant');
CREATE TRIGGER hold_handoffs       BEFORE DELETE ON handoffs
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('unit');
CREATE TRIGGER hold_escrow         BEFORE DELETE ON escrow_movements
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('project');
CREATE TRIGGER hold_qpr            BEFORE DELETE ON qpr_filings
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('project');
CREATE TRIGGER hold_site_log       BEFORE DELETE ON site_log
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('project');
CREATE TRIGGER hold_notifications  BEFORE DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('project');

-- demands, receipts and audit_log already refuse every delete outright, from
-- migrations 004, 017 and 003. A hold cannot make "never" any stronger.
