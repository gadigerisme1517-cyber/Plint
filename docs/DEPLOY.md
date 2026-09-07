# Deploying Plint on a free tier

- **Database:** Supabase, free plan.
- **Node process:** Render, free web service.

No card for either. Read "What breaks" before you demo from this.

---

## Why this split

**The Node process needs a host that keeps a process alive.** Plint is a raw
`http.createServer` holding a connection pool and setting a transaction-scoped
identity on every request. That rules out Vercel and Netlify, and it is not the
only reason they are out: evidence photographs are content-addressed files read
back off disk to build certificate thumbnails, and neither platform has a
filesystem that survives a request.

**Fly.io and Railway both require a payment card** before they will deploy
anything, even inside their free allowances. That leaves Render's free web
service as the one host that runs a long-lived container with HTTPS and no
card.

**Supabase over Render's own Postgres** for two reasons. Render's free database
is deleted 30 days after creation, which makes it useless for anything you want
to show more than once. Supabase's free project persists — it pauses after a
week of inactivity and resumes on demand rather than being destroyed. Supabase
also gives a `postgres` role with more latitude than Render's database owner,
which matters here more than usual.

**Why it matters more than usual:** Plint needs *two* roles. One owns the
schema and runs migrations; the other is what the server connects as, and it
must **not** own the tables, because an owner bypasses row-level security. With
only one role available the server would have to connect as the owner and every
buyer would see every villa. Migration 010 removed `FORCE ROW LEVEL SECURITY`
so this can run without a superuser, so the two-role separation is now the
whole isolation boundary. `scripts/preflight.js` exists to confirm a given
database allows it, and `db/bootstrap.js` refuses to start the server if it
turns out not to hold.

---

## Step 1. Create the Supabase project

1. **supabase.com** → sign in → **New project**.
2. Name it anything. Region: pick one near you.
3. It will ask you to set a **database password**. Choose one and keep it — it
   is shown once and it is part of the connection string below.
4. Wait for provisioning, a minute or two.

## Step 2. Fetch these values

All of them are on one page: **Project Settings** (the gear, bottom left) →
**Database**.

| What to copy | Exactly where | What it is |
|---|---|---|
| **Session pooler** connection string | Database → *Connection string* → **Session pooler** tab → URI | The database URL the app uses |
| Your database password | The one you chose in step 1 | Goes into the string, replacing `[YOUR-PASSWORD]` |

The string looks like:

```
postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
```

Replace `[YOUR-PASSWORD]` with the password from step 1. That final string is
what Render and the preflight both want.

### Take the Session pooler, not the others

There are three tabs and only one is right:

- **Direct connection** — IPv6 only on new projects. Render's free egress is
  IPv4, so this will simply fail to connect.
- **Transaction pooler** (port 6543) — drops session state between statements.
  Plint's identity is transaction-scoped so it would *probably* survive, but
  "probably" is not what you want holding buyer isolation.
- **Session pooler** (port 5432) — IPv4, keeps a real session. **Use this one.**

## Step 3. Let me check it before you deploy

This is the step that decides whether any of it is safe. Put the string in a
file rather than pasting it into chat — it is a live database password, and the
file is git-ignored:

```bash
cd ~/Documents/Blueprint/plint; Set-Content -Path .env.supabase -Value 'DATABASE_URL=postgresql://postgres.PROJECT:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres' -Encoding utf8
```

Then tell me, and I will run:

```bash
node -e "process.loadEnvFile('.env.supabase')" && node scripts/preflight.js
```

It takes about ten seconds, creates a probe role and a probe table, verifies
that a non-owner role with no identity sees **0 of 2** rows, and drops
everything it made. If it reports `CANNOT run Plint safely`, we stop there.

## Step 4. Deploy the web service on Render

1. **dashboard.render.com** → **New** → **Blueprint**.
2. Connect the GitHub repository `gadigerisme1517-cyber/Plint`.
3. Render reads `render.yaml`: one web service, free plan, no database.
4. It prompts for **`DATABASE_URL`** — paste the Session pooler string from
   step 2. `PGPASSWORD` and `PLINT_SECRET` are `generateValue: true`, so
   Render mints those itself.
5. **Change `PGUSER`** from `plint_app` to **`plint_app.<your project ref>`** —
   the same reference that appears in the pooler username, for example
   `plint_app.abcdefghijklmnopqrst`.

   Supabase's pooler works out which project you want from the *username*, and
   rejects a bare role name with `no tenant identifier provided`. The role
   inside Postgres is still plain `plint_app`, which is what all the grants
   name; the server strips the suffix before it speaks SQL.
6. **Apply**.

### The database is already built

Migrations and the seed have already been run against this Supabase project
from a developer machine, and verified: 10 migrations, 48 villas, 269 demands
reconciling to 269 audit rows. The first Render deploy will find the database
populated, skip the seed, and go straight to serving.

### Watch the first deploy log for these

```
bootstrap: isolation verified - plint_app is not an owner, not a superuser, not BYPASSRLS
migrate: already up to date
── seed
  skipped: 48 villas already present
── database TLS
  our connection: encrypted, TLSv1.3
  backend reports: not encrypted (expected behind a pooler)
```

That second TLS line is correct and not a problem. `pg_stat_ssl` reports the
pooler's own hop to Postgres, inside Supabase's network. The line above it is
the hop that carries your credentials across the internet, and it is TLS 1.3.

If the isolation line or the TLS line is missing, the service refused to start.
That is deliberate — it will not serve buyers' financial positions over a
connection it cannot vouch for, or with a role that could read past RLS.

## Step 5. Sign in

Your URL is on the Render service page, something like
`https://plint.onrender.com`.

| Email | Role | Password |
|---|---|---|
| arjun@example.in | Buyer, villa B-14 | plint |
| sharma@example.in | Buyer, villa A-07 | plint |
| ramachandran@nvt.in | Certifying engineer | plint |
| priya@nvt.in | Head office | plint |

---

## What breaks on the free tier

### Evidence photographs do not survive a restart

Render's free plan has **no persistent disk** — disks are a paid feature. Every
uploaded photograph is lost on every deploy, restart, and cold start.

It fails gracefully, and was designed to:

- During a session, upload works completely: stored, served, and embedded as a
  thumbnail in the completion certificate.
- After a restart the evidence **rows** are still there with captions, GPS and
  hashes. `/evidence/<hash>` returns 404 and the certificate prints
  `photograph unavailable` in the thumbnail box rather than failing to render.
- The seeded 48 villas never had image files, only rows, so nothing that ships
  in the seed is affected.

**Upload photographs during the demo, not before it.**

### The web service sleeps

Free services spin down after ~15 minutes idle, and the next request waits
roughly 50 seconds. **Open the URL a minute before you present.** A cold start
also clears the evidence files.

Sessions live in the database, so a cold start does **not** sign anyone out.

### The Supabase project pauses

Free projects pause after about a week with no activity. They resume from the
dashboard — the data is not deleted, unlike Render's free database. If a demo
is more than a week out, open the Supabase dashboard first.

### One instance

Free services do not scale out, which suits an app that expects a single writer
for the evidence directory.

---

## If you move off the free tier

1. A paid Render instance with a disk at `/data`, and
   `PLINT_EVIDENCE_DIR=/data/evidence` — the Dockerfile already defaults to it.
2. Consider restoring `FORCE ROW LEVEL SECURITY`, which migration 010 removed
   to run without a superuser. It is defence in depth against the application
   ever connecting as the owner; `db/bootstrap.js` asserts that case at every
   boot instead.
