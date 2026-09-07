# DECISIONS

`plint_production_build_brief.md` was not in the upload. Only `plint-v15.html` was
on disk. Sections 3, 4, 9 and 10 were therefore unreadable, and every rule below
was taken from the locked prototype rather than from the brief. Each one needs
checking against the brief when it arrives. Where the brief disagrees, the brief
wins and the change lands in `src/money.js` or `db/seed.js` only.

## Money rules, all taken from the prototype

| Rule | Value | Where it came from |
|---|---|---|
| Stage schedule | 10 / 15 / 10 / 10 / 10 / 10 / 10 / 10 / 8 / 7 per cent | `MILES` in the prototype |
| Agreement value, seed | ₹3,20,00,000 per villa | `AGV = 32000000` |
| GST | 5 per cent on the construction component | `gst = dAmt*.05` |
| Payment terms | due on the fourteenth day | "due in fourteen days" |
| Late interest | 12 per cent a year, simple, from the day after due | "interest runs at twelve per cent a year" |
| Finish upgrades | ride on the next demand, not a separate bill | buyer picks screen |

Consequences of the above that the prototype does not state, chosen as the
simplest option:

- **Integer paise everywhere.** No float touches money. Intermediates are
  `BigInt`, rounding is half-up, and the stage percentage is stored as basis
  points so `15%` is `1500` and never `0.15`.
- **Interest is simple, not compounding**, on `total_paise` including GST, at
  `total × 1200bp × overdue_days / (10000 × 365)`. GST on interest is not
  charged. Both need confirming.
- **The stage schedule is data, not code.** `stage_templates` is keyed by
  project, so a second project can carry a different schedule without a
  deploy.
- **Demands are stored as computed.** A re-issued letter reprints stored
  paise rather than recomputing, so a letter can never disagree with the
  ledger after a rule change.

## Isolation

- Enforced in Postgres with `ENABLE` plus `FORCE ROW LEVEL SECURITY` on every
  table. The application connects as `plint_app`, which is not a superuser,
  not `BYPASSRLS`, does not own the tables, and holds no `DELETE` grant
  anywhere.
- Identity is set per transaction with
  `set_config('plint.user_id', $1, true)`. `true` makes it transaction-local,
  so a pooled connection cannot carry one user's identity into the next
  request. `test/isolation.test.js` asserts this directly.
- A session with no identity sees zero rows on every table. There is no
  implicit "admin" fallback.
- Login has to read `users` before an identity exists, so it goes through one
  `SECURITY DEFINER` function, `login_lookup(email)`, rather than opening the
  table to unauthenticated sessions.
- **A buyer asking for another villa gets 404, not 403.** A 403 would confirm
  the villa exists. Same answer as a villa that was never built.
- Roles are `buyer`, `engineer`, `office`. The prototype also shows a site
  supervisor (Suresh Kumar) who marks stages but cannot certify. He is seeded
  as a name on `unit_stages.marked_by`, not as a login, because nothing in the
  prototype gives him a screen of his own.

## Design

- `public/plint.css` is lines 14 to 609 of `plint-v15.html`, unchanged. Class
  names and markup follow the prototype: `.blk .lede .top .item .wrow .stage
  .marks .mega .k .b .s`.
- Red is used in three places only: the stuck-money KPI on the head-office
  worklist, ageing dots on rows past 21 days, and the buyer's amount due. The
  third is a judgement call. The prototype renders the raised demand as
  `mega hot`, so that was kept. If the brief means red for overdue only, the
  change is one conditional in `buyerScreen`.
- Amber (`--warn`) appears on ageing dots between 10 and 20 days. No gold,
  rose gold, beige or tan. No green as an accent; `--ok` is unused.

## Documents

- PDFs embed Inter, converted from `inter-ui` to TTF in `assets/`. The Google
  Fonts latin subset omits U+20B9, so the full face is required for the rupee
  sign. Registering it under a standard PDF font name silently drops the glyph,
  so it is registered as `inter`.
- Documents print strings the calculation layer produced. `src/pdf.js` contains
  no arithmetic beyond dividing basis points by 100 to print "10 per cent".

## Not built

Buyer finish selections, warranty and snag flows, the site-engineer screens,
lender-facing pack delivery, and the document-chase list. All exist in the
prototype and none are in the first deliverable.

---

# Production build, second pass

Written on the machine the zip landed on. Everything below was decided without
the brief, which still does not exist. The money rules above were left alone.

## Environment

- **The repo was not where the handover said it was.** The zip had unpacked to
  `Downloads/plint/plint`, not the working directory. Copied to
  `Documents/Blueprint/plint`, alongside the other projects on this machine.
  The Downloads copy is untouched and is now a pristine record of what shipped.
- **PostgreSQL 18.6 inside WSL2 Ubuntu**, not Docker. Docker Desktop is
  installed but its daemon would not stay up, and a package install needs no
  daemon. The `postgresql` package left a valid data directory that its own
  postinst never registered as a Debian cluster, because WSL has no systemd, so
  the server is started directly with `pg_ctl` rather than through
  `pg_ctlcluster`. Node runs on Windows and reaches it over TCP on
  `127.0.0.1:5432`; WSL2 localhost forwarding makes that work unchanged.
- The README says PostgreSQL 16. Nothing in the schema is version-specific and
  18 is what this distribution ships. Left at 18.
- `db/seed.js` connected over a unix socket as `root`, which is a sandbox-ism
  that cannot work from Windows. It now uses the same TCP configuration as
  everything else, as the owning role.

## 3. Configuration

- All configuration moved to `src/config.js`. **No credential carries a
  default anywhere in `src/` or `db/`.** A missing one writes the variable's
  name and what it is for to stderr and exits 1 before a connection is opened.
- Two credential sets, because they are two privileges: `PGUSER`/`PGPASSWORD`
  is the runtime role that cannot bypass RLS, and `PGADMINUSER`/
  `PGADMINPASSWORD` owns the schema and is used by migrations and the seed
  only. `src/server.js` has no path to the admin credentials.
- Non-secret values may carry a default (`PGPORT`, `PORT`). Credentials may
  not. That is the whole rule.
- `.env` is read with Node's own `process.loadEnvFile`, so there is no
  dotenv dependency. In production no `.env` exists and the supervisor sets
  the variables.
- `.env.example` lists every variable with empty values, and is committed.
  `.env` is not.

## 4. Migrations

- `db/schema.sql` is superseded by `db/migrations/`, applied by
  `node db/migrate.js`. It is kept on disk unchanged as the historical record
  of what the sandbox shipped, and nothing runs it.
- `001_initial_schema.sql` is that schema with the `DROP SCHEMA` removed and
  the `CREATE ROLE` lifted out. Otherwise byte-for-byte the same objects.
- **Roles are not migrations.** A role is a cluster-level object shared by
  every database in the cluster, and its password belongs to the environment,
  so creating it inside a schema migration is a category error and would put a
  password in a committed file. `db/bootstrap.js` creates the database and the
  runtime role, idempotently, and re-asserts `NOSUPERUSER NOBYPASSRLS` on every
  run, because that assertion is the isolation boundary.
- Each migration runs in its own transaction and is recorded in
  `plint.schema_migrations` with a sha256 of its text. A file that changes
  after it has been applied stops the runner rather than being silently
  re-applied or silently ignored: migrations are history, and you add to
  history rather than editing it.
- The seed stays separate and development-only.

## 1 and 2. Sessions and the secret

- **A sessions table, not signed cookies.** Signed cookies would have needed a
  revocation list in the database anyway, so the table was the smaller of the
  two designs, and it makes sign-out a fact rather than a request the browser
  is trusted to honour.
- **The cookie is not what is stored.** The cookie carries 32 random bytes.
  The table stores `HMAC-SHA256(token, PLINT_SECRET)`. Reading every row
  yields no usable cookie, and rotating the secret invalidates every
  outstanding session without touching a row. This is what `PLINT_SECRET` is
  now for, which answers item 2: it is used, so the line stays.
- **The application role holds no grant on `sessions`.** Not a policy that
  returns nothing - no grant at all. Every path goes through three
  `SECURITY DEFINER` functions: open, look up, revoke. RLS is enabled on the
  table as a second lock in case a grant is ever added by mistake. It is not
  FORCEd, because the definer functions run as the owner and must work whether
  or not that owner happens to be a superuser.
- A session has to be resolved before an identity exists, so session queries
  are the one thing that legitimately runs outside `asUser`. They reach only
  the definer functions.
- `Secure` is set unless `PLINT_INSECURE_COOKIES=1` is explicitly present. The
  insecure setting has to be asked for; an environment that has not said what
  it is gets the safe answer. `HttpOnly` and `SameSite=Lax` are unconditional.
- Twelve-hour `Max-Age`, matching the row's `expires_at` so the browser and the
  database agree on when the session ended. `PLINT_SESSION_HOURS` overrides it.
- Sign-out revokes rather than deletes, so a revoked session stays
  distinguishable from one that never existed. `session_sweep()` clears rows
  a month past expiry.
- The cookie header is now parsed by name rather than by a regular expression
  that would have matched a cookie called `notplint`.

## 5 and 6. Immutable demands, and the audit trail

- **Two independent locks on a demand, not one.** The `UPDATE` grant is
  revoked from the application role, so a direct update raises permission
  denied. Behind that, a trigger refuses any change to `base_paise`,
  `gst_paise`, `extras_paise`, `total_paise`, the document number or either
  date - for every role including the owner and a superuser. The grant is the
  lock that matters day to day; the trigger is the one that still holds after
  somebody re-grants `UPDATE` by accident in six months.
- The single permitted transition is `demand_settle(demand_id, reference)`,
  `SECURITY DEFINER`. It writes `paid_at`, moves the stage to `paid`, and
  writes the audit row. It cannot touch the money columns: it does not name
  them, and the trigger would refuse if it did. Settling twice returns false
  rather than raising, because a duplicate bank file is an ordinary event.
- **The actor is the transaction identity, never a parameter.** An earlier
  draft took `actor_id` as an argument, which would have let any caller settle
  a demand in someone else's name. It reads
  `current_setting('plint.user_id')` instead, and refuses when there is no
  identity or the role is not staff.
- An `UPDATE` policy exists on `demands` permitting everything. That is not a
  hole: a policy cannot return a privilege that was never granted, and the
  application role has no `UPDATE` grant. It is there so the definer function
  works whether or not the owning role happens to be a superuser, which is a
  thing this schema should not depend on.
- **Corrections are credit rows.** `credits` is insert-only under RLS, keyed
  to a demand, readable by the buyer it concerns under the same ownership test
  every other buyer-visible table uses. No screen renders it yet. It exists
  because the rule "a correction is a new credit row, never an edit" is
  otherwise unimplementable, and a stated rule with no mechanism is a comment.
- **`audit_log` is append-only twice over**, the same way: `SELECT, INSERT`
  and no more for the application role, plus triggers that raise on any UPDATE
  or DELETE regardless of who is asking. The insert policy requires
  `actor_id = current_user_id()`, so a staff session cannot forge a row in
  another name.
- **"Exactly one audit row per certification" is taken literally.** In this
  system certification *is* the raising of the demand - `certify` is the only
  place a demand is created - so one act gets one row, and the demand's figures
  ride in that row rather than in a second one. A settlement is a separate act
  and gets its own. If demands ever gain a second creation path, that path
  writes its own row.
- The audit row is written on the same client, inside the same transaction, as
  the act. An act cannot land without its record, and a record cannot outlive
  an act that rolled back.
- A buyer cannot read `audit_log`. His evidence of what was signed is the
  certificate PDF, which carries the same figures.

## 7. Evidence storage

- **Content-addressed on disk**, at `var/evidence/ab/cd/<sha256>`, sharded two
  levels so no directory becomes unlistable. The name of a file is a fact about
  its contents, so nothing the client sends is ever used to build a path: not
  the filename, not the declared content-type, not the caption.
- **Verified on write.** The bytes are written to a temporary name in the same
  directory and renamed into place, so a reader cannot observe a half-written
  file at a content address. Then the file is read back off the disk and hashed
  again. If a content address is a claim, that read-back is what makes it true.
- **JPEG and PNG by magic bytes**, never by the declared type or the extension.
  A part claiming `image/jpeg` with a corrupt PNG signature is refused. Capped
  at 8 MB, refused as the body streams rather than after buffering it.
- **Reading is authorised by RLS and nothing else.** `GET /evidence/<sha256>`
  fetches the evidence row as the asking session and touches the disk only if a
  row came back. A buyer holding the exact hash of a neighbour's photograph
  gets 404 - the same answer as a hash that was never issued. The test proves
  it with the real hash of a file that is genuinely on disk and that its own
  buyer can read, so the 404 is about authorisation and not a missing file.
- `sha256` is deliberately not unique: one photograph may be evidence for two
  stages, and the store already de-duplicates. So the fetch returns the rows
  the session may see, which is what makes hash-guessing pointless rather than
  merely hard.
- **"Engineer and supervisor roles" was read as engineer and head office.**
  There is no supervisor login in this system - `DECISIONS.md` above records
  that Suresh Kumar is a name on `unit_stages.marked_by`, not a user - so there
  was no supervisor role to grant. If the brief wants one, it is a role value,
  a seeded login and one more entry in the two policy lists.
- **A plain HTML form, and a small multipart reader to receive it.** The design
  is locked and carries no JavaScript, so the upload had to be a native form
  post, which means multipart. `src/multipart.js` is about eighty lines and
  handles one file and a few text fields, in Buffers throughout. That was
  smaller than taking a dependency for the one endpoint that needs it.
- The upload form sits on the engineer worklist under each row, which is where
  the need is: rows with fewer than two photographs show "Too few photographs"
  and no Certify button, and until now there was no way to fix that from the
  screen.
- **Thumbnails are the stored image scaled into a box, not a resized file.** A
  genuine resize needs an image library; none was added for one certificate
  panel. The consequence is honest and worth stating: an 8 MB photograph is
  embedded at 8 MB. If certificates get heavy, that is the reason, and the fix
  is a resize at upload time.
- An unreadable file prints "photograph unavailable" in its box rather than
  taking the certificate down. A row with no stored file prints as an evidence
  line and no thumbnail, exactly as the certificate did before files existed.

## 9. Pack delivery

- **Both halves of the choice, because only doing one leaves a lie in place.**
  There is now a `pack_deliveries` row per certification, carrying state,
  attempts, the lender and its response. And the copy was changed to say
  "queued", which is what actually happened.
- **No sender was built, deliberately.** There is no lender channel to send
  anything to, and a worker that marked rows delivered without delivering them
  would be the same untruth in a more expensive form. Rows stay `queued`. When
  a real channel exists, the work is moving rows out of `queued` and nothing
  else: the table, the states and the attempt counter are already there.
- A villa with no lender gets `not_applicable`, not `failed`. Having nowhere to
  send a pack is a state, not an error.
- Three pieces of copy changed: the engineer's confirmation ("the pack has gone
  to the lender" became "the evidence pack is queued for HDFC Ltd"), the demand
  letter ("went to HDFC Ltd on the same day" became "are queued for HDFC Ltd"),
  and the blocker reason certification writes. A test greps `src/` for the old
  phrasings so the claim cannot creep back in.
- The seeded blockers still describe packs sitting with lenders. That is
  scenario data describing a project mid-flight, not the system claiming it
  acted, and the worklist needs it to have anything to show.

## 10. Operational basics

- **Structured logs**, one JSON object per line on stdout, every request line
  carrying the actor id and a request id. `PLINT_LOG=silent` for test runs.
  Nothing logs a cookie, a token or a password: the session token passes
  through this process on every request and a log file is exactly where it
  must not land.
- **`/health` checks the database**, because without one this process can do
  nothing at all. It answers 200 with `{"status":"ok","database":"up"}` or 503.
  It runs before session lookup, so a database that is down reports as down
  rather than as an authentication failure.
- **The error handler gives the browser a request id and nothing else.** No
  message, no exception class, no query, no stack. The stack goes to the log
  against that id, so a user can quote the id and an operator can find the
  line. `unhandledRejection` and `uncaughtException` are logged rather than
  printed bare.
- **`npm test` runs against a scratch database it creates and drops.**
  `test/run.js` makes `plint_test_<random>`, bootstraps, migrates, seeds, runs
  the migrator a second time to prove it is a no-op on populated data, then
  runs all seven suites in separate processes, then drops the database and the
  temporary evidence directory. The developer database is never touched, and a
  suite that leaves behind a row it cannot delete - a settled demand, an audit
  line - does not poison the next run.
- Suites run in their own processes and in a deliberate order: the calculation
  layer first, because if that is wrong nothing else means anything, then the
  isolation boundary, then the screens, then everything that mutates.

---

# Third pass: residual allocation, real thumbnails, deployment hygiene

## Residual on the last stage

- **Stages one to nine price as before. The tenth is the agreement value minus
  the other nine.** Ten independently rounded stages need not sum to what the
  buyer agreed to pay; now they always do, for any agreement value and any
  schedule length.
- `M.stageBases()` and `M.schedule()` are the new entry points. `stageBase()`
  survives for a stage considered on its own and is what the first nine still
  use, but **no screen calls it any more**, because a stage cannot be priced
  correctly outside the schedule it belongs to.
- Consequently every caller had to change: the buyer screen prices the whole
  schedule at once, the engineer worklist and the head-office worklist load
  each project's ordered basis points and price a stage at its `seq`, and
  certification passes the schedule and the index rather than one percentage.
  `db/seed.js` does the same, so a seeded demand and a certified one cannot
  disagree.
- **Order is now load-bearing.** The residual lands on the last element, so a
  caller passing stages out of schedule order would put it on the wrong stage.
  Every query that feeds these functions orders by `t.seq`, and the functions
  say so in their comments.
- **Nothing anybody has been billed changes.** Rs 3,20,00,000 divides cleanly
  by all ten percentages, so the residual equals the figure the last stage
  already had. A test asserts exactly that, and would fail if this change had
  moved a single existing figure.
- The tests that documented the drift as a known bound are gone, replaced by
  ones that assert it cannot happen: fourteen awkward agreement values,
  schedules of one, two and three stages, and a test that the first nine stages
  are untouched while the tenth absorbs precisely the paise they left behind.
- **GST is still rounded per stage and is not residualised.** The instruction
  was about the stage bases, and it is the base that constitutes the agreement
  value. Summed GST can therefore still differ by a paise or two from
  `gstOn(agreementValue)` on an awkward value. Left alone deliberately: GST is
  a tax computed per invoice, and making one invoice absorb the rounding of
  nine others is a claim about tax law that this codebase should not make
  without the brief.

## Thumbnails

- **`sharp`, 480px on the long edge, quality 70**, cached beside the original
  as `<hash>.thumb-480q70.jpg`. The cache key carries the settings, so changing
  the edge or the quality produces a new derivative rather than serving a stale
  one under the old key. Written by rename-into-place, like the originals, so a
  reader never sees a half-made thumbnail.
- Always JPEG, whatever the original was: a certificate panel wants small, not
  lossless. `.rotate()` first, so a photograph taken sideways on a phone is not
  embedded sideways.
- Measured: four 2400x1800 photographs totalling about 5 MB produce a
  **141 KB** certificate. The test asserts under 1 MB and asserts the inputs
  are genuinely over 1 MB each, so it cannot pass by resizing nothing.
- **The upload cap went from 8 MB to 12 MB.** It was 8 partly because a large
  original went straight into the PDF. That is no longer true, and real site
  photographs run to 12 MB.
- The originals are still served whole by `/evidence/<sha256>`. Only the
  certificate gets the derivative; a buyer looking at his own photograph gets
  the photograph.
- A page break in the thumbnail grid now only happens at the start of a row, so
  a row is never split across two pages.

## Housekeeping

- `Downloads/plint/plint` renamed to **`plint-sandbox-original`**. It is the
  untouched sandbox tree; the live one is `Documents/Blueprint/plint`.
- **Database TLS is `PGSSLMODE`**: `disable`, `require`, `verify-ca` or
  `verify-full`. It defaults to `require` unless `NODE_ENV=development`, which
  defaults to `disable`. An environment that has not said what it is gets the
  production answer, because that is the direction that fails safe.
  `verify-ca` and `verify-full` demand `PGSSLROOTCERT` and refuse to start
  without it. **`require` rather than `verify-full` as the default is a
  deliberate compromise**: verify-full needs a root certificate this deployment
  does not have, and defaulting to it would stop the process starting at all.
  `require` defeats passive interception, which is the threat when the database
  is across a network, and it is the strongest setting that works unattended.
- **Login rate limiting lives in the database**, for the reason sessions do:
  with two instances an in-process counter doubles the attacker's budget, and a
  restart hands them a fresh one. Same shape as `sessions` - no grant on the
  table, RLS with no policy as a second lock, three `SECURITY DEFINER`
  functions as the whole vocabulary.
- Two counters per attempt: **five failures per email** and **fifty per
  address**, both in a fifteen-minute window, blocking for fifteen minutes.
  The email counter stops one account being ground down; the address counter
  stops one source working through many accounts. The address limit sits far
  above the email limit deliberately, so one blocked account cannot take a
  whole shared-NAT office offline.
- **Only failures accumulate.** A successful sign-in clears both counters, so
  somebody signing in ten times a day never meets this. It is also why the
  suites, which sign in constantly and correctly, are unaffected.
- The check runs **before the password is examined**, so a blocked key costs an
  attacker a round trip and not an scrypt.
- A block refuses the correct password too. A limiter that lets the right
  answer through is only slowing down the wrong ones. The test asserts it.
- `X-Forwarded-For` is honoured **only** when `PLINT_TRUST_PROXY=1`. Trusting
  it unconditionally would let one source present itself as thousands and walk
  around the address counter entirely.
- `ratelimit.test.js` runs last, because it deliberately blocks a key, and
  clears what it blocked so the suite is re-runnable.

## Still untouched, and needed before this is deployed

Written down because none of it is built, and a reader should not have to
infer that from silence.

- **Backups. There are none.** No dump schedule, no retention, no restore
  drill, no point-in-time recovery, no WAL archiving. For a system whose whole
  value is an evidence trail saying who signed what and when, this is the
  largest single gap in the repo. It needs `pg_dump` on a schedule to
  off-machine storage, and the restore rehearsed rather than assumed.
  `var/evidence/` needs backing up too and is not in the database: a restored
  database whose photographs are gone still cannot reproduce a certificate.
- **TLS to the browser.** The process serves plain HTTP. Something has to
  terminate TLS in front of it, and `PLINT_INSECURE_COOKIES` must be unset once
  it does, or the `Secure` flag will stop cookies being sent at all.
- **No migration rollback path.** Migrations are forward-only by design, but
  there is no tested procedure for one that lands badly, other than restoring
  from the backups that do not exist.
- **Nothing sweeps.** `session_sweep()` and `login_attempts_sweep()` exist and
  are called by nothing. They want a scheduled job.
- **No process supervision, no restart policy, no log shipping.** Logs go to
  stdout as JSON on the assumption something collects them. Nothing does yet.
- **No CI.** `npm test` is one command and green; nothing runs it on a push.
- **No secret management.** Secrets come from the environment, which is right,
  but nothing rotates them, and rotating `PLINT_SECRET` signs everyone out with
  no warning to anybody.
- **No monitoring or alerting** on `/health`, on the queued pack backlog, or on
  demands going past due.
- **`sharp` is a native dependency.** It ships prebuilt binaries per platform;
  a deployment target unlike this machine needs that checked at build time.
- **No load consideration.** The pool is eight connections, uploads buffer
  whole in memory, and a thumbnail is generated synchronously with the first
  certificate request that needs it.
- **The residual and the audit trail are not reconciled.** Nothing checks that
  the ten demands actually raised for a villa sum to its agreement value. The
  calculation layer guarantees it; a report proving it after the fact does not
  exist.

## Fourth pass: proving the residual refactor was complete

- **`sharp` pinned to exactly `0.35.4`**, not `^0.35.4`. It is a native
  dependency shipping prebuilt binaries per platform, so a silent minor bump is
  a silent change of native code underneath a document-generating path. A test
  asserts both the pin and that `require.resolve('sharp')` sits inside this
  repo's own `node_modules`, because it once did not: an `npm install` run from
  the wrong directory put it in the parent, where it still resolved by
  directory walking and would have vanished the moment the repo moved.

- **Audited every call site that prices a stage.** Outside `src/money.js`
  nothing calls `stageBase` or `gstOn` any more. Everything goes through
  `M.schedule`, `M.ledger`, or `M.priceStage` with a schedule and an index.

- **The silent fallback in `priceStage` is gone.** It used to accept a schedule
  and an index *or* a bare percentage, choosing whichever was present. That
  meant a schedule which failed to load would quietly fall back to pricing the
  stage alone, which is wrong only on the last stage and only by a paise -
  precisely the kind of wrong figure that looks right. Half a first form is now
  an error: an index with no schedule throws, an out-of-range index throws, and
  a schedule containing a hole throws.

- **A guard that skipped what it was written to catch.** The schedule
  validation was first written with `forEach`, which skips array holes. A hole
  is exactly what a missing `seq` produces, since `schedules()` builds its
  arrays by assigning at an index. The test caught it; the loop is now an index
  loop. Worth recording because the guard looked correct and was not.

- **Villa A-07 is now seeded on ₹2,98,76,543.21**, down from the flat
  ₹3.2 Cr every villa shared, with a matching smaller sanction. It is a smaller
  3 BHK, so a lower figure is realistic, but the reason is the awkwardness:
  ₹3.2 Cr divides cleanly by all ten percentages, so residual allocation and
  per-stage rounding produce identical numbers on every villa and a missed call
  site would have been invisible on every screen. A-07 drifts by one paise
  under per-stage rounding, so the seeded data itself now exercises the
  residual. `isolation.test.js` still passes unchanged: it asserts villa
  counts, not amounts.

- **`reconcile.test.js` checks the seed against the layer, not just the layer
  against itself.** Every stored demand in the database - all of them, not a
  sample - is compared to what `M.schedule` prices for that villa and stage
  index today. Then B-14's and A-07's buyer screens are fetched over HTTP and
  every rendered stage amount and the paid-so-far figure are compared to the
  same source. Then the demand letters are rendered. If the seed and the
  screens ever diverge, that is where it surfaces.

- Confirmed by that test: **the demand PDF cannot disagree with the ledger**,
  because it prints stored figures and the stored figures equal what the layer
  prices. The assertion is on the stored row rather than on text scraped out of
  a compressed PDF stream, which would prove less and break more often.

- **Recorded rather than fixed:** per-stage GST still differs from GST on the
  whole by two paise on A-07. The test asserts that difference explicitly, so
  it is a documented property with a number attached rather than something a
  reader has to discover. The reasoning for leaving it stands: GST is computed
  per invoice, and making one invoice absorb nine others' rounding is a claim
  about tax law this codebase should not make without the brief.

---

# Fifth pass: deployment hardening and an acceptance audit

## Database TLS, enforced rather than requested

- **The cluster now refuses plaintext.** `pg_hba.conf` carries
  `hostnossl … reject` ahead of `hostssl … scram-sha-256`, so an unencrypted
  TCP connection is refused outright rather than allowed to fall back. Before
  this, the client asked for TLS and the server did not care, which meant a
  misconfigured client would have sent scram and every row in the clear while
  every test still passed.
- A self-signed certificate was generated for the development cluster. The
  unix socket keeps `trust`, because it is not reachable off the machine and
  the seed uses it.
- The development `.env` moved from `PGSSLMODE=disable` to `require`. The
  config default is unchanged - development still defaults to `disable` - but
  this machine's cluster now requires TLS, so the environment says so
  explicitly rather than relying on a default that no longer fits.
- `tls.test.js` proves the refusal rather than asserting the intent: it opens a
  connection with `ssl: false` and requires the server to refuse it, and checks
  the error names encryption rather than being any old failure. It also reads
  `pg_stat_ssl` for the pool the application actually uses, so "we asked for
  TLS" and "we got TLS" are two separate assertions.
- A third test demands a *verified* certificate and requires that to fail
  against the self-signed development one. If that ever succeeds, verification
  has stopped happening.

## Backup and restore

- `scripts/backup.sh` and `scripts/restore.sh`, documented in
  `docs/BACKUP.md`. Custom-format `pg_dump` plus a tarball of `var/evidence`,
  with checksums and a manifest, into one timestamped directory.
- **Both halves or neither.** A restored database whose photographs are gone
  still cannot reproduce a completion certificate. The restore verifies that
  every evidence row claiming a stored file has that file on disk.
- `restore.sh` refuses to restore over `PGDATABASE` unless
  `PLINT_RESTORE_OVER_LIVE=1`. The ordinary reason to run it is a drill, and a
  drill that silently overwrites production is worse than no drill.
- **The drill is a test, not a document.** `restore.test.js` dumps the working
  database, restores it into a fresh one, compares row counts and the summed
  demand total, checks RLS and FORCE survived the restore, and regenerates a
  thumbnail from the restored bytes. If `pg_dump` cannot be found it fails
  loudly rather than skipping: "we could not run the drill" is not "the drill
  passed".

### Two faults the drill found, which nothing else had

- **269 seeded demands and zero audit rows.** The seed fabricated certified
  stages with `certified_by` and `certified_at` set - the database asserting
  that S. Ramachandran signed them - while the audit trail recorded nothing.
  The one question that table exists to answer had no answer for any historical
  demand. The seed now writes the same rows certification writes: 269
  `certified` rows and 221 `demand_settled` rows.
- **`pack_deliveries` empty on a fresh database.** Same shape of fault: seeded
  history skipped the record that certification creates. Any check counting
  those rows passed by having nothing to count. The seed now writes one per
  certified stage, `delivered` where the demand was paid, because what released
  the money was the pack arriving.

Both are the same lesson: seeded history that skips a side effect leaves the
database internally inconsistent, and makes every test over that table weaker
than it looks.

## Acceptance audit: can each test fail?

`scripts/mutation-audit.js` breaks one specific behaviour at a time and runs
the suites that claim to cover it. A mutation that makes a suite fail was
caught by a test doing real work. A mutation that leaves everything green means
the test passes whether the code is right or not.

**Final: 31 mutations, 29 killed, 2 survived.** `npm run audit`.

### Three real gaps, found and closed

1. **`required()` had no test at all.** Replacing its body with a default -
   turning "no credential defaults" into a lie - broke nothing. The claim had
   been verified by hand once, during the first pass, and never encoded.
   `config.test.js` now blanks each of the seven required variables in turn and
   requires the process to exit 1 naming that variable, with a control that the
   same call succeeds when nothing is missing.
2. **The `verify-ca` / `verify-full` branch was never executed.** Flipping
   `rejectUnauthorized` to `false` there survived, because every real-connection
   test goes through `require`, which is a different literal. `config.test.js`
   now inspects the option object each mode produces.
3. **Partial days of interest were untested.** `Math.floor` could become
   `Math.ceil` unnoticed, which would charge a full day's interest to somebody
   paying an hour late. There are now assertions at a minute, twelve hours, one
   second short of a day, and exactly a day - and that interest is never
   negative however far before the due date.

### Two survivors, both equivalent rather than untested

The identity handling in `asUser` is protected twice over, and disabling
either protection alone changes nothing observable:

- Skipping `set_config` for an unidentified request is harmless because the
  setting is transaction-local and reverts on COMMIT anyway.
- Making it session-scoped is harmless because every request sets it again.

Only both faults together leak. That combination **is** caught, by
`isolation.test.js` run against a single connection. So the two survivors are
equivalent mutations, not gaps, and they are left in the audit with that
recorded against them rather than deleted - a survivor with a reason is
information, a deleted survivor is not.

`PLINT_POOL_MAX` was added for this: `npm test` runs `isolation.test.js` with a
pool of one, so any identity outliving its transaction must appear in the next
request rather than hiding behind a different backend.

### Two mutations that were wrong, and what that cost

- The first identity-leak mutation set the GUC a second time at session scope,
  which the next transaction overwrote. It survived for want of being a real
  fault, not for want of a test. A survivor is a hypothesis about the tests;
  it has to be read before it is believed.
- `overdueDays <= 0` to `< 0` is genuinely equivalent: zero overdue days yields
  zero interest either way, so no input distinguishes them. Replaced with the
  `floor`/`ceil` mutation, which is observable, and which found gap 3 above.

### What the audit does not cover

Mutation coverage is not proof. It says these 31 specific faults are caught. It
says nothing about faults nobody thought to write down, and the DB-level
mutations only cover the four migrations they touch. It is a floor, not a
ceiling.

## Housekeeping

- `PLINT_POOL_MAX`, default 8, so a test can pin the pool to one connection.
- `npm run audit` and `npm run backup`.
- `test/run.js` takes per-suite environment overrides.

---

# Sixth pass: the audit row becomes structural

The previous pass fixed the wrong thing. A restore drill found 269 certified
stages with no audit rows, and the fix was to make the seed write them — which
left two writers of the same record and preserved the arrangement that caused
the fault. The record was a convention, correct only while every writer
remembered, and a writer had already forgotten.

It is now the database's job.

## Which transition actually fires it

**There is no `status = 'certified'` to hook.** The enum carries the value and
no code path sets it: `certify()` moves a stage from `marked` straight to
`demanded` in one statement, and the seed inserts `demanded` and `paid` rows
directly. All 269 certified stages in the seeded database are `demanded` or
`paid`; none is `certified`.

A trigger on the status value would have fired zero times and looked correct.
What actually marks a certification is `certified_by`, `certified_at` and
`certificate_hash` going from null to not-null, so that is the condition.

## Why the trigger is deferred

`certify()` updates the stage first and inserts the demand second. An immediate
`AFTER` trigger would run before the demand existed and record a certification
with no figures. A `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` fires
at COMMIT, by which time everything the row refers to is in place, **whatever
order the writer chose**. That is the property that makes it work for writers
nobody has written yet.

It also means the seed had to become one transaction. In autocommit each
statement is its own transaction, so a deferred trigger would have fired
immediately after each `unit_stages` insert, before the demand. The seed now
wraps in `BEGIN`/`COMMIT`, which it should have done anyway.

## Exactly one writer

- The route handler's `AUDIT.write` call is gone, and with it the import.
- The seed's hand-written audit rows are gone.
- `src/audit.js` no longer exports `write`. It reads and nothing else, and says
  in its header why.
- `demand_settle()` no longer writes its own row either: a settlement trigger
  on `demands` does it, for the same reason. The seed was bypassing
  `demand_settle()` entirely to fabricate 221 historical payments, so that
  function being a choke point was worth nothing.

Both triggers are `SECURITY DEFINER`, so the record is written whatever the
writer's privileges. The `au_write` policy stays as defence for direct inserts,
which is what `an actor cannot write an audit row in another name` still tests.

## Attribution

- A certification is attributed to **the row's own `certified_by`**, not to
  whoever is connected. Head office backfilling a certificate the engineer
  signed on site produces a row naming the engineer. That distinction was
  invisible to every test until one was written for it: in all the others the
  connected user and the signer were the same person, and a mutation
  substituting the connected identity survived. Now covered.
- A settlement has no `settled_by` column to read, so it is attributed to the
  transaction identity, and **the absence of one is an error**. Money moving
  must name who moved it; a row attributed to nobody is worse than a refusal.
  This is why the seed sets an identity: it is head office writing the
  project's history, and it says so.

## Two further constraints that came with it

- A `CHECK` that the three certification columns are all null or all not-null.
  A `certified_at` with no `certified_by` is a signature nobody signed.
- A certification cannot be altered or withdrawn once signed. Without it the
  audit row could be made to describe something the row no longer says.

## What now proves it

- `ledger.test.js` certifies by raw SQL as the application role, and again as
  the owning role the way a psql prompt would, and requires exactly one audit
  row each time. Neither goes near the route handler.
- The seed reconciles its own work at the end and throws if the counts
  disagree: 269 demands to 269 `certified` rows, 221 settled to 221
  `demand_settled` rows.
- `restore.test.js` and `scripts/restore.sh` both assert the reconciliation, on
  the restored copy as well as the live one, plus that no audit row names an
  actor who does not exist.
- Six new mutations on the trigger itself, including the fault that actually
  shipped — a writer that certifies and leaves no record. All killed. One
  survivor (attribution) was a real gap and is closed.

One of those mutations, removing `INSERT` from the trigger's event list, was
caught by the **seed's own reconciliation** rather than by a suite. That is the
intended behaviour: a seed that cannot produce a consistent database should
refuse to finish rather than hand one over.

## A process failure worth recording

The first full run after this change reported `config.test.js` failing. It was
not a code fault: a mutation audit had been left running in the background, and
it edits source files in place, so the test run read a deliberately broken
`src/config.js`. Diagnosing it cost a round trip.

Both sides now refuse to race. The audit takes `var/.mutation-audit.lock` and
drops it on exit or interrupt; `npm test` refuses to start while it is held and
says why. A tool that breaks source on purpose has to announce itself, or every
failure it causes looks like a real one.

### Correction

The commit message for the audit-trigger pass says 145 assertions. The correct
figure is **137**: money 22, isolation 24, smoke 14, session 8, ledger 16,
evidence 12, pack 6, reconcile 8, config 7, tls 7, restore 6, ratelimit 7. The
suites did not change; the addition did. `CLOSEOUT.md` carries the right number
and `npm test` prints the per-suite counts it was summed from.

---

# Seventh pass: plint-v21 becomes the design reference

`plint-v21.html` supersedes `plint-v15.html`. Different brand (#635BFF, not
#1B4DD8), different face (Instrument Sans, not Inter), light ground (#F6F9FC)
instead of dark chrome, and two new shadow tokens. The loan model also changed,
and the repo was stale against it.

## 1. The stylesheet is lines 14 to 628, not 14 to 609

The instruction said 14 to 609, "exactly as the v15 extraction was done". Those
two clauses disagree for this file and the second one is the one that means
something.

In v15 `<style>` opened at 13 and closed at **610**, so 14 to 609 was the whole
block: 596 lines, matching `public/plint.css` byte for byte. In v21 the block
closes at **629**, so the whole block is 14 to 628, and it is 615 lines.

Stopping at 609 would have silently dropped nineteen lines: the entire
`@media print` block, the reduced-motion block, `.jtag`, `.caflag`, `.duebar`,
`.agdoc`, `.toast`, `.said`, the focus and checked states, and
`.marks i.on{background:var(--brand)}` - which is the rule that colours the
buyer's progress dots. The stylesheet would have looked almost right and been
wrong in the places that carry the new brand colour.

Taken as 14 to 628. Verified identical to the source range.

## 2. The red rule, re-verified against v21

**On the office screen the three-place rule holds exactly**, and that is where
it was written for: `.kpin.hot` is the stuck-money KPI, `.agebar.hot` is the
ageing bars, `.wrow .days b.h::after` is the dot on a late row. All three are
implemented and nothing else on that screen is red.

**v21 itself uses red in more places than three**, and they are all on the
buyer's screen, not head office: `.duebar` and `.duebar .dtx strong` for the
next-payment bar, `.marks i.due` for the stage dot that is due, and `.mega.hot`
for the amount due, which v21 renders at line 1305. `.chip.late` and `.offbar`
are red too.

The instruction was to match v21's markup and to re-verify the rule. Those pull
in opposite directions on the buyer screen, and the design reference won: the
buyer's amount due and due-bar are red, as v21 draws them. This is the same
judgement `DECISIONS.md` recorded under v15, where the prototype rendered the
raised demand as `mega hot` and it was kept. **If the rule is meant to bind the
buyer screen as well, it is one conditional in `buyerScreen` and one in the
`.duebar` line.** Flagged rather than silently conformed to either reading.

One tightening: the stage amount is now red only when the stage is actually
`demanded`. It used to redden for `marked` and `certified` too, which meant a
stage nobody had billed yet was shown in the colour of money owed.

## 3. v21's own top bar is invisible, and the fix is in markup

`.bm` is `color:#FFF` and v21's `logo(size,light)` is called with `light=true`,
which paints the mark `#FFF` as well. Both sit on a `#F6F9FC` body, so in v21
the brand mark and the word "Plint" are white on near-white.

The stylesheet is a verbatim extraction and is not mine to edit, so the colour
is supplied in the markup instead: the mark is drawn with `var(--brand)` and
`.bm` carries an inline `color:var(--ink)`. The CSS file stays byte-identical
to the source range. Worth knowing that v21's logo helper also still paints
`#1B4DD8`, the **v15** brand blue, in its non-light branch - the helper was not
updated when the palette was.

## 4. Instrument Sans has no rupee sign, so the documents keep Inter

Checked properly, because `DECISIONS.md` already records the trap: the Google
Fonts served face is a latin subset that omits U+20B9, so testing the subset
would have proved nothing about the family.

The **full upstream release** was fetched from `google/fonts`
(`ofl/instrumentsans/InstrumentSans[wdth,wght].ttf`, 190 KB against the 47 KB
served subset) and read with fontkit:

    Instrument Sans, full upstream   501 glyphs   U+20B9 = NO
                                                  control U+0024 $ = YES
    Inter Regular (in assets/)                    U+20B9 = YES, glyph 1317

The control matters: the same font answers yes for `$`, so the no for U+20B9 is
the font and not the test.

**So the screens and the documents now use different faces, deliberately.**
Screens are Instrument Sans, per v21. `src/pdf.js` and `assets/` are unchanged
and stay on Inter, because a demand letter that cannot print `₹` is not a
demand letter. `assets/` was not touched.

If they must match, the options are a fallback face for the glyph alone, or
Instrument Sans with the rupee patched in - both of which change what a legal
document looks like, and neither of which is worth doing without being asked.

## 5. The loan model

v21 is narrower than what the repo had. The builder does not chase documents.

- **The buyer side is a list.** `/documents` renders the fourteen papers his
  bank will ask for - six for a salaried applicant, eight for a
  self-employed one - with the CA sign-off flag on the P&L, and nothing else.
  No upload, no ticking, no submit. `loan.test.js` asserts there is no file
  input, no checkbox and **no `<form>` element at all** on that page, because
  the absence is the feature.
- Applicant composition is not in this schema, so the two applicants that make
  the total fourteen come from the design and are stated as such in the code.
- **The office side records the sanction.** `/office/sanctions` is v21's
  "Sanction not recorded" tab: villa, buyer, lender, how long it has been
  waiting, and three fields - sanctioned amount, own contribution, letter
  reference. Nothing is disbursed against a stage until it is recorded.

## 6. Own contribution is stored per unit, not assumed

**v21 is internally inconsistent about this and neither of its answers was
taken.** Its receipt hardcodes twenty per cent (`const own=amt*0.2`, line
1954); its own sanction sheet says "agreement value less sanction" (line 2360).

It is now `units.own_contribution_paise`, entered off the letter and kept. A
buyer may put in more than the difference, and a lender may sanction against a
valuation rather than the agreement value, so neither a percentage nor a
subtraction is safe. The test records a figure that is deliberately neither -
₹95 L against a ₹2.10 Cr sanction on a ₹3.20 Cr agreement - and asserts it
survives as itself.

At runtime nothing is computed: both figures are typed in. The seed derives a
plausible one as agreement less sanction, once, and says so.

## 7. Recording a sanction adds no RLS policy

`units` carries a SELECT policy and no UPDATE policy, so the application role
cannot write to it at all. Rather than add one - the isolation model is not
mine to widen for a new screen, and the instruction was explicit - this goes
through `record_sanction()`, `SECURITY DEFINER`, which is how every other
privileged write in this schema already works: `login_lookup`, `session_open`,
`demand_settle`, `login_attempt`.

The actor is the transaction identity, never a parameter, for the same reason
`demand_settle` takes it that way. It refuses a non-office caller, an absent
amount, an absent contribution and a blank letter reference.

A `CHECK` makes a sanction all-or-nothing: an amount with no letter behind it
and nobody's name against it is the kind of record that looks like evidence and
is not. The test proves the owning role cannot write half of one either.

It writes an audit row, `action = 'sanction_recorded'`. That adds a third kind
of row **alongside** the certification and settlement triggers without touching
either, and the reconciliation checks in `restore.test.js` filter by action, so
they are unaffected.

## 8. What was NOT touched, as instructed

`src/money.js`, the RLS policies, the audit triggers and the stage schedule in
`db/schema.sql` are all unchanged. Checked rather than assumed: **nothing in
v21 changes a money rule.**

| | v21 | repo |
|---|---|---|
| Stage schedule | `pc:` 10, 15, 10, 10, 10, 10, 10, 10, 8, 7 | 1000, 1500, 1000 x6, 800, 700 bp |
| Agreement value | `AGV=32000000` rupees | 3200000000 paise |
| GST | `gst=dAmt*.05` | 500 bp |
| Payment terms | "due in fourteen days" (line 1096) | `DUE_DAYS = 14` |

Identical throughout. v21 states no interest rate that differs from twelve per
cent a year. `assets/` is untouched.

## 9. The seed draws `sanctioned` from its own generator

The office needs a non-empty "Sanction not recorded" list, so some villas have
a recorded sanction and some do not. Taking that draw from the existing `r()`
consumed one more number per villa and shifted every bank, channel partner and
pack state that followed - 269 demands became 260, and the whole seeded project
quietly rewrote itself to add one field.

It is drawn from a separate `lcg(97)` instead. The existing project is
byte-identical to before: 269 demands, 221 settled. 14 villas end up without a
recorded sanction, which is the same number v21's own `CHASE` list carries.

## 10. Two suites were updated for the new markup, and why

Both existing suites pass. Three assertions in `smoke.test.js` and two
extractors in `reconcile.test.js` were keyed to v15 presentation and had to
move:

- `Payment schedule` became `Stage by stage`, which is what v21 calls it.
- The certifiable-B-14 check keyed on row copy (`B-14 &middot; Blockwork`). It
  now keys on `value="us-B-14-brick"` near a Certify button - **the stage id
  does not move between design revisions and the copy does**. This one was not
  a cosmetic fix: when it silently stopped matching, the test took its
  "certified on an earlier run" branch, certified nothing, and the demand-PDF
  assertion failed two steps later with no hint of the cause.
- The stuck-money KPI is `.kpin.hot` in v21's desktop shell, `.mega.hot` in
  v15's phone frame.
- `reconcile.test.js` scraped every `.amt` on the buyer screen. v21 renders the
  villa summary with the same class, so an unscoped match picked up the
  agreement value and the ledger lines and compared the wrong numbers against
  the schedule. It is now anchored inside `.stage` blocks.

## 11. Scope taken on the office screen

v21's head office is a full desktop application: a dozen tabs, search, sort,
notifications, an owner view, RERA filing. The repo has one worklist and now
one sanction tab, and this pass restyled those into v21's `.desk` / `.side` /
`.wl` shell rather than building the other ten tabs. The instruction was to
make the existing screens match v21's markup and class names, not to implement
v21.

---

# Eighth pass: deployment

## Vercel cannot run this, and the reason is not the process model

The process model is the obvious objection - `src/server.js` is a raw
`http.createServer` holding a connection pool, and Vercel runs request-scoped
functions - but that one is fixable with an adapter.

**The disk is not.** Evidence photographs are content-addressed files under
`PLINT_EVIDENCE_DIR`, written by `src/evidence.js` and read back to build
certificate thumbnails. Vercel's filesystem is read-only except `/tmp`, and
`/tmp` does not survive between invocations. Every uploaded photograph would
vanish, `restore.test.js`'s integrity check would find rows pointing at
nothing, and completion certificates would print "photograph unavailable"
where the evidence should be. That is the product failing, not a deployment
detail.

Transaction-scoped RLS identity would in fact survive a transaction-mode
pooler, since `set_config(..., true)` and the statements that depend on it
travel in one transaction on one connection. It is not the blocker. The disk is.

## Railway, and the reason is superuser

**The deciding test.** Every `SECURITY DEFINER` function in this schema -
`login_lookup`, `session_open`, `session_lookup`, `login_attempt`,
`demand_settle`, `record_sanction` - is owned by the role that owns the
tables, and those tables carry `FORCE ROW LEVEL SECURITY`. `FORCE` means the
owner is subject to the policies too. On this machine `plint_owner` is a
superuser, which bypasses RLS and hides what happens when it is not.

Built the case that managed Postgres actually gives you - a non-superuser
database owner - and probed it directly:

    building as: probe_owner | superuser: false
    owner selecting users directly, FORCE on, no identity: 0 rows
    login_lookup equivalent returned: 0 row(s) -> LOGIN WOULD FAIL

**Nobody could sign in.** Not a degraded mode: `login_lookup` returns zero
rows for every credential, because the definer is the non-superuser owner and
`u_self` grants nothing without an identity, and there is no identity yet
during login. This would have passed every local test and failed on the first
click of the demo.

Two more, found on the way and confirmed:

- `db/bootstrap.js` runs `ALTER ROLE ... NOSUPERUSER NOBYPASSRLS`, and clearing
  `SUPERUSER` requires superuser. `CREATEROLE` is not enough.
- The migrations grant to the literal name `plint_app`, twenty references
  across nine files, and forward-only migrations cannot be retroactively
  parameterised. The runtime role has to carry that name.

So the platform requirement is not "managed Postgres". It is **Postgres where
we own the superuser**.

| | long process | disk | superuser Postgres |
|---|---|---|---|
| Vercel | no | **no** | n/a |
| Render | yes | yes, paid | **no** - you get a database owner |
| Neon / Supabase | n/a | n/a | **no** - owner, not superuser |
| Railway | yes | yes, volumes | **yes** - Postgres runs as a container you own |

Railway. Its Postgres is a container in your project running as `postgres`,
so the two-role model, `FORCE` RLS and the definer functions all work exactly
as tested, with no change to the security model.

**The alternative was to weaken the schema to suit the platform** - drop
`FORCE` on `users` so a non-superuser owner can read past it. That is a real
option and it is not obviously wrong, since `plint_app` is not the owner and
is bound by RLS either way, making `FORCE` defence in depth rather than the
boundary. It was rejected because a platform exists that does not require it,
and relaxing an isolation control to fit a host is the wrong direction of
travel. If Railway is ever swapped for Neon or Render, this is the change that
has to be made, and it should be made deliberately.

## What was built

- **`Dockerfile`** - Node 22, `npm ci --omit=dev`, evidence directory at
  `/data/evidence` for a mounted volume, runs as `node`, entrypoint
  `scripts/deploy-start.js`. **Not built locally**: there is no Docker daemon
  on this machine. Railway's build will be its first. `npm ci --omit=dev` and
  a boot with production dependencies only were verified directly.
- **`railway.json`** - Dockerfile builder, health check on `/health`, one
  replica. One, because the service has a disk attached and the evidence store
  is not shared.
- **`scripts/deploy-start.js`** - bootstrap, migrate, seed if asked and if the
  database is empty, **verify TLS**, then serve.
- **`DATABASE_URL` support in `src/config.js`** - platforms hand you one
  connection string and it is the **owning** role. It fills the admin half
  only. `PGUSER`/`PGPASSWORD`, the runtime role that cannot bypass RLS, stay
  separate and still have no default. Buyer isolation does not get to depend
  on which variable a host happened to set.
- **`start()` exported from `src/server.js`** so the entrypoint can migrate
  first and then start the same server rather than reimplementing the block.
- **A role-name guard in bootstrap.** `PGUSER` other than `plint_app` now
  fails at boot, because the failure it prevents is silent: the role is
  created, the server connects, and every query returns nothing, since the
  grants and policies name a different role.

## TLS is verified at boot, not assumed

The entrypoint opens the runtime connection and reads `pg_stat_ssl`, the same
check `tls.test.js` uses. If the link is not encrypted it refuses to serve.
"Managed Postgres with TLS" is a claim about a running system, and a client
asking for TLS is not the same as getting it. `PLINT_ALLOW_PLAINTEXT_DB=1`
overrides it for a genuinely private link, deliberately, with a name that says
what it is.

Verified locally against the WSL cluster, which rejects plaintext:

    ── database TLS
      encrypted, TLSv1.3

## What was verified locally, end to end

Against a fresh database, with no `.env`, `DATABASE_URL` only, `NODE_ENV=
production`, `PGSSLMODE=require`:

- bootstrap created the database and role; migrate applied all nine; seed ran
  and reconciled 269 demands to 269 audit rows, 221 settled to 221.
- Run again on the populated database: nine migrations skipped, seed skipped
  on 48 villas already present, still served. Idempotent.
- TLS verified TLSv1.3.
- All three logins work, and the cookie carries
  `HttpOnly; Path=/; SameSite=Lax; Max-Age=43200; Secure` - `Secure` because
  `NODE_ENV=production` and `PLINT_INSECURE_COOKIES` is unset, which is what
  will be true behind Railway's HTTPS.

## Two defects found by deploying rather than by reading

- **The engineer's sidebar linked to office pages.** `desk()` had one fixed
  nav, so a certifying engineer was offered "Stuck money" and "Sanction not
  recorded", both of which 404 for him. The nav is built from the role now.
  Only running it as each of the three roles showed this.
- **My own patch failed silently.** The edit that added `.start()` to the
  entrypoint never applied - the same backslash mangling this shell does to
  quoted heredocs - and the script printed a success message it had not
  earned, because I did not assert the replacement. The symptom was a
  container that migrated, seeded, logged "serving" and exited 0 without ever
  listening, which on a platform would have looked like a crash loop with no
  error. Asserted patches, or the Edit tool, for anything containing an escape.

## Not done, and why

Nothing has been deployed. Creating a Railway project, provisioning Postgres
and a volume, and attaching a payment method all need the account holder.
`PLINT_SECRET`, the database URL and the runtime role password are set in the
platform's own variable store and **no secret was written to the repository** -
`.env` remains untracked and `.env.example` remains empty of values.

---

# Ninth pass: free tier. Render, and the schema change that makes it possible

No card. That removes Railway, and it removes Fly.io too - **Fly requires a
payment method before it will deploy anything**, even inside the free
allowances. Its Postgres would have suited this app best, because you get a
real superuser in a container you own.

So: **Render free web service plus Render free Postgres.**

## The blocker had to be fixed, not worked around

Last pass established that every `SECURITY DEFINER` function here is owned by
the role that owns the tables, that eight tables carried `FORCE ROW LEVEL
SECURITY`, and that `FORCE` binds the owner too - so on a non-superuser owner
`login_lookup` returns zero rows and **nobody can sign in**. Render's free
Postgres gives a database owner, not a superuser. Railway was chosen precisely
to avoid this.

Without a card that escape is gone, so the schema had to change.

**Migration 010 drops `FORCE` on the nine tables that carried it.** RLS itself
stays `ENABLE`d on every one.

### Why that is not a hole

`FORCE` was never what protects a buyer from his neighbour. The application
connects as `plint_app`, which does **not own** these tables, and ordinary
row-level security binds any role that is not the owner whether or not `FORCE`
is set. `FORCE` closed exactly one further case: the application connecting
**as the owner**, which would then bypass RLS entirely.

That case is now closed by assertion instead. `db/bootstrap.js` gained
`assertIsolationHolds()`, which runs at every boot - and again after
migrations, from the deploy entrypoint - and refuses to start if the runtime
role owns any table, is a superuser, holds `BYPASSRLS`, or if any table has
RLS switched off. A refusal to start is a better answer than a flag the
platform will not let us set, because the flag was only ever defence against a
misconfiguration and the assertion catches the same misconfiguration louder.

`restore.test.js` used to assert `FORCE` survived a restore. It now asserts the
thing that actually guarantees isolation: the restored `plint_app` is not a
superuser, does not hold `BYPASSRLS`, and owns none of the tables.

### Proven, not assumed

Built the database Render will hand us - a **non-superuser owner** - and ran
the whole stack against it:

    bootstrap: cannot set role attributes here (permission denied to alter
               role); they will be verified instead
    bootstrap: isolation verified - plint_app is not an owner, not a
               superuser, not BYPASSRLS
    migrate: applied 10
    seeded 48 units
      demands 269 -> audit certified 269
      settled 221 -> audit settled   221
    ── database TLS
      encrypted, TLSv1.3

    isolation suite: 24 passed, 0 failed
    arjun@example.in    -> Villa B-14
    ramachandran@nvt.in -> Sign-off and evidence
    priya@nvt.in        -> Stuck money
    B-14 buyer -> /villa/A-07  HTTP 404
    B-14 buyer -> /office      HTTP 404

`bootstrap` also had to stop insisting on `ALTER ROLE ... NOSUPERUSER`, which
requires being a superuser. It attempts it, and where the platform refuses it
says so and falls through to verifying the same facts.

`ensureDatabase` now asks the target database directly before reaching for the
`postgres` maintenance database, because on a managed platform the database
already exists and we may have no rights there at all.

## The remaining unknown, and the probe for it

The single thing that decides whether **any** Postgres can run this safely is
whether it will let us create a **second role**. With one role the server must
connect as the owner, an owner bypasses RLS, and every buyer sees every villa.

I cannot test Render's free Postgres without an account, so rather than assert
it, `scripts/preflight.js` answers it in about ten seconds against any
connection string: connects, reports superuser/bypassrls/createrole, checks
TLS, creates a probe role and a probe table, and verifies that **a non-owner
role with no identity sees 0 of 2 rows**. It drops everything it made.

It found a bug in itself on the first run, which is the reason it reports the
user it connected as: passing `user` alongside `connectionString` to `pg` does
**not** override the string, so the "non-owner" connection was silently the
owner and the check reported the opposite of the truth.

## What breaks on the free tier

Written up for the demo in `docs/DEPLOY.md`. The one that matters:

**There is no persistent disk.** Disks are a paid feature on Render, so
`PLINT_EVIDENCE_DIR` points inside the container. Uploaded photographs are lost
on every deploy, every restart, and every cold start after the service sleeps.

The failure is graceful and was already designed for: the evidence **rows**
survive with their captions, GPS and hashes, `/evidence/<hash>` returns 404,
and the completion certificate prints "photograph unavailable" in the thumbnail
box rather than failing to render. The seeded 48 villas never had image files,
only rows, so nothing that ships in the seed is affected. **Upload photographs
during the demo, not before it.**

Also: the service sleeps after ~15 minutes idle with a ~50 second cold start,
and Render's free Postgres is deleted after 30 days. Sessions are in the
database, so a cold start does not sign anyone out - which is what makes a
sleeping service tolerable, and is the first punch-list item paying off.

## Not done

Nothing is deployed. Creating the Render account, connecting the repository and
clicking Apply need the account holder, and the repository still has to reach
GitHub first. `PGPASSWORD` and `PLINT_SECRET` are declared `generateValue: true`
in `render.yaml`, so Render mints them itself and **no secret is typed into or
stored in this repository**.

---

# Tenth pass: Supabase for the database, Render for the process

Split by instruction for the database, and by elimination for the process.

## The Node process stays on Render

Nothing changed about what the app needs: a host that keeps a process alive,
because `src/server.js` is a long-lived `http.createServer` holding a pool and
setting a transaction-scoped identity per request, and a filesystem that
survives a request, because evidence photographs are content-addressed files
read back to build certificate thumbnails.

That rules out Vercel and Netlify on both counts. **Fly.io and Railway both
require a payment card** before they will deploy anything, even inside their
free allowances. Render's free web service is the remaining host that runs a
long-lived container with HTTPS and no card, and its blueprint was already
written and reviewed. Keeping it means the only thing that changed this pass is
where the database lives.

## Supabase over Render's own Postgres

Two reasons, and the first is the one that matters for a demo.

**Render's free database is deleted 30 days after creation.** Not paused —
deleted. Anything demonstrated from it has an expiry date. Supabase's free
project pauses after about a week of inactivity and resumes on demand, with the
data intact.

**Supabase's `postgres` role has more latitude than Render's database owner.**
That matters here more than it usually would, because of what migration 010
did: dropping `FORCE ROW LEVEL SECURITY` moved the entire isolation boundary
onto the fact that the server connects as a role which does not own the tables.
Creating that second role is now the single capability the whole security model
depends on. A database that will not allow it cannot run this application
safely at all - the server would have to connect as the owner, and an owner
bypasses RLS.

## What I have NOT verified, and will not assume

**Whether Supabase allows the second role.** I have no connection string: the
project does not exist yet, and no credential for it is on this machine. So
`scripts/preflight.js` has not been run and I am not going to claim Supabase
works until it has been.

This is the whole reason that script was written last pass. It creates a probe
role and a probe table, checks that a non-owner role with no identity sees 0 of
2 rows, and drops both. If it reports a blocker the deployment stops there.

The credential is to be dropped into a git-ignored `.env.supabase` rather than
pasted into the conversation - it is a live database password. `.gitignore` now
covers `.env.*` with `.env.example` excepted, so no variant of it can be
committed by accident.

## The connection string has to be the Session pooler

Supabase offers three and only one is right:

- **Direct connection** is IPv6-only on new projects; Render's free egress is
  IPv4, so it will not connect at all.
- **Transaction pooler** (6543) drops session state between statements.
  Plint's identity is transaction-scoped so it would *probably* survive, since
  `asUser` wraps everything in one explicit transaction. "Probably" is not a
  basis for buyer isolation.
- **Session pooler** (5432) is IPv4 and keeps a real session. This one.

Recorded because getting it wrong produces two different confusing failures -
a connection that never establishes, or one that works until it does not.

## `render.yaml` changes

The `databases:` block is gone. `DATABASE_URL` becomes `sync: false`, so Render
prompts for it once and stores it in its own dashboard. It is the **owning**
role; `db/bootstrap.js` creates the runtime role from it, and `PGPASSWORD` and
`PLINT_SECRET` are still `generateValue: true` so Render mints them.

**One value is typed by hand, into Render's dashboard, and no secret is in this
repository or in this conversation.**

## Still not done

Nothing is deployed. Creating the Supabase project, copying its Session pooler
string, and applying the Render blueprint all need the account holder. The
preflight is the gate before any of the Render work is worth doing.

---

# Eleventh pass: Supabase verified, and two faults the preflight exposed

The preflight ran against the real Supabase project. **Supabase can run this**,
but its first verdict line said "usable, with 2 warnings" and that was wrong -
the script was too lenient about its own failures, and both warnings turned out
to be real faults in this repo rather than in Supabase.

## What the probe actually found

    connected as postgres to postgres
    PostgreSQL 17.6      superuser: false   bypassrls: true   createrole: true

    TLS                        ✗ NOT encrypted on this endpoint
    Two roles                  ✓ CREATE ROLE works
    RLS binds a non-owner      ✗ could not test: (ENOIDENTIFIER) no tenant
                                 identifier provided
    Schema                     ✓ CREATE SCHEMA works

Two of those needed chasing rather than accepting.

### 1. "NOT encrypted" was my check measuring the wrong hop

`pg_stat_ssl` reports the connection **the backend** sees. Behind Supabase's
Supavisor pooler that is the pooler-to-Postgres hop, inside their network and
unencrypted. The hop that carries our credentials across the public internet is
client-to-pooler, and asking the socket directly shows what it really is:

    client socket encrypted: true (TLSv1.3)
    pg_stat_ssl says: false   <- the pooler-to-Postgres hop, not ours

So `scripts/deploy-start.js` would have refused to serve a perfectly encrypted
connection. It now asks its own socket first and reports both, and only refuses
when neither is encrypted.

Worth recording separately: **the pooler accepts a plaintext connection if the
client asks for one.** TLS here is the client's responsibility, which is why
`PGSSLMODE=require` is set in `render.yaml` and why the boot check stays.

### 2. "could not test" was hiding the question that matters most

The RLS check did not fail - it never ran, and the script counted that as a
warning. The single most important property in this application went
unverified while the summary said "usable". A check that cannot run is not a
check that passed.

The cause is a real constraint: Supavisor identifies the project from the
**username**, so a bare role name is rejected with `ENOIDENTIFIER`. Connecting
as `plint_probe.<projectref>` works, and then:

    connected as plint_probe_pewuf, superuser=false, bypassrls=false
    rows visible with no identity set: 0 of 2  <- RLS BINDS IT

That is the answer that was missing. Buyer isolation holds on Supabase.

## The code change that follows from it

**The connection username and the database role are not the same string.** The
server connects as `plint_app.<projectref>`; the role inside Postgres is plain
`plint_app`, which is what all twenty grants and every policy name.

`db/bootstrap.js` conflated them - it used `PGUSER` verbatim for `CREATE ROLE`,
for grants, and for the "must be named plint_app" guard, so on Supabase it
would have tried to create a role called `plint_app.gfoid...` and then the
grants would have applied to a role that does not exist. The server would have
connected successfully and seen nothing at all, which is exactly the failure
that guard was written to prevent.

It now takes the part before the first dot as the role and leaves `PGUSER`
whole for the connection. On a platform without a pooler suffix the two are the
same string and nothing changes.

## Supabase's `postgres` role holds BYPASSRLS

Noted because it is a hazard worth naming: `rolbypassrls: true` on the owner.
That is fine and in fact necessary - migrations and the seed have to write past
the policies - but it means connecting the *application* as `postgres` would
silently disable buyer isolation entirely. `assertIsolationHolds()` checks the
runtime role for exactly this and refuses to start, and the newly created
`plint_app` inherits none of it (`bypassrls=false`, confirmed above).

## Verified end to end against the real project

Not simulated. Against `aws-0-ap-south-1.pooler.supabase.com`:

    bootstrap: created role plint_app
    bootstrap: cannot set role attributes here (permission denied to alter
               role); they will be verified instead
    bootstrap: isolation verified - plint_app is not an owner, not a
               superuser, not BYPASSRLS
    migrate: applied 10
    seeded 48 units
      demands 269 -> audit certified 269
      settled 221 -> audit settled   221
    ── database TLS
      our connection: encrypted, TLSv1.3
      backend reports: not encrypted (expected behind a pooler)

    health: {"status":"ok","database":"up"}
    arjun@example.in    -> Villa B-14
    sharma@example.in   -> Villa A-07
    ramachandran@nvt.in -> Sign-off and evidence
    priya@nvt.in        -> Stuck money
    B-14 buyer -> /villa/A-07 : HTTP 404
    B-14 buyer -> /office     : HTTP 404

**The database half of the deployment is done and proven.** Render only has to
run the container.

## Left as it is

`scripts/preflight.js` still prints "usable, with warnings" for a run where the
RLS check could not execute. Making "could not test" fatal, and teaching it the
`role.projectref` username form so the check runs on a pooler, is the obvious
follow-up. It is not done: the answer for this database is now known by direct
measurement, and changing the script would not change that answer.

---

# Twelfth pass: the Render crash loop, and why it was ours

`password authentication failed for user "plint_app"` on every deploy, moments
after bootstrap reported the password re-applied. Reproduced locally against
the real Supabase project with the same environment shape, so it was never a
configuration mistake on the platform.

## The cause

`ensureAppRole()` ran `ALTER ROLE plint_app LOGIN PASSWORD ...` on **every
boot**, whether or not the password had changed. In plain Postgres that is a
harmless no-op. Behind Supabase's pooler it is not.

**Supavisor caches the credential it authenticates clients against.** After an
`ALTER ROLE ... PASSWORD` it keeps rejecting the new password for a minute or
two, so the server that has just set the password cannot then use it. Measured
directly:

    bootstrap: role plint_app already present, password re-applied
    app connect immediately after   -> password authentication failed
    ...
    t+  0s : OK      (same password, ~90s later)
    t+ 15s : OK
    t+ 30s : OK

An earlier test of exactly this had "passed" only because minutes of wall clock
separated my two commands. Running them back to back is what exposed it - and
back to back is what a deploy does.

## The fix, in two halves

**Do not touch a password that already works.** Bootstrap now tries to log in
as the runtime role first, and only sets the password when it cannot. A deploy
that changes nothing now invalidates nothing, which removes the failure window
entirely from the common case.

**When it does have to set the password, wait for it to take effect.** The boot
polls its own credential every ten seconds for up to two and a half minutes and
refuses to start if it never works. Measured on the real project: the password
became usable after **14 seconds**, and bootstrap took 24 seconds end to end.

Booting into a window where the credential is known not to work yet, and
letting the platform restart the container over and over, is worse than waiting
for it.

## The variables were also doing harm

The user had set `DATABASE_URL` **and** `PGHOST`, `PGPORT`, `PGDATABASE`,
`PGADMINUSER`, `PGADMINPASSWORD`, `PGUSER`. The parser was gated on
`!process.env.PGHOST`, so setting `PGHOST` silently disabled `DATABASE_URL`
entirely and every value had to be right by hand, including the pooler suffix
on `PGUSER`.

Now `DATABASE_URL` is always parsed, anything set explicitly still wins, and
**`PGUSER` is derived**: the runtime role is always `plint_app`, so it takes
whatever suffix the owner carries. `postgres.<ref>` gives `plint_app.<ref>`; a
plain `postgres` gives `plint_app`. Nobody has to know that Supavisor
identifies a project from the username.

That reduces what a deployment must be told to `DATABASE_URL`, `PGPASSWORD`
and `PLINT_SECRET`, and the last two are generated by the platform.

## Verified against the live project

Both paths, not one:

- **Password unchanged:** `role plint_app present, its password already works`,
  no ALTER issued, credential confirmed in 2s.
- **Password changed**, as Render's `generateValue` supplies on a first deploy:
  detected the failure, set it, waited 14s, confirmed, verified isolation. The
  app then connected immediately and saw **0 rows with no identity set**.

Then the whole entrypoint in Render's exact configuration - `DATABASE_URL`
alone, `NODE_ENV=production`, `PGSSLMODE=require`, nothing else by hand:
migrations up to date, TLSv1.3, health 200, and all three logins landing on
their own screens.

148 assertions still green locally.

# Thirteenth pass: an installable app that deliberately works badly offline

## The buyer screen was a phone card on a 27-inch monitor

`plint.css` is v21 verbatim and gives `.phone` a fixed 392px. That is right for
the design file, where the phone is a prop sitting next to a desk view. It is
wrong for the running application, where the buyer opening Plint on a laptop
got a narrow strip in the middle of the screen.

v21 already carries a `.phone.wide` variant with desktop paddings above 900px
that collapses back to 392px below it, so the buyer screens now render
`phone wide solo`. The extra `solo` class is ours: `wide` alone goes to 1160px,
which is right for the office worklist and far too wide for one column of a
buyer's own villa. `public/app.css` caps it at 860px.

**`plint.css` is still not edited.** Everything the running app needs beyond the
design file lives in `app.css`, loaded after it. Measured in Chrome at a 1910px
viewport: wrap 1340px centred, card 860px centred inside it.

## What the service worker caches: the shell, and nothing else

Every screen in Plint is server-rendered HTML behind a session cookie, and the
content is one buyer's financial position. **A service worker cache is keyed by
origin, not by session, and it outlives sign-out.** Cache a villa page and the
next person to open the app on that phone - the buyer's spouse, a colleague,
whoever the device is handed to - can be served it while offline, with no
session and no way for the server to intervene.

So the cache is an explicit allowlist of ten static files: two stylesheets, six
icons, the manifest, and one offline page. Everything else is network-only.
The list is written out rather than pattern-matched, so adding a route can
never silently make it cacheable, and `test/pwa.test.js` fails if anything
under `/villa`, `/office`, `/engineer`, `/doc`, `/evidence`, `/login` or
`/logout` appears in it, or if a non-asset does.

This buys less offline function than a demo would like. It is the right trade
for an application whose entire product is an evidence trail about money, and
the offline page says so to the person looking at it.

## Sign-out clears the cache, then puts the shell straight back

Clearing alone looked correct and was not. Verified in Chrome: after a
sign-out the cache refilled lazily from whatever the next page requested and
settled at **four of ten entries with no `/offline`** - so the first person to
lose signal after someone signed out would have got the browser's error page
instead of ours. The handler now deletes every cache and re-adds the shell in
the same turn. Re-verified with a sentinel entry: sentinel gone, ten entries
back, `/offline` among them.

## The registration failure the embedded browser reported, and the one it hid

`navigator.serviceWorker.register('/sw.js')` fails in the Claude preview pane
with *"An unknown error occurred when fetching the script"*, while the server
log shows that same request answered `200`. In real Chrome on the same origin
and the same port it registers, activates, and takes control. The pane is not
a service worker host; that is not a defect in this app.

It was findable only because the `.catch(function () {})` I wrote first was
changed to log. **A swallowed failure in a feature whose whole point is that it
works when nothing else does is worse than no feature.** It now warns.

## What was tested where

Ten assertions in `test/pwa.test.js` run in `npm test` against the served
routes and the worker's source: manifest validity, both icon sizes in both
`any` and `maskable` purposes with the bytes checked to really be PNGs, the
head tags on every page, `no-cache` on `/sw.js` because it is the update
channel for an installed app, and the allowlist rules above. Five mutations
confirmed they can fail, including adding `/villa/B-14` to the shell (3 fail)
and dropping the maskable icons (1 fail).

The parts a Node process cannot observe - registration, activation, cache
contents, the offline fallback - were driven in real Chrome against a running
server, with the server **stopped** to produce a genuine offline navigation.
Result: the offline page rendered, styled, from cache; the manifest and icons
answered from cache; a demand PDF threw. See CLOSEOUT.md for the plain list.

## Not done here

The `@media (display-mode: standalone)` rules - full-bleed layout, no fake
status bar, safe-area padding for the notch - are asserted by the media query
and by the rules being present. They have not been observed on an installed
app, because installing one is a step on the user's device.

# Fourteenth pass: what the deployed URL showed that localhost could not

## The live site was behind, and I misdiagnosed why

`https://plint-o0vr.onrender.com/sw.js` answered **302**, not 200 - the old
build has no such route, so it fell through to the catch-all redirect. Nothing
about the service worker was live.

I found `autoDeploy: false` in `render.yaml`, with **no reason recorded
anywhere**, and concluded that was the cause. **It was not.** A Docker build on
Render's free plan takes six to thirteen minutes, and both pushes deployed on
their own while I was writing: `186dddf` was committed at 11:59 and was live by
12:05, with no dashboard step from anyone. The service is not blueprint-synced,
so that line in `render.yaml` was never in effect at all.

Two things to keep separate. `autoDeploy: true` is still the right value and
still stands, because the file should not say the opposite of how the service
behaves - but it fixed nothing, and the honest reason the URL looked stale is
that **I checked it about ninety seconds after pushing**. A free-tier Docker
deploy is slow enough that "the push did not deploy" and "the push has not
deployed *yet*" are indistinguishable without waiting. Wait, or read the
dashboard; do not infer a cause from a config file that happens to be nearby.

The `no reason recorded` complaint about the original `autoDeploy: false` still
holds on its own terms. It just was not the bug.

Worth naming the near-miss: a service worker script served through a redirect
fails registration with an opaque error. Had the route existed and 302'd, the
failure would have looked exactly like the one the preview pane produces, and
I would have gone looking in the wrong place.

## The cache name was a constant, which made it a bug

`const VERSION = 'plint-shell-v1'` shipped in the previous pass. On localhost
it is invisible. On a URL that gets deployed to more than once it is a defect
with no recovery path:

- the cache is keyed by URL;
- none of `/plint.css`, `/app.css` or the icons carries a version in its URL;
- the fetch handler is cache-first for exactly those files, so after the first
  hit it never asks the server again;
- and `activate` only deletes caches whose name is *not* VERSION.

So an app installed today would still be running today's stylesheet after every
future deploy. For ever. There is no cache-busting header that fixes this,
because the worker never issues the request.

VERSION is now `plint-shell-<BUILD>`, where **BUILD is a hash over the bytes of
every file in the shell**, computed once at boot and substituted into `/sw.js`
as it is served. One byte changes anywhere in the shell and the worker opens a
new cache, fills it, and deletes the old one. `src/server.js` refuses to start
if `public/sw.js` does not declare the placeholder - anchored on the exact
declaration line, because a looser check passed happily while VERSION had been
hardcoded back to a constant, which is a mutation I actually ran.

## Filling the new cache from the old bytes would have defeated it

`cache.addAll(SHELL)` fetches through the browser's own HTTP cache. A new
VERSION would have opened a new cache and filled it from the same week-old copy
the HTTP cache was holding. The shell is now fetched with
`new Request(url, { cache: 'reload' })`, which goes past it.

## The stylesheets were lying about being immutable

`public, max-age=604800` on a URL with no version in it means a browser holds
whatever it had when the deploy landed, for a week, and is right to. That is
fine for an icon and wrong for a stylesheet. Both `.css` files are now
`no-cache` - held, but revalidated - and every static file carries an **ETag**,
so the revalidation costs a 304 rather than a download. The icons keep the long
life: a stale mark for a week is cosmetic, a stale stylesheet is a broken
screen. Static files are now read and hashed once at boot rather than off disk
per request.

## Proved end to end, in Chrome, not asserted

The whole chain was run against a real browser and a real server:

1. Install: cache `plint-shell-617011eb93bc`, ten entries, matching the
   server's own `BUILD`.
2. One byte appended to `public/app.css`, server restarted - `BUILD` moved to
   `5f7ebbcd3dc4`.
3. Reload: the old cache **gone**, the new one present with ten entries, and
   the edited stylesheet **actually inside it**. That last check is the one
   that matters; without `cache: 'reload'` it is the step that fails.
4. `public/app.css` restored, `BUILD` back to `617011eb93bc`.

Then the server was stopped mid-session for a genuine offline run: navigation
to `/office` rendered the offline page, styled from cache; the villa screen,
the office worklist, a demand PDF, an evidence photograph and a sign-in were
all unreachable; the stylesheets, manifest, icons and offline page all
answered 200 from cache.

Five more mutations, all caught: the cache name back to a constant, `BUILD`
frozen to a literal, the ETag dropped, `no-cache` back to `IMMUTABLE`, and the
304 branch disabled. A sixth - dropping `cache: 'reload'` - was **not** caught
by any behavioural test, because no Node process can observe a browser's HTTP
cache; it is held by a source assertion instead, and that is stated in the test
rather than hidden.

162 assertions, fourteen suites, green from a clean database.

## The ETag comparison was wrong, and only the deployed URL could show it

`if (req.headers['if-none-match'] === a.etag)`. String equality. Correct on
localhost, wrong on every origin this app is actually served from.

The proxy in front of Render compresses text responses and rewrites the ETag to
its **weak** form. The server issues `"ff82fad949bbb584"`; the client is handed
`W/"ff82fad949bbb584"`; it sends that back; the equality fails; the server
returns 200 with the whole body. Measured against the live URL - the exact ETag
the server had just issued came back as **200 and 45,537 bytes**, while the
strong form of the same validator returned 304 and zero.

`If-None-Match` was never a string comparison. RFC 9110 s8.8.3.2 specifies the
**weak** comparison function, over a **list**, with `*` matching anything. The
code now does that.

This is worse than it sounds, and it is my doing twice over: the same pass that
introduced the bad comparison also changed the stylesheets from a week-long
`max-age` to `no-cache`, which makes revalidation happen on **every single
navigation**. So the failure was not an occasional extra download. It was 45KB
of CSS on every page load, on a phone, for every user, on the free plan whose
whole constraint is that it is small and slow.

The test now sends every form a real client sends - strong, weak, in a list on
either side, and `*` - and asserts a 304 with an empty body for each, plus a
200 for an ETag the server never issued. Three mutations confirmed it fails:
back to `===`, dropping `*`, and dropping the weak-form stripping.

**The general lesson, which is the reason this pass exists.** Localhost has no
proxy, no compression layer, and no CDN. Three defects in this feature -
the constant cache name, the immutable stylesheet, and this - were all
invisible until the code ran on a real origin, and all three were shipped
green. A local suite proves the code does what it says. It cannot prove the
network agrees.
