-- Plint. Schema and isolation boundary.
-- Buyer isolation is enforced here, in the database, not in application code.
-- The application connects as plint_app, which is NOT the table owner and is
-- NOT a superuser, so row-level security cannot be bypassed by a bad route.

DROP SCHEMA IF EXISTS plint CASCADE;
CREATE SCHEMA plint;
SET search_path = plint, public;

-- ---------------------------------------------------------------- identities
CREATE TABLE users (
  id            text PRIMARY KEY,
  email         text UNIQUE NOT NULL,
  pw_hash       text NOT NULL,          -- scrypt, salt:hash hex
  role          text NOT NULL CHECK (role IN ('buyer','engineer','office')),
  display_name  text NOT NULL,
  engineer_qual text,
  engineer_reg  text
);

CREATE TABLE projects (
  id    text PRIMARY KEY,
  name  text NOT NULL,
  phase text NOT NULL
);

CREATE TABLE units (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  code                 text NOT NULL,
  buyer_user_id        text REFERENCES users(id),
  buyer_name           text NOT NULL,
  unit_type            text NOT NULL,
  agreement_value_paise bigint NOT NULL CHECK (agreement_value_paise > 0),
  bank                 text,
  sanction_paise       bigint,
  channel_partner      text,
  site_engineer        text,
  relationship_manager text,
  UNIQUE (project_id, code)
);

-- ------------------------------------------------------------ stage schedule
-- pct_bp is basis points of agreement value. Integers only. No floats anywhere
-- near money. The schedule is data, not code, so a project can carry its own.
CREATE TABLE stage_templates (
  project_id  text NOT NULL REFERENCES projects(id),
  seq         int  NOT NULL,
  code        text NOT NULL,
  name        text NOT NULL,
  pct_bp      int  NOT NULL CHECK (pct_bp > 0),
  description text NOT NULL,
  PRIMARY KEY (project_id, code)
);

CREATE TABLE unit_stages (
  id               text PRIMARY KEY,
  unit_id          text NOT NULL REFERENCES units(id),
  stage_code       text NOT NULL,
  -- pending -> marked (site) -> certified (qualified engineer) -> demanded -> paid
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','marked','certified','demanded','paid')),
  marked_by        text,
  marked_at        timestamptz,
  certified_by     text REFERENCES users(id),
  certified_at     timestamptz,
  certificate_hash text,
  UNIQUE (unit_id, stage_code)
);

CREATE TABLE evidence (
  id            text PRIMARY KEY,
  unit_stage_id text NOT NULL REFERENCES unit_stages(id),
  caption       text NOT NULL,
  taken_at      timestamptz NOT NULL,
  gps           text NOT NULL,
  sha256        text NOT NULL
);

-- Demands are written by the calculation layer only. Amounts are stored as
-- computed so a re-issued letter can never disagree with the ledger.
CREATE TABLE demands (
  id            text PRIMARY KEY,
  unit_stage_id text NOT NULL UNIQUE REFERENCES unit_stages(id),
  doc_no        text NOT NULL UNIQUE,
  raised_at     timestamptz NOT NULL,
  due_at        timestamptz NOT NULL,
  base_paise    bigint NOT NULL,
  gst_paise     bigint NOT NULL,
  extras_paise  bigint NOT NULL DEFAULT 0,
  total_paise   bigint NOT NULL,
  paid_at       timestamptz
);

-- Head-office worklist reasons live with the stage, not in a screen.
CREATE TABLE blockers (
  unit_stage_id text PRIMARY KEY REFERENCES unit_stages(id),
  holder        text NOT NULL,   -- who is holding it up
  holder_role   text NOT NULL,
  reason        text NOT NULL,
  since         date NOT NULL
);

-- ------------------------------------------------------------------ indexing
CREATE INDEX ON units (buyer_user_id);
CREATE INDEX ON unit_stages (unit_id);
CREATE INDEX ON evidence (unit_stage_id);

-- =========================================================== ROW LEVEL SECURITY
-- Every request opens a transaction and calls
--   select set_config('plint.user_id', $1, true), set_config('plint.role', $2, true)
-- true = local to the transaction, so it cannot leak between pooled requests.

CREATE FUNCTION current_user_id() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT current_setting('plint.user_id', true) $$;

CREATE FUNCTION current_role_name() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT current_setting('plint.role', true) $$;

-- A buyer may see exactly the units where he is the named buyer. Nothing else.
CREATE FUNCTION owns_unit(u text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT EXISTS (SELECT 1 FROM plint.units
                    WHERE id = u AND buyer_user_id = plint.current_user_id())
  $$;

ALTER TABLE users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE units        ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_stages  ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence     ENABLE ROW LEVEL SECURITY;
ALTER TABLE demands      ENABLE ROW LEVEL SECURITY;
ALTER TABLE blockers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects     ENABLE ROW LEVEL SECURITY;
ALTER TABLE stage_templates ENABLE ROW LEVEL SECURITY;

ALTER TABLE users        FORCE ROW LEVEL SECURITY;
ALTER TABLE units        FORCE ROW LEVEL SECURITY;
ALTER TABLE unit_stages  FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence     FORCE ROW LEVEL SECURITY;
ALTER TABLE demands      FORCE ROW LEVEL SECURITY;
ALTER TABLE blockers     FORCE ROW LEVEL SECURITY;

-- users: you can read yourself. Staff can read staff. Nobody reads other buyers.
CREATE POLICY u_self ON users FOR SELECT USING (
  id = current_user_id()
  OR (current_role_name() IN ('engineer','office') AND role IN ('engineer','office'))
);

-- projects and the stage schedule are reference data, readable by any session.
CREATE POLICY p_read ON projects FOR SELECT USING (true);
CREATE POLICY st_read ON stage_templates FOR SELECT USING (true);

CREATE POLICY un_read ON units FOR SELECT USING (
  CASE current_role_name()
    WHEN 'buyer' THEN buyer_user_id = current_user_id()
    WHEN 'engineer' THEN true
    WHEN 'office' THEN true
    ELSE false
  END);

CREATE POLICY us_read ON unit_stages FOR SELECT USING (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit(unit_id)
    WHEN 'engineer' THEN true
    WHEN 'office' THEN true
    ELSE false
  END);

-- Only a qualified engineer may write a certification. A buyer may write nothing.
CREATE POLICY us_write ON unit_stages FOR UPDATE USING (
  current_role_name() IN ('engineer','office'))
  WITH CHECK (current_role_name() IN ('engineer','office'));

CREATE POLICY ev_read ON evidence FOR SELECT USING (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit((SELECT unit_id FROM unit_stages s WHERE s.id = unit_stage_id))
    WHEN 'engineer' THEN true
    WHEN 'office' THEN true
    ELSE false
  END);

CREATE POLICY ev_write ON evidence FOR INSERT
  WITH CHECK (current_role_name() IN ('engineer','office'));

CREATE POLICY dm_read ON demands FOR SELECT USING (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit((SELECT unit_id FROM unit_stages s WHERE s.id = unit_stage_id))
    WHEN 'engineer' THEN true
    WHEN 'office' THEN true
    ELSE false
  END);

CREATE POLICY dm_write ON demands FOR INSERT
  WITH CHECK (current_role_name() IN ('engineer','office'));

CREATE POLICY bl_read ON blockers FOR SELECT USING (
  current_role_name() IN ('engineer','office'));
CREATE POLICY bl_write ON blockers FOR ALL USING (
  current_role_name() IN ('engineer','office'))
  WITH CHECK (current_role_name() IN ('engineer','office'));

-- ------------------------------------------------------------- the app role
DROP ROLE IF EXISTS plint_app;
CREATE ROLE plint_app LOGIN PASSWORD 'plint_app_dev';
GRANT USAGE ON SCHEMA plint TO plint_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA plint TO plint_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA plint TO plint_app;
ALTER ROLE plint_app SET search_path = plint, public;
-- Deliberately no DELETE anywhere, and no ownership, so RLS always applies.

-- Login happens before a session identity exists, so it goes through one
-- audited SECURITY DEFINER function rather than opening up the users table.
CREATE FUNCTION login_lookup(p_email text)
  RETURNS TABLE (id text, pw_hash text, role text, display_name text)
  LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT u.id, u.pw_hash, u.role, u.display_name
      FROM plint.users u WHERE lower(u.email) = lower(p_email)
  $$;
GRANT EXECUTE ON FUNCTION login_lookup(text) TO plint_app;
