-- 011 the buyer's journey, as shared state
--
-- plint-v21 draws ten journey steps for the buyer, of which this repo only
-- ever built two: the construction stages and the sanction record. The rest -
-- choosing a lender, the papers that lender will ask for, the agreement being
-- signed and registered, the interior choices, possession - existed only as
-- constants inside the prototype's JavaScript.
--
-- Every one of them is a fact two roles need to agree on. The buyer picks a
-- bank and the office has to see which one. The office ticks off a document
-- and the buyer has to see it is no longer outstanding. So none of it is
-- screen state; all of it is rows.
--
-- WHAT THIS DOES NOT TOUCH: the stage schedule, the demand rows, the audit
-- triggers, or any policy on units, unit_stages, demands or evidence. Money
-- is not in this file.

SET search_path = plint, public;

-- ------------------------------------------------------------------ lenders
-- Reference data. Each bank vets the project once and issues an APF code; a
-- buyer either picks from this panel or brings a bank that has none, which is
-- allowed and slower. Rates are basis points because they are compared, and a
-- float that displays as 8.40 and compares as 8.399999 is a bug waiting.
CREATE TABLE lenders (
  id               text PRIMARY KEY,
  name             text NOT NULL UNIQUE,
  apf_code         text,                      -- null = on no panel for this project
  rate_bp          int  NOT NULL CHECK (rate_bp > 0),
  turnaround_low   int  NOT NULL CHECK (turnaround_low  > 0),
  turnaround_high  int  NOT NULL CHECK (turnaround_high >= turnaround_low),
  on_panel         boolean NOT NULL DEFAULT true,
  seq              int NOT NULL
);

-- The buyer's chosen lender, kept beside the sanction rather than inside it.
-- Choosing a bank is not the same event as a sanction arriving, and conflating
-- them is how "he told us HDFC" turns into "HDFC has sanctioned".
ALTER TABLE units
  ADD COLUMN lender_id        text REFERENCES lenders(id),
  ADD COLUMN outside_lender   text,
  ADD COLUMN lender_chosen_at timestamptz,
  ADD COLUMN lender_chosen_by text REFERENCES users(id);

-- A choice is one bank or the other, never both, and never a bare timestamp.
ALTER TABLE units ADD CONSTRAINT units_lender_choice_coherent CHECK (
  (lender_id IS NULL AND outside_lender IS NULL AND lender_chosen_at IS NULL)
  OR
  (lender_chosen_at IS NOT NULL
   AND ((lender_id IS NOT NULL AND outside_lender IS NULL)
     OR (lender_id IS NULL AND outside_lender IS NOT NULL)))
);

-- ---------------------------------------------------------------- applicants
-- A loan has one or two people on it, and the papers required differ by how
-- each of them earns. v21 hardcodes a salaried main applicant and a
-- self-employed spouse; real files vary, so this is rows.
CREATE TABLE loan_applicants (
  id         text PRIMARY KEY,
  unit_id    text NOT NULL REFERENCES units(id),
  full_name  text NOT NULL,
  earns      text NOT NULL CHECK (earns IN ('salaried','self')),
  relation   text NOT NULL,
  seq        int  NOT NULL,
  UNIQUE (unit_id, seq)
);
CREATE INDEX ON loan_applicants (unit_id);

-- One row per paper the bank will ask this person for.
--
-- The buyer side stays read-only, which is the decision migration 009 recorded
-- and this does not reverse: the builder collects nothing and sends nothing.
-- What changed is that the OFFICE can now mark a paper seen, because v21's
-- "Sanction not recorded" screen counts what is still missing per person and
-- cannot do that against a constant.
CREATE TABLE loan_documents (
  id           text PRIMARY KEY,
  applicant_id text NOT NULL REFERENCES loan_applicants(id),
  doc_key      text NOT NULL,
  label        text NOT NULL,
  seq          int  NOT NULL,
  seen_at      timestamptz,
  seen_by      text REFERENCES users(id),
  UNIQUE (applicant_id, doc_key),
  CONSTRAINT loan_documents_seen_whole CHECK (
    (seen_at IS NULL AND seen_by IS NULL) OR (seen_at IS NOT NULL AND seen_by IS NOT NULL))
);
CREATE INDEX ON loan_documents (applicant_id);

-- --------------------------------------------------------------- agreement
-- Step two of the journey. Three dates, each of which either happened or did
-- not; a registration reference only exists once it is registered.
CREATE TABLE agreements (
  unit_id           text PRIMARY KEY REFERENCES units(id),
  sent_to_sign_at   timestamptz,
  signed_at         timestamptz,
  registered_at     timestamptz,
  registration_ref  text,
  updated_by        text REFERENCES users(id),
  CONSTRAINT agreements_order CHECK (
    (signed_at IS NULL OR sent_to_sign_at IS NOT NULL)
    AND (registered_at IS NULL OR signed_at IS NOT NULL)),
  CONSTRAINT agreements_ref_with_registration CHECK (
    (registered_at IS NULL) = (registration_ref IS NULL))
);

-- ----------------------------------------------------------------- choices
-- Interior selections the buyer must make by a date, because the site cannot
-- proceed past a stage without them. The office chases the ones not made.
CREATE TABLE choices (
  id         text PRIMARY KEY,
  unit_id    text NOT NULL REFERENCES units(id),
  choice_key text NOT NULL,
  label      text NOT NULL,
  detail     text NOT NULL,
  options    text[] NOT NULL CHECK (cardinality(options) > 1),
  needed_by  date NOT NULL,
  selected   text,
  signed_at  timestamptz,
  signed_by  text REFERENCES users(id),
  UNIQUE (unit_id, choice_key),
  -- A selection is signed or it is not made. An unsigned preference is not a
  -- decision the site can build against.
  CONSTRAINT choices_signed_whole CHECK (
    (selected IS NULL AND signed_at IS NULL AND signed_by IS NULL)
    OR (selected IS NOT NULL AND signed_at IS NOT NULL AND signed_by IS NOT NULL)),
  CONSTRAINT choices_selected_is_an_option CHECK (selected IS NULL OR selected = ANY (options))
);
CREATE INDEX ON choices (unit_id);

-- -------------------------------------------------------------- possession
CREATE TABLE possessions (
  unit_id          text PRIMARY KEY REFERENCES units(id),
  offered_at       timestamptz,
  snags_cleared_at timestamptz,
  handed_over_at   timestamptz,
  keys_to          text,
  updated_by       text REFERENCES users(id),
  CONSTRAINT possessions_order CHECK (handed_over_at IS NULL OR offered_at IS NOT NULL)
);

-- ------------------------------------------------------------------- policy
ALTER TABLE lenders         ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_applicants ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_documents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE agreements      ENABLE ROW LEVEL SECURITY;
ALTER TABLE choices         ENABLE ROW LEVEL SECURITY;
ALTER TABLE possessions     ENABLE ROW LEVEL SECURITY;

-- The panel is reference data, like the stage schedule.
CREATE POLICY ln_read ON lenders FOR SELECT USING (true);

-- Everything else is per unit, and a buyer reaches exactly his own.
CREATE POLICY la_read ON loan_applicants FOR SELECT USING (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit(unit_id)
    WHEN 'engineer' THEN false           -- the site has no business in a loan file
    WHEN 'office' THEN true
    ELSE false END);
CREATE POLICY la_write ON loan_applicants FOR ALL USING (current_role_name() = 'office')
  WITH CHECK (current_role_name() = 'office');

CREATE POLICY ld_read ON loan_documents FOR SELECT USING (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit((SELECT unit_id FROM loan_applicants a WHERE a.id = applicant_id))
    WHEN 'engineer' THEN false
    WHEN 'office' THEN true
    ELSE false END);
-- Only the office ticks a paper off, and only the office, because the tick
-- means "I have seen the original", which is a statement about a person.
CREATE POLICY ld_write ON loan_documents FOR UPDATE USING (current_role_name() = 'office')
  WITH CHECK (current_role_name() = 'office');
CREATE POLICY ld_insert ON loan_documents FOR INSERT
  WITH CHECK (current_role_name() = 'office');

CREATE POLICY ag_read ON agreements FOR SELECT USING (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit(unit_id)
    WHEN 'engineer' THEN true
    WHEN 'office' THEN true
    ELSE false END);
CREATE POLICY ag_write ON agreements FOR ALL USING (current_role_name() = 'office')
  WITH CHECK (current_role_name() = 'office');

-- Choices are the one thing here a buyer writes: he is the one making them.
CREATE POLICY ch_read ON choices FOR SELECT USING (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit(unit_id)
    WHEN 'engineer' THEN true            -- the site builds what was chosen
    WHEN 'office' THEN true
    ELSE false END);
CREATE POLICY ch_write ON choices FOR UPDATE USING (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit(unit_id)
    WHEN 'office' THEN true
    ELSE false END)
  WITH CHECK (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit(unit_id)
    WHEN 'office' THEN true
    ELSE false END);
CREATE POLICY ch_insert ON choices FOR INSERT WITH CHECK (current_role_name() = 'office');

CREATE POLICY po_read ON possessions FOR SELECT USING (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit(unit_id)
    WHEN 'engineer' THEN true
    WHEN 'office' THEN true
    ELSE false END);
CREATE POLICY po_write ON possessions FOR ALL USING (current_role_name() = 'office')
  WITH CHECK (current_role_name() = 'office');

-- ------------------------------------------------------------------- grants
-- No DELETE anywhere, the same as every other table in this schema.
GRANT SELECT ON lenders TO plint_app;
GRANT SELECT, INSERT, UPDATE ON loan_applicants TO plint_app;
GRANT SELECT, INSERT, UPDATE ON loan_documents  TO plint_app;
GRANT SELECT, INSERT, UPDATE ON agreements      TO plint_app;
GRANT SELECT, INSERT, UPDATE ON choices         TO plint_app;
GRANT SELECT, INSERT, UPDATE ON possessions     TO plint_app;

-- --------------------------------------------------- choosing a lender
-- units carries a SELECT policy and no UPDATE policy, exactly as record_sanction
-- found it. Same answer as 009: a SECURITY DEFINER function, actor taken from
-- the transaction identity and never from a parameter.
CREATE FUNCTION choose_lender(
  p_unit_id   text,
  p_lender_id text,
  p_outside   text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor text := nullif(plint.current_user_id(), '');
    v_role  text := nullif(plint.current_role_name(), '');
    v_name  text;
    v_found boolean;
  BEGIN
    IF v_actor IS NULL THEN
      RAISE EXCEPTION 'a lender cannot be chosen by nobody';
    END IF;
    -- The buyer chooses his own bank. The office may record it for him,
    -- because he often says it across a desk rather than in the app.
    IF v_role = 'buyer' THEN
      IF NOT plint.owns_unit(p_unit_id) THEN RETURN false; END IF;
    ELSIF v_role <> 'office' THEN
      RAISE EXCEPTION 'only the buyer or the office may choose a lender';
    END IF;

    IF (p_lender_id IS NULL) = (nullif(btrim(coalesce(p_outside,'')),'') IS NULL) THEN
      RAISE EXCEPTION 'choose exactly one of a panel lender or an outside bank';
    END IF;

    IF p_lender_id IS NOT NULL THEN
      SELECT name INTO v_name FROM plint.lenders WHERE id = p_lender_id;
      IF v_name IS NULL THEN RAISE EXCEPTION 'no such lender'; END IF;
    ELSE
      v_name := btrim(p_outside);
    END IF;

    SELECT true INTO v_found FROM plint.units
     WHERE id = p_unit_id AND sanction_recorded_at IS NULL FOR UPDATE;
    -- Once a sanction is on file the bank is settled; changing it would orphan
    -- the letter that was recorded against it.
    IF v_found IS NULL THEN RETURN false; END IF;

    UPDATE plint.units
       SET lender_id        = p_lender_id,
           outside_lender   = nullif(btrim(coalesce(p_outside,'')),''),
           lender_chosen_at = now(),
           lender_chosen_by = v_actor,
           bank             = v_name
     WHERE id = p_unit_id;

    INSERT INTO plint.audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (v_actor, v_role, 'lender_chosen', 'unit', p_unit_id,
            jsonb_build_object('lender', v_name, 'on_panel', p_lender_id IS NOT NULL));
    RETURN true;
  END
$$;

GRANT EXECUTE ON FUNCTION choose_lender(text,text,text) TO plint_app;
