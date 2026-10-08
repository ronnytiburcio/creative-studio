#!/bin/zsh
# Makes sure Studio (web + worker LaunchAgents) is running, then waits until it answers.
# Used by the desktop app (built by build_app.sh). Exit 0 = up: prints Studio's URL (the only line on stdout; the app
# opens it). Exit 1 = did not come up (see logs).
# Labels, logs folder and the port: scripts/studio-identity.sh (HOME, the repo's optional private/identity.env, and
# STUDIO_PORT from the environment, the env file or the Studio config's "env"; the applet runs this with a bare PATH).
REPO="${0:A:h}/.."
. "$REPO/scripts/studio-identity.sh"
# The repo is the web agent's working folder: a relative STUDIO_CONFIG then resolves the same way here (the applet runs from /).
cd "$REPO" || exit 1
mkdir -p "$STUDIO_DATA_DIR/logs"
PORT="$(studio_port 2>>"$STUDIO_DATA_DIR/logs/launcher.log")" || exit 1
BASE="http://127.0.0.1:$PORT"
URL="$BASE/api/status"
UIDN=$(id -u)

up() {
  curl -sf -o /dev/null --max-time 1 "$URL" || return 1
  print -r -- "$BASE/"
}

up && exit 0

for label in "$STUDIO_LABEL_WEB" "$STUDIO_LABEL_WORKER"; do
  if launchctl print "gui/$UIDN/$label" >/dev/null 2>&1; then
    launchctl kickstart "gui/$UIDN/$label" >/dev/null 2>&1
  else
    NEED_INSTALL=1
  fi
done
if [[ -n "$NEED_INSTALL" ]]; then
  /bin/bash "$REPO/scripts/install-launchd.sh" >> "$STUDIO_DATA_DIR/logs/launcher.log" 2>&1 || exit 1
fi

for _ in {1..60}; do
  sleep 0.25
  up && exit 0
done
exit 1
