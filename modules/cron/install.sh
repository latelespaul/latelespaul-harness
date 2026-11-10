#!/bin/zsh
# Cron module: hcron, one scheduler for every harness, firstmate and personal job on this Mac.
# One launchd agent runs `hcron tick` each minute; jobs live in <profile>/cron/jobs.json.
# GUI jobs (--needs gui) run only while the screen is unlocked; Hammerspoon holds the permissions.
#   install.sh            install / repair (links ~/.local/bin/hcron, loads the agent)
#   install.sh --status   is the agent loaded and ticking? (exit 1 if not)
#   install.sh --uninstall stop the agent (jobs.json is kept)
set -e
(( ${argv[(Ie)--dry-run]} )) && { export HARNESS_DRY_RUN=1; argv=(${argv:#--dry-run}) }
source ${0:A:h:h:h}/lib/common.sh
mod=$HARNESS_DIR/modules/cron
HCRON_LABEL=com.$LABEL_PREFIX.hcron
plist=$agents_dir/$HCRON_LABEL.plist

case ${1:-install} in
--status)
  launchd_loaded $HCRON_LABEL || { print "hcron agent is not loaded (run $0)."; exit 1 }
  st=$HOME/.local/state/hcron
  newest=$(ls -t $st/*.json(N) 2>/dev/null | head -1)
  [[ -n $newest ]] && print "hcron is loaded; last tick wrote ${newest:t} $(( $(date +%s) - $(stat -f %m $newest) ))s ago." || print "hcron is loaded (no jobs yet)."
  exit 0 ;;
--uninstall)
  launchd_unload $HCRON_LABEL
  act rm -f $plist
  print "hcron stopped; jobs kept in $PROFILE_DIR/cron/jobs.json."
  exit 0 ;;
install) ;;
*) print "usage: $0 [--status|--uninstall]"; exit 1 ;;
esac

NODE=$(command -v node) || { print "Install Node first (brew install node)."; exit 1 }
HCRON=$mod/hcron.mjs
HCRON_NOTIFY="python3 $mod/tg-notify.py"
act chmod +x $mod/hcron.mjs $mod/tg-notify.py
ensure_dir $HOME/.local/bin
ensure_dir $HOME/Library/Logs/hcron
ensure_dir $PROFILE_DIR/cron
link $mod/hcron.mjs $HOME/.local/bin/hcron
[[ -f $PROFILE_DIR/cron/jobs.json ]] || act zsh -c "print -r -- '{\"version\":1,\"paused\":false,\"jobs\":{}}' > $PROFILE_DIR/cron/jobs.json"
render_keys=(HCRON_LABEL NODE HCRON HOME PROFILE_DIR HCRON_NOTIFY)
if dry; then print "would write $plist"; else render $mod/hcron.plist.tmpl > $plist; fi
launchd_load $HCRON_LABEL $plist
print "hcron installed. Add a job:  hcron add <id> --cron \"7 * * * *\" --cmd \"...\" [--window 20:00-05:00] [--needs gui]"
