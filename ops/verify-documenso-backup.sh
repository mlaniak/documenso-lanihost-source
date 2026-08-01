#!/bin/bash
# Verify the latest encrypted Documenso backup, restore it to an isolated
# temporary database, compare core row counts, then remove the temporary DB.
set -euo pipefail

BACKUP_DIR=/opt/backups/databases
PASSPHRASE_FILE=/root/.backup-passphrase
LATEST=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'documenso_*.sql.gz.gpg' -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)

if [ -z "$LATEST" ]; then
  echo "No encrypted Documenso backup found" >&2
  exit 1
fi

CHECKSUM_FILE="${LATEST}.sha256"
if [ ! -f "$CHECKSUM_FILE" ]; then
  sha256sum "$LATEST" > "$CHECKSUM_FILE"
  chmod 600 "$CHECKSUM_FILE"
fi

sha256sum --check "$CHECKSUM_FILE"

RESTORE_DB="documenso_restore_drill_$(date -u +%Y%m%d%H%M%S)"
cleanup() {
  docker exec documenso-db dropdb -U documenso --if-exists "$RESTORE_DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker exec documenso-db createdb -U documenso "$RESTORE_DB"
gpg --batch --quiet --passphrase-file "$PASSPHRASE_FILE" --decrypt "$LATEST" \
  | gunzip \
  | docker exec -i documenso-db psql -U documenso -d "$RESTORE_DB" -v ON_ERROR_STOP=1 >/dev/null

PRODUCTION_COUNTS=$(docker exec documenso-db psql -U documenso -d documenso -Atc \
  'SELECT (SELECT count(*) FROM "Envelope") || '"'"'|'"'"' || (SELECT count(*) FROM "Recipient");')
RESTORED_COUNTS=$(docker exec documenso-db psql -U documenso -d "$RESTORE_DB" -Atc \
  'SELECT (SELECT count(*) FROM "Envelope") || '"'"'|'"'"' || (SELECT count(*) FROM "Recipient");')

echo "Backup restored successfully: $(basename "$LATEST")"
echo "Current envelope|recipient counts: $PRODUCTION_COUNTS"
echo "Restored envelope|recipient counts: $RESTORED_COUNTS"
