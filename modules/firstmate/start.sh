#!/bin/zsh
# Starts firstmate's tmux session when it is not running; never a second copy, never a restart.
# hcron runs it every 5 minutes with --catchup, so it also runs on the first tick after a login,
# reboot or wake (hcron has no at-login trigger). Its secondmates come back through firstmate's own
# session-start recovery, so only firstmate itself is started here.
#   start.sh              start the session if it is missing (exit 0 when it already runs)
#   start.sh --register   add the hcron job firstmate-start (FIRSTMATE_AUTOSTART=1) or remove it (0)
#   start.sh --status     one line: is the hcron job registered? (exit 1 if autostart wants it and it is not)
set -e
(( ${argv[(Ie)--dry-run]} )) && { export HARNESS_DRY_RUN=1; argv=(${argv:#--dry-run}) }
source ${0:A:h:h:h}/lib/common.sh
mod=$HARNESS_DIR/modules/firstmate
job=firstmate-start
# The session name with "=" so tmux matches it exactly, not as a prefix of another session's name.
target="=$FIRSTMATE_SESSION"

# hcron straight from the harness, so it works before ~/.local/bin/hcron is linked.
hcron() { node $HARNESS_DIR/modules/cron/hcron.mjs "$@" }
has_job() { command -v node >/dev/null && hcron next $job -n 1 >/dev/null 2>&1 }

case ${1:-start} in
start)
  tmux has-session -t $target 2>/dev/null && { print "firstmate already running in tmux session $FIRSTMATE_SESSION."; exit 0 }
  [[ -d $FIRSTMATE_DIR/.git ]] || { print "firstmate is not installed yet (run: $mod/install.sh)"; exit 1 }
  # hcron's own variables should not end up in firstmate's environment.
  unset HCRON_CMD HCRON_TIMEOUT HCRON_AWAKE
  if act tmux new -d -s $FIRSTMATE_SESSION $mod/run-firstmate.sh; then
    dry || print "started firstmate in tmux session $FIRSTMATE_SESSION (watch: tmux attach -t $FIRSTMATE_SESSION)."
  elif tmux has-session -t $target 2>/dev/null; then
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
    act hcron add $job --cron '*/5 * * * *' --cmd "/bin/zsh $mod/start.sh" --catchup --timeout 2m --project firstmate
    enabled cron || print "Note: the hcron job $job only runs once the cron module is on (add cron to MODULES)."
  elif has_job; then
    act hcron rm $job
  fi
  exit 0 ;;
--status)
  if [[ $FIRSTMATE_AUTOSTART != 1 ]]; then print "autostart off (FIRSTMATE_AUTOSTART=0)."; exit 0; fi
  if ! has_job; then print "autostart: hcron job $job is not registered (run: $mod/install.sh)."; exit 1; fi
  if ! enabled cron; then print "autostart: hcron job $job is registered, but the cron module is off, so it never runs."; exit 1; fi
  print "autostart: hcron job $job starts the session within 5 minutes of a login or reboot (stop it: hcron pause $job)."
  exit 0 ;;
*) print "usage: $0 [--register|--status] [--dry-run]"; exit 1 ;;
esac
