-- ============================================================================
-- THE INVENTORY HAS TO NAME WHAT THE LAST FOUR MIGRATIONS ADDED.
--
-- Migration 019 wrote a retention period for every table that existed when it
-- was written, and nothing has written one since. Seven tables have been added
-- in the two passes after it - the hold register itself, the retention table
-- itself, the sub-processor list, the breach register, the option prices, the
-- plans, and the recorded decisions - and every one of them answers "how long
-- is this kept" with silence.
--
-- Silence is the failure this product keeps fixing. A screen that says
-- "8 years" for twenty-seven tables and nothing at all for seven more is not
-- an inventory; it is an inventory of the tables somebody remembered.
--
-- One of the 019 rows is also now WRONG rather than missing. `notifications`
-- was described as "a prompt to somebody at the office" because that is all it
-- was; it now carries what the site tells a buyer and what the office asks the
-- site, so its description has to say so.
--
-- The hold triggers get the same treatment: a legal hold that stops a villa's
-- photographs being deleted but not the floor plan it was built to, or not the
-- price the buyer signed for their kitchen counter, is a hold with a hole in
-- it. Three of the new tables hang off something a hold can name, and they get
-- the same BEFORE DELETE refusal as the twenty-one that already have one.
-- ============================================================================

SET search_path = plint, public;

-- ------------------------------------------------- one description corrected
UPDATE retention_policy
   SET basis = 'What the site tells a buyer, what the office asks the site, '
               'and what either has read. It records nothing that is not '
               'recorded elsewhere, so a year is enough - but it is read by '
               'the person it names, which the earlier description did not say.'
 WHERE table_name = 'notifications';

-- ------------------------------------------------- a sixth kind of record
--
-- 019 used NULL keep_years for one thing only: a row with no clock, swept on
-- some other basis - a dead session, a lapsed login. Four of the rows below
-- also have no clock, for the opposite reason: they are never destroyed. The
-- register of freezes, the register of decisions, the list of who held the
-- data and this table itself are the records that make the others answerable
-- afterwards, and destroying one would destroy the answer.
--
-- Sharing NULL between "no clock" and "kept forever" would make the two
-- indistinguishable, and the check that a financial or evidentiary record is
-- kept at least eight years reads a NULL as a period nobody set. So the
-- distinction is in the category, where a reader and a check can both see it.
ALTER TABLE retention_policy DROP CONSTRAINT retention_policy_category_check;
ALTER TABLE retention_policy ADD CONSTRAINT retention_policy_category_check
  CHECK (category IN ('financial', 'evidentiary', 'contractual',
                      'correspondence', 'operational', 'permanent'));

-- ----------------------------------------------------- seven tables, named
INSERT INTO retention_policy (table_name, keep_years, category, basis) VALUES
  ('project_documents', 8, 'evidentiary',
   'The plan a stage was certified against and the approval it was built '
   'under. A superseded revision is kept for the same eight years as the '
   'certification that referred to it, which is the only reason it is kept.'),
  ('choice_options',    8, 'contractual',
   'The price list a signed variation was chosen from. Kept as long as the '
   'variation, because "what did it cost at the time" is a question about '
   'the contract and not about the current price list.'),
  ('policy_decisions',  NULL, 'permanent',
   'A decision about the data itself, and what superseded it. There is no '
   'period: a record of who decided what and when is what makes the earlier '
   'decision answerable, and destroying it would destroy the answer.'),
  ('legal_holds',       NULL, 'permanent',
   'The register of freezes. A released hold is the evidence that a freeze '
   'existed between two dates, which is the whole point of keeping it.'),
  ('retention_policy',  NULL, 'permanent',
   'This table. What was kept and for how long has to stay answerable after '
   'the period it describes has run.'),
  ('sub_processors',    NULL, 'permanent',
   'Who held the data and between which dates. A retired sub-processor keeps '
   'its row for the same reason a released hold does.'),
  ('breach_notices',    8, 'evidentiary',
   'When a breach was found, when the builder was told and what was in it. '
   'Kept eight years, because the question is asked long after the incident.');

-- ------------------------------------------- a hold covers them too
--
-- `held_row_stays` resolves a row to the unit or project a hold could name.
-- `choice_options` hangs off a choice, which hangs off a unit, and there was
-- no branch for that; it gets one. `project_documents` and `breach_notices`
-- carry a project id and use the branch that already exists.
--
-- `policy_decisions` and `sub_processors` belong to no villa and no project,
-- so their trigger resolves to NULL on both and `on_hold(NULL, NULL)` is true
-- only under a hold whose scope is 'everything'. That is the right answer:
-- a dispute about one villa does not freeze the company's policy register,
-- and an investigation into the company does.
CREATE OR REPLACE FUNCTION held_row_stays() RETURNS trigger LANGUAGE plpgsql AS $$
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
    ELSIF v_how = 'choice' THEN
      SELECT c.unit_id INTO v_unit FROM plint.choices c WHERE c.id = OLD.choice_id;
    -- 'company' resolves to neither, and only a hold on everything reaches it.
    END IF;

    IF plint.on_hold(v_unit, v_project) THEN
      RAISE EXCEPTION
        'this row is under a legal hold and cannot be deleted (% %)',
        TG_TABLE_NAME, coalesce(v_unit, v_project, 'everything');
    END IF;
    RETURN OLD;
  END
$$;

CREATE TRIGGER hold_project_documents BEFORE DELETE ON project_documents
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('project');
CREATE TRIGGER hold_choice_options    BEFORE DELETE ON choice_options
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('choice');
CREATE TRIGGER hold_breach_notices    BEFORE DELETE ON breach_notices
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('project');
CREATE TRIGGER hold_policy_decisions  BEFORE DELETE ON policy_decisions
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('company');
CREATE TRIGGER hold_sub_processors    BEFORE DELETE ON sub_processors
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('company');
CREATE TRIGGER hold_legal_holds       BEFORE DELETE ON legal_holds
  FOR EACH ROW EXECUTE FUNCTION held_row_stays('company');
