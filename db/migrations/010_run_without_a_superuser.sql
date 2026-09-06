-- 010 run without a superuser
--
-- Every SECURITY DEFINER function here is owned by the role that owns the
-- tables, and eight of those tables carried FORCE ROW LEVEL SECURITY. FORCE
-- means the owner is bound by the policies too, so on a database where the
-- owner is not a superuser:
--
--   login_lookup returns zero rows for every credential, because there is no
--   identity yet during login and u_self grants nothing without one.
--
-- Nobody can sign in. Proven directly against a non-superuser owner before
-- this migration was written. It is invisible on a development machine where
-- the owner happens to be a superuser and bypasses RLS.
--
-- Free managed Postgres does not give you a superuser. So FORCE goes.
--
-- WHAT THIS DOES NOT GIVE UP. FORCE was never what protects a buyer from his
-- neighbour. The application connects as plint_app, which does not own these
-- tables, so ordinary row-level security binds it whether or not FORCE is set.
-- FORCE closed exactly one further case: the application connecting AS THE
-- OWNER, which would then bypass RLS entirely.
--
-- That case is now closed by assertion instead, at boot, in db/bootstrap.js:
-- the server refuses to start if its runtime role owns the tables, is a
-- superuser, or holds BYPASSRLS. A refusal to start is a better answer than a
-- flag that a platform will not let us set, because the flag was only ever
-- defence against a misconfiguration and the assertion catches the same
-- misconfiguration louder.
--
-- The seed and the migrations run as the owner and need to write past these
-- policies; that is why they are the owner. Nothing else does.

SET search_path = plint, public;

ALTER TABLE users           NO FORCE ROW LEVEL SECURITY;
ALTER TABLE units           NO FORCE ROW LEVEL SECURITY;
ALTER TABLE unit_stages     NO FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE demands         NO FORCE ROW LEVEL SECURITY;
ALTER TABLE blockers        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE credits         NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pack_deliveries NO FORCE ROW LEVEL SECURITY;

-- Row-level security itself stays ENABLED on every one of them. That is the
-- part that binds plint_app, and it is untouched.
