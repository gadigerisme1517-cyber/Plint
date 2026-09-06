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

Rewritten after the punch list was worked. Everything below was run on the
machine this repo now lives on, not in the sandbox it was built in.

`npm test` is green from nothing: it creates a scratch database, bootstraps,
migrates, seeds, proves the migrator is a no-op on a populated database, runs
all twelve suites, and drops the database again. **131 assertions, all passing.**
Every one of them has been checked by mutation: see DECISIONS.md and CLOSEOUT.md.

    money       22   the calculation layer, called directly
    config       7   no credential defaults; the TLS option shapes
    isolation   24   the boundary, unchanged from the sandbox
    smoke       14   three logins end to end, unchanged from the sandbox
    session      8   survives a restart of the server module
    ledger      16   demands immutable, the audit row written by the database
    evidence    12   photographs stored, hashed, thumbnailed, buyer-only
    pack         6   delivery recorded, and the copy that says so is true
    reconcile    8   stored demands, screens and the layer agree, to the paise
    tls          7   the server refuses an unencrypted connection
    restore      6   a backup restores, and the restore is usable
    ratelimit    7   sign-ins block, a success clears it, a block survives restart

### Built

- **Configuration is entirely environmental.** No credential default exists in
  `src/` or `db/`. A missing one names itself on stderr and exits 1 before a
  connection is opened. Two credential sets: the runtime role, and the schema
  owner used only by migrations and the seed.
- **Forward-only migrations** under `db/migrations`, applied by
  `node db/migrate.js`, recorded in `plint.schema_migrations` with a checksum.
  Running it twice on a populated database changes nothing. There is no `DROP`
  in the path. `db/schema.sql` is kept as the historical record and nothing
  runs it. Roles are created by `db/bootstrap.js`, not by a migration.
- **Sessions live in the database.** A restart signs nobody out and a second
  instance authenticates cookies the first one issued. The cookie carries a
  random token; the table stores its HMAC under `PLINT_SECRET`, so reading
  every row yields no usable cookie and rotating the secret ends every session.
  The application role has no grant on the table at all - three
  `SECURITY DEFINER` functions are the whole vocabulary.
- **`PLINT_SECRET` is load-bearing**, which is what item 2 asked for. No unused
  security-shaped identifier remains in `src/`.
- **Demands are immutable**, behind two independent locks: the `UPDATE` grant
  is revoked, and a trigger refuses any change to the money columns, the
  document number or the dates for every role including a superuser. The one
  permitted transition is `demand_settle()`, which takes its actor from the
  transaction identity rather than a parameter. Corrections are `credits` rows.
- **The audit row is written by the database**, by deferred triggers on
  `unit_stages` and `demands`, so a certification that leaves no record is
  impossible whoever does the writing. `audit_log` is append-only the same way: insert-and-select grants, plus
  triggers that raise on UPDATE and DELETE whoever is asking. An actor can only
  write rows in their own name. Certification writes exactly one row carrying
  the figures as at the moment it was signed.
- **The ten stages always sum to the agreement value.** Stages one to nine
  price as they always did; the tenth is the agreement value minus the other
  nine, so no amount of rounding can drift. Nothing already billed moved: the
  seeded value divides cleanly and a test asserts the residual equals the
  figure that stage already had.
- **Villa A-07 is seeded on a deliberately awkward agreement value**,
  ₹2,98,76,543.21, which drifts by a paise under per-stage rounding. It exists
  so that the residual is exercised by real seeded data rather than only by
  unit tests, and so a call site that priced a stage alone would show up as a
  demand disagreeing with the ledger. `reconcile.test.js` checks every stored
  demand in the database against the calculation layer, and reads A-07's and
  B-14's buyer screens to confirm the rendered figures match.
- **Evidence photographs are real files**, content-addressed by the sha256 the
  schema already carried, verified by reading back off the disk after writing.
  JPEG and PNG by magic bytes, never by the declared type; 12 MB cap; the
  client filename never reaches a path. Reads are authorised by row-level
  security, so a buyer holding a neighbour's exact hash gets the same 404 as a
  hash that was never issued.
- **Certificate thumbnails are resized, not merely scaled for display.** sharp,
  480px long edge, quality 70, cached beside the original under its hash. Four
  2400x1800 photographs totalling ~5 MB make a 141 KB certificate.
- **Sign-in is rate limited in the database**: five failures per email and
  fifty per address in fifteen minutes. Only failures count. A block refuses
  the correct password too.
- **Database TLS is `PGSSLMODE`**, defaulting to `require` outside
  development.
- **Uploads are a plain HTML form** on the engineer worklist, received by a
  small multipart reader in `src/multipart.js`. No dependency was added.
- **Pack delivery is recorded, not asserted.** One `pack_deliveries` row per
  certification with state, attempts and lender response. The copy now says
  "queued", which is true.
- **Operational basics**: JSON request logs carrying the actor id, `/health`
  that fails 503 when the database does, and an error handler that gives the
  browser a request id and never a stack.

### Not built, and why

- **Nothing sends a pack to a lender.** There is no channel to send one to. The
  queue, the states and the attempt counter exist; the sender does not, because
  a worker that marked rows delivered without delivering them would be the same
  lie in a more expensive form. Wiring a real channel means moving rows out of
  `queued` and nothing else.
- **There is no supervisor role.** Item 7 asked for uploads by "the engineer
  and supervisor roles"; the system has `buyer`, `engineer` and `office`, and
  Suresh Kumar is a name on `unit_stages.marked_by`, not a login. Uploads are
  open to engineer and office. A supervisor is a role value, a seeded login and
  one entry in each of two policy lists.
- **`credits` has no screen.** The table exists because "a correction is a new
  credit row" is otherwise unimplementable, but nothing renders or writes one
  outside the tests.
- Buyer finish selections, warranty and snag flows, the site-engineer screens
  and the document-chase list remain unbuilt, as they were.

### One money rule the brief still has to settle

The stage **bases** now always sum to the agreement value exactly. **GST does
not**: it is rounded per stage, so on an agreement value that does not divide
cleanly the summed GST can differ by a paise or two from five per cent of the
whole. That was left deliberately. Making one invoice absorb the rounding of
nine others is a claim about tax law, not an arithmetic tidy-up, and it is not
this codebase's to make without the brief.

### Before this is deployed

**Read `CLOSEOUT.md`.** It states what is production ready, what is not, what
was inferred from the prototype rather than specified, and what a new engineer
must know before touching the money layer.

Backup and restore now exist: `scripts/backup.sh`, `scripts/restore.sh`,
`docs/BACKUP.md`, and a restore drill that runs on every `npm test`. What is
still missing is everything around them - a schedule, off-machine storage,
retention, encryption at rest, and WAL archiving for a recovery point better
than the last dump. After that: TLS in front of the process, a scheduler for
the two sweep functions nothing calls, CI, supervision, log shipping, and
monitoring on `/health` and the queued pack backlog.

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
