#!/usr/bin/env bash
# Plint backup.
#
# Two things have to be caught, and they are not in the same place:
#   1. the database, which holds the audit trail, demands and evidence rows
#   2. var/evidence, which holds the photograph bytes those rows point at
#
# A restored database whose photographs are gone still cannot reproduce a
# completion certificate, so a backup that takes only the first is not a
# backup. Both are written into one timestamped directory, with a manifest.
#
# Reads the same environment as the application. Run it as the owning role.
#
#   PLINT_BACKUP_DIR=/srv/backups ./scripts/backup.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$HERE/.env" ] && set -a && . "$HERE/.env" && set +a

: "${PGHOST:?PGHOST is not set}"
: "${PGDATABASE:?PGDATABASE is not set}"
: "${PGADMINUSER:?PGADMINUSER is not set}"
: "${PGADMINPASSWORD:?PGADMINPASSWORD is not set}"

BACKUP_DIR="${PLINT_BACKUP_DIR:-$HERE/var/backups}"
EVIDENCE_DIR="${PLINT_EVIDENCE_DIR:-$HERE/var/evidence}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/$STAMP"
mkdir -p "$OUT"

export PGPASSWORD="$PGADMINPASSWORD"
PGPORT="${PGPORT:-5432}"

echo "plint backup -> $OUT"

# Custom format: it restores selectively and in parallel, and pg_restore can
# list its contents without a running server.
pg_dump \
  --host="$PGHOST" --port="$PGPORT" --username="$PGADMINUSER" \
  --dbname="$PGDATABASE" \
  --format=custom --compress=9 --no-owner --no-privileges \
  --file="$OUT/plint.dump"

# The photographs. Content-addressed, so this is append-only in practice and
# an incremental sync (rsync/restic) is the right tool at scale.
if [ -d "$EVIDENCE_DIR" ]; then
  tar -czf "$OUT/evidence.tar.gz" -C "$(dirname "$EVIDENCE_DIR")" "$(basename "$EVIDENCE_DIR")"
else
  echo "warning: no evidence directory at $EVIDENCE_DIR" >&2
fi

# Checksums, so a restore can prove it read what was written.
( cd "$OUT" && sha256sum plint.dump evidence.tar.gz 2>/dev/null > SHA256SUMS || true )

cat > "$OUT/manifest.txt" <<EOF
plint backup
taken          $STAMP
database       $PGDATABASE on $PGHOST:$PGPORT
evidence       $EVIDENCE_DIR
dump format    custom (pg_restore)
schema version $(pg_dump --host="$PGHOST" --port="$PGPORT" --username="$PGADMINUSER" \
                   --dbname="$PGDATABASE" --schema-only --table=plint.schema_migrations \
                   --data-only 2>/dev/null | grep -c '^' || echo unknown)
EOF

echo "wrote:"
ls -la "$OUT"
echo
echo "Restore with: ./scripts/restore.sh $OUT <target-database>"
