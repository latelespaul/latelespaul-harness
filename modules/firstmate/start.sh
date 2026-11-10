#!/bin/zsh
# Starts firstmate's tmux session when it is not running; never a second copy, never a restart.
# hcron runs `start.sh --once` every 5 minutes with --catchup, so it also runs on the first tick
# after a login, reboot or wake (hcron has no at-login trigger). --once starts the session at most
# once per boot: a marker records the boot time (sysctl kern.boottime) at which start.sh last
# started or found the session, so a session closed on purpose stays closed until the next boot.
# Its secondmates come back through firstmate's own session-start recovery, so only firstmate
# itself is started here.
#   start.sh              start the session if it is missing (exit 0 when it already runs)
#   start.sh --once       the same, but do nothing if it already started or found it this boot
#   start.sh --register   add the hcron job firstmate-start (FIRSTMATE_AUTOSTART=1) or remove it (0)
#   start.sh --status     one line: is the hcron job registered? (exit 1 if autostart and cron are on and it is not)
set -e
(( ${argv[(Ie)--dry-run]} )) && { export HARNESS_DRY_RUN=1; argv=(${argv:#--dry-run}) }
source ${0:A:h:h:h}/lib/common.sh
mod=$HARNESS_DIR/modules/firstmate
job=firstmate-start
# The session name with "=" so tmux matches it exactly, not as a prefix of another session's name.
target="=$FIRSTMATE_SESSION"
marker=$HOME/.local/state/harness/firstmate-autostart.boot
boot=$(sysctl -n kern.boottime 2>/dev/null || true)
mark() { dry || [[ -z $boot ]] || { mkdir -p ${marker:h}; print -r -- $boot > $marker } }

# hcron straight from the harness, so it works before ~/.local/bin/hcron is linked.
hcron() { node $HARNESS_DIR/modules/cron/hcron.mjs "$@" }
has_job() { command -v node >/dev/null && hcron next $job -n 1 >/dev/null 2>&1 }

case ${1:-start} in
start|--once)
  if [[ $1 == --once && -n $boot && -f $marker && "$(<$marker)" == "$boot" ]]; then
    print "firstmate autostart already ran this boot; left the session alone."; exit 0
  fi
  tmux has-session -t $target 2>/dev/null && { mark; print "firstmate already running in tmux session $FIRSTMATE_SESSION."; exit 0 }
  [[ -d $FIRSTMATE_DIR/.git ]] || { print "firstmate is not installed yet (run: $mod/install.sh)"; exit 1 }
  # hcron's own variables should not end up in firstmate's environment.
  unset HCRON_CMD HCRON_TIMEOUT HCRON_AWAKE
  if act tmux new -d -s $FIRSTMATE_SESSION $mod/run-firstmate.sh; then
    mark
    dry || print "started firstmate in tmux session $FIRSTMATE_SESSION (watch: tmux attach -t $FIRSTMATE_SESSION)."
  elif tmux has-session -t $target 2>/dev/null; then
    mark
    print "firstmate already running in tmux session $FIRSTMATE_SESSION (started by another starter)."
  else
    print "could not start firstmate in tmux session $FIRSTMATE_SESSION."; exit 1
  fi
  exit 0 ;;
--register)
  # The LaunchAgent older installs used is retired: hcron is the one scheduler. Only the file is
  # removed; it is not booted out, so nothing it started (the tmux session) is touched.
  old=$agents_dir/com.$LABEL_PREFIX.firstmate.plist
  [[ -f $old ]] && { act rm -f $old; dry || print "removed the old firstmate LaunchAgent $old (hcron starts it now)." }
  command -v node >/dev/null || { print "Note: no node, so the hcron job $job was not checked (brew install node)."; exit 0 }
  if [[ $FIRSTMATE_AUTOSTART == 1 ]]; then
    # hcron add updates the job in place (and keeps a pause), so re-running is safe.
    act hcron add $job --cron '*/5 * * * *' --cmd "/bin/zsh $mod/start.sh --once" --catchup --timeout 2m --project firstmate
    enabled cron || print "Note: the hcron job $job only runs once the cron module is on (add cron to MODULES)."
  elif has_job; then
    act hcron rm $job
  fi
  exit 0 ;;
--status)
  if [[ $FIRSTMATE_AUTOSTART != 1 ]]; then print "autostart off (FIRSTMATE_AUTOSTART=0)."; exit 0; fi
  if ! enabled cron; then print "Note: autostart is effectively off: the cron module is off, so the hcron job $job never runs (add cron to MODULES)."; exit 0; fi
  if ! has_job; then print "autostart: hcron job $job is not registered (run: $mod/install.sh)."; exit 1; fi
  print "autostart: hcron job $job starts the session once per boot, within 5 minutes of a login or reboot (stop it: hcron pause $job)."
  exit 0 ;;
*) print "usage: $0 [--once|--register|--status] [--dry-run]"; exit 1 ;;
esac
