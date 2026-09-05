# HANDOVER — Plint, to Claude Code

You are finishing a partly built system. Read this file, then `README.md`, then
`DECISIONS.md`, then the code. Start work immediately.

## How to work

**Decide, do not ask.** You have full authority over every choice in this
document and every choice it does not mention. Do not stop to confirm scope, to
propose options, or to check a preference. If two approaches are defensible,
take the simpler one, implement it, and append one line to `DECISIONS.md` saying
what you took and why. An unlogged decision is a bug; a delayed decision is
worse.

**Do not wait for the brief.** `plint_production_build_brief.md` does not exist
in this repo and will not appear during your run. Every money rule currently in
the code was inferred from the locked prototype and is listed in
`DECISIONS.md`. Treat those rules as correct and keep building. Do not
re-derive them, do not hedge them, and do not add "TBD" comments around them.
Isolate them so a later correction is a one-file change, which is already the
case in `src/money.js`.

**Test before claiming.** Every item below has an acceptance line. Nothing is
done until its test runs green in the same session you wrote it. Do not report
an item as complete on the strength of the code reading correctly.

**Run to the end.** Work the punch list top to bottom in one pass. If an item
proves impossible in the environment, log why in `DECISIONS.md`, skip it, and
carry on to the next. Do not stop the run to report a blocker.

## Where this repo came from

It was built and tested inside a sandbox, then shipped to you as a zip. It has
never been on this machine, is not in any git remote, and has no history. If you
are reading this and the code around it is present, you are in the right place:
unzip put it here. There is nothing else to find and nothing to clone.

Your first act is `npm install`, because `node_modules` was excluded from the
zip. Then `git init` and commit the tree as-is, before you change a line, so the
punch list produces a readable diff.

## Standing up PostgreSQL is your job, not a separate ask

Nothing here runs without a database. Bring one up however suits the machine:
Docker, a local install, or the Supabase container if one is already configured.
Create the database, run the migrations from item 4, seed it, and wire it into
`npm test` as a scratch database that is created and dropped by the test run.
Record what you chose in `DECISIONS.md`. Do not ask which route to take, and do
not treat a missing database as a blocker.

## State of play

Working and tested in the sandbox where this was built. Reproduce these first,
then do not regress them:

- PostgreSQL schema with `ENABLE` plus `FORCE ROW LEVEL SECURITY` on every
  table. `db/schema.sql`.
- `test/isolation.test.js`, 24 assertions, all passing. This is the highest
  value artefact in the repo. If a change breaks one of these, the change is
  wrong, not the test.
- `test/smoke.test.js`, 14 assertions, all passing. Three logins end to end,
  buyer screen, certification, both PDFs, head-office worklist.
- One calculation layer in `src/money.js`. Integer paise, `BigInt`
  intermediates, half-up rounding, basis points for percentages. No screen and
  no document computes a rupee.
- 48 villas seeded deterministically. B-14 opens as Arjun Nair with correct
  isolation. S. Ramachandran certifies blockwork and that single act raises the
  demand and produces both PDFs.

## Punch list, in order

### 1. Sessions survive a restart
`src/server.js` keeps sessions in an in-process `Map`. Every restart logs
everyone out and a second instance breaks authentication. Move sessions to a
`sessions` table or to signed cookies with a server-side revocation list. Pick
one. Set `Secure` and a sane `Max-Age`, keep `HttpOnly` and `SameSite=Lax`.
Acceptance: a test that signs in, restarts the server in-process, and finds the
cookie still valid.

### 2. Kill the fake security
`const SECRET = process.env.PLINT_SECRET` is declared and never used. Either use
it for cookie signing in item 1 or delete the line. Dead code that looks like
security is worse than no security.
Acceptance: no unused security-shaped identifiers anywhere in `src/`.

### 3. Configuration out of the source
`src/db.js` hardcodes `plint_app_dev` as a default password. Remove every
credential default. Read `PGHOST`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`,
`PORT` and the session secret from the environment, fail loudly at boot if a
required one is missing, and add `.env.example` listing every variable with no
real values in it.
Acceptance: the process exits with a clear message when `PGPASSWORD` is unset.

### 4. Migrations, not a destructive rebuild
`db/schema.sql` opens with `DROP SCHEMA plint CASCADE`. Running it twice
destroys production data. Split it into numbered forward-only migrations under
`db/migrations/`, with a `schema_migrations` table and a runner
(`node db/migrate.js`). The first migration is the current schema without the
drop. `db/seed.js` stays separate and stays development-only.
Acceptance: running the migrator twice on a populated database is a no-op and
loses nothing.

### 5. Demands become immutable
`plint_app` holds `UPDATE` on `demands`, so a compromised process can rewrite an
issued demand amount and nothing would notice. Revoke `UPDATE` on the money
columns. Allow exactly one transition, unpaid to paid, through a
`SECURITY DEFINER` function that writes the payment and cannot touch
`base_paise`, `gst_paise`, `extras_paise` or `total_paise`. A correction is a
new credit row, never an edit.
Acceptance: an isolation test asserting that a direct `UPDATE demands SET
total_paise` as `plint_app` affects zero rows or raises.

### 6. Audit trail
Every certification, demand and payment writes an append-only row: actor, role,
action, target, timestamp, and the figures as at that moment. `plint_app` gets
`INSERT` only, no `UPDATE`, no `DELETE`. This is the record that answers "who
signed this and what did it say when they signed it".
Acceptance: certifying a stage writes exactly one audit row, and the app role
cannot amend it.

### 7. Real evidence storage
Evidence is currently captions, a GPS string and a hash, with no image and no
upload path. The certificate cites photographs that do not exist as files.
Add an upload endpoint for the engineer and supervisor roles, store files on
disk under a content-addressed path with the sha256 the schema already carries,
verify the hash on write, serve them through an RLS-checked route so a buyer
can only fetch his own villa's images, and embed thumbnails in the completion
certificate PDF. Reject anything that is not a JPEG or PNG, cap the size, and
never trust the client-supplied filename.
Acceptance: an isolation test proving a buyer cannot fetch another villa's
image by guessing its hash, and a certificate PDF with real thumbnails on it.

### 8. Unit tests on the money layer
Both suites exercise `src/money.js` only through screens. It has zero direct
tests. Write them: rounding at the half-paise boundary, a stage schedule that
sums to exactly 100 per cent of agreement value across all ten stages with no
drift, GST on a base plus extras, interest at zero on the due date and at one
day past, and a full ledger where paid plus demanded plus remaining equals the
agreement value with GST. Use `node:test`.
Acceptance: a stage-by-stage sum that lands on the agreement value to the paise.

### 9. Pack delivery is currently display text
Nothing sends the evidence pack to the lender; the buyer screen and the
certification message say it happened. Either build it as a queued job with a
`pack_deliveries` table recording state, attempts and lender response, or
change the copy to say what is true. Do not leave text asserting an action the
system does not take.
Acceptance: either a delivery row per certification, or no copy claiming
delivery.

### 10. Operational basics
Structured request logging with the actor id, a health endpoint that checks the
database, a global error handler that never leaks a stack to the browser, and
`npm test` wired to run migrations, seed a scratch database, and execute all
suites.
Acceptance: `npm test` green from a clean database in one command.

## Rules that do not move

- **Buyer isolation is enforced at the database.** Never in a route handler,
  never in a `WHERE` clause you remembered to add. Every new table gets RLS
  before it gets a screen. Every new buyer-visible route gets an isolation test
  before it gets a template.
- **One calculation layer.** All money logic in `src/money.js`. If a screen or
  a PDF ever needs a number, it asks for it formatted. Two screens disagreeing
  is a bug in the layer, never in the screen.
- **Design is locked.** `public/plint.css` is lines 14 to 609 of
  `plint-v15.html`, unchanged. Match its class names and markup. Flat, no
  gradients. Red only for the stuck-money KPI, the oldest ageing bars and
  late-row dots. No gold, rose gold, beige or tan. No green as a default
  accent.
- **Out of scope, do not build:** lead capture, pre-sales, inventory blocking,
  general ledger, vendor bills, purchase orders, payroll, procurement,
  e-signature. The narrowness is the product.

## When you finish

Run both existing suites plus everything you added. Then rewrite the "State of
play" section of this file to match reality, and append to `DECISIONS.md` every
choice you made. State plainly what is built and what is not. No hedging, no
summary of your process.
