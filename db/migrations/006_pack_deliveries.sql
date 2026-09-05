-- 006 pack deliveries
--
-- Certification used to tell the buyer the evidence pack "has gone to the
-- lender". Nothing sent it. There was no queue, no record and no lender.
--
-- This table is the record. One row per certification, created in the same
-- transaction as the demand, in state 'queued'. It carries the attempt count
-- and the lender's response so that a sender, when one exists, has somewhere
-- to write.
--
-- There is deliberately NO sender in this deliverable. A worker that pretended
-- to deliver would be the same lie in a more expensive form. Rows stay queued,
-- the copy now says queued, and both are true. Wiring a real channel means
-- moving rows out of 'queued' and nothing else.

SET search_path = plint, public;

CREATE TABLE pack_deliveries (
  id            text PRIMARY KEY,
  unit_stage_id text NOT NULL UNIQUE REFERENCES unit_stages(id),
  lender        text,                   -- null when the villa is self funded
  state         text NOT NULL DEFAULT 'queued'
                CHECK (state IN ('queued','sending','delivered','failed','not_applicable')),
  attempts      int  NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  response      text,                   -- whatever the lender said back
  queued_at     timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz
);

CREATE INDEX ON pack_deliveries (state);
CREATE INDEX ON pack_deliveries (lender);

ALTER TABLE pack_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE pack_deliveries FORCE ROW LEVEL SECURITY;

-- A buyer may see the state of his own villa's pack: it is the answer to
-- "where is my money", which is the whole product. Same ownership test as
-- every other buyer-visible table.
CREATE POLICY pd_read ON pack_deliveries FOR SELECT USING (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit((SELECT s.unit_id FROM plint.unit_stages s
                                  WHERE s.id = unit_stage_id))
    WHEN 'engineer' THEN true
    WHEN 'office' THEN true
    ELSE false
  END);

CREATE POLICY pd_write ON pack_deliveries FOR INSERT WITH CHECK (
  current_role_name() IN ('engineer','office'));

-- A sender updates state, attempts and the response. It may not rewrite which
-- stage the pack belongs to, nor when it was queued.
CREATE POLICY pd_update ON pack_deliveries FOR UPDATE USING (
  current_role_name() IN ('engineer','office'))
  WITH CHECK (current_role_name() IN ('engineer','office'));

GRANT SELECT, INSERT, UPDATE ON pack_deliveries TO plint_app;

CREATE FUNCTION pack_deliveries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.unit_stage_id IS DISTINCT FROM OLD.unit_stage_id
    OR NEW.queued_at     IS DISTINCT FROM OLD.queued_at
    OR NEW.id            IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'a queued pack cannot be re-pointed at another stage';
    END IF;
    RETURN NEW;
  END
$$;

CREATE TRIGGER pack_deliveries_immutable BEFORE UPDATE ON pack_deliveries
  FOR EACH ROW EXECUTE FUNCTION pack_deliveries_immutable();
