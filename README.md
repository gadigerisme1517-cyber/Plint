# Plint

Stage-payment evidence and disbursement for residential construction.
Work done on site, money moved at the bank.

## Run

Requires PostgreSQL 16 and Node 22.

```bash
createdb plint
psql -d plint -v ON_ERROR_STOP=1 -f db/schema.sql   # tables, RLS, plint_app role
node db/seed.js                                     # 48 villas, three logins
npm install
node src/server.js                                  # http://localhost:3000
```

`db/seed.js` connects as a superuser to write past RLS. Everything else
connects as `plint_app`, which cannot.

## Test

```bash
node test/isolation.test.js   # 24 assertions, buyer isolation at the database
node test/smoke.test.js       # 14 assertions, three logins end to end, writes both PDFs
```

`isolation.test.js` runs against the real database as the real application
role. It was written and passing before the buyer screen existed.

## Logins

| Email | Role | Password |
|---|---|---|
| arjun@example.in | Buyer, villa B-14 | plint |
| ramachandran@nvt.in | S. Ramachandran, certifying engineer | plint |
| priya@nvt.in | Priya Menon, head office | plint |

## Layout

```
db/schema.sql          tables, row-level security, the plint_app role
db/seed.js             NVT Eterna Phase 1, 48 villas, deterministic
src/money.js           the only place a rupee is computed
src/db.js              pooling, transaction-local identity, scrypt passwords
src/pdf.js             demand letter, completion certificate
src/server.js          routes and the three screens
public/plint.css       lines 14-609 of plint-v15.html, unchanged
assets/                Inter TTF, embedded in the documents
test/                  isolation, then everything else
DECISIONS.md           every rule inferred because the brief was missing
```

## The chain

A supervisor marks a stage complete on site with stamped photographs. Nothing
moves. A qualified engineer opens the stage, sees the photograph count, and
signs. That signature is the only event that raises a demand: the calculation
layer prices the stage, writes the demand, and the letter and certificate are
generated from the stored figures. The buyer sees the amount and both
documents. Head office sees only who is holding each villa up.
