#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Usage: bash scripts/restore-production.sh path/to/shipyard-backup.json" >&2
  exit 2
fi

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backup_file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
cd "$project_dir"

compose=(docker compose --env-file .env.production -f compose.production.yaml)
normalized_file="$(mktemp)"
restart_shipyard=0
restore_cleanup() {
  if [[ "$restart_shipyard" == 1 ]]; then "${compose[@]}" start shipyard >/dev/null || true; fi
  rm -f "$normalized_file"
}
trap restore_cleanup EXIT
"${compose[@]}" exec -T shipyard node -e '
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { raw += chunk; });
  process.stdin.on("end", () => {
    try {
      const data = JSON.parse(raw);
      const workspace = data?.workspace || data;
      if (!workspace || !Array.isArray(workspace.services) || !Array.isArray(workspace.releases)) throw new Error("not a Shipyard workspace backup");
      process.stdout.write(JSON.stringify(workspace, null, 2));
    } catch (error) {
      console.error(`Invalid Shipyard backup: ${error.message}`);
      process.exitCode = 1;
    }
  });
' < "$backup_file" > "$normalized_file"
if [[ ! -s "$normalized_file" ]]; then echo "The backup did not contain a Shipyard workspace." >&2; exit 1; fi

echo "Saving a backup of the current workspace before restoring."
bash "$project_dir/scripts/backup-production.sh"

"${compose[@]}" stop shipyard
restart_shipyard=1
"${compose[@]}" cp "$normalized_file" shipyard:/var/lib/shipyard/shipyard.json
"${compose[@]}" start shipyard
restart_shipyard=0
trap - EXIT
rm -f "$normalized_file"
echo "Shipyard data restored. The current workspace backup was kept in the backups folder."
