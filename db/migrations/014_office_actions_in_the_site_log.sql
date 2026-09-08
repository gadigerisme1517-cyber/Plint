-- 014 the office's own actions belong in the site file
--
-- `site_log.kind` allowed six things, and all six are conditions on site:
-- material, labour, weather, safety, drawing, rework. That is the engineer's
-- log of what happened at the villa.
--
-- Three of the head office's actions are also things that happened to that
-- villa, and both roles need to be able to read them afterwards:
--
--   pack   a stage pack went to a lender, or the lender was chased on it
--   photo  the office asked the site for a photograph
--
-- Without them the office could send a pack and then have no record of having
-- sent it - the write landed in `pack_deliveries`, which says the state
-- changed but not who changed it or when they last asked. And "ask the site
-- for a photograph" wrote a notification the office is not allowed to read
-- back, because `nt_read` is scoped to the role the notification is FOR. So
-- the office asked, and the screen it asked from could not show that it had.
--
-- `sl_read` already lets both roles read this table and `sl_insert` already
-- requires `logged_by = current_user_id()`, so nothing about who may write
-- what changes here. Only the vocabulary widens.

SET search_path = plint, public;

ALTER TABLE site_log DROP CONSTRAINT site_log_kind_check;

ALTER TABLE site_log ADD CONSTRAINT site_log_kind_check
  CHECK (kind IN ('material', 'labour', 'weather', 'safety', 'drawing', 'rework',
                  'pack', 'photo'));
