-- 005 evidence gains an actual file
--
-- Evidence was a caption, a GPS string and a sha256 of nothing: the completion
-- certificate cited photographs that did not exist as files. These columns
-- describe the bytes that are now on disk, content-addressed by the sha256 the
-- table already carried.
--
-- sha256 is deliberately NOT unique. The same photograph may legitimately be
-- evidence for two stages, and content-addressed storage already means one
-- file on disk either way. Fetching by hash therefore returns the rows the
-- asking session is allowed to see and no others - which is what makes
-- guessing a neighbour's hash useless rather than merely difficult.

SET search_path = plint, public;

ALTER TABLE evidence
  ADD COLUMN mime        text CHECK (mime IN ('image/jpeg','image/png')),
  ADD COLUMN byte_size   bigint CHECK (byte_size > 0),
  ADD COLUMN uploaded_by text REFERENCES users(id),
  ADD COLUMN uploaded_at timestamptz;

-- A row either describes a stored file completely or not at all. Half a
-- record is worse than none: it would put a broken image on a certificate.
ALTER TABLE evidence ADD CONSTRAINT evidence_file_complete CHECK (
  (mime IS NULL AND byte_size IS NULL AND uploaded_by IS NULL AND uploaded_at IS NULL)
  OR
  (mime IS NOT NULL AND byte_size IS NOT NULL AND uploaded_by IS NOT NULL AND uploaded_at IS NOT NULL)
);

CREATE INDEX ON evidence (sha256);

-- An uploader may only file evidence in their own name, the same rule the
-- audit log uses. The role test stays in the existing ev_write policy.
DROP POLICY ev_write ON evidence;
CREATE POLICY ev_write ON evidence FOR INSERT WITH CHECK (
  current_role_name() IN ('engineer','office')
  AND (uploaded_by IS NULL OR uploaded_by = current_user_id()));
