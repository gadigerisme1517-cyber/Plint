-- ============================================================================
-- THREE DECISIONS THAT ARE NOT THE CODE'S TO MAKE.
--
-- Pass 7 named them and left them: what may be erased and when, what a buyer
-- may withdraw while a contract is running, and what the breach process is.
-- Each needs an answer from the builder, and a schema that guessed would be
-- worse than a schema that is silent.
--
-- But "left" has meant "absent", and absent is indistinguishable on screen
-- from "nobody has thought about it". So this migration builds the same shape
-- `legal_holds` already has - a placer, a time and a reason - for a POLICY
-- rather than for a freeze, and leaves every value unset.
--
-- WHAT THIS DELIBERATELY DOES NOT DO: default anything. There is no fallback
-- value, no "assume 8 years", no "assume withdrawal is allowed". `policy_of()`
-- returns NULL until somebody records a decision, and every screen that asks
-- says "not decided" and names who has to decide it. An unanswered question
-- that says so is worth more than an answer nobody chose.
--
-- WHY A ROW AND NOT A SETTING. A setting is a value. A decision is a value,
-- the person who took it, the day they took it, and the reason - and a later
-- decision does not erase the earlier one, it supersedes it, so the question
-- "what was our policy in March" stays answerable. That is exactly the shape
-- of a legal hold, and for exactly the same reason.
-- ============================================================================

SET search_path = plint, public;

CREATE TABLE policy_decisions (
  id          text PRIMARY KEY,
  -- The three from Pass 7, and nothing else: this is not a settings table.
  topic       text NOT NULL CHECK (topic IN
                ('erasure', 'withdrawal', 'breach_process')),
  -- Free text on purpose. The answer to "what may be erased and when" is a
  -- sentence, not an enum somebody has to squeeze it into, and an enum here
  -- would be this file deciding the shape of the answer.
  decision    text NOT NULL CHECK (btrim(decision) <> ''),
  reason      text NOT NULL CHECK (btrim(reason) <> ''),
  -- Optional, and only where the decision genuinely has one.
  effective_from date,
  decided_by  text NOT NULL REFERENCES users(id),
  decided_at  timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  /* DEFERRED, because the old row has to step down before the new one can be
     inserted - `policy_decisions_one_live` allows exactly one live row per
     topic - and at that moment the row it points forward to does not exist
     yet. Both statements are in one transaction and the reference is true by
     the time it ends, which is what deferring checks at commit means. */
  superseded_by text REFERENCES policy_decisions(id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX policy_decisions_one_live ON policy_decisions (topic)
  WHERE superseded_at IS NULL;

ALTER TABLE policy_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_decisions FORCE ROW LEVEL SECURITY;

-- A buyer is entitled to read the policy about their own data - it is the
-- answer to "can I have this deleted", and telling them to ask while the
-- answer sits in a table would be the same failure as every other screen this
-- product has fixed.
CREATE POLICY pol_read ON policy_decisions FOR SELECT USING (true);
GRANT SELECT ON policy_decisions TO plint_app;

/* The decision in force on a topic, or NULL. There is no default and there
   will not be one: a caller that wants a value has to handle not having one,
   which is what makes "not decided" appear on the screen instead of a guess. */
CREATE FUNCTION policy_of(p_topic text)
  RETURNS text LANGUAGE sql STABLE AS $$
    SELECT d.decision FROM plint.policy_decisions d
     WHERE d.topic = p_topic AND d.superseded_at IS NULL
  $$;
GRANT EXECUTE ON FUNCTION policy_of(text) TO plint_app;

/* Recording one. The office types it; nothing here proposes it. A second
   decision on the same topic supersedes the first rather than overwriting it,
   so "what was our policy in March" stays answerable. */
CREATE FUNCTION policy_decide(p_topic text, p_decision text, p_reason text,
                              p_from date DEFAULT NULL)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
  DECLARE
    v_actor text := plint.current_user_id();
    v_role  text := plint.current_role_name();
    v_old   text;
    v_id    text;
  BEGIN
    IF v_actor IS NULL OR v_role <> 'office' THEN
      RAISE EXCEPTION 'a policy decision is recorded by the head office';
    END IF;
    IF coalesce(btrim(p_decision), '') = '' OR coalesce(btrim(p_reason), '') = '' THEN
      RAISE EXCEPTION 'a decision is what was decided and why it was decided';
    END IF;

    v_id := 'pol-' || substr(md5(p_topic || clock_timestamp()::text), 1, 16);

    /* THE OLD ONE STEPS DOWN BEFORE THE NEW ONE ARRIVES.
       `policy_decisions_one_live` is a partial unique index on the topic where
       nothing has superseded it, so two live rows on one topic is not
       something this table will hold - which is the point of the index and
       also the reason this order matters. Inserting first raised a duplicate
       key on the second decision anybody recorded. */
    UPDATE plint.policy_decisions
       SET superseded_at = now(), superseded_by = v_id
     WHERE topic = p_topic AND superseded_at IS NULL
    RETURNING id INTO v_old;

    INSERT INTO plint.policy_decisions
      (id, topic, decision, reason, effective_from, decided_by)
    VALUES (v_id, p_topic, btrim(p_decision), btrim(p_reason), p_from, v_actor);

    INSERT INTO plint.audit_log (actor_id, actor_role, action, target_kind, target_id, figures)
    VALUES (v_actor, v_role, 'policy_decided', 'policy_decision', v_id,
            jsonb_build_object('topic', p_topic, 'decision', btrim(p_decision),
                               'supersedes', v_old));
    RETURN v_id;
  END
$$;
GRANT EXECUTE ON FUNCTION policy_decide(text,text,text,date) TO plint_app;

-- Nothing is inserted here. All three topics are unanswered, on purpose, and
-- every screen that reads one says so and says whose answer it is waiting on.
