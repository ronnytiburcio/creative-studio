#!/bin/bash
# Stop and remove the Studio LaunchAgents (labels from scripts/studio-identity.sh). Leaves the DB, cache and logs alone.
set -euo pipefail
# shellcheck source=studio-identity.sh
. "$(cd "$(dirname "$0")" && pwd)/studio-identity.sh"
UID_NUM="$(id -u)"
for label in "$STUDIO_LABEL_WEB" "$STUDIO_LABEL_WORKER"; do
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null && echo "stopped $label" || echo "$label was not loaded"
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
done
echo "Removed. Data kept in $STUDIO_DATA_DIR (studio.db, cache, logs)."
