-- 002 sessions
--
-- Sessions were an in-process Map. Every restart signed everyone out and a
-- second instance could not authenticate a cookie the first one had issued.
--
-- What the cookie carries is a random token. What this table stores is the
-- HMAC of that token under PLINT_SECRET. The two are not interchangeable:
-- reading every row of this table does not yield a single usable cookie, and
-- rotating the secret invalidates every outstanding session at once.
--
-- The application role gets no access to this table at all. Not a policy that
-- returns nothing, no grant in the first place. Everything goes through the
-- three SECURITY DEFINER functions below, which are the only supported
-- vocabulary: open one, look one up, revoke one.

SET search_path = plint, public;

CREATE TABLE sessions (
  id            text PRIMARY KEY,          -- HMAC-SHA256 of the cookie token
  user_id       text NOT NULL REFERENCES users(id),
  role          text NOT NULL CHECK (role IN ('buyer','engineer','office')),
  display_name  text NOT NULL,
  unit_code     text,                      -- buyers land on their own villa
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);

CREATE INDEX ON sessions (expires_at);
CREATE INDEX ON sessions (user_id);

-- Enabled, but the real boundary below is the absence of a grant. RLS with no
-- policy is the second lock: were a grant ever added by mistake, the table
-- still returns nothing to the application role.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON sessions FROM plint_app;

-- ---------------------------------------------------------------- vocabulary

CREATE FUNCTION session_open(
  p_id text, p_user_id text, p_role text, p_name text, p_unit text, p_ttl interval)
  RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
    INSERT INTO plint.sessions (id, user_id, role, display_name, unit_code, expires_at)
    VALUES (p_id, p_user_id, p_role, p_name, p_unit, now() + p_ttl)
  $$;

CREATE FUNCTION session_lookup(p_id text)
  RETURNS TABLE (user_id text, role text, display_name text, unit_code text)
  LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT s.user_id, s.role, s.display_name, s.unit_code
      FROM plint.sessions s
     WHERE s.id = p_id
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
  $$;

-- Sign-out. Revocation is a write, not a delete: the row stays so that an
-- expired or revoked session is distinguishable from one that never existed.
CREATE FUNCTION session_revoke(p_id text)
  RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
    UPDATE plint.sessions SET revoked_at = now()
     WHERE id = p_id AND revoked_at IS NULL
  $$;

-- Housekeeping. Rows that are long dead carry no evidentiary value.
CREATE FUNCTION session_sweep(p_older_than interval DEFAULT '30 days')
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
    DECLARE n integer;
    BEGIN
      DELETE FROM plint.sessions
       WHERE expires_at < now() - p_older_than;
      GET DIAGNOSTICS n = ROW_COUNT;
      RETURN n;
    END
  $$;

GRANT EXECUTE ON FUNCTION session_open(text,text,text,text,text,interval) TO plint_app;
GRANT EXECUTE ON FUNCTION session_lookup(text) TO plint_app;
GRANT EXECUTE ON FUNCTION session_revoke(text) TO plint_app;
GRANT EXECUTE ON FUNCTION session_sweep(interval) TO plint_app;
