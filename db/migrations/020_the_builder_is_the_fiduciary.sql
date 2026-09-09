-- ============================================================================
-- WHO IS WHO UNDER THE DPDP ACT, WRITTEN DOWN IN THE PRODUCT.
--
-- The builder decides why a buyer's data is collected and what is done with
-- it. That makes the builder the DATA FIDUCIARY. Plint holds and processes it
-- on their instruction and for no purpose of its own, which makes Plint a DATA
-- PROCESSOR. Everything follows from that one fact and almost none of it was
-- anywhere in the product:
--
--   * the notice a buyer is entitled to is the BUILDER'S notice, not Plint's
--   * the Grievance Officer is the builder's officer, named by the builder,
--     per project - a buyer on Prestige Lakeview must not be sent to NVT
--   * a processor may not add a sub-processor without the fiduciary's prior
--     authorisation, so the list of them has to exist somewhere the builder
--     can be shown it and it has to be dated
--   * on a breach the processor's duty is to tell the fiduciary at once, so
--     the fiduciary can meet the Board's own timeline. That needs somewhere
--     to record that it was done, and when.
--
-- WHAT IS DELIBERATELY NOT HERE: what may be erased and when, what a buyer may
-- withdraw while a contract is running, and the breach process itself. Those
-- are the builder's decisions and a schema that guessed at them would be
-- worse than a schema that is silent.
-- ============================================================================

SET search_path = plint, public;

-- ------------------------------------------------- the fiduciary's own desk
ALTER TABLE projects ADD COLUMN grievance_name  text;
ALTER TABLE projects ADD COLUMN grievance_email text;
ALTER TABLE projects ADD COLUMN grievance_phone text;
ALTER TABLE projects ADD COLUMN notice_url      text;

COMMENT ON COLUMN projects.grievance_name IS
  'The builder''s Grievance Officer for this project. Theirs, not Plint''s: '
  'Plint is the processor and has no standing to answer a data grievance '
  'about a buyer it holds data for on somebody else''s instruction.';

CREATE FUNCTION project_grievance_set(
  p_project text, p_name text, p_email text, p_phone text, p_notice text DEFAULT NULL)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor text := plint.current_user_id();
    v_role  text := plint.current_role_name();
  BEGIN
    IF v_actor IS NULL OR v_role <> 'office' THEN
      RAISE EXCEPTION 'only the head office records the grievance contact';
    END IF;
    IF coalesce(btrim(p_name), '') = '' OR coalesce(btrim(p_email), '') = '' THEN
      RAISE EXCEPTION 'a grievance contact is a named person and a way to reach them';
    END IF;
    IF position('@' in p_email) = 0 THEN
      RAISE EXCEPTION 'that is not an email address';
    END IF;
    UPDATE plint.projects
       SET grievance_name = btrim(p_name), grievance_email = btrim(p_email),
           grievance_phone = nullif(btrim(p_phone), ''),
           notice_url = nullif(btrim(p_notice), '')
     WHERE id = p_project;
    IF NOT FOUND THEN RETURN false; END IF;
    INSERT INTO plint.audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (v_actor, v_role, 'grievance_contact_set', 'project', p_project,
            jsonb_build_object('name', btrim(p_name), 'email', btrim(p_email)));
    RETURN true;
  END
$$;
GRANT EXECUTE ON FUNCTION project_grievance_set(text,text,text,text,text) TO plint_app;

-- --------------------------------------------------------- the sub-processors
-- Everyone Plint hands a buyer's data to in order to run the service. The
-- contract requires the builder's prior authorisation before this list
-- changes, and an authorisation is meaningless unless what was authorised is
-- written down and dated. Insert-only from the application's point of view.
CREATE TABLE sub_processors (
  id        text PRIMARY KEY,
  name      text NOT NULL,
  purpose   text NOT NULL,     -- what it does for Plint
  holds     text NOT NULL,     -- what personal data it therefore holds
  region    text NOT NULL,     -- where, physically
  since     date NOT NULL,
  until     date,              -- set when one is retired; the row stays
  authorised_note text         -- how the builder's authorisation was recorded
);

ALTER TABLE sub_processors ENABLE ROW LEVEL SECURITY;
ALTER TABLE sub_processors FORCE ROW LEVEL SECURITY;
-- A buyer is entitled to know who holds their data. There is nothing here
-- that is not true of every buyer on every project.
CREATE POLICY sp_read ON sub_processors FOR SELECT USING (true);
GRANT SELECT ON sub_processors TO plint_app;

INSERT INTO sub_processors (id, name, purpose, holds, region, since, authorised_note) VALUES
  ('supabase', 'Supabase',
   'The managed Postgres database Plint runs on.',
   'Every row in this schema: the buyer''s name, villa, price, demands, '
   'receipts, questions and the hashes of their password and their '
   'photographs.',
   'Singapore (ap-southeast-1)', DATE '2026-01-01',
   'Recorded here as the list in force. The builder''s authorisation is a '
   'contract term and is not held in this database.'),
  ('render', 'Render',
   'The container the application itself runs in, and the disk the evidence '
   'photographs are written to.',
   'Every request a signed-in person makes, the session cookie''s HMAC, and '
   'the photograph files.',
   'Singapore', DATE '2026-01-01',
   'Recorded here as the list in force. The builder''s authorisation is a '
   'contract term and is not held in this database.'),
  ('google-fonts', 'Google Fonts',
   'Two typefaces, requested by the browser when a page is opened.',
   'No personal data is sent by Plint. The browser''s own request carries its '
   'IP address to Google, as it would for any web font.',
   'Global CDN', DATE '2026-01-01',
   'Named for completeness: it receives no data from Plint and holds no row.');

-- --------------------------------------------------------------- the breach
-- The processor's duty is to tell the fiduciary at once. This is where the
-- fact that it was done lives, with the time it was detected and the time the
-- builder was told, because the gap between those two is the thing anybody
-- will ask about afterwards.
--
-- WHAT THIS IS NOT: the process. Who at the builder is called, in what form,
-- within how long, and what the builder then files with the Board are the
-- builder's decisions and are not in this schema.
CREATE TABLE breach_notices (
  id            text PRIMARY KEY,
  project_id    text REFERENCES projects(id),   -- NULL where it touches every project
  detected_at   timestamptz NOT NULL,
  told_at       timestamptz NOT NULL DEFAULT now(),
  told_whom     text NOT NULL,                  -- the builder's contact, as at that moment
  what_happened text NOT NULL,
  what_data     text NOT NULL,
  recorded_by   text NOT NULL REFERENCES users(id)
);

ALTER TABLE breach_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE breach_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY bn_read ON breach_notices FOR SELECT USING (
  current_role_name() = 'office');
GRANT SELECT ON breach_notices TO plint_app;

CREATE FUNCTION breach_record(p_project text, p_detected timestamptz,
                              p_what text, p_data text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor text := plint.current_user_id();
    v_role  text := plint.current_role_name();
    v_whom  text;
    v_id    text;
  BEGIN
    IF v_actor IS NULL OR v_role <> 'office' THEN
      RAISE EXCEPTION 'only the head office records a breach notification';
    END IF;
    IF coalesce(btrim(p_what), '') = '' OR coalesce(btrim(p_data), '') = '' THEN
      RAISE EXCEPTION 'a breach notice says what happened and what data it touched';
    END IF;
    SELECT coalesce(grievance_name || ' <' || grievance_email || '>',
                    builder_name, 'the builder')
      INTO v_whom FROM plint.projects WHERE id = p_project;
    v_id := 'breach-' || substr(md5(p_what || clock_timestamp()::text), 1, 16);
    INSERT INTO plint.breach_notices (id, project_id, detected_at, told_whom,
                                      what_happened, what_data, recorded_by)
    VALUES (v_id, p_project, p_detected, coalesce(v_whom, 'the builder'),
            btrim(p_what), btrim(p_data), v_actor);
    INSERT INTO plint.audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (v_actor, v_role, 'breach_notified', 'project', coalesce(p_project, 'all'),
            jsonb_build_object('detected_at', p_detected, 'told_whom', v_whom));
    RETURN v_id;
  END
$$;
GRANT EXECUTE ON FUNCTION breach_record(text,timestamptz,text,text) TO plint_app;

-- The seeded project's builder, so the demo shows a real contact rather than
-- an empty one. A project created through /office/setup captures it on the
-- form; this is the one that predates the form.
UPDATE projects
   SET grievance_name = 'K. Sridhar',
       grievance_email = 'grievance@nvtlifestyle.in',
       grievance_phone = '+91 80 4123 7788'
 WHERE id = 'eterna-p1' AND grievance_name IS NULL;
