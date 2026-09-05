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
