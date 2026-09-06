#!/usr/bin/env bash
# Plint restore.
#
#   ./scripts/restore.sh <backup-directory> <target-database> [evidence-dir]
#
# Restores into a database you name. It will not restore over PGDATABASE
# unless you set PLINT_RESTORE_OVER_LIVE=1, because the ordinary reason to run
# this is a drill, and a drill that silently overwrites production is worse
# than no drill.
#
# A restore is not finished when pg_restore exits 0. It is finished when the
# checks at the bottom pass: the migration ledger is intact, the audit trail is
# there, and the photographs the evidence rows point at exist on disk.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$HERE/.env" ] && set -a && . "$HERE/.env" && set +a

SRC="${1:?usage: restore.sh <backup-directory> <target-database> [evidence-dir]}"
TARGET="${2:?usage: restore.sh <backup-directory> <target-database> [evidence-dir]}"
EVIDENCE_OUT="${3:-$HERE/var/restored-evidence}"

: "${PGHOST:?PGHOST is not set}"
: "${PGADMINUSER:?PGADMINUSER is not set}"
: "${PGADMINPASSWORD:?PGADMINPASSWORD is not set}"
PGPORT="${PGPORT:-5432}"
export PGPASSWORD="$PGADMINPASSWORD"

if [ "$TARGET" = "${PGDATABASE:-}" ] && [ "${PLINT_RESTORE_OVER_LIVE:-}" != "1" ]; then
  echo "refusing to restore over the live database ($TARGET)." >&2
  echo "set PLINT_RESTORE_OVER_LIVE=1 if that is genuinely what you want." >&2
  exit 1
fi

psql_admin() { psql --host="$PGHOST" --port="$PGPORT" --username="$PGADMINUSER" "$@"; }

echo "verifying the backup before trusting it"
if [ -f "$SRC/SHA256SUMS" ]; then
  ( cd "$SRC" && sha256sum -c SHA256SUMS )
else
  echo "warning: no SHA256SUMS in $SRC" >&2
fi

echo "creating $TARGET"
psql_admin --dbname=postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$TARGET\""
psql_admin --dbname=postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$TARGET\" OWNER \"$PGADMINUSER\""

echo "restoring the database"
pg_restore --host="$PGHOST" --port="$PGPORT" --username="$PGADMINUSER" \
  --dbname="$TARGET" --no-owner --no-privileges --exit-on-error \
  "$SRC/plint.dump"

echo "restoring the photographs"
if [ -f "$SRC/evidence.tar.gz" ]; then
  mkdir -p "$EVIDENCE_OUT"
  tar -xzf "$SRC/evidence.tar.gz" -C "$EVIDENCE_OUT" --strip-components=1
fi

echo
echo "checking the restore is actually usable"

check() {
  local label="$1" sql="$2" want="$3"
  local got
  got="$(psql_admin --dbname="$TARGET" -tAc "$sql")"
  if [ "$got" = "$want" ] || { [ "$want" = ">0" ] && [ "${got:-0}" -gt 0 ]; }; then
    printf '  ok    %-34s %s\n' "$label" "$got"
  else
    printf '  FAIL  %-34s got %s, wanted %s\n' "$label" "$got" "$want"
    return 1
  fi
}

check "migrations applied"  "SELECT count(*) FROM plint.schema_migrations" ">0"
check "villas"              "SELECT count(*) FROM plint.units" ">0"
check "demands"             "SELECT count(*) FROM plint.demands" ">0"
check "audit rows"          "SELECT count(*) FROM plint.audit_log" ">0"
check "row security on"     "SELECT count(*) FROM pg_tables WHERE schemaname='plint' AND rowsecurity" ">0"

# The audit trail must account for every certification and every settlement.
# A database can restore perfectly and still be one where nobody signed
# anything; that is what this catches, and it is how the fault was found.
check "every certification audited" \
  "SELECT (SELECT count(*) FROM plint.unit_stages WHERE certified_at IS NOT NULL)
        - (SELECT count(*) FROM plint.audit_log WHERE action='certified')" "0"
check "every settlement audited" \
  "SELECT (SELECT count(*) FROM plint.demands WHERE paid_at IS NOT NULL)
        - (SELECT count(*) FROM plint.audit_log WHERE action='demand_settled')" "0"
check "no audit row names a stranger" \
  "SELECT count(*) FROM plint.audit_log a
    WHERE NOT EXISTS (SELECT 1 FROM plint.users u WHERE u.id = a.actor_id)" "0"

# The check that matters most: every evidence row that claims a stored file
# must have that file on disk. A database restored without its photographs
# cannot reproduce a completion certificate, and would pass every check above.
missing=0
while IFS= read -r h; do
  [ -z "$h" ] && continue
  if [ ! -f "$EVIDENCE_OUT/${h:0:2}/${h:2:2}/$h" ]; then
    missing=$((missing + 1))
  fi
done < <(psql_admin --dbname="$TARGET" -tAc \
  "SELECT sha256 FROM plint.evidence WHERE mime IS NOT NULL")

if [ "$missing" -eq 0 ]; then
  printf '  ok    %-34s every stored photograph present\n' "evidence files"
else
  printf '  FAIL  %-34s %d photographs missing from disk\n' "evidence files" "$missing"
  exit 1
fi

echo
echo "restore verified: $TARGET"
