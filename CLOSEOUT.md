# Plint — closeout

Written at the end of the production build, for whoever picks this up next.

Plint records that a construction stage was completed, that a qualified
engineer certified it, and that a demand for money followed from that
certificate. Its value is the evidence trail, not the screens.

`npm test` builds a scratch database, migrates it, seeds it, runs every suite,
and drops it. It is green.

---

## 1. What is production ready

These are built, tested, and have been shown to fail when broken (see §5).

**Buyer isolation.** Enforced in PostgreSQL with `ENABLE` plus `FORCE ROW LEVEL
SECURITY`, not in route handlers. The application connects as a role that is
not a superuser, not `BYPASSRLS`, does not own the tables, and holds no
`DELETE` grant anywhere. A session with no identity sees zero rows on every
table. A buyer asking for a neighbour's villa gets 404, never 403, because 403
would confirm the villa exists.

**The calculation layer.** One file. Integer paise, `BigInt` intermediates,
half-up rounding, percentages as basis points. No screen and no document
performs arithmetic. The ten stages sum to the agreement value exactly, for any
agreement value, because the last stage is the residual.

**Immutable demands.** Two independent locks: the `UPDATE` grant is revoked,
and a trigger refuses any change to the money columns, document number or dates
for every role including a superuser. The single permitted transition is
`demand_settle()`, which takes its actor from the transaction identity rather
than a parameter. Corrections are credit rows.

**Append-only audit trail.** Insert-and-select grants only, plus triggers that
raise on UPDATE and DELETE whoever asks. An actor can only write rows in their
own name. Certification writes exactly one row carrying the figures as at the
moment it was signed.

**Sessions.** In the database, so a restart signs nobody out and a second
instance authenticates cookies the first issued. The cookie carries a random
token; the table stores its HMAC, so reading every row yields no usable cookie.
The application role has no grant on the table at all.

**Evidence photographs.** Content-addressed, verified by reading back off disk
after writing. JPEG and PNG by magic bytes, never by declared type. The client
filename never reaches a path. Reads are authorised by RLS, so a buyer holding
a neighbour's exact hash gets the same 404 as a hash never issued.

**Certificate thumbnails.** Resized through sharp, cached beside the original.
Four 2400×1800 photographs totalling ~5 MB produce a 141 KB certificate.

**Login rate limiting.** In the database, so two instances do not double an
attacker's budget and a restart does not clear it. Five failures per email,
fifty per address. Only failures accumulate. A block refuses the correct
password too.

**Database TLS.** The server rejects unencrypted TCP outright (`hostnossl …
reject`). The client defaults to `require` unless `NODE_ENV=development`.

**Migrations.** Forward-only, checksummed, one transaction each. Running the
migrator twice on a populated database changes nothing. There is no `DROP` in
the path.

**Configuration.** Every value from the environment. No credential default
anywhere. A missing one names itself on stderr and exits 1 before a connection
is opened.

**Backup and restore.** Documented in `docs/BACKUP.md`, and the restore is
rehearsed by a test on every run, including a negative control.

---

## 2. What is NOT production ready

Nothing below is built. Do not deploy believing otherwise.

### Blocking

**No scheduled backups.** `scripts/backup.sh` exists and works. Nothing runs
it, nothing moves its output off the machine, nothing prunes it, and nothing
encrypts it. The dump contains password hashes and every buyer's financial
position in the clear.

**No point-in-time recovery.** No WAL archiving. The recovery point is the last
dump, which for a system of record is probably not good enough.

**No TLS to the browser.** The process serves plain HTTP. Something must
terminate TLS in front of it, and `PLINT_INSECURE_COOKIES` must then be unset
or the `Secure` flag will stop cookies being sent at all.

**The development TLS certificate is self-signed** and `PGSSLMODE=require`
does not verify it. Production wants `verify-full` and a real CA, which needs
`PGSSLROOTCERT`. The code supports it; nothing has exercised it against a real
certificate.

### Serious

**Nothing sweeps.** `session_sweep()` and `login_attempts_sweep()` exist and
are called by nothing.

**No process supervision, restart policy, or log shipping.** Logs are JSON on
stdout on the assumption something collects them. Nothing does.

**No CI.** `npm test` is one command and green; nothing runs it on a push.

**No monitoring or alerting** on `/health`, on the queued pack backlog, or on
demands going past due.

**No pack delivery.** `pack_deliveries` records state, attempts and lender
response. Nothing sends anything. Rows stay `queued`, and the copy says
"queued", which is true. Wiring a real channel means moving rows out of
`queued`.

**No secret rotation.** Rotating `PLINT_SECRET` signs everyone out with no
warning to anybody.

**No load consideration.** Pool defaults to eight connections, uploads buffer
whole in memory, and a thumbnail is generated synchronously with the first
certificate request that needs it.

**`sharp` is a native dependency**, pinned to `0.35.4`. It ships prebuilt
binaries per platform; verify it resolves on the deployment target.

### Known gaps in scope

**No supervisor role.** The brief's item 7 asked for uploads by "the engineer
and supervisor roles". The system has `buyer`, `engineer`, `office`. Suresh
Kumar is a name on `unit_stages.marked_by`, not a login. Uploads are open to
engineer and office.

**`credits` has no screen.** The table exists because "a correction is a new
credit row" is otherwise unimplementable. Nothing renders or writes one outside
the tests.

**Never built at all:** buyer finish selections, warranty and snag flows, the
site-engineer screens, the document-chase list.

---

## 3. What is inferred, not specified

`plint_production_build_brief.md` never arrived. Sections 3, 4, 9 and 10 were
unreadable. **Every money rule below was read off the locked prototype
`plint-v15.html`, not off a specification.** Each needs confirming, and where
the brief disagrees, the brief wins.

| Rule | Value | Where it came from |
|---|---|---|
| Stage schedule | 10/15/10/10/10/10/10/10/8/7 per cent | `MILES` in the prototype |
| Agreement value | ₹3,20,00,000 | `AGV = 32000000` |
| GST | 5 per cent on the construction component | `gst = dAmt*.05` |
| Payment terms | due on the fourteenth day | "due in fourteen days" |
| Late interest | 12 per cent a year, simple, from the day after due | "interest runs at twelve per cent a year" |
| Finish upgrades | ride on the next demand | buyer picks screen |

Consequences chosen because the prototype does not state them:

- **Interest is simple, not compounding**, charged on the total including GST.
  GST is not charged on interest. Both need confirming.
- **Interest accrues in whole days**, floored. An hour late is not a day.
- **The last stage carries the rounding residual**, so the ten stages sum to
  the agreement value exactly.
- **GST is rounded per stage and is NOT residualised.** On an agreement value
  that does not divide cleanly, summed GST differs from GST on the whole by a
  paise or two — two paise on villa A-07, asserted by test. This was left
  deliberately: GST is computed per invoice, and making one invoice absorb nine
  others' rounding is a claim about tax law, not an arithmetic tidy-up.
- **Demands are stored as computed**, so a reissued letter cannot disagree with
  the ledger after a rule change.
- **The stage schedule is data, not code**, keyed by project.

Also inferred: that a buyer sees red for an amount due (the prototype renders
the raised demand as `mega hot`); that a 404 rather than 403 is wanted for
another buyer's villa; that the site supervisor gets no login.

---

## 4. Before you touch the money layer

Read this section. It is the part where a mistake costs somebody money.

**1. `src/money.js` is the only place a rupee is computed.** Not "mostly". If a
screen or a PDF needs a number, it asks for it formatted. Two screens
disagreeing is a bug in the layer, never in the screen. `src/pdf.js` contains
no arithmetic beyond dividing basis points by 100 to print "10 per cent".

**2. A stage cannot be priced outside its schedule.** `stageBase()` prices one
stage alone and is correct only for stages one to nine. The last stage is the
agreement value minus the other nine. Use `M.schedule()` or `M.stageBases()`,
or `M.priceStage()` with `scheduleBps` and `index`. Nothing outside `money.js`
should call `stageBase()`.

**3. Order is load-bearing.** The residual lands on the last element of the
array you pass. Every query feeding these functions orders by `t.seq`. If you
pass stages out of order you will move money onto the wrong stage and nothing
will look wrong.

**4. The layer refuses to guess.** A missing schedule, a hole in it, or an
out-of-range index throws. Do not add a fallback. The previous fallback quietly
priced the last stage alone, which is wrong by one paise — the kind of wrong
that looks right.

**5. Integer paise, always.** No float touches money. Intermediates are
`BigInt`. Percentages are basis points, so 15% is `1500` and never `0.15`.
Rounding is half-up, not banker's.

**6. Villa A-07 is a deliberate probe, not a typo.** It is seeded on
₹2,98,76,543.21, which drifts by a paise under per-stage rounding. Every other
villa is on ₹3.2 Cr, where residual allocation and per-stage rounding give
identical answers and a bug would be invisible on every screen. **If you
"tidy" A-07 onto a round number you disable the test that catches the whole
class of rounding bug.** `reconcile.test.js` asserts A-07 is awkward and fails
if it stops being.

**7. Changing a rule changes only new demands.** Demands store what they were
priced at. A rule change does not restate an issued demand, and must not: a
demand is immutable and a correction is a credit row.

**8. Run the mutation audit after touching the layer.**
`node scripts/mutation-audit.js money` breaks each money rule in turn and
checks a test notices. If a mutation survives, the test you just wrote does not
test what you think.

---

## 5. How much the tests are worth

Every test was audited by mutation: break the behaviour, confirm a test fails.
Results, method and the two equivalent mutations are recorded in
`DECISIONS.md` under "Acceptance audit". Three real gaps were found and closed;
they are named there rather than quietly fixed.

The suites, and what each holds down:

| Suite | Holds down |
|---|---|
| `money` | rounding, the residual, GST, interest, the ledger |
| `config` | no credential defaults; the TLS option shapes |
| `isolation` | buyer isolation at the database, as the real app role |
| `smoke` | three logins end to end, both PDFs, the worklist |
| `session` | survives a restart; sign-out actually revokes |
| `ledger` | demands immutable; audit trail append-only |
| `evidence` | photographs stored, thumbnailed, buyer-only |
| `pack` | delivery recorded, and the copy about it is true |
| `reconcile` | stored demands, screens and the layer agree, to the paise |
| `tls` | the server refuses unencrypted connections |
| `restore` | a backup restores and the restore is usable |
| `ratelimit` | failed sign-ins block; a success clears the count |

`isolation.test.js` was written and passing before the buyer screen existed. If
a change breaks one of its assertions, the change is wrong, not the test.

---

## 6. Things that will surprise you

- **`db/schema.sql` is historical.** Nothing runs it. It still opens with
  `DROP SCHEMA`. The live schema is `db/migrations/`.
- **Roles are not migrations.** A role is cluster-level and its password comes
  from the environment, so `db/bootstrap.js` creates it, not a migration.
- **The seed writes audit rows and pack deliveries** for the history it
  fabricates. It did not, until a restore drill found a database full of
  certified stages that no audit row said anybody had signed.
- **The seed connects as a superuser** because seeding must write past the RLS
  every other path obeys. The server has no path to those credentials.
- **`public/plint.css` is lines 14–609 of `plint-v15.html`, unchanged.** The
  design is locked. Match its class names and markup. Red appears only on the
  stuck-money KPI, ageing dots past 21 days, and the buyer's amount due.
- **The engineer worklist collapses to phone width below 900px.** That is the
  prototype's own media query, not a bug.
- **`npm test` needs PostgreSQL running.** On the machine this was built on it
  lives in WSL2 and does not restart itself; see `DECISIONS.md`.
