-- ============================================================================
-- THE NAME OF A MEMBER OF STAFF, TO SOMEBODY WHOSE FILE THEY ARE WORKING ON.
--
-- `u_self` lets a buyer read exactly one row of `users`: their own. That is
-- right - the table holds password hashes and every other buyer's address -
-- and it has a consequence nobody had looked at.
--
-- The buyer's visit screen reads
--     SELECT v.*, w.display_name engineer_name
--       FROM visits v LEFT JOIN users w ON w.id = v.engineer_id
-- and the outer join does its job: the visit row survives. The NAME does not.
-- `engineer_name` came back NULL on every visit, for every buyer, since the
-- screen was written, and the markup says `v.engineer_name ? ... : ''` - so it
-- printed nothing at all. A screen whose own sentence is "You are shown round
-- by the engineer who signs your certificates" never once said which engineer.
--
-- That is the snag bug in its other form. The snag bug lost ROWS to an inner
-- join. This lost a FIELD to an outer one, which is worse, because the outer
-- join is the thing you reach for to be safe and it hides the loss completely.
--
-- THE FIX IS NOT A WIDER POLICY. Opening `users` to buyers would hand out
-- email addresses and hashes to solve a display problem. This function returns
-- one column, for staff rows only, and nothing else - not the email, not the
-- hash, not a buyer's row. A buyer may learn the name of the engineer coming
-- to their villa and the name of the person at the office replying to them,
-- which is what those two screens exist to say.
-- ============================================================================

SET search_path = plint, public;

CREATE FUNCTION staff_name(p_user_id text)
  RETURNS text LANGUAGE sql SECURITY DEFINER STABLE AS $$
    SELECT u.display_name FROM plint.users u
     WHERE u.id = p_user_id AND u.role IN ('engineer', 'office')
  $$;

COMMENT ON FUNCTION staff_name(text) IS
  'The display name of a member of staff, to anybody. Returns NULL for a '
  'buyer''s id, so it cannot be used to enumerate buyers. It is the only '
  'reason any screen needs to read a users row it does not own.';

REVOKE ALL ON FUNCTION staff_name(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_name(text) TO plint_app;
