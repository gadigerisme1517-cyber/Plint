-- ============================================================================
-- THE PLANS AND THE APPROVALS.
--
-- Named absent in three audits and never built. A buyer on this product could
-- see every photograph of their villa going up and could not see the approved
-- plan it was being built to, the floor plan of their own unit type, or the
-- project's RERA registration - the three documents a buyer actually asks a
-- builder for, and the three a builder is required to publish.
--
-- WHAT PLINT HOLDS AND WHAT IT DOES NOT. A RERA registration is a number on a
-- public register: what belongs here is the number and where to read it, not a
-- copy of somebody else's certificate. A floor plan is a drawing, and a buyer
-- wants to look at it rather than follow a link to it, so a floor plan may be
-- uploaded and is stored the way every other file in this product is stored -
-- content-addressed, hashed, and served through the asking session. Both are
-- allowed on one row: a reference, a link, a file, or any two of them.
--
-- NONE OF THIS IS PERSONAL DATA. A plan is the same for every buyer of that
-- unit type and a registration is the same for the whole project, so the read
-- policy is `true` and the DPDP inventory does not grow by a row. That is why
-- it is a separate table from `evidence`, which is one villa's own record.
-- ============================================================================

SET search_path = plint, public;

CREATE TABLE project_documents (
  id           text PRIMARY KEY,
  project_id   text NOT NULL REFERENCES projects(id),
  -- Null means the whole project. A floor plan names the unit type it is of,
  -- which is how a buyer is shown theirs and not somebody else's.
  unit_type    text,
  kind         text NOT NULL CHECK (kind IN
                 ('rera_certificate', 'approved_plan', 'floor_plan',
                  'specification', 'commencement', 'occupancy', 'other')),
  label        text NOT NULL,
  reference    text,             -- the registration or approval number
  url          text,             -- where the authority publishes it
  sha256       text,             -- a drawing uploaded here, content-addressed
  mime         text,
  byte_size    bigint,
  issued_on    date,
  added_by     text NOT NULL REFERENCES users(id),
  added_at     timestamptz NOT NULL DEFAULT now(),
  -- A revision does not overwrite: the old row stays and says when it stopped
  -- being current. A villa built to revision B is evidence about revision B.
  superseded_at timestamptz,
  superseded_by text REFERENCES project_documents(id),
  CHECK (coalesce(reference, url, sha256) IS NOT NULL)
);

CREATE INDEX ON project_documents (project_id, kind) WHERE superseded_at IS NULL;
CREATE INDEX ON project_documents (sha256);

ALTER TABLE project_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_documents FORCE ROW LEVEL SECURITY;

-- Everybody. A plan and an approval are published documents: a buyer is
-- entitled to them, the engineer builds to them, and the office keeps them.
CREATE POLICY pdoc_read ON project_documents FOR SELECT USING (true);
GRANT SELECT ON project_documents TO plint_app;

-- ----------------------------------------------------------------- writing
CREATE FUNCTION project_document_add(
  p_project text, p_kind text, p_label text, p_unit_type text,
  p_reference text, p_url text, p_sha256 text, p_mime text, p_bytes bigint,
  p_issued date DEFAULT NULL)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor text := plint.current_user_id();
    v_role  text := plint.current_role_name();
    v_id    text;
  BEGIN
    IF v_actor IS NULL OR v_role <> 'office' THEN
      RAISE EXCEPTION 'only the head office records a plan or an approval';
    END IF;
    IF coalesce(btrim(p_label), '') = '' THEN
      RAISE EXCEPTION 'a document needs a name somebody would recognise it by';
    END IF;
    IF coalesce(nullif(btrim(p_reference), ''), nullif(btrim(p_url), ''), p_sha256) IS NULL THEN
      RAISE EXCEPTION 'a reference, a link or a file - one of the three, at least';
    END IF;
    IF p_issued IS NOT NULL AND p_issued > current_date THEN
      RAISE EXCEPTION 'a document cannot have been issued on a day that has not happened';
    END IF;

    v_id := 'pd-' || substr(md5(p_project || p_kind || p_label
                                || clock_timestamp()::text), 1, 16);
    INSERT INTO plint.project_documents
      (id, project_id, unit_type, kind, label, reference, url, sha256, mime,
       byte_size, issued_on, added_by)
    VALUES (v_id, p_project, nullif(btrim(p_unit_type), ''), p_kind, btrim(p_label),
            nullif(btrim(p_reference), ''), nullif(btrim(p_url), ''), p_sha256,
            p_mime, p_bytes, p_issued, v_actor);

    INSERT INTO plint.audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (v_actor, v_role, 'document_added', 'project_document', v_id,
            jsonb_build_object('project', p_project, 'kind', p_kind,
                               'label', btrim(p_label), 'reference', p_reference));
    RETURN v_id;
  END
$$;
GRANT EXECUTE ON FUNCTION project_document_add(text,text,text,text,text,text,text,text,bigint,date)
  TO plint_app;

-- A revision supersedes rather than replaces. The superseded row stays
-- readable, because a stage certified last March was built to what was current
-- last March and the evidence pack has to be able to say so.
CREATE FUNCTION project_document_supersede(p_old text, p_new text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor text := plint.current_user_id();
    v_role  text := plint.current_role_name();
  BEGIN
    IF v_actor IS NULL OR v_role <> 'office' THEN
      RAISE EXCEPTION 'only the head office supersedes a document';
    END IF;
    UPDATE plint.project_documents
       SET superseded_at = now(), superseded_by = p_new
     WHERE id = p_old AND superseded_at IS NULL;
    IF NOT FOUND THEN RETURN false; END IF;
    INSERT INTO plint.audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (v_actor, v_role, 'document_superseded', 'project_document', p_old,
            jsonb_build_object('by', p_new));
    RETURN true;
  END
$$;
GRANT EXECUTE ON FUNCTION project_document_supersede(text,text) TO plint_app;

-- The seeded project's own registration, which `projects.builder_ref` has
-- carried since onboarding and which nothing has ever shown to a buyer.
INSERT INTO project_documents (id, project_id, kind, label, reference, url, added_by)
SELECT 'pd-rera-' || p.id, p.id, 'rera_certificate',
       'RERA registration, ' || p.name,
       p.builder_ref, 'https://rera.karnataka.gov.in/projectViewDetails',
       (SELECT u.id FROM plint.users u WHERE u.role = 'office' ORDER BY u.id LIMIT 1)
  FROM plint.projects p
 WHERE p.builder_ref IS NOT NULL
   AND EXISTS (SELECT 1 FROM plint.users u WHERE u.role = 'office');
