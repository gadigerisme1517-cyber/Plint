-- 003 audit log
--
-- The record that answers "who signed this, and what did it say when they
-- signed it". Append-only: the application role may INSERT and SELECT and has
-- no UPDATE or DELETE grant, and there is no policy that would let it acquire
-- one. The figures are copied in as at the moment of the act, so a later rule
-- change in src/money.js cannot retrospectively alter what was signed.

SET search_path = plint, public;

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    text NOT NULL REFERENCES users(id),
  actor_role  text NOT NULL,
  action      text NOT NULL,
  target_kind text NOT NULL,       -- 'unit_stage', 'demand'
  target_id   text NOT NULL,
  figures     jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX ON audit_log (target_kind, target_id);
CREATE INDEX ON audit_log (actor_id);
CREATE INDEX ON audit_log (at);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- The worklist and the certificate are staff instruments. A buyer's evidence
-- of what was signed is the certificate PDF, which carries the same figures.
CREATE POLICY au_read ON audit_log FOR SELECT USING (
  current_role_name() IN ('engineer','office'));

-- An actor may only write rows about themselves. A staff session cannot forge
-- a row attributed to someone else.
CREATE POLICY au_write ON audit_log FOR INSERT WITH CHECK (
  actor_id = current_user_id() AND current_role_name() IN ('engineer','office'));

-- INSERT and SELECT only. No UPDATE, no DELETE, deliberately.
GRANT SELECT, INSERT ON audit_log TO plint_app;

-- A second lock, independent of grants: even the owner cannot rewrite history.
CREATE FUNCTION audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'audit_log is append-only (attempted %)', TG_OP;
  END
$$;

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_append_only();
