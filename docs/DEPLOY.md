# Deploying Plint on a free tier

Target: **Render**, free web service plus free Postgres. No card.

Read the "What breaks" section before you demo from this. Some of it will bite
during a demo if you do not know it is coming.

---

## Why Render and not Fly

**Fly.io requires a payment card** before it will deploy anything, even inside
the free allowances. That rules it out on the stated constraint. Its Postgres
would otherwise have suited this app better, because you get a real superuser.

**Vercel cannot run this at all**, for a reason that is not the process model:
evidence photographs are content-addressed files on disk, read back to build
certificate thumbnails, and Vercel's filesystem is read-only outside `/tmp`
with nothing surviving between invocations.

Render's free Postgres gives a database **owner**, not a superuser. That used
to be fatal — see `DECISIONS.md` — and migration 010 is what makes it work.

---

## Before you start: check the database will do

The one thing that decides whether any Postgres can run Plint safely is whether
it will let you create a **second role**. Plint needs one role that owns the
schema and a different one the server connects as, because an owner bypasses
row-level security. With a single role there is no isolation at all.

Once the database exists, take its connection string and run:

```bash
DATABASE_URL="postgres://..." node scripts/preflight.js
```

It answers in about ten seconds and cleans up after itself. If it prints
`VERDICT: this database CANNOT run Plint safely`, stop — do not deploy, and
send me the output.

---

## What to click

### 1. Push the repository to GitHub

Still outstanding. Render deploys from a repo, so this has to happen first.

### 2. Create the services

1. Go to **dashboard.render.com** → **New** → **Blueprint**.
2. Connect the GitHub repository.
3. Render reads `render.yaml` and offers one web service (`plint`) and one
   Postgres (`plint-db`). Both are on the free plan.
4. It will prompt for the values marked `sync:false` — there are none to type,
   because `PGPASSWORD` and `PLINT_SECRET` are both `generateValue: true` and
   Render creates them itself. **Nothing secret is typed or stored in the
   repository.**
5. Click **Apply**.

The first deploy takes a few minutes: it builds the Docker image, then the
entrypoint bootstraps the role, runs ten migrations, seeds 48 villas, verifies
the database connection is encrypted, and starts serving.

### 3. Watch the log for these four lines

```
bootstrap: isolation verified - plint_app is not an owner, not a superuser, not BYPASSRLS
migrate: applied 10
seeded 48 units
── database TLS
  encrypted, TLSv1.3
```

If the isolation line is missing, or the TLS block says NOT ENCRYPTED, the
service will have refused to start. That is deliberate.

### 4. Sign in

Your URL will be `https://plint.onrender.com` or similar — Render shows it at
the top of the service page.

| Email | Role | Password |
|---|---|---|
| arjun@example.in | Buyer, villa B-14 | plint |
| sharma@example.in | Buyer, villa A-07 | plint |
| ramachandran@nvt.in | Certifying engineer | plint |
| priya@nvt.in | Head office | plint |

---

## What breaks on the free tier

### Evidence photographs do not survive

**The free plan has no persistent disk.** Persistent disks are a paid feature.
`PLINT_EVIDENCE_DIR` points inside the container, so every uploaded photograph
is lost on every deploy, every restart, and every cold start after the service
sleeps.

What that looks like in the demo:

- Upload a photograph on the engineer screen and it works, is served, and
  appears as a thumbnail on the completion certificate. Within that session it
  is entirely real.
- Come back tomorrow and the evidence **rows** are still there with their
  captions, GPS and hashes, but the files are gone. The certificate prints
  `photograph unavailable` in the thumbnail box rather than failing, and
  `/evidence/<hash>` returns 404.
- The seeded 48 villas never had image files in the first place, only evidence
  rows, so nothing that ships in the seed is affected.

So: **upload photographs during the demo, not before it.**

The fix when it matters is a paid instance with a disk mounted at `/data`, and
`PLINT_EVIDENCE_DIR=/data/evidence` — which is what the Dockerfile already
defaults to. Or object storage, which is a code change `src/evidence.js` is
shaped for but does not have.

### The service sleeps

A free web service spins down after about 15 minutes with no traffic, and the
next request waits roughly 50 seconds while it starts again. **Open the URL a
minute before you demo.** The health check keeps it up only while Render is
polling it, which it does not do on the free plan once idle.

A cold start also loses the evidence files, as above.

### The database expires

Render's free Postgres is time-limited — currently 30 days from creation, after
which it is deleted. Diarise it. Redeploying re-seeds a fresh one, because the
entrypoint seeds when it finds an empty database.

### Sessions survive, which is the point

Sessions are in the database, not in memory, so a cold start does **not** sign
anyone out. That was the first item on the original punch list and it is what
makes the sleeping service tolerable.

### One instance only

Free services do not scale out, which suits this app: it expects a single
writer for the evidence directory.

---

## If you move off the free tier later

The change to make is not in the app. It is:

1. A paid instance with a disk at `/data`, and `PLINT_EVIDENCE_DIR=/data/evidence`.
2. A Postgres that is not time-limited.
3. Consider putting `FORCE ROW LEVEL SECURITY` back, which migration 010
   removed to run without a superuser. It is defence in depth against the
   application ever connecting as the owner; `db/bootstrap.js` asserts that
   case at every boot instead.
