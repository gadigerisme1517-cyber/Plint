-- ============================================================================
-- A CHOICE HAS A PRICE, AND THE PRICE REACHES THE DEMAND.
--
-- The buyer's interior screen has said since it was written: "Anything you
-- choose above the allowance goes onto your next demand letter, not a separate
-- bill." Two things were missing behind that sentence.
--
--   1. AN OPTION HAD NO PRICE. `choices.options` is a text array. Black
--      granite and quartz sat in the same list at the same apparent cost, and
--      a buyer signing one had no way to know which one cost more, or how much
--      more, until a demand arrived.
--   2. NOTHING EVER REACHED A DEMAND. `demands.extras_paise` has existed since
--      the first migration and `priceStage` has charged GST on base + extras
--      since the money layer was written. Every demand this product has ever
--      raised carried extras of zero, because nothing computed one.
--
-- THE SNAPSHOT, AND WHY IT IS NOT A SECOND FIGURE. `choice_options.extra_paise`
-- is the price list: it may be edited, because a builder re-prices. The amount
-- copied onto the choice when it is SIGNED may not, because that is the price
-- the buyer agreed to and a variation to a contract is not re-priced
-- afterwards. The demand then reads the signed amount, once, and marks the
-- choice billed. Three rows, one number moving forward through them, and no
-- point at which two of them can hold different values for the same thing.
-- ============================================================================

SET search_path = plint, public;

CREATE TABLE choice_options (
  id          text PRIMARY KEY,
  choice_id   text NOT NULL REFERENCES choices(id) ON DELETE CASCADE,
  seq         int  NOT NULL,
  label       text NOT NULL,
  -- Above the allowance. Zero is the standard specification: it is included,
  -- and saying so with a zero is better than leaving it blank and letting a
  -- reader wonder.
  extra_paise bigint NOT NULL DEFAULT 0 CHECK (extra_paise >= 0),
  UNIQUE (choice_id, seq),
  UNIQUE (choice_id, label)
);
CREATE INDEX ON choice_options (choice_id, seq);

ALTER TABLE choice_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE choice_options FORCE ROW LEVEL SECURITY;

-- A buyer reads the prices on their own villa's choices. Staff read all of
-- them, because the office quotes them and the engineer builds what was
-- signed.
CREATE POLICY co_read ON choice_options FOR SELECT USING (
  CASE current_role_name()
    WHEN 'buyer' THEN owns_unit((SELECT ch.unit_id FROM plint.choices ch
                                  WHERE ch.id = choice_options.choice_id))
    WHEN 'engineer' THEN true
    WHEN 'office' THEN true
    ELSE false
  END);
GRANT SELECT ON choice_options TO plint_app;

-- Every option already offered becomes a row at zero. NOT a guessed price:
-- what a builder charges for quartz over granite is theirs to enter, and a
-- number invented here would be quoted to a buyer as though it were real.
INSERT INTO choice_options (id, choice_id, seq, label)
SELECT ch.id || '-' || (o.ord - 1), ch.id, (o.ord - 1)::int, o.label
  FROM plint.choices ch,
       LATERAL unnest(ch.options) WITH ORDINALITY AS o(label, ord);

-- ------------------------------------------------ what the buyer signed for
ALTER TABLE choices ADD COLUMN extra_paise bigint;
ALTER TABLE choices ADD COLUMN billed_demand_id text REFERENCES demands(id);

COMMENT ON COLUMN choices.extra_paise IS
  'The price of the option AS SIGNED. Null until it is signed. It is a copy on '
  'purpose: the price list may change afterwards and a signed variation may not.';
COMMENT ON COLUMN choices.billed_demand_id IS
  'The demand this extra was added to. Set once, when that demand is raised, '
  'so an extra can never be billed twice.';

-- A choice signed before this column existed is given the price of the option
-- it names, which is what it would have carried. That is zero on every row
-- until somebody prices the list, and zero is the truth: nothing above the
-- allowance has ever been billed by this product.
UPDATE choices ch
   SET extra_paise = coalesce((SELECT co.extra_paise FROM plint.choice_options co
                                WHERE co.choice_id = ch.id AND co.label = ch.selected), 0)
 WHERE ch.selected IS NOT NULL;

-- A signed choice carries the price it was signed at, and an unsigned one
-- carries none. The same shape as `choices_signed_whole`, one column along.
ALTER TABLE choices ADD CONSTRAINT choices_priced_when_signed
  CHECK ((selected IS NULL AND extra_paise IS NULL)
      OR (selected IS NOT NULL AND extra_paise IS NOT NULL));

-- And nothing may be billed that was never signed.
ALTER TABLE choices ADD CONSTRAINT choices_billed_only_when_signed
  CHECK (billed_demand_id IS NULL OR selected IS NOT NULL);

-- ------------------------------------------------------------- the signing
-- Signing is the buyer's one write here and it now has to copy a figure, so
-- it stops being a bare UPDATE from the route and becomes a function: the
-- price must come from the option the buyer actually picked, read inside the
-- same statement, and not from anything the browser posted.
CREATE FUNCTION choice_sign(p_choice_id text, p_option text)
  RETURNS TABLE (label text, selected text, extra_paise bigint)
  LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor text := plint.current_user_id();
    v_role  text := plint.current_role_name();
    v_unit  text;
    v_extra bigint;
  BEGIN
    IF v_actor IS NULL OR v_role <> 'buyer' THEN
      RAISE EXCEPTION 'an interior choice is signed by the buyer whose villa it is';
    END IF;

    SELECT ch.unit_id INTO v_unit FROM plint.choices ch WHERE ch.id = p_choice_id;
    IF v_unit IS NULL THEN RETURN; END IF;
    -- The buyer's own villa, checked here because this function runs as the
    -- owner and the policy that would have checked it is therefore not in
    -- play. This is the whole reason SECURITY DEFINER functions in this
    -- schema read the transaction's identity rather than trusting a parameter.
    IF NOT plint.owns_unit(v_unit) THEN
      RAISE EXCEPTION 'that choice is not on your villa';
    END IF;

    SELECT co.extra_paise INTO v_extra
      FROM plint.choice_options co
     WHERE co.choice_id = p_choice_id AND co.label = p_option;
    IF v_extra IS NULL THEN
      RAISE EXCEPTION 'that is not one of the options offered on this choice';
    END IF;

    RETURN QUERY
      UPDATE plint.choices ch
         SET selected = p_option, signed_at = now(), signed_by = v_actor,
             extra_paise = v_extra
       WHERE ch.id = p_choice_id AND ch.selected IS NULL
      RETURNING ch.label, ch.selected, ch.extra_paise;
  END
$$;
GRANT EXECUTE ON FUNCTION choice_sign(text,text) TO plint_app;

-- --------------------------------------------------- what a demand must add
-- The signed extras on a villa that no demand has carried yet. Certification
-- reads this, puts it in `extras_paise`, and marks the choices billed - all in
-- the transaction that raises the demand, so an extra cannot be counted twice
-- and cannot be dropped between the two statements.
CREATE FUNCTION unbilled_extras(p_unit_id text)
  RETURNS bigint LANGUAGE sql STABLE AS $$
    SELECT coalesce(sum(ch.extra_paise), 0)::bigint
      FROM plint.choices ch
     WHERE ch.unit_id = p_unit_id
       AND ch.selected IS NOT NULL
       AND ch.billed_demand_id IS NULL
  $$;
GRANT EXECUTE ON FUNCTION unbilled_extras(text) TO plint_app;

/* AND MARKING THEM BILLED, WHICH IS NOT A WRITE THE CERTIFIER MAY MAKE.

   Certification runs as the ENGINEER, and `ch_write` lets the buyer edit their
   own choices and the office edit any of them - not the site. A plain UPDATE
   from `certify()` therefore matched no rows, said nothing, and would have
   billed the same extra again on the next stage. That is the silent-subset
   defect this schema has already been bitten by twice, in its write form.

   So it goes through a function, as every other privileged write here does.
   It marks only choices that are signed and unbilled, it can only ever attach
   them to a demand that exists, and it returns how many it marked so the
   caller can refuse to continue if the number is not the one it priced. */
CREATE FUNCTION extras_billed(p_unit_id text, p_demand_id text)
  RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_role text := plint.current_role_name();
    n int;
  BEGIN
    IF v_role NOT IN ('engineer', 'office') THEN
      RAISE EXCEPTION 'only the certifier or the office bills an interior extra';
    END IF;
    UPDATE plint.choices
       SET billed_demand_id = p_demand_id
     WHERE unit_id = p_unit_id AND selected IS NOT NULL AND billed_demand_id IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
  END
$$;
GRANT EXECUTE ON FUNCTION extras_billed(text,text) TO plint_app;

-- The office prices the list. Not the buyer, and not the site.
CREATE FUNCTION choice_option_price(p_option_id text, p_extra_paise bigint)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor text := plint.current_user_id();
    v_role  text := plint.current_role_name();
    v_signed timestamptz;
  BEGIN
    IF v_actor IS NULL OR v_role <> 'office' THEN
      RAISE EXCEPTION 'only the head office prices an interior option';
    END IF;
    IF p_extra_paise < 0 THEN
      RAISE EXCEPTION 'an extra is not a discount';
    END IF;
    -- A signed choice is a variation somebody agreed to at a price. Re-pricing
    -- its options afterwards would not change the signed amount - the copy on
    -- the choice is what bills - but it would put a different number in front
    -- of the buyer than the one on their file, so it is refused.
    SELECT ch.signed_at INTO v_signed
      FROM plint.choices ch
      JOIN plint.choice_options co ON co.choice_id = ch.id
     WHERE co.id = p_option_id;
    IF v_signed IS NOT NULL THEN
      RAISE EXCEPTION 'that choice is already signed; its price is what was agreed';
    END IF;

    UPDATE plint.choice_options SET extra_paise = p_extra_paise WHERE id = p_option_id;
    IF NOT FOUND THEN RETURN false; END IF;

    INSERT INTO plint.audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (v_actor, v_role, 'option_priced', 'choice_option', p_option_id,
            jsonb_build_object('extra_paise', p_extra_paise));
    RETURN true;
  END
$$;
GRANT EXECUTE ON FUNCTION choice_option_price(text,bigint) TO plint_app;
GRANT UPDATE ON choices TO plint_app;
