#!/bin/zsh
# Hammerspoon watchdog: hcron runs it every minute (job hammerspoon-watchdog, added by install.sh).
# When Hammerspoon is not running (a crash, or a quit), it starts it again with `open -a`. It sends
# one alert per outage through modules/cron/tg-notify.py (to <profile>/logs/master-alerts.log while
# the master session is up, else to Telegram), never one per minute:
#   running                    nothing (and a recorded outage ends)
#   not running, first time    start it, alert once, record the outage
#   still not running          start it again, no new alert
# A short grace period (HS_WATCHDOG_GRACE seconds, default 5) and a second check keep it from
# acting in the gap of an `install.sh --restart` (quit, sleep, open).
# State: HS_WATCHDOG_STATE (default ~/.local/state/harness/hammerspoon-watchdog.state) holds "down"
# during an outage. It is written only after tg-notify.py took the alert, so an undelivered alert is
# tried again on the next run. Nothing here goes over the hs IPC port. Stop it: hcron pause
# hammerspoon-watchdog.
source ${0:A:h:h:h}/lib/env.sh
path+=($HOME/.local/bin /usr/local/bin /opt/homebrew/bin)   # hcron and cron start us with a short PATH
STATE=${HS_WATCHDOG_STATE:-$HOME/.local/state/harness/hammerspoon-watchdog.state}
GRACE=${HS_WATCHDOG_GRACE:-5}
notify=(python3 $HARNESS_DIR/modules/cron/tg-notify.py)
[[ -n $HS_WATCHDOG_NOTIFY ]] && notify=(${=HS_WATCHDOG_NOTIFY})   # tests: a stub

running() { pgrep -xq Hammerspoon }

if running; then
  [[ -f $STATE ]] && rm -f $STATE
  exit 0
fi
(( GRACE > 0 )) && sleep $GRACE
if running; then
  [[ -f $STATE ]] && rm -f $STATE
  exit 0
fi

if open -a Hammerspoon >/dev/null 2>&1; then started="started it again"
else started="could not start it (open -a Hammerspoon failed; is it installed?)"; fi
[[ -f $STATE && "$(<$STATE)" == down ]] && exit 0   # this outage was already reported

msg="Hammerspoon watchdog: Hammerspoon was not running (crash or quit); $started. Eyes, hands and the harness port were down. Crash reports: ~/Library/Logs/DiagnosticReports/Hammerspoon-*.ips"
if $notify "$msg" >/dev/null 2>&1; then
  mkdir -p ${STATE:h}
  print -r -- down > $STATE
fi
exit 0
