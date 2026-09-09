-- ============================================================================
-- RECEIPTS.
--
-- Plint could raise a demand and it could mark one settled - `demand_settle`,
-- from migration 004 - but nothing in the product ever called that from a
-- screen, and a buyer who paid had no document saying so. The money went out
-- of their account and the only acknowledgement was a row turning green.
--
-- THE ONE RULE THIS TABLE IS BUILT TO: IT HOLDS NO MONEY.
--
-- A receipt is not a second record of an amount. It carries the reference the
-- bank gave, how it was paid, the day the money was received and who recorded
-- it - and nothing else. Every figure a receipt shows is read from the demand
-- it points at, which is immutable from the moment it is issued. So a receipt
-- and a demand CANNOT disagree: there is no second number to drift.
--
-- That is deliberate and it is the whole design. A `receipts.amount_paise`
-- would have been easier to render and would have been wrong within one
-- correction: a credit raised against the demand would move one figure and
-- not the other, and the two documents in the buyer's file would say
-- different things about the same payment.
--
-- WHY ONE RECEIPT PER DEMAND. This schema settles a demand once, in full -
-- `demands.paid_at` is a single timestamp and the trigger refuses a second
-- settlement. Part payment is not modelled anywhere in Plint, and inventing
-- it here, in the receipt, would put a second and contradictory idea of what
-- "paid" means into the product. If part payment is ever wanted it belongs in
-- the demand and everything else follows from there.
-- ============================================================================

SET search_path = plint, public;

CREATE TABLE receipts (
  id            text PRIMARY KEY,
  demand_id     text NOT NULL UNIQUE REFERENCES demands(id),
  receipt_no    text NOT NULL UNIQUE,
  mode          text NOT NULL CHECK (mode IN ('neft','rtgs','imps','upi','cheque','draft','cash')),
  reference     text NOT NULL,           -- the bank's, the cheque's, the UPI id
  received_on   date NOT NULL,
  issued_by     text NOT NULL REFERENCES users(id),
  issued_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON receipts (demand_id);

-- A receipt is a record like a demand is. It is not edited and it is not
-- deleted; a payment recorded in error is corrected by a credit against the
-- demand, which is the mechanism this schema already has.
CREATE FUNCTION receipts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'a receipt is not edited or deleted; correct the demand with a credit'; END
$$;
CREATE TRIGGER receipts_no_update BEFORE UPDATE ON receipts
  FOR EACH ROW EXECUTE FUNCTION receipts_immutable();
CREATE TRIGGER receipts_no_delete BEFORE DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION receipts_immutable();

ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts FORCE ROW LEVEL SECURITY;

-- The same ownership test every buyer-visible table uses: a buyer sees the
-- receipts against their own villa's demands and nobody else's.
CREATE POLICY rc_read ON receipts FOR SELECT USING (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit((SELECT s.unit_id FROM plint.unit_stages s
                                  JOIN plint.demands d ON d.unit_stage_id = s.id
                                 WHERE d.id = demand_id))
    WHEN 'engineer' THEN true
    WHEN 'office' THEN true
    ELSE false
  END);

-- No INSERT policy and no INSERT grant. A receipt is written by the function
-- below and by nothing else, which is how every privileged write in this
-- schema works.
GRANT SELECT ON receipts TO plint_app;

-- ------------------------------------------------------- recording a payment
-- Settling the demand and issuing the receipt are ONE act, in one
-- transaction. They were never going to be allowed to happen separately: a
-- settled demand with no receipt is a buyer who cannot prove they paid, and a
-- receipt against an unsettled demand is a document for money the ledger says
-- is still owed.
--
-- It does not settle the demand itself. It calls `demand_settle`, which is
-- the only path in this schema that may, and which writes its own audit row
-- with the figures as at that moment.
CREATE FUNCTION receipt_issue(
  p_demand_id  text,
  p_mode       text,
  p_reference  text,
  p_received   date
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor   text := plint.current_user_id();
    v_role    text := plint.current_role_name();
    v_code    text;
    v_seq     int;
    v_no      text;
    v_id      text;
    v_settled boolean;
  BEGIN
    -- The head office receives money. Not the engineer, who is on a site, and
    -- not the buyer, who would be recording their own payment.
    IF v_actor IS NULL OR v_actor = '' OR v_role <> 'office' THEN
      RAISE EXCEPTION 'only the head office records a payment';
    END IF;
    IF coalesce(trim(p_reference), '') = '' THEN
      RAISE EXCEPTION 'a payment is recorded against a reference, not on its own';
    END IF;
    IF p_received > current_date THEN
      RAISE EXCEPTION 'money cannot have been received on a day that has not happened';
    END IF;

    SELECT u.code INTO v_code
      FROM plint.demands d
      JOIN plint.unit_stages s ON s.id = d.unit_stage_id
      JOIN plint.units u ON u.id = s.unit_id
     WHERE d.id = p_demand_id;
    IF v_code IS NULL THEN RETURN NULL; END IF;

    -- The one transition, through the one function that owns it. False means
    -- it was already settled, and then no receipt is issued: the first one
    -- stands.
    v_settled := plint.demand_settle(p_demand_id, upper(p_mode) || ' ' || p_reference);
    IF NOT v_settled THEN RETURN NULL; END IF;

    SELECT count(*)::int + 1 INTO v_seq
      FROM plint.receipts r
      JOIN plint.demands d ON d.id = r.demand_id
      JOIN plint.unit_stages s ON s.id = d.unit_stage_id
      JOIN plint.units u ON u.id = s.unit_id
     WHERE u.code = v_code;

    v_no := 'RC/' || replace(v_code, '-', '') || '/' || lpad(v_seq::text, 2, '0');
    v_id := 'rc-' || p_demand_id;

    INSERT INTO plint.receipts (id, demand_id, receipt_no, mode, reference, received_on, issued_by)
    VALUES (v_id, p_demand_id, v_no, p_mode, trim(p_reference), p_received, v_actor);

    -- Its own audit row, beside the settlement's. The figures are NOT copied
    -- into it: the demand id is here and the demand is immutable.
    INSERT INTO plint.audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (v_actor, v_role, 'receipt_issued', 'receipt', v_id,
            jsonb_build_object('receipt_no', v_no, 'demand_id', p_demand_id,
                               'mode', p_mode, 'reference', trim(p_reference),
                               'received_on', p_received));
    RETURN v_no;
  END
$$;

GRANT EXECUTE ON FUNCTION receipt_issue(text,text,text,date) TO plint_app;
