-- 012 site and office operations, as shared state
--
-- The second half of what plint-v21 draws and this repo never stored: the work
-- an engineer is actually chased for, the visits a buyer books and an engineer
-- attends, the snags raised against a unit, the daily site log, the questions
-- a buyer asks and the office answers, the files sales hands over, the queries
-- a lender raises against a pack, the escrow account, and the quarterly RERA
-- filing.
--
-- The requirement these exist to meet is that one role's action is visible to
-- another. So the shape of each table is chosen around who writes it and who
-- must see the result, not around the screen it came from.
--
-- Money is not in this file either.

SET search_path = plint, public;

-- ---------------------------------------------------- who is on which villa
-- units.site_engineer is a name in a text column, which is fine for printing
-- and useless for "show me my work" or for reassigning it. This is the link.
ALTER TABLE units ADD COLUMN assigned_engineer_id text REFERENCES users(id);
CREATE INDEX ON units (assigned_engineer_id);

-- ------------------------------------------------------------------ visits
-- A buyer asks to come to site; an engineer accepts, cannot make it, or asks
-- for it to be reassigned. Every one of those is a state both of them read.
CREATE TABLE visits (
  id            text PRIMARY KEY,
  unit_id       text NOT NULL REFERENCES units(id),
  slot_at       timestamptz NOT NULL,
  note          text NOT NULL DEFAULT '',
  requested_by  text NOT NULL REFERENCES users(id),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  engineer_id   text REFERENCES users(id),
  status        text NOT NULL DEFAULT 'requested'
                CHECK (status IN ('requested','confirmed','declined','reassign','done')),
  responded_at  timestamptz,
  response_note text,
  CONSTRAINT visits_response_whole CHECK (
    (status = 'requested' AND responded_at IS NULL) OR
    (status <> 'requested' AND responded_at IS NOT NULL))
);
CREATE INDEX ON visits (unit_id);
CREATE INDEX ON visits (engineer_id, slot_at);
CREATE INDEX ON visits (status);

-- ------------------------------------------------------------------ queries
-- One table for the buyer's questions and his warranty claims, because they
-- are the same object with a different reason for existing and the office
-- works them from one queue. `kind` keeps the two screens apart.
CREATE TABLE queries (
  id         text PRIMARY KEY,
  unit_id    text NOT NULL REFERENCES units(id),
  kind       text NOT NULL CHECK (kind IN ('query','warranty')),
  subject    text NOT NULL,
  raised_by  text NOT NULL REFERENCES users(id),
  raised_at  timestamptz NOT NULL DEFAULT now(),
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  closed_at  timestamptz,
  CONSTRAINT queries_closed_whole CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX ON queries (unit_id);
CREATE INDEX ON queries (status, raised_at);

CREATE TABLE query_messages (
  id          text PRIMARY KEY,
  query_id    text NOT NULL REFERENCES queries(id),
  author_id   text NOT NULL REFERENCES users(id),
  author_role text NOT NULL CHECK (author_role IN ('buyer','engineer','office')),
  body        text NOT NULL CHECK (btrim(body) <> ''),
  sent_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON query_messages (query_id, sent_at);

-- -------------------------------------------------------------------- snags
CREATE TABLE snags (
  id            text PRIMARY KEY,
  unit_id       text NOT NULL REFERENCES units(id),
  title         text NOT NULL CHECK (btrim(title) <> ''),
  raised_by     text NOT NULL REFERENCES users(id),
  raised_role   text NOT NULL CHECK (raised_role IN ('buyer','engineer','office')),
  raised_at     timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','fixed')),
  fixed_at      timestamptz,
  fixed_by      text REFERENCES users(id),
  -- The photograph of the fix, content-addressed like every other photograph
  -- here. A snag closed with no evidence is a claim, not a record.
  fix_sha256    text,
  CONSTRAINT snags_fixed_whole CHECK (
    (status = 'open'  AND fixed_at IS NULL AND fixed_by IS NULL AND fix_sha256 IS NULL) OR
    (status = 'fixed' AND fixed_at IS NOT NULL AND fixed_by IS NOT NULL AND fix_sha256 IS NOT NULL))
);
CREATE INDEX ON snags (unit_id);
CREATE INDEX ON snags (status, raised_at);

-- ----------------------------------------------------------------- site log
-- The daily record a site person actually keeps. Project-wide by default, with
-- an optional unit when the entry is about one villa.
CREATE TABLE site_log (
  id         text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  unit_id    text REFERENCES units(id),
  kind       text NOT NULL CHECK (kind IN ('material','labour','weather','safety','drawing','rework')),
  title      text NOT NULL CHECK (btrim(title) <> ''),
  detail     text NOT NULL DEFAULT '',
  logged_by  text NOT NULL REFERENCES users(id),
  logged_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON site_log (project_id, logged_at DESC);
CREATE INDEX ON site_log (unit_id);

-- ---------------------------------------------------------------- handoffs
-- Sales has taken a token and there is no owner on the file yet. This is the
-- office's inbox, and picking one up is what starts the journey.
CREATE TABLE handoffs (
  id            text PRIMARY KEY,
  unit_id       text NOT NULL REFERENCES units(id),
  token_paise   bigint NOT NULL CHECK (token_paise > 0),
  salesperson   text NOT NULL,
  note          text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  picked_up_at  timestamptz,
  picked_up_by  text REFERENCES users(id),
  CONSTRAINT handoffs_pickup_whole CHECK (
    (picked_up_at IS NULL) = (picked_up_by IS NULL)),
  UNIQUE (unit_id)
);
CREATE INDEX ON handoffs (picked_up_at);

-- ------------------------------------------------------------ lender queries
-- A pack went to the lender and the lender asked something back. Until it is
-- answered the disbursement is stopped, which is why it has its own screen.
CREATE TABLE pack_queries (
  id            text PRIMARY KEY,
  unit_stage_id text NOT NULL REFERENCES unit_stages(id),
  asked_at      timestamptz NOT NULL DEFAULT now(),
  question      text NOT NULL CHECK (btrim(question) <> ''),
  answered_at   timestamptz,
  answer        text,
  answered_by   text REFERENCES users(id),
  CONSTRAINT pack_queries_answer_whole CHECK (
    (answered_at IS NULL AND answer IS NULL AND answered_by IS NULL) OR
    (answered_at IS NOT NULL AND answer IS NOT NULL AND answered_by IS NOT NULL))
);
CREATE INDEX ON pack_queries (unit_stage_id);
CREATE INDEX ON pack_queries (answered_at);

-- ------------------------------------------------------------------ escrow
-- The designated account. Integer paise, like everything else that is money,
-- but this is a record of movements and not a calculation: nothing here feeds
-- a demand or a stage figure.
CREATE TABLE escrow_movements (
  id           text PRIMARY KEY,
  project_id   text NOT NULL REFERENCES projects(id),
  unit_id      text REFERENCES units(id),
  direction    text NOT NULL CHECK (direction IN ('in','out')),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  occurred_at  timestamptz NOT NULL,
  reference    text NOT NULL,
  recorded_by  text REFERENCES users(id)
);
CREATE INDEX ON escrow_movements (project_id, occurred_at DESC);

-- --------------------------------------------------------------- RERA filing
CREATE TABLE qpr_filings (
  id          text PRIMARY KEY,
  project_id  text NOT NULL REFERENCES projects(id),
  quarter     text NOT NULL,
  due_on      date NOT NULL,
  filed_at    timestamptz,
  filed_by    text REFERENCES users(id),
  reference   text,
  UNIQUE (project_id, quarter),
  CONSTRAINT qpr_filed_whole CHECK (
    (filed_at IS NULL AND filed_by IS NULL AND reference IS NULL) OR
    (filed_at IS NOT NULL AND filed_by IS NOT NULL AND reference IS NOT NULL))
);

-- ------------------------------------------------------------ notifications
CREATE TABLE notifications (
  id         text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  for_role   text NOT NULL CHECK (for_role IN ('buyer','engineer','office')),
  unit_id    text REFERENCES units(id),
  severity   text NOT NULL CHECK (severity IN ('hot','warn','ok')),
  title      text NOT NULL,
  detail     text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX ON notifications (for_role, created_at DESC);

-- ------------------------------------------------------------------- policy
ALTER TABLE visits           ENABLE ROW LEVEL SECURITY;
ALTER TABLE queries          ENABLE ROW LEVEL SECURITY;
ALTER TABLE query_messages   ENABLE ROW LEVEL SECURITY;
ALTER TABLE snags            ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoffs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE pack_queries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE escrow_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE qpr_filings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications    ENABLE ROW LEVEL SECURITY;

-- Visits: the buyer sees his own and books them; the engineer sees and answers
-- every visit, because reassignment moves them between engineers.
CREATE POLICY vi_read ON visits FOR SELECT USING (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit(unit_id)
    WHEN 'engineer' THEN true
    WHEN 'office' THEN true
    ELSE false END);
CREATE POLICY vi_insert ON visits FOR INSERT WITH CHECK (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit(unit_id) AND requested_by = current_user_id()
    WHEN 'office' THEN true
    ELSE false END);
CREATE POLICY vi_update ON visits FOR UPDATE USING (
  current_role_name() IN ('engineer','office'))
  WITH CHECK (current_role_name() IN ('engineer','office'));

-- Queries and warranty claims: raised by the buyer, worked by the office.
CREATE POLICY qr_read ON queries FOR SELECT USING (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit(unit_id)
    WHEN 'engineer' THEN true
    WHEN 'office' THEN true
    ELSE false END);
CREATE POLICY qr_insert ON queries FOR INSERT WITH CHECK (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit(unit_id) AND raised_by = current_user_id()
    WHEN 'office' THEN true
    ELSE false END);
CREATE POLICY qr_update ON queries FOR UPDATE USING (
  current_role_name() IN ('engineer','office'))
  WITH CHECK (current_role_name() IN ('engineer','office'));

CREATE POLICY qm_read ON query_messages FOR SELECT USING (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit((SELECT unit_id FROM queries q WHERE q.id = query_id))
    WHEN 'engineer' THEN true
    WHEN 'office' THEN true
    ELSE false END);
-- Whoever writes a message signs it as themselves. Not a parameter.
CREATE POLICY qm_insert ON query_messages FOR INSERT WITH CHECK (
  author_id = current_user_id()
  AND author_role = current_role_name()
  AND CASE current_role_name()
        WHEN 'buyer' THEN owns_unit((SELECT unit_id FROM queries q WHERE q.id = query_id))
        WHEN 'engineer' THEN true
        WHEN 'office' THEN true
        ELSE false END);

CREATE POLICY sn_read ON snags FOR SELECT USING (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit(unit_id)
    WHEN 'engineer' THEN true
    WHEN 'office' THEN true
    ELSE false END);
CREATE POLICY sn_insert ON snags FOR INSERT WITH CHECK (
  raised_by = current_user_id() AND raised_role = current_role_name()
  AND CASE current_role_name()
        WHEN 'buyer' THEN owns_unit(unit_id)
        WHEN 'engineer' THEN true
        WHEN 'office' THEN true
        ELSE false END);
-- Only site closes a snag, because closing it means someone went and looked.
CREATE POLICY sn_update ON snags FOR UPDATE USING (
  current_role_name() IN ('engineer','office'))
  WITH CHECK (current_role_name() IN ('engineer','office'));

-- The site log is the site's, and the office reads it. A buyer sees none of it.
CREATE POLICY sl_read ON site_log FOR SELECT USING (
  current_role_name() IN ('engineer','office'));
CREATE POLICY sl_insert ON site_log FOR INSERT WITH CHECK (
  logged_by = current_user_id() AND current_role_name() IN ('engineer','office'));

CREATE POLICY ho_read ON handoffs FOR SELECT USING (current_role_name() = 'office');
CREATE POLICY ho_write ON handoffs FOR ALL USING (current_role_name() = 'office')
  WITH CHECK (current_role_name() = 'office');

CREATE POLICY pq_read ON pack_queries FOR SELECT USING (
  current_role_name() IN ('engineer','office'));
CREATE POLICY pq_write ON pack_queries FOR ALL USING (current_role_name() = 'office')
  WITH CHECK (current_role_name() = 'office');

CREATE POLICY es_read ON escrow_movements FOR SELECT USING (current_role_name() = 'office');
CREATE POLICY es_write ON escrow_movements FOR INSERT WITH CHECK (current_role_name() = 'office');

CREATE POLICY qp_read ON qpr_filings FOR SELECT USING (
  current_role_name() IN ('engineer','office'));
CREATE POLICY qp_write ON qpr_filings FOR ALL USING (current_role_name() = 'office')
  WITH CHECK (current_role_name() = 'office');

/* Read is narrow: a notification reaches the role it is addressed to.

   Write is deliberately NOT `FOR ALL`. Policies are permissive and OR together,
   so a `FOR ALL ... USING (role IN ('engineer','office'))` alongside this one
   would add its USING clause to SELECT as well and hand every office
   notification to the site. That is exactly what the first version of this
   file did, and what `a notification reaches one role and stays there` caught.
   Anywhere a table needs both a narrow read and a broad write, the write is
   spelled out per command. */
CREATE POLICY nt_read ON notifications FOR SELECT USING (
  for_role = current_role_name()
  AND (unit_id IS NULL OR current_role_name() <> 'buyer' OR owns_unit(unit_id)));
CREATE POLICY nt_insert ON notifications FOR INSERT
  WITH CHECK (current_role_name() IN ('engineer','office'));
CREATE POLICY nt_update ON notifications FOR UPDATE
  USING (for_role = current_role_name())
  WITH CHECK (for_role = current_role_name());

-- ------------------------------------------------------------------- grants
GRANT SELECT, INSERT, UPDATE ON visits           TO plint_app;
GRANT SELECT, INSERT, UPDATE ON queries          TO plint_app;
GRANT SELECT, INSERT         ON query_messages   TO plint_app;
GRANT SELECT, INSERT, UPDATE ON snags            TO plint_app;
GRANT SELECT, INSERT         ON site_log         TO plint_app;
GRANT SELECT, INSERT, UPDATE ON handoffs         TO plint_app;
GRANT SELECT, INSERT, UPDATE ON pack_queries     TO plint_app;
GRANT SELECT, INSERT         ON escrow_movements TO plint_app;
GRANT SELECT, INSERT, UPDATE ON qpr_filings      TO plint_app;
GRANT SELECT, INSERT, UPDATE ON notifications    TO plint_app;

-- ------------------------------------------------------- reassigning a villa
-- units has no UPDATE policy, and this does not add one: the same
-- SECURITY DEFINER route as record_sanction and choose_lender.
--
-- Reassignment is the flow that has to be visible across roles: the office
-- moves a villa and the engineer's list changes on his next request.
CREATE FUNCTION assign_engineer(p_unit_id text, p_engineer_id text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor text := nullif(plint.current_user_id(), '');
    v_role  text := nullif(plint.current_role_name(), '');
    v_name  text;
    v_prev  text;
  BEGIN
    IF v_actor IS NULL OR v_role <> 'office' THEN
      RAISE EXCEPTION 'only the head office may reassign a villa';
    END IF;

    SELECT full_name INTO v_name FROM plint.users
     WHERE id = p_engineer_id AND role = 'engineer';
    IF v_name IS NULL THEN RAISE EXCEPTION 'no such engineer'; END IF;

    SELECT assigned_engineer_id INTO v_prev FROM plint.units WHERE id = p_unit_id FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;

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

GRANT EXECUTE ON FUNCTION assign_engineer(text,text) TO plint_app;
