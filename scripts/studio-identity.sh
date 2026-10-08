# Studio install identity for the shell scripts (sourced by scripts/install-launchd.sh, scripts/uninstall-launchd.sh,
# launcher/start.sh and launcher/build_app.sh; bash and zsh). The SAME rule as resolveIdentity() in src/lib/config.ts
# (the smoke runs both on temp repos + homes and compares): the neutral names, or, when this repo carries
# private/identity.env, the values it gives (an existing install keeps its folders, LaunchAgents and app). The file is
# READ, never sourced: only STUDIO_ID_* KEY=VALUE lines count and every value is checked (a bad one keeps the neutral
# value). STUDIO_IDENTITY (the environment only): unset / empty / "auto" = the file when present; "neutral" (or any
# other value) = never read the file, the neutral names (the demo). Needs only HOME (no node: the desktop app runs
# start.sh with a bare PATH). Sets STUDIO_APP_NAME,
# STUDIO_SETTINGS_DIR, STUDIO_DATA_DIR, STUDIO_LABEL_WEB, STUDIO_LABEL_WORKER, STUDIO_SLUG. The launchd logs go to
# "$STUDIO_DATA_DIR/logs" (STUDIO_LOGS in the env file is the app's own).
# Also defines studio_setting / studio_port (config values for the shell, below).
if [ -n "${ZSH_VERSION:-}" ]; then
  eval '_sid_self="${(%):-%x}"'
else
  _sid_self="${BASH_SOURCE[0]}"
fi
_sid_repo="$(cd "$(dirname "$_sid_self")/.." && pwd)"
_sid_settings=".studio"
_sid_data="Studio-Data"
_sid_prefix="com.studio"
_sid_app="Creative Studio"
_sid_slug="creative-studio"
_sid_file="$_sid_repo/private/identity.env"
_sid_folder_re='^[A-Za-z0-9._-]{1,64}$'
_sid_prefix_re='^[A-Za-z0-9-]{1,40}(\.[A-Za-z0-9-]{1,40}){1,5}$'
_sid_app_re='^[A-Za-z0-9 ._-]{1,60}$'
_sid_slug_re='^[a-z0-9-]{1,40}$'
_sid_mode="${STUDIO_IDENTITY:-}"
_sid_mode="${_sid_mode#"${_sid_mode%%[![:space:]]*}"}"
_sid_mode="${_sid_mode%"${_sid_mode##*[![:space:]]}"}"
if { [ -z "$_sid_mode" ] || [ "$_sid_mode" = "auto" ]; } && [ -f "$_sid_file" ] && [ "$(wc -c < "$_sid_file")" -le 4096 ]; then
  STUDIO_ID_LEGACY=1
  while IFS= read -r _sid_line || [ -n "$_sid_line" ]; do
    _sid_line="${_sid_line%$'\r'}"
    _sid_line="${_sid_line#"${_sid_line%%[![:space:]]*}"}"
    case "$_sid_line" in "export "*) _sid_line="${_sid_line#export }"; _sid_line="${_sid_line#"${_sid_line%%[![:space:]]*}"}" ;; esac
    case "$_sid_line" in STUDIO_ID_*=*) ;; *) continue ;; esac
    _sid_key="${_sid_line%%=*}"
    _sid_val="${_sid_line#*=}"
    # dotenv's rules for a plain value: surrounding blanks out, matching quotes out, an unquoted " #..." is a comment.
    _sid_val="${_sid_val#"${_sid_val%%[![:space:]]*}"}"
    _sid_val="${_sid_val%"${_sid_val##*[![:space:]]}"}"
    case "$_sid_val" in
      \"*\") _sid_val="${_sid_val#\"}"; _sid_val="${_sid_val%\"}" ;;
      \'*\') _sid_val="${_sid_val#\'}"; _sid_val="${_sid_val%\'}" ;;
      *) _sid_val="${_sid_val%% \#*}"; _sid_val="${_sid_val%"${_sid_val##*[![:space:]]}"}" ;;
    esac
    case "$_sid_val" in .|..) continue ;; esac
    case "$_sid_key" in
      STUDIO_ID_SETTINGS) [[ "$_sid_val" =~ $_sid_folder_re ]] && _sid_settings="$_sid_val" ;;
      STUDIO_ID_DATA) [[ "$_sid_val" =~ $_sid_folder_re ]] && _sid_data="$_sid_val" ;;
      STUDIO_ID_LABEL_PREFIX) [[ "$_sid_val" =~ $_sid_prefix_re ]] && _sid_prefix="$_sid_val" ;;
      STUDIO_ID_APP_NAME) [[ "$_sid_val" =~ $_sid_app_re ]] && _sid_app="$_sid_val" ;;
      STUDIO_ID_SLUG) [[ "$_sid_val" =~ $_sid_slug_re ]] && _sid_slug="$_sid_val" ;;
    esac
  done < "$_sid_file"
else
  STUDIO_ID_LEGACY=0
fi
STUDIO_APP_NAME="$_sid_app"
STUDIO_SETTINGS_DIR="$HOME/$_sid_settings"
STUDIO_DATA_DIR="$HOME/$_sid_data"
STUDIO_LABEL_PREFIX="$_sid_prefix"
STUDIO_SLUG="$_sid_slug"
STUDIO_LABEL_WEB="$STUDIO_LABEL_PREFIX.web"
STUDIO_LABEL_WORKER="$STUDIO_LABEL_PREFIX.worker"
unset _sid_mode _sid_self _sid_repo _sid_settings _sid_data _sid_prefix _sid_app _sid_slug _sid_file _sid_line _sid_key _sid_val _sid_folder_re _sid_prefix_re _sid_app_re _sid_slug_re

# ---------------------------------------------------------------- config values for the shell (Phase 4b)
# studio_setting KEY prints KEY with loadConfig's precedence (src/lib/config.ts): the process environment, else the env
# file, else the Studio config's "env" section; exit 1 = set nowhere (the caller uses its default). The env file and the
# config are found the way config.ts finds them: STUDIO_ENV_FILE, else <settings dir>/.env; STUDIO_CONFIG from the
# environment, else the env file, else <settings dir>/studio.config.json. The env file is READ, never sourced (dotenv's
# rules for a one-line value: `export ` allowed, matching quotes out, an unquoted value ends at #, blanks trimmed, the
# last line wins; an empty value = unset), the config with plutil (no node: the desktop app runs start.sh with a bare
# PATH; a value starting with ./ = the config file's folder). studio_port prints STUDIO_PORT checked like the schema (a
# whole number from 1 to 65535, default 4747) or says why on stderr and fails. The smoke compares both with loadConfig.
_studio_tilde() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s\n' "$HOME/${1#"~/"}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}
_studio_trim() {
  local t="$1"
  t="${t#"${t%%[![:space:]]*}"}"
  printf '%s\n' "${t%"${t##*[![:space:]]}"}"
}
# FILE KEY: dotenv's value of KEY in FILE (may be empty); exit 1 = no such line or no readable file.
_studio_file_value() {
  local l r v q inner rest found=1 out=""
  if [ ! -f "$1" ] || [ ! -r "$1" ]; then return 1; fi
  while IFS= read -r l || [ -n "$l" ]; do
    l="${l%$'\r'}"
    l="${l#"${l%%[![:space:]]*}"}"
    case "$l" in "export "*|"export	"*) l="${l#export}"; l="${l#"${l%%[![:space:]]*}"}" ;; esac
    r="${l#"$2"}"
    if [ "$r" = "$l" ]; then continue; fi
    r="${r#"${r%%[![:space:]]*}"}"
    case "$r" in "="*) ;; *) continue ;; esac
    v="${r#=}"
    v="${v#"${v%%[![:space:]]*}"}"
    q=""
    case "$v" in \"*) q='"' ;; \'*) q="'" ;; \`*) q='`' ;; esac
    if [ -n "$q" ]; then
      inner="${v#?}"
      rest="${inner#*"$q"}"
      if [ "$rest" != "$inner" ]; then
        rest="${rest#"${rest%%[![:space:]]*}"}"
        case "$rest" in ""|\#*) out="${inner%%"$q"*}"; found=0; continue ;; esac
      fi
    fi
    v="${v%%\#*}"
    out="$(_studio_trim "$v")"
    found=0
  done < "$1"
  if [ "$found" -ne 0 ]; then return 1; fi
  printf '%s\n' "$out"
}
studio_env_file() {
  if [ -n "${STUDIO_ENV_FILE:-}" ]; then _studio_tilde "$STUDIO_ENV_FILE"; else printf '%s\n' "$STUDIO_SETTINGS_DIR/.env"; fi
}
# KEY from the process environment or the env file, non-empty; exit 1 = neither.
_studio_env_or_file() {
  local v=""
  case "$1" in ""|*[!A-Z0-9_]*) return 1 ;; esac
  eval "v=\"\${$1-}\""
  if [ -n "$v" ]; then printf '%s\n' "$v"; return 0; fi
  v="$(_studio_file_value "$(studio_env_file)" "$1")" || return 1
  if [ -z "$v" ]; then return 1; fi
  printf '%s\n' "$v"
}
studio_config_file() {
  local c
  c="$(_studio_env_or_file STUDIO_CONFIG)" || c="$STUDIO_SETTINGS_DIR/studio.config.json"
  c="$(_studio_tilde "$c")"
  case "$c" in /*) ;; *) c="$PWD/$c" ;; esac
  printf '%s\n' "$c"
}
studio_setting() {
  local v c
  if v="$(_studio_env_or_file "$1")"; then printf '%s\n' "$v"; return 0; fi
  c="$(studio_config_file)"
  if [ ! -f "$c" ]; then return 1; fi
  v="$(/usr/bin/plutil -extract "env.$1" raw -o - "$c" 2>/dev/null)" || return 1
  case "$v" in ./*) v="${c%/*}/${v#./}" ;; esac
  printf '%s\n' "$v"
}
studio_port() {
  local v
  v="$(studio_setting STUDIO_PORT)" || v=4747
  v="$(_studio_trim "$v")"
  case "$v" in
    ""|*[!0-9]*) printf 'STUDIO_PORT (%s) is not a whole number from 1 to 65535.\n' "$v" >&2; return 1 ;;
  esac
  v="${v#"${v%%[!0]*}"}"
  if [ -z "$v" ] || [ "${#v}" -gt 5 ] || [ "$v" -gt 65535 ]; then
    printf 'STUDIO_PORT is not a whole number from 1 to 65535.\n' >&2
    return 1
  fi
  printf '%s\n' "$v"
}
