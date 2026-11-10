#!/bin/zsh
# Hammerspoon module: one signed app that holds Accessibility + Screen Recording for agent GUI tools.
#   install.sh            link ~/.hammerspoon/init.lua to this module and (re)start Hammerspoon
#   install.sh --status   is it running, is the `hs` CLI reachable, are the permissions on? (exit 1 if not)
set -e
(( ${argv[(Ie)--dry-run]} )) && { export HARNESS_DRY_RUN=1; argv=(${argv:#--dry-run}) }
source ${0:A:h:h:h}/lib/common.sh
mod=$HARNESS_DIR/modules/hammerspoon

status_json() { command -v hs >/dev/null && hs -t 3 -c 'return harness and harness.status() or "{}"' 2>/dev/null }

case ${1:-install} in
--status)
  pgrep -xq Hammerspoon || { print "Hammerspoon is not running (open -a Hammerspoon)."; exit 1 }
  j=$(status_json) || { print "Hammerspoon runs, but the hs CLI does not answer (reload the config)."; exit 1 }
  print -r -- "$j"
  [[ $j == *'"accessibility":true'* ]] || { print "Grant Accessibility: System Settings > Privacy & Security > Accessibility > Hammerspoon."; exit 1 }
  [[ $j == *'"screen_recording":false'* ]] && { print "Grant Screen Recording: System Settings > Privacy & Security > Screen Recording > Hammerspoon."; exit 1 }
  exit 0 ;;
install) ;;
*) print "usage: $0 [--status]"; exit 1 ;;
esac

[[ -d /Applications/Hammerspoon.app ]] || { print "Install it first: brew install --cask hammerspoon"; dry || exit 1 }
ensure_dir $HOME/.hammerspoon
ensure_dir $HOME/.hammerspoon/local
link $mod/init.lua $HOME/.hammerspoon/init.lua
if pgrep -xq Hammerspoon; then act osascript -e 'tell application "Hammerspoon" to quit'; sleep 2; fi
act open -a Hammerspoon
print "Hammerspoon started with the harness config. Check: $0 --status"
