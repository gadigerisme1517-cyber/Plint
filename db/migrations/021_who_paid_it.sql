-- ============================================================================
-- WHO PAID IT: LOAN DISBURSEMENT, TRACKED WITHOUT A SECOND SET OF FIGURES.
--
-- Plint knows what a villa was sanctioned for - `units.sanction_paise`, since
-- migration 009 - and it has never known how much of that the lender has
-- actually released. The buyer's loan screen could say "sanctioned three
-- crore" and nothing else; the office's "At the lender" screen could say a
-- pack had been sitting for eighteen days and could not say whether the money
-- against the last one had arrived.
--
-- THE OBVIOUS DESIGN IS THE WRONG ONE. A `disbursements` table with its own
-- amount would be a SECOND record of money against the same stage, and the
-- rule this schema has held since Pass 6 is that a figure exists once. Two
-- amounts against one demand disagree the first time a credit is raised.
--
-- So a disbursement is not a new kind of row. It is a receipt with a payer.
-- The amount is still the demand's, in full, read from the demand; what this
-- migration adds is WHO the money came from and, when it is a lender, which
-- one. "Disbursed so far" is then a sum over demands settled by lender-paid
-- receipts - derived, never stored, and incapable of drifting from the ledger
-- it is derived from.
--
-- WHAT IS DELIBERATELY REFUSED: a part payment. This schema settles a demand
-- once, in full, and nothing models a balance. A lender that releases less
-- than the demand is a business rule nobody has given, and inventing one here
-- would put a second idea of "paid" into the product. The function refuses it
-- and says so in words.
-- ============================================================================

SET search_path = plint, public;

ALTER TABLE receipts ADD COLUMN payer text NOT NULL DEFAULT 'buyer'
  CHECK (payer IN ('buyer', 'lender'));
ALTER TABLE receipts ADD COLUMN payer_name text;

COMMENT ON COLUMN receipts.payer IS
  'Who the money came from. A lender-paid receipt is a disbursement against '
  'the sanction; the amount is the demand''s either way, and is not held here.';

-- A lender-paid receipt names the lender. A buyer-paid one does not need to.
ALTER TABLE receipts ADD CONSTRAINT receipts_lender_named
  CHECK (payer <> 'lender' OR coalesce(btrim(payer_name), '') <> '');

-- The seeded history predates the column. Everything already recorded is
-- attributed to the lender where the villa has one and to the buyer where it
-- does not, which is what those payments were.
--
-- THE TRIGGER FROM MIGRATION 017 REFUSES THIS, and it is right to: a receipt
-- is not edited. What is happening here is not an edit to a record - no
-- reference, no date and no amount changes - it is a column being given the
-- value it would have had if it had existed when the row was written. That is
-- a schema change, and a schema change is the one thing a migration is for.
-- It is disabled for exactly these two statements, by the owner, inside the
-- migration's own transaction, and turned back on before it ends.
--
-- Said plainly, because it is worth saying: the immutability of a receipt is
-- enforced against the application and against anybody at a psql prompt who
-- has not deliberately disabled the trigger first. It is not a guarantee
-- against the owner of the schema, and nothing in Postgres can be.
ALTER TABLE receipts DISABLE TRIGGER receipts_no_update;

UPDATE receipts r SET payer = 'lender', payer_name = u.bank
  FROM demands d, unit_stages s, units u
 WHERE r.demand_id = d.id AND s.id = d.unit_stage_id AND u.id = s.unit_id
   AND u.bank IS NOT NULL;

ALTER TABLE receipts ENABLE TRIGGER receipts_no_update;

-- ------------------------------------------------------------- the function
-- The four-argument form stays, because it is what the receipts screen and
-- its tests already call, and a buyer paying their own money is the default.
DROP FUNCTION IF EXISTS receipt_issue(text, text, text, date);

CREATE FUNCTION receipt_issue(
  p_demand_id  text,
  p_mode       text,
  p_reference  text,
  p_received   date,
  p_payer      text DEFAULT 'buyer',
  p_payer_name text DEFAULT NULL
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor   text := plint.current_user_id();
    v_role    text := plint.current_role_name();
    v_code    text;
    v_bank    text;
    v_seq     int;
    v_no      text;
    v_id      text;
    v_settled boolean;
  BEGIN
    IF v_actor IS NULL OR v_actor = '' OR v_role <> 'office' THEN
      RAISE EXCEPTION 'only the head office records a payment';
    END IF;
    IF coalesce(trim(p_reference), '') = '' THEN
      RAISE EXCEPTION 'a payment is recorded against a reference, not on its own';
    END IF;
    IF p_received > current_date THEN
      RAISE EXCEPTION 'money cannot have been received on a day that has not happened';
    END IF;
    IF p_payer NOT IN ('buyer', 'lender') THEN
      RAISE EXCEPTION 'a payment comes from the buyer or from their lender';
    END IF;

    SELECT u.code, u.bank INTO v_code, v_bank
      FROM plint.demands d
      JOIN plint.unit_stages s ON s.id = d.unit_stage_id
      JOIN plint.units u ON u.id = s.unit_id
     WHERE d.id = p_demand_id;
    IF v_code IS NULL THEN RETURN NULL; END IF;

    -- A disbursement is money from the lender on that villa's file. Recording
    -- one against a villa with no lender is a mistake worth refusing rather
    -- than a fact worth storing.
    IF p_payer = 'lender' AND coalesce(btrim(coalesce(p_payer_name, v_bank)), '') = '' THEN
      RAISE EXCEPTION 'that villa has no lender on file, so nothing can be disbursed against it';
    END IF;

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

    INSERT INTO plint.receipts (id, demand_id, receipt_no, mode, reference,
                                received_on, issued_by, payer, payer_name)
    VALUES (v_id, p_demand_id, v_no, p_mode, trim(p_reference), p_received, v_actor,
            p_payer,
            CASE WHEN p_payer = 'lender'
                 THEN coalesce(nullif(btrim(p_payer_name), ''), v_bank) END);

    INSERT INTO plint.audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (v_actor, v_role, 'receipt_issued', 'receipt', v_id,
            jsonb_build_object('receipt_no', v_no, 'demand_id', p_demand_id,
                               'mode', p_mode, 'reference', trim(p_reference),
                               'received_on', p_received, 'payer', p_payer));
    RETURN v_no;
  END
$$;

GRANT EXECUTE ON FUNCTION receipt_issue(text,text,text,date,text,text) TO plint_app;

-- ------------------------------------------------------- the drawdown, read
-- Everything a screen needs to say about a villa's loan, derived from the
-- ledger and holding no figure of its own. `sanctioned` is what the lender
-- agreed; `disbursed` is the total of the demands their money has settled;
-- `left_to_draw` is the difference, and it can be negative only if somebody
-- recorded a sanction smaller than what was actually released, which is a
-- fact worth being able to see rather than one to hide.
CREATE VIEW loan_drawdown AS
  SELECT u.id                                        AS unit_id,
         u.code,
         u.bank,
         u.sanction_paise,
         u.own_contribution_paise,
         coalesce(sum(d.total_paise) FILTER
           (WHERE r.payer = 'lender'), 0)::bigint    AS disbursed_paise,
         coalesce(sum(d.total_paise) FILTER
           (WHERE r.payer = 'buyer'), 0)::bigint     AS own_paid_paise,
         count(*)   FILTER (WHERE r.payer = 'lender')::int AS releases,
         max(r.received_on) FILTER (WHERE r.payer = 'lender') AS last_release_on,
         u.sanction_paise - coalesce(sum(d.total_paise) FILTER
           (WHERE r.payer = 'lender'), 0)            AS left_to_draw_paise
    FROM plint.units u
    LEFT JOIN plint.unit_stages s ON s.unit_id = u.id
    LEFT JOIN plint.demands d ON d.unit_stage_id = s.id
    LEFT JOIN plint.receipts r ON r.demand_id = d.id
   GROUP BY u.id, u.code, u.bank, u.sanction_paise, u.own_contribution_paise;

-- A view inherits the row-level security of the tables under it when it is
-- not SECURITY DEFINER, so a buyer reading this sees their own villa and a
-- member of staff sees every one. Nothing extra to police.
ALTER VIEW loan_drawdown SET (security_invoker = true);
GRANT SELECT ON loan_drawdown TO plint_app;
