# Plint

Stage-payment evidence and disbursement for residential construction.
Work done on site, money moved at the bank.

## Run

Requires PostgreSQL 16 or later and Node 22 or later. Developed against
PostgreSQL 18 and Node 24. `sharp` is a native dependency and ships prebuilt
binaries per platform; check it resolves on your deployment target.

```bash
cp .env.example .env      # then fill it in; nothing has a credential default
npm install
npm run setup             # bootstrap the role, migrate, seed 48 villas
npm start                 # http://localhost:3000
```

`npm run setup` is three separate steps and each can be run alone:

```bash
npm run db:bootstrap      # create the database and the runtime role
npm run db:migrate        # apply db/migrations, forward-only, idempotent
npm run db:seed           # development data only
```

`db/migrate.js` is safe to run against a populated database: it applies only
what has not been applied, in a transaction each, and records a checksum. It
never drops anything. `db/seed.js` connects as the schema owner because seeding
has to write past the row-level security every other path obeys; the server has
no path to those credentials.

`db/schema.sql` is the schema as the sandbox shipped it, kept as a historical
record. Nothing runs it. It still opens with `DROP SCHEMA`.

## Test

```bash
npm test
```

Creates a scratch database, bootstraps, migrates, seeds, proves the migrator is
a no-op the second time, runs every suite in its own process, then drops the
database and the temporary evidence directory. Your development database is
untouched.

| Suite | Assertions | What it holds down |
|---|---|---|
| `money` | 22 | rounding, the residual, GST, interest, the ledger |
| `config` | 7 | no credential defaults; the TLS option shapes |
| `isolation` | 24 | buyer isolation, at the database, as the real app role |
| `smoke` | 14 | three logins end to end, both PDFs, the worklist |
| `session` | 8 | sessions survive a restart; sign-out actually revokes |
| `ledger` | 16 | demands immutable; the audit row is written by the database |
| `evidence` | 12 | photographs stored, thumbnailed, readable only by their buyer |
| `pack` | 6 | delivery is recorded, and the copy about it is true |
| `loan` | 11 | the papers list is read-only; a sanction is recorded once |
| `reconcile` | 8 | stored demands, screens and the calculation layer agree |
| `tls` | 7 | the server refuses unencrypted connections |
| `restore` | 6 | a backup restores, and the restore is usable |
| `ratelimit` | 7 | failed sign-ins block; a success clears it; a block survives restart |

`reconcile.test.js` is the one that catches a stage priced outside its
schedule. Villa A-07 is seeded on ₹2,98,76,543.21, which does not divide
cleanly by the stage percentages, so residual allocation and per-stage
rounding give different answers on its last stage. Every other villa is on a
figure where they agree and a mistake would be invisible.

`isolation.test.js` runs against the real database as the real application
role. It was written and passing before the buyer screen existed. If a change
breaks one of its assertions, the change is wrong.

Every test has been checked by mutation: break the behaviour, confirm a test
fails. `npm run audit` runs it. Results are in `DECISIONS.md`.

The audit edits source files in place while it runs, so it takes a lock and
`npm test` refuses to start while that lock is held. Do not run the two at
once; the results are meaningless and look like real failures.

## Backups

See `docs/BACKUP.md`. `npm run backup` takes one; `scripts/restore.sh` restores
it and verifies the restore is usable. The drill runs as part of `npm test`.

## Configuration

Every value comes from the environment; see `.env.example`. No credential
carries a default anywhere in `src/` or `db/`, and a missing one names itself
on stderr and exits 1 before a connection is opened.

Two credential sets, because they are two privileges: `PGUSER`/`PGPASSWORD` is
the runtime role, which is not a superuser, not `BYPASSRLS`, does not own the
tables and holds no `DELETE` grant. `PGADMINUSER`/`PGADMINPASSWORD` owns the
schema and is used by migrations and the seed only.

`PLINT_SECRET` signs session lookups. Rotating it signs everyone out.

`PGSSLMODE` is `disable`, `require`, `verify-ca` or `verify-full`. It defaults
to `require` unless `NODE_ENV=development`, which defaults to `disable`: an
environment that has not said what it is gets the production answer.
`verify-ca` and `verify-full` need `PGSSLROOTCERT` and refuse to start without
one.

`NODE_ENV=development` belongs on a developer machine and nowhere else. It is
what relaxes database TLS.

The development cluster is configured with `hostnossl ... reject`, so an
unencrypted connection to it is refused by the server, not merely discouraged
by the client. `test/tls.test.js` proves it.

The screens use Instrument Sans, per plint-v21. The PDFs stay on Inter because
Instrument Sans carries no U+20B9 and a demand letter has to print `₹`. That
divergence is deliberate; see `DECISIONS.md`.

`PLINT_POOL_MAX` (default 8) sizes the connection pool. `npm test` pins the
isolation suite to one connection so an identity outliving its transaction
cannot hide behind a different backend.

## Logins

| Email | Role | Password |
|---|---|---|
| arjun@example.in | Buyer, villa B-14 | plint |
| sharma@example.in | Buyer, villa A-07 | plint |
| ramachandran@nvt.in | S. Ramachandran, certifying engineer | plint |
| priya@nvt.in | Priya Menon, head office | plint |

## Operating

`GET /health` returns 200 with `{"status":"ok","database":"up"}`, or 503 when
the database does not answer. It runs before session lookup, so a database that
is down reports as down rather than as an authentication failure.

Sign-in is rate limited in the database: five failures per email address and
fifty per network address in a fifteen-minute window, blocking for fifteen
minutes. Only failures count, so a successful sign-in clears the counter and an
ordinary user never meets it. `X-Forwarded-For` is believed only when
`PLINT_TRUST_PROXY=1`.

Logs are one JSON object per line on stdout. Every request line carries the
actor id and a request id. Nothing logs a cookie, a token or a password. An
unhandled error gives the browser only its request id; the stack goes to the
log against that id.

## Layout

```
db/migrations/         forward-only, checksummed, applied by db/migrate.js
db/bootstrap.js        the database and the runtime role. Not a migration.
db/migrate.js          the runner
db/seed.js             NVT Eterna Phase 1, 48 villas, deterministic
db/schema.sql          what the sandbox shipped. Historical. Nothing runs it.
src/config.js          every value from the environment, no credential defaults
src/money.js           the only place a rupee is computed
src/db.js              pooling, transaction-local identity, scrypt passwords
src/session.js         database-backed sessions, HMAC of the cookie token
src/evidence.js        content-addressed photographs, verified on write
src/throttle.js        login rate limiting, counted in the database
scripts/backup.sh      database and photographs, with checksums
scripts/restore.sh     restore, then prove the restore is usable
scripts/mutation-audit.js  break each behaviour, confirm a test notices
docs/BACKUP.md         the backup and restore procedure
CLOSEOUT.md            what is ready, what is not, what was inferred
src/multipart.js       a small form-data reader, so uploads need no dependency
src/audit.js           reads the audit trail. Triggers write it, not this.
src/log.js             structured logs, actor id on every request
src/pdf.js             demand letter, completion certificate with thumbnails
src/server.js          routes and the three screens
public/plint.css       lines 14-628 of plint-v21.html, unchanged
assets/                Inter TTF, embedded in the documents
var/evidence/          uploaded photographs and their thumbnails. Not in the repo.
test/run.js            npm test: scratch database, all suites, drop
DECISIONS.md           every rule inferred, and every choice made since
```

## The chain

A supervisor marks a stage complete on site with stamped photographs. Nothing
moves. A qualified engineer opens the stage, sees the photograph count, and
signs. That signature is the only event that raises a demand: the calculation
layer prices the stage, writes the demand, writes one audit row carrying the
figures as at that moment, and queues the evidence pack for the lender. The
letter and certificate are generated from the stored figures. The buyer sees
the amount, both documents, and only his own villa's photographs. Head office
sees only who is holding each villa up.
