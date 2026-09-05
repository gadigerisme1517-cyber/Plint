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
