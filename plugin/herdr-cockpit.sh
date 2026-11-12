#!/bin/sh
# Herdr Cockpit plugin. POSIX sh on macOS and Linux; needs only Herdr's CLI and standard tools (sed, awk).
#
#   herdr-cockpit.sh open          open the focused space (and pane) in the editor   (action)
#   herdr-cockpit.sh open-file     open the selected path[:line[:col]] in the editor (action)
#   herdr-cockpit.sh review        review the focused pane's changes in the editor   (action)
#   herdr-cockpit.sh popup NAME    open the setup or status popup                    (action)
#   herdr-cockpit.sh setup         interactive setup                                 (popup)
#   herdr-cockpit.sh status        Cockpit window status                                 (popup)
#   herdr-cockpit.sh on-status     pane.agent_status_changed hook                    (event)
#
# The editor side is the Herdr Cockpit extension. They talk through deep links,
# <scheme>://sriharirao.herdr-cockpit/<action>?..., which the editor's own command line opens
# (`<cli> --open-url`), and files the extension keeps in ~/.herdr-cockpit:
#   editors/<scheme>.json   editors that have the extension, with their command line
#   status/<scheme>.json    the Cockpit window's live state
# Links only ever name a space, a pane or a file; the extension validates them again.
set -u

PLUGIN_ID=sriharirao.vscode-herdr-cockpit
EXT_ID=sriharirao.herdr-cockpit
LINK_VERSION=1
VSIX_URL=https://github.com/sriharirao92/vscode-herdr-cockpit/releases/latest/download/herdr-cockpit.vsix
HERDR=${HERDR_BIN_PATH:-herdr}
HUB_DIR=${HERDR_COCKPIT_DIR:-$HOME/.herdr-cockpit}
CONFIG_DIR=${HERDR_PLUGIN_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins/config/$PLUGIN_ID}
CONFIG=$CONFIG_DIR/config.toml
# Herdr runs plugins with the server's PATH, which may be minimal.
PATH=$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
export PATH

# ---------- helpers ----------

say() { printf '%s\n' "$*"; }

# A message the user sees: a Herdr notification (actions have no terminal), and the plugin log.
notify() {
  "$HERDR" notification show "Herdr Cockpit" --body "$1" >/dev/null 2>&1 || true
  say "$1" >&2
}

# json_str KEY: the value of string "KEY" in the JSON on stdin. For Herdr's flat records: with a key
# repeated in nested objects it takes the last. Keeps the first line of a multi-line value (a selection
# ending in a newline); Herdr writes non-ASCII as UTF-8, not \u escapes.
json_str() {
  sed -nE 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' | head -n 1 |
    sed -e 's/\\[nr].*//' -e 's/\\"/"/g' -e 's#\\/#/#g' -e 's/\\\\/\\/g'
}
# json_num KEY: the first number value of "KEY".
json_num() {
  sed -nE 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*(-?[0-9]+).*/\1/p' | head -n 1
}

# alive PID: a running process with this pid. Only real pids (> 1): `kill -0 0` signals our own process group
# and -1 every process we may signal, so both "succeed".
alive() {
  case $1 in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$1" -gt 1 ] 2>/dev/null && kill -0 "$1" 2>/dev/null
}

# Percent-encode for a URL query value.
urlencode() {
  S=$1 LC_ALL=C awk 'BEGIN {
    for (i = 1; i < 256; i++) ord[sprintf("%c", i)] = i
    s = ENVIRON["S"]; out = ""
    for (i = 1; i <= length(s); i++) {
      c = substr(s, i, 1)
      if (c ~ /[A-Za-z0-9._~\/-]/) out = out c; else out = out sprintf("%%%02X", ord[c])
    }
    printf "%s", out
  }'
}
# q NAME VALUE: "&NAME=VALUE" when VALUE is set.
q() { [ -n "$2" ] && printf '&%s=%s' "$1" "$(urlencode "$2")"; return 0; }

# config_get KEY DEFAULT from config.toml (`key = "value"` lines; read, never executed).
config_get() {
  v=
  [ -f "$CONFIG" ] && v=$(sed -nE 's/^[[:space:]]*'"$1"'[[:space:]]*=[[:space:]]*"?([^"#]*[^"#[:space:]])"?[[:space:]]*(#.*)?$/\1/p' "$CONFIG" | tail -n 1)
  printf '%s' "${v:-$2}"
}
config_set() {
  mkdir -p "$CONFIG_DIR"
  [ -f "$CONFIG" ] || printf '# Herdr Cockpit plugin settings. See the plugin README.\n' >"$CONFIG"
  tmp=$CONFIG.tmp.$$
  grep -v -E "^[[:space:]]*$1[[:space:]]*=" "$CONFIG" >"$tmp" || true
  printf '%s = "%s"\n' "$1" "$2" >>"$tmp"
  mv "$tmp" "$CONFIG"
}

# The Herdr session this plugin runs in; empty for the default session.
session_name() {
  if [ -n "${HERDR_SESSION:-}" ]; then
    printf '%s' "$HERDR_SESSION"
  else
    printf '%s' "${HERDR_SOCKET_PATH:-}" | sed -nE 's#.*/sessions/([^/]+)/herdr\.sock$#\1#p'
  fi
}

ctx() { printf '%s' "${HERDR_PLUGIN_CONTEXT_JSON:-}" | json_str "$1"; }

# ---------- editors ----------
# scheme|name|macOS app|macOS command names|Linux command names
EDITORS='vscode|VS Code|Visual Studio Code.app|code|code
cursor|Cursor|Cursor.app|cursor code|cursor
kiro|Kiro|Kiro.app|kiro code|kiro
positron|Positron|Positron.app|positron code|positron
vscode-insiders|VS Code Insiders|Visual Studio Code - Insiders.app|code-insiders|code-insiders
vscodium|VSCodium|VSCodium.app|codium|codium
windsurf|Windsurf|Windsurf.app|windsurf|windsurf'

editor_field() { say "$EDITORS" | awk -F'|' -v s="$1" -v f="$2" '$1 == s { print $f }'; }
editor_name() { n=$(editor_field "$1" 2); printf '%s' "${n:-$1}"; }

# The editor's command line: from the extension's record, else the app bundle (macOS) or PATH.
# On macOS PATH is skipped: `code` there may be another editor's shim.
find_cli() {
  rec=$HUB_DIR/editors/$1.json
  if [ -f "$rec" ]; then
    c=$(json_str cli <"$rec")
    [ -n "$c" ] && [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  fi
  if [ "$(uname -s)" = Darwin ]; then
    app=$(editor_field "$1" 3)
    old_ifs=$IFS; IFS=:
    for d in ${HERDR_COCKPIT_APP_DIRS:-/Applications:$HOME/Applications}; do
      IFS=$old_ifs
      for n in $(editor_field "$1" 4); do
        c="$d/$app/Contents/Resources/app/bin/$n"
        [ -x "$c" ] && { printf '%s' "$c"; return 0; }
      done
      IFS=:
    done
    IFS=$old_ifs
    return 1
  fi
  for n in $(editor_field "$1" 5); do
    c=$(command -v "$n" 2>/dev/null) && [ -n "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

# Installed editors, one "scheme|cli" per line.
list_editors() {
  say "$EDITORS" | while IFS='|' read -r s _rest; do
    c=$(find_cli "$s") && say "$s|$c"
  done
}

# The extension's version in an editor, from its record (written whenever the extension starts).
ext_version() { [ -f "$HUB_DIR/editors/$1.json" ] && json_str extensionVersion <"$HUB_DIR/editors/$1.json"; }
ext_link_version() { [ -f "$HUB_DIR/editors/$1.json" ] && json_num linkVersion <"$HUB_DIR/editors/$1.json"; }

# Ask the editor itself (slower, but right after an install, before the extension has started).
cli_has_extension() {
  (unset VSCODE_IPC_HOOK_CLI ELECTRON_RUN_AS_NODE; "$1" --list-extensions 2>/dev/null) | grep -qix "$EXT_ID"
}

# The editor to use: config `editor`, else the one whose extension ran most recently.
choose_editor() {
  e=$(config_get editor "")
  if [ -n "$e" ]; then printf '%s' "$e"; return 0; fi
  best= best_t=0
  for f in "$HUB_DIR"/editors/*.json; do
    [ -f "$f" ] || continue
    s=$(json_str scheme <"$f") t=$(json_num updated <"$f")
    [ -n "$s" ] && [ "${t:-0}" -gt "$best_t" ] && find_cli "$s" >/dev/null && best=$s best_t=$t
  done
  [ -n "$best" ] && { printf '%s' "$best"; return 0; }
  return 1
}

# open_link SCHEME ACTION QUERY: hand the link to the editor's command line (it starts the editor if needed).
open_link() {
  cli=$(find_cli "$1") || { notify "Can't find $(editor_name "$1")'s command line. Run Herdr Cockpit: Set up editor."; return 1; }
  lv=$(ext_link_version "$1")
  if [ -n "$lv" ] && [ "$lv" -lt "$LINK_VERSION" ]; then
    notify "Update the Herdr Cockpit extension in $(editor_name "$1"): this plugin needs a newer one."
    return 1
  fi
  url="$1://$EXT_ID/$2?v=$LINK_VERSION$3$(q session "$(session_name)")"
  say "opening $url" >&2
  # A server started from an editor terminal passes that editor's IPC variables on: don't let the
  # command line route through them.
  # nohup: a popup that closes right after must not take the launch down with it.
  (unset VSCODE_IPC_HOOK_CLI VSCODE_PID ELECTRON_RUN_AS_NODE; exec nohup "$cli" --open-url "$url") </dev/null >/dev/null 2>&1 &
}

# popup NAME [KEY=VALUE...]: open an interactive popup pane of this plugin.
popup() {
  name=$1; shift
  set -- --env "HUB_PANE=${HERDR_PANE_ID:-$(ctx focused_pane_id)}" --env "HUB_SPACE=${HERDR_WORKSPACE_ID:-$(ctx workspace_id)}" "$@"
  "$HERDR" plugin pane open --plugin "$PLUGIN_ID" --entrypoint "$name" --placement popup --focus "$@" >/dev/null 2>&1 ||
    notify "Couldn't open the $name screen (close Herdr's settings or copy mode and try again)."
}

# Editor to use, or open setup (which continues with $after when done).
editor_or_setup() {
  choose_editor && return 0
  popup setup --env "HUB_AFTER=$1" --env "HUB_SELECTION=$(ctx selected_text)"
  return 1
}

# ---------- actions ----------

space_query() {
  printf '%s%s%s' "$(q space "${HUB_SPACE:-${HERDR_WORKSPACE_ID:-$(ctx workspace_id)}}")" \
    "$(q pane "${HUB_PANE:-${HERDR_PANE_ID:-$(ctx focused_pane_id)}}")" "$(q label "$(ctx workspace_label)")"
}

cmd_open() {
  ed=$(editor_or_setup open) || return 0
  open_link "$ed" open "$(space_query)"
}

cmd_review() {
  ed=$(editor_or_setup review) || return 0
  open_link "$ed" review "$(space_query)"
}

# parse_location TEXT: prints "path<TAB>line<TAB>col" for the forms tools print:
# path:line:col, path:line, path(line,col), path#Lline, File "path", line N.
parse_location() {
  printf '%s\n' "$1" | head -n 1 | sed -E \
    -e 's/^[[:space:]]+//; s/[[:space:]]+$//' \
    -e 's/^File "([^"]+)", line ([0-9]+).*/\1	\2	/' \
    -e '/	/!s/^[`"'"'"'(<[]+//' \
    -e '/	/!s/^(.+)\(([0-9]+)(,[[:space:]]*([0-9]+))?\).*$/\1	\2	\4/' \
    -e '/	/!s/[]`"'"'"')>,;.:]+$//' \
    -e '/	/!s/^(.+):([0-9]+):([0-9]+)(:.*)?$/\1	\2	\3/' \
    -e '/	/!s/^(.+):([0-9]+)(:.*)?$/\1	\2	/' \
    -e '/	/!s/^(.+)#L([0-9]+)(C([0-9]+))?$/\1	\2	\4/' \
    -e '/	/!s/$/		/'
}

cmd_open_file() {
  sel=${HUB_SELECTION:-$(ctx selected_text)}
  if [ -z "$sel" ]; then
    notify "Select a path first (like src/app.ts:42), then run Open selected file."
    return 0
  fi
  loc=$(parse_location "$sel")
  file=$(printf '%s' "$loc" | cut -f1) line=$(printf '%s' "$loc" | cut -f2) col=$(printf '%s' "$loc" | cut -f3)
  case $file in
  "~"/*) file=$HOME/${file#\~/} ;;
  /*) ;;
  *)
    # Relative to where the pane's program runs now (an agent may have changed directory).
    pane=${HUB_PANE:-${HERDR_PANE_ID:-}}
    base=
    [ -n "$pane" ] && base=$("$HERDR" pane get "$pane" 2>/dev/null | json_str foreground_cwd)
    [ -n "$base" ] || base=$(ctx focused_pane_cwd)
    [ -n "$base" ] || base=$(ctx workspace_cwd)
    file=$base/$file
    ;;
  esac
  if [ ! -e "$file" ]; then
    notify "No such file: $file"
    return 0
  fi
  ed=$(editor_or_setup open-file) || return 0
  open_link "$ed" file "$(q path "$file")$(q line "$line")$(q col "$col")"
}

# Agent finished: open its changes, when review_on_done = "true".
cmd_on_status() {
  [ "$(config_get review_on_done false)" = true ] || return 0
  ev=${HERDR_PLUGIN_EVENT_JSON:-}
  [ "$(printf '%s' "$ev" | json_str agent_status)" = done ] || return 0
  ed=$(choose_editor) || return 0
  open_link "$ed" review "$(q space "$(printf '%s' "$ev" | json_str workspace_id)")$(q pane "$(printf '%s' "$ev" | json_str pane_id)")"
}

# ---------- popups ----------

pause() {
  printf '\nPress Enter to close. '
  read -r _ || true
}

ask() { # ask PROMPT DEFAULT → answer
  printf '%s ' "$1" >&2
  read -r a || a=
  printf '%s' "${a:-$2}"
}

age() { # seconds since a ms timestamp
  now=$(date +%s)
  printf '%s' $((now - ${1:-0} / 1000))
}

cmd_status() {
  say "Herdr Cockpit"
  say ""
  default=$(choose_editor 2>/dev/null) || default=
  found=0
  for f in "$HUB_DIR"/editors/*.json; do
    [ -f "$f" ] || continue
    found=1
    s=$(json_str scheme <"$f")
    mark=; [ "$s" = "$default" ] && mark="  (used by this plugin)"
    say "  $(json_str name <"$f"): extension $(json_str extensionVersion <"$f")$mark"
    st=$HUB_DIR/status/$s.json
    if [ -f "$st" ] && alive "$(json_num pid <"$st")" && [ "$(age "$(json_num updated <"$st")")" -lt 90 ]; then
      if grep -q '"connected": true' "$st"; then
        sp=$(json_str space <"$st")
        say "    Cockpit window: connected${sp:+, space \"$sp\"}, $(json_num tabs <"$st") tabs open"
        say "    agents: $(json_num working <"$st") working, $(json_num blocked <"$st") blocked, $(json_num done <"$st") done, $(json_num idle <"$st") idle"
      else
        say "    Cockpit window: open, not connected to Herdr ($(json_str state <"$st"))"
      fi
    else
      say "    Cockpit window: not open"
    fi
  done
  if [ "$found" = 0 ]; then
    say "  No editor has the Herdr Cockpit extension yet. Run Herdr Cockpit: Set up editor."
  fi
  sess=$(session_name)
  say ""
  say "  Herdr session: ${sess:-default}"
  pause
}

install_extension() { # install_extension CLI NAME
  say "Installing Herdr Cockpit in $2..."
  if (unset VSCODE_IPC_HOOK_CLI ELECTRON_RUN_AS_NODE; "$1" --install-extension "$EXT_ID") 2>&1 | tail -n 2 && cli_has_extension "$1"; then
    return 0
  fi
  say "Not in $2's extension store; trying the latest GitHub release..."
  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t herdrhub) || return 1
  vsix=$tmp/herdr-cockpit.vsix
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$vsix" "$VSIX_URL"
  else
    wget -q -O "$vsix" "$VSIX_URL"
  fi && (unset VSCODE_IPC_HOOK_CLI ELECTRON_RUN_AS_NODE; "$1" --install-extension "$vsix") 2>&1 | tail -n 2
  rm -rf "$tmp"
  cli_has_extension "$1"
}

herdr_config_file() { printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}/herdr/config.toml"; }

# offer_key KEY ACTION DESCRIPTION: add a keybinding to Herdr's config, after asking.
offer_key() {
  cfg=$(herdr_config_file)
  if [ -f "$cfg" ] && grep -q "$PLUGIN_ID.$2\"" "$cfg"; then
    say "  $3: already bound in $cfg"
    return 0
  fi
  if [ -f "$cfg" ] && { grep -Fq "\"$1\"" "$cfg" || grep -Fq "'$1'" "$cfg"; }; then
    say "  $1 is already used in $cfg; bind \"$PLUGIN_ID.$2\" to another key there."
    return 0
  fi
  # Appending [[keys.command]] is only valid TOML when keys.command isn't already an inline array.
  if [ -f "$cfg" ] && grep -Eq '^[[:space:]]*(keys\.)?command[[:space:]]*=[[:space:]]*\[' "$cfg"; then
    say "  Your config sets keys.command as a list; add \"$PLUGIN_ID.$2\" to it yourself."
    return 0
  fi
  case $(ask "  Bind $1 to \"$3\"? [y/N]" n) in
  y | Y | yes)
    mkdir -p "$(dirname "$cfg")"
    printf '\n[[keys.command]]\nkey = "%s"\ntype = "plugin_action"\ncommand = "%s.%s"\ndescription = "%s"\n' "$1" "$PLUGIN_ID" "$2" "$3" >>"$cfg"
    say "  Added to $cfg."
    added_keys=1
    ;;
  esac
}

cmd_setup() {
  say "Herdr Cockpit setup"
  say "================"
  say ""
  editors=$(list_editors)
  if [ -z "$editors" ]; then
    say "No VS Code, Cursor, Kiro or Positron found on this machine."
    if [ -n "${SSH_CONNECTION:-}" ] || [ "$(uname -s)" != Darwin ]; then
      host=$(config_get ssh_host "$(hostname 2>/dev/null)")
      say ""
      say "Herdr runs on a server? Open it from your own computer with Remote-SSH, then install"
      say "Herdr Cockpit there and run \"Herdr Cockpit: Set Up Cockpit Window\":"
      say ""
      say "    code --remote ssh-remote+$host $HOME"
      say ""
      say "(Set ssh_host in $CONFIG if your SSH host has another name.)"
    else
      say "Install one, then run this again."
    fi
    pause
    return 0
  fi
  say "Editors on this machine:"
  i=0
  current=$(config_get editor "")
  [ -n "$current" ] || current=$(choose_editor 2>/dev/null) || current=
  default_i=1
  # One editor per line; paths have spaces ("Visual Studio Code.app").
  old_ifs=$IFS
  IFS='
'
  for line in $editors; do
    i=$((i + 1))
    s=${line%%|*}
    v=$(ext_version "$s")
    [ "$s" = "$current" ] && default_i=$i
    say "  $i) $(editor_name "$s")${v:+   Herdr Cockpit $v}"
  done
  IFS=$old_ifs
  pick=$(ask "Use which editor? [$default_i]" "$default_i")
  case $pick in *[!0-9]* | '') pick=0 ;; esac
  line=$(say "$editors" | sed -n "${pick}p")
  if [ -z "$line" ]; then
    say "No editor $pick."
    pause
    return 0
  fi
  s=${line%%|*} cli=${line#*|}
  config_set editor "$s"
  say ""
  if [ -z "$(ext_version "$s")" ] && ! cli_has_extension "$cli"; then
    case $(ask "Herdr Cockpit isn't installed in $(editor_name "$s"). Install it now? [Y/n]" y) in
    n | N | no)
      say "Skipped. Install \"Herdr Cockpit\" from the extensions view, then run this again."
      pause
      return 0
      ;;
    esac
    if ! install_extension "$cli" "$(editor_name "$s")"; then
      say "Couldn't install it. Install \"Herdr Cockpit\" from $(editor_name "$s")'s extensions view."
      pause
      return 0
    fi
    say "Installed."
  else
    say "$(editor_name "$s") has Herdr Cockpit."
  fi
  say ""
  say "Keyboard shortcuts in Herdr (prefix is ctrl+b by default):"
  added_keys=0
  offer_key prefix+shift+e open "open in editor"
  offer_key prefix+shift+o open-file "open selected file in editor"
  [ "$added_keys" = 1 ] && "$HERDR" server reload-config >/dev/null 2>&1 && say "  Reloaded Herdr's config."
  say ""
  say "Done. Open in editor any time with your shortcut, or: herdr plugin action invoke $PLUGIN_ID.open"
  case ${HUB_AFTER:-} in
  open) cmd_open ;;
  review) cmd_review ;;
  open-file) cmd_open_file ;;
  esac
  pause
}

case ${1:-} in
open) cmd_open ;;
open-file) cmd_open_file ;;
review) cmd_review ;;
on-status) cmd_on_status ;;
setup) cmd_setup ;;
status) cmd_status ;;
popup) shift && popup "$@" ;;
parse-location) parse_location "${2:-}" ;; # for tests
*)
  say "usage: herdr-cockpit.sh open|open-file|review|setup|status|popup NAME|on-status" >&2
  exit 64
  ;;
esac
