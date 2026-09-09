-- ============================================================================
-- A RATE NOBODY QUOTED.
--
-- Reading b-bank-1440 with my own eyes: six lenders that are not on this
-- project's panel, each carrying "9.00 per cent". No bank had said that. The
-- seed wrote 900 basis points into every one of them because the column was
-- NOT NULL and a number had to go somewhere, and the screen then printed it
-- as though a lender had quoted it to this buyer.
--
-- A rate Plint does not hold is not a rate. The column takes null now and the
-- screen says the rate is not quoted here. The CHECK stays: a rate that IS
-- recorded is still a positive number, and null passes a check constraint
-- because unknown is not false.
--
-- The turnaround on those six is NOT a fabrication in the same sense and is
-- left alone: it is what a lender who has not approved the project takes to
-- run its own legal and technical survey, which the screen says in as many
-- words underneath.
-- ============================================================================

SET search_path = plint, public;

ALTER TABLE lenders ALTER COLUMN rate_bp DROP NOT NULL;

COMMENT ON COLUMN lenders.rate_bp IS
  'Basis points. NULL where this lender has quoted nothing for this project - '
  'the screen must say so rather than print a number nobody gave.';
