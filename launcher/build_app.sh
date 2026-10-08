#!/bin/zsh
# Builds "<app name>.app" (AppleScript applet with the sand mark tile) in /Applications.
# The app name, repo folder and logs folder come from scripts/studio-identity.sh (the neutral names, or the original
# install's own when the repo carries private/identity.env), filled into the studio.applescript template. No port is built
# in: the app opens the URL launcher/start.sh prints (STUDIO_PORT), so a port change needs no rebuild.
# The icon: STUDIO_APP_ICON (an SVG) when set, else mark-sand.svg in the install's own brand folder (STUDIO_BRAND_DIR from
# the environment, the env file or the Studio config's "env"), else the generic public/brand/mark-sand.svg.
# The rendered icon is also saved as <data dir>/icon-preview.png (local only).
# Usage: launcher/build_app.sh [output_dir]   (default /Applications)
set -e
HERE="${0:A:h}"
REPO="${HERE:h}"
. "$REPO/scripts/studio-identity.sh"
cd "$REPO" || exit 1 # a relative STUDIO_CONFIG resolves as the agents' does
OUT_DIR="${1:-/Applications}"
APP="$OUT_DIR/$STUDIO_APP_NAME.app"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# Chrome renders the icon: check it before anything is written, so a missing Chrome never leaves a half built app.
if [ ! -x "$CHROME" ]; then
  print -r -- "build_app.sh: Google Chrome is needed to render the app icon (not found at $CHROME). Install Chrome and run this again." >&2
  exit 1
fi
MARK="${STUDIO_APP_ICON:-}"
if [ -z "$MARK" ]; then
  # studio_setting (scripts/studio-identity.sh): the environment, the env file, then the Studio config's "env".
  BRAND="$(studio_setting STUDIO_BRAND_DIR)" || BRAND=""
  BRAND="$(_studio_tilde "$BRAND")"
  if [ -n "$BRAND" ] && [ -f "$BRAND/mark-sand.svg" ]; then MARK="$BRAND/mark-sand.svg"; else MARK="$REPO/public/brand/mark-sand.svg"; fi
fi
TMP=$(mktemp -d)

# AppleScript string literal escaping (backslash, then double quote) for the filled-in values.
as_str() { local v="${1//\\/\\\\}"; print -r -- "${v//\"/\\\"}"; }
SRC="$(<"$HERE/studio.applescript")"
SRC="${SRC//__APP_NAME__/$(as_str "$STUDIO_APP_NAME")}"
SRC="${SRC//__REPO__/$(as_str "$REPO")}"
SRC="${SRC//__LOGS__/$(as_str "${STUDIO_DATA_DIR/#$HOME/~}/logs")}"
print -r -- "$SRC" > "$TMP/studio.applescript"

chmod +x "$HERE/start.sh"
rm -rf "$APP"
osacompile -o "$APP" "$TMP/studio.applescript"

# macOS icon grid: the ~824px mark tile inside a transparent 1024 canvas.
cat > "$TMP/icon.html" <<HTML
<html><body style="margin:0;background:transparent">
<img src="file://$MARK" style="position:absolute;left:100px;top:100px;width:824px;height:824px;filter:drop-shadow(0 10px 14px rgba(0,0,0,.28))">
</body></html>
HTML
"$CHROME" --headless=new --disable-gpu \
  --allow-file-access-from-files --default-background-color=00000000 \
  --window-size=1024,1024 --hide-scrollbars --screenshot="$TMP/icon.png" "file://$TMP/icon.html" >/dev/null 2>&1

mkdir "$TMP/icon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon.png" --out "$TMP/icon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$TMP/icon.png" --out "$TMP/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$TMP/icon.iconset" -o "$APP/Contents/Resources/applet.icns"
mkdir -p "$STUDIO_DATA_DIR" && cp "$TMP/icon.png" "$STUDIO_DATA_DIR/icon-preview.png"
# osacompile ships its own icon in Assets.car; drop it so applet.icns wins, then re-sign.
rm -f "$APP/Contents/Resources/Assets.car"
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$APP/Contents/Info.plist" 2>/dev/null || true
xattr -cr "$APP"
codesign --force --deep -s - "$APP" 2>/dev/null
touch "$APP"
rm -rf "$TMP"
echo "Built $APP"
