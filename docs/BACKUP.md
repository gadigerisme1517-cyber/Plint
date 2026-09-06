# Backup and restore

Plint's value is an evidence trail that says who signed what, and what it said
when they signed it. A backup that cannot be restored is not a backup, so the
restore is rehearsed by `test/restore.test.js` on every `npm test` run, and the
procedure below is the one that test performs.

## What has to be caught

Two things, in two places:

| | Where | Holds |
|---|---|---|
| Database | PostgreSQL | audit trail, demands, certifications, evidence rows, sessions |
| Photographs | `var/evidence/` | the image bytes the evidence rows point at |

**Neither is sufficient alone.** A restored database whose photographs are gone
still cannot reproduce a completion certificate: the rows will describe
photographs that are not there, and the certificate will print evidence lines
with no images. A restored photograph store with no database has no idea what
any of the files are.

`scripts/backup.sh` takes both into one timestamped directory with a manifest
and checksums.

## Taking a backup

```bash
PLINT_BACKUP_DIR=/srv/backups ./scripts/backup.sh
```

Produces `/srv/backups/<UTC timestamp>/` containing:

```
plint.dump        pg_dump custom format, compressed
evidence.tar.gz   var/evidence, whole
SHA256SUMS        so a restore can prove it read what was written
manifest.txt      what was taken, from where, when
```

It reads the same environment as the application and connects as the owning
role. It does not need the application stopped.

### Scheduling it

Not wired up. It wants a timer, off-machine storage, and a retention policy.
Nothing in this repo runs it on a schedule — see CLOSEOUT.md.

A reasonable starting point, once there is somewhere to put them:

```cron
17 2 * * * cd /srv/plint && PLINT_BACKUP_DIR=/srv/backups ./scripts/backup.sh >> /var/log/plint-backup.log 2>&1
```

Because the photograph store is content-addressed, files are never rewritten,
only added. `rsync` or `restic` against `var/evidence/` is the right tool at
any real size; the tarball is for small installations and for the drill.

## Restoring

```bash
./scripts/restore.sh /srv/backups/20260906T002337Z plint_restore_drill /srv/restored-evidence
```

Arguments: the backup directory, the database to restore **into**, and where to
unpack the photographs.

The script refuses to restore over `PGDATABASE` unless
`PLINT_RESTORE_OVER_LIVE=1` is set. The ordinary reason to run it is a drill,
and a drill that silently overwrites production is worse than no drill.

### It is not finished when pg_restore exits

`restore.sh` verifies, and fails loudly if any of these do not hold:

| Check | Why |
|---|---|
| checksums match | the backup was not truncated or corrupted in transit |
| migrations applied | the schema is a schema, not an empty database |
| villas, demands, audit rows all non-zero | the data came with it |
| row security on | RLS is schema; a restore without it serves every buyer every villa |
| every evidence row's file is on disk | the certificate can actually be reproduced |

That last one is the check that matters and the one that is easiest to get
wrong. Its first version passed against a freshly seeded database because
seeded evidence rows carry no files, so it iterated an empty set and reported
success. `test/restore.test.js` now uploads real photographs first, and
includes a negative control that removes one and asserts the check notices.

## Restoring into production

1. Stop the application. A restore under live traffic will interleave.
2. Restore into a **new** database, not over the live one.
3. Run the verification above and read it.
4. Point `PGDATABASE` at the restored database and start.
5. Point `PLINT_EVIDENCE_DIR` at the restored photographs.

Step 4 rather than renaming: the database that was live stays on disk until
somebody deliberately drops it.

## What this does not cover

- **Point-in-time recovery.** There is no WAL archiving, so the recovery point
  is the last dump. Between nightly dumps, up to a day of certifications could
  be lost. If that is unacceptable — and for a system of record it probably is
  — WAL archiving is the next piece of work.
- **Off-site.** `scripts/backup.sh` writes to a directory. Getting that
  directory onto different hardware is not automated.
- **Encryption at rest.** The dump contains password hashes and every
  buyer's financial position, in the clear.
- **Retention and pruning.** Nothing deletes old backups.
- **Restore time.** Never measured against a production-sized dataset.
