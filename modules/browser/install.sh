#!/bin/zsh
# Browser module: "Claude Chrome", a separate Chrome (own profile in ~/.chrome-claude) that agents
# control through chrome-devtools-axi on 127.0.0.1:$BROWSER_PORT. Your normal Chrome is never touched.
# Each id:port in BROWSER_EXTRA adds another one (~/.chrome-<id>) plus a chrome-<id> command.
#   install.sh                         install / repair all of them on this Mac
#   install.sh [--id <id>] --uninstall stop one (default: claude); keeps the profile and its logins
#   install.sh [--id <id>] --status    is it up? (exit 1 if not; without --id: all of them)
# A profile in desktop mode (chrome-mode.sh) is left stopped: its agent is not loaded or restarted.
set -e
# --dry-run anywhere: print actions only (same as HARNESS_DRY_RUN=1).
(( ${argv[(Ie)--dry-run]} )) && { export HARNESS_DRY_RUN=1; argv=(${argv:#--dry-run}) }
source ${0:A:h:h:h}/lib/common.sh
mod=$HARNESS_DIR/modules/browser
source $mod/chrome-mode.sh
chrome_bin=${CHROME_BIN:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
uid=$(id -u)
browsers=(claude:$BROWSER_PORT ${(z)BROWSER_EXTRA})
id=claude ids=()
[[ $1 == --id ]] && { id=$2 ids=($2); shift 2 }
port_of() { local b; for b in $browsers; do [[ ${b%%:*} == $1 ]] && { print ${b#*:}; return 0 }; done; return 1 }
up() { curl -s --max-time 3 http://127.0.0.1:$1/json/version | grep -q '"Browser"' }

case ${1:-install} in
--status)
  (( $#ids )) || ids=(${browsers%%:*})
  rc=0
  for id in $ids; do
    port=$(port_of $id) || { print "no browser with id $id"; rc=1; continue }
    if up $port; then print "chrome-$id is up on 127.0.0.1:$port."
    elif [[ $(chrome_mode $id) == desktop ]]; then print "chrome-$id is in desktop mode: agent left stopped."
    else print "chrome-$id is down."; rc=1; fi
  done
  command -v chrome-devtools-axi >/dev/null || { print "chrome-devtools-axi is not installed (npm i -g chrome-devtools-axi@0.1.44)."; rc=1 }
  exit $rc ;;
--uninstall)
  launchd_unload com.$LABEL_PREFIX.chrome-$id
  act rm -f $agents_dir/com.$LABEL_PREFIX.chrome-$id.plist
  print "Stopped. Profile and logins kept in ~/.chrome-$id (delete it to reset)."
  exit 0 ;;
install) ;;
*) print "usage: $0 [--id <id>] [--uninstall|--status]"; exit 1 ;;
esac

[[ -x $chrome_bin ]] || { print "Install Google Chrome first: brew install --cask google-chrome"; dry || exit 1 }
command -v chrome-devtools-axi >/dev/null || print "Note: install the controller with: npm i -g chrome-devtools-axi@0.1.44"

ensure_dir $agents_dir
render_keys+=(CHROME_LABEL CHROME_PROFILE CHROME_PORT CHROME_ID)
# A profile that fails is reported and the loop goes on, so one profile never stops the next one.
rc=0
for b in $browsers; do
  CHROME_ID=${b%%:*} CHROME_PORT=${b#*:}
  CHROME_LABEL=com.$LABEL_PREFIX.chrome-$CHROME_ID CHROME_PROFILE=.chrome-$CHROME_ID
  plist=$agents_dir/$CHROME_LABEL.plist
  [[ -d ~/$CHROME_PROFILE ]] || act mkdir -p ~/$CHROME_PROFILE ~/$CHROME_PROFILE-logs
  write_file $plist "$(render $mod/launchd/chrome.plist.tmpl)"
  plist_changed=$changed
  # Extra browsers get a command that points chrome-devtools-axi at them.
  if [[ $CHROME_ID != claude ]]; then
    act mkdir -p ~/.local/bin
    write_file ~/.local/bin/chrome-$CHROME_ID "$(render $mod/chrome-wrapper.tmpl)"
    act chmod +x ~/.local/bin/chrome-$CHROME_ID
    (( ${path[(Ie)$HOME/.local/bin]} )) || print "Note: ~/.local/bin is not on PATH, so chrome-$CHROME_ID won't be found. Add to ~/.zshrc: export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
  # Desktop mode: another tool runs this profile as a normal Chrome. Loading the agent would hand
  # each launch to that Chrome, which opens one more empty window every time.
  if [[ $(chrome_mode $CHROME_ID) == desktop ]]; then
    # An agent still loaded from an older plist keeps relaunching; stop it unless it serves its port.
    if launchd_loaded $CHROME_LABEL && ! up $CHROME_PORT; then launchd_unload $CHROME_LABEL; fi
    print "chrome-$CHROME_ID: desktop mode: agent left stopped (back to agent mode: $mod/chrome-mode.sh $CHROME_ID agent, then re-run this installer)."
    continue
  fi
  if (( ! plist_changed )) && launchd_loaded $CHROME_LABEL && up $CHROME_PORT; then
    print "chrome-$CHROME_ID already running; left it alone."
    continue
  fi
  # Agent mode (or no record): the agent must end up loaded. A changed plist is reloaded, which stops
  # its Chrome for a moment; launchd_load waits for the old job to go before loading the new one.
  launchd_load $CHROME_LABEL $plist || { print "chrome-$CHROME_ID: could not load its agent; re-run this installer."; rc=1; continue }
  if [[ $HARNESS_SKIP_LAUNCHD == 1 ]] || dry; then continue; fi
  for i in {1..20}; do up $CHROME_PORT && break; sleep 1; done
  up $CHROME_PORT && print "chrome-$CHROME_ID is running on 127.0.0.1:$CHROME_PORT. Log in to the accounts agents should use, in that window." \
    || { print "chrome-$CHROME_ID did not open its debug port yet (its agent stays loaded and retries); see ~/$CHROME_PROFILE-logs/chrome.log"; rc=1 }
done
exit $rc
