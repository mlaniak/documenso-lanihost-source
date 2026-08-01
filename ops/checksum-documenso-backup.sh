#!/bin/bash
set -euo pipefail

BACKUP_DIR=/opt/backups/databases
LATEST=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'documenso_*.sql.gz.gpg' -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)

if [ -z "$LATEST" ]; then
  echo "No encrypted Documenso backup found" >&2
  exit 1
fi

sha256sum "$LATEST" > "${LATEST}.sha256"
chmod 600 "${LATEST}.sha256"
echo "Wrote checksum for $(basename "$LATEST")"
