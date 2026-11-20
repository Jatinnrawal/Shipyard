#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

backup_dir="${SHIPYARD_BACKUP_DIR:-$project_dir/backups}"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
umask 077

timestamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
backup_file="$backup_dir/shipyard-$timestamp.json"
temporary_file="$backup_file.tmp"
trap 'rm -f "$temporary_file"' EXIT

docker compose --env-file .env.production -f compose.production.yaml exec -T shipyard \
  node -e 'process.stdout.write(require("node:fs").readFileSync("/var/lib/shipyard/shipyard.json"))' \
  > "$temporary_file"

if [[ ! -s "$temporary_file" ]]; then
  echo "Shipyard returned an empty backup; nothing was saved." >&2
  exit 1
fi

mv "$temporary_file" "$backup_file"
chmod 600 "$backup_file"
trap - EXIT
echo "Private Shipyard backup written to: $backup_file"
