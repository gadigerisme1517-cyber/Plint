-- 007 login rate limiting
--
-- The login route would answer an unlimited number of guesses as fast as
-- scrypt could refuse them. scrypt is slow on purpose, which helps, but it is
-- not a limit.
--
-- In the database rather than in process, for the reason sessions are: with
-- two instances behind a balancer an in-process counter gives an attacker
-- twice the budget, and a restart hands them a fresh one. This survives both.
--
-- Two independent counters per attempt, because they answer different
-- questions: the email key stops one account being ground down, and the
-- address key stops one source working through many accounts.
--
-- Only failures accumulate. A successful sign-in clears both counters, so a
-- person who signs in ten times a day is never affected by this at all.

SET search_path = plint, public;

CREATE TABLE login_attempts (
  key           text PRIMARY KEY,          -- 'email:someone@x' or 'addr:1.2.3.4'
  attempts      int  NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  window_start  timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz
);

CREATE INDEX ON login_attempts (blocked_until);

-- Same shape as sessions: the application role gets no grant on the table, and
-- RLS with no policy is the second lock. Everything goes through the functions.
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON login_attempts FROM plint_app;

/*
 * Records one attempt against a key and says whether it may proceed.
 * Returns NULL when allowed, or the moment the block lifts when not.
 */
CREATE FUNCTION login_attempt(
  p_key text, p_limit int, p_window interval, p_block interval)
  RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE r plint.login_attempts;
  BEGIN
    INSERT INTO plint.login_attempts (key) VALUES (p_key)
      ON CONFLICT (key) DO NOTHING;

    -- Locked, so two simultaneous guesses cannot both read the same count.
    SELECT * INTO r FROM plint.login_attempts WHERE key = p_key FOR UPDATE;

    IF r.blocked_until IS NOT NULL AND r.blocked_until > now() THEN
      RETURN r.blocked_until;                       -- still serving it
    END IF;

    -- A window that has run out, or a block that has just lifted, starts over.
    IF r.window_start < now() - p_window
       OR (r.blocked_until IS NOT NULL AND r.blocked_until <= now()) THEN
      UPDATE plint.login_attempts
         SET attempts = 1, window_start = now(), blocked_until = NULL
       WHERE key = p_key;
      RETURN NULL;
    END IF;

    IF r.attempts + 1 > p_limit THEN
      UPDATE plint.login_attempts
         SET attempts = r.attempts + 1, blocked_until = now() + p_block
       WHERE key = p_key;
      RETURN now() + p_block;
    END IF;

    UPDATE plint.login_attempts SET attempts = r.attempts + 1 WHERE key = p_key;
    RETURN NULL;
  END
$$;

/* A sign-in that worked. Clears the counter, so only failures accumulate. */
CREATE FUNCTION login_cleared(p_key text)
  RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
    UPDATE plint.login_attempts
       SET attempts = 0, window_start = now(), blocked_until = NULL
     WHERE key = p_key
  $$;

/* Housekeeping. A key nobody has touched in a day carries no information. */
CREATE FUNCTION login_attempts_sweep(p_older_than interval DEFAULT '1 day')
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
    DECLARE n integer;
    BEGIN
      DELETE FROM plint.login_attempts
       WHERE window_start < now() - p_older_than
         AND (blocked_until IS NULL OR blocked_until < now());
      GET DIAGNOSTICS n = ROW_COUNT;
      RETURN n;
    END
$$;

GRANT EXECUTE ON FUNCTION login_attempt(text,int,interval,interval) TO plint_app;
GRANT EXECUTE ON FUNCTION login_cleared(text) TO plint_app;
GRANT EXECUTE ON FUNCTION login_attempts_sweep(interval) TO plint_app;
