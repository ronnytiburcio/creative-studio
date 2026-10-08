#!/bin/bash
# Install the two Studio LaunchAgents (web + worker) for the current user. Labels and the logs folder come from
# scripts/studio-identity.sh (the same rule as src/lib/config.ts resolveIdentity):
#   com.studio.web     -> npm run start   (127.0.0.1:<STUDIO_PORT>, default 4747)   (another prefix when the repo carries private/identity.env)
#   com.studio.worker  -> npm run worker
# Logs: ~/Studio-Data/logs/{web,worker}.log (or the data folder private/identity.env names)
# KeepAlive + RunAtLoad. The plists carry no port and no tool path: both agents read the env file at start
# (scripts/next.ts, src/worker/tool-env.ts), so a change there needs a restart, not a reinstall.
#
# Usage: scripts/install-launchd.sh            install + load
#        scripts/install-launchd.sh --dry-run  write plists to a temp dir and lint them only
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=studio-identity.sh
. "$REPO/scripts/studio-identity.sh"
cd "$REPO" # the agents' working folder: a relative STUDIO_CONFIG resolves as theirs does
NODE="$(command -v node || true)"
NPM="$(command -v npm || true)"
if [[ -z "$NODE" || -z "$NPM" ]]; then
  echo "node/npm not found in PATH" >&2
  exit 1
fi
NODE="$(readlink -f "$NODE")"
NPM_CLI="$(readlink -f "$NPM")" # .../lib/node_modules/npm/bin/npm-cli.js
NODE_DIR="$(dirname "$NODE")"
# The port Studio will answer on (the same rule as the app's config; a bad value stops here, the web agent could not start).
PORT="$(studio_port)" || exit 1
LOGS="$STUDIO_DATA_DIR/logs"
UID_NUM="$(id -u)"

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1
if [[ $DRY == 1 ]]; then
  DEST="$(mktemp -d)"
else
  DEST="$HOME/Library/LaunchAgents"
fi
mkdir -p "$DEST" "$LOGS"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

write_plist() {
  local label="$1" script="$2" log="$3"
  local file="$DEST/$label.plist"
  cat >"$file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>$(xml "$NPM_CLI")</string>
    <string>run</string>
    <string>$script</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$REPO")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$NODE_DIR"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$(xml "$HOME")</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml "$LOGS/$log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOGS/$log")</string>
</dict>
</plist>
PLIST
  plutil -lint "$file" >/dev/null
  echo "$file"
}

WEB="$(write_plist "$STUDIO_LABEL_WEB" start web.log)"
WORKER="$(write_plist "$STUDIO_LABEL_WORKER" worker worker.log)"

if [[ $DRY == 1 ]]; then
  echo "dry run: plists written and linted in $DEST (nothing loaded); Studio would answer on http://127.0.0.1:$PORT"
  exit 0
fi

if [[ ! -f "$REPO/.next/BUILD_ID" ]]; then
  echo "No production build found, running npm run build..."
  (cd "$REPO" && "$NODE" "$NPM_CLI" run build)
fi

for label in "$STUDIO_LABEL_WEB" "$STUDIO_LABEL_WORKER"; do
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
done
launchctl bootstrap "gui/$UID_NUM" "$WORKER"
launchctl bootstrap "gui/$UID_NUM" "$WEB"
echo "Loaded $STUDIO_LABEL_WORKER and $STUDIO_LABEL_WEB"
echo "$STUDIO_APP_NAME: http://127.0.0.1:$PORT   Logs: $LOGS"
