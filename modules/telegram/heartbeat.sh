#!/bin/zsh
# Heartbeat for the host that runs the master session (a VM). It is never installed for you: add this
# crontab line (crontab -e) on that host, with <harness> as the harness folder:
#   * * * * * /bin/zsh <harness>/modules/telegram/heartbeat.sh >/dev/null 2>&1
# Each run checks three things and reports only a change (down, or up again), through
# modules/cron/tg-notify.py: to <profile>/logs/master-alerts.log while the master session is up, else
# to Telegram marked "(master session down)".
#   master     the master session claude-tg (tmux on Linux, screen on macOS)
#   firstmate  firstmate's tmux session ($FIRSTMATE_SESSION)
#   mac-node   the link to the Mac (only with the macnode module, on the VM side)
# While the master session and the link are both up, it also pulls the Mac's new alerts into the same
# log (mac-node pull-alerts). A Mac that was away keeps its alerts and catches up when it returns.
# State: <profile>/logs/master-heartbeat.state, one "<check> <up|down>" line each. A check with no
# state counts as up. A change is recorded only once tg-notify.py took it, so an undelivered one is
# tried again on the next run.
source ${0:A:h:h:h}/lib/env.sh
path+=($HOME/.local/bin /usr/local/bin /opt/homebrew/bin)   # cron starts us with a bare PATH
STATE=${HEARTBEAT_STATE:-$PROFILE_DIR/logs/master-heartbeat.state}
notify=(python3 $HARNESS_DIR/modules/cron/tg-notify.py)
macnode=(node $HARNESS_DIR/modules/macnode/mac-node.mjs)
[[ -n $HEARTBEAT_MACNODE ]] && macnode=($HEARTBEAT_MACNODE)    # tests: a stub
mkdir -p ${STATE:h}

master_up() {
  if [[ $OSTYPE == darwin* ]]; then screen -ls 2>/dev/null | grep -q '\.claude-tg'
  else tmux has-session -t '=claude-tg' 2>/dev/null; fi
}
firstmate_up() { tmux has-session -t "=$FIRSTMATE_SESSION" 2>/dev/null }
# The mac-node check runs only where this host is the VM side of the link.
role=${MACNODE_ROLE:-$([[ $OSTYPE == darwin* ]] && print mac || print vm)}
macnode_on() { [[ " $MODULES " == *" macnode "* && $role == vm ]] }
link_up() { $macnode status >/dev/null 2>&1 }

typeset -A says=(
  master-down "Heartbeat: the master session (claude-tg) is down"
  master-up "Heartbeat: the master session (claude-tg) is up again"
  firstmate-down "Heartbeat: firstmate's tmux session ($FIRSTMATE_SESSION) is down"
  firstmate-up "Heartbeat: firstmate's tmux session ($FIRSTMATE_SESSION) is up again"
  mac-node-down "Heartbeat: the mac-node link to the Mac is down (asleep, offline or its service stopped); Mac alerts wait there until it returns"
  mac-node-up "Heartbeat: the mac-node link to the Mac is up again"
)
typeset -A prev now
[[ -f $STATE ]] && while read -r k v; do [[ -n $k ]] && prev[$k]=$v; done < $STATE

master_up && now[master]=up || now[master]=down
firstmate_up && now[firstmate]=up || now[firstmate]=down
if macnode_on; then link_up && now[mac-node]=up || now[mac-node]=down; fi

new=$(mktemp ${STATE}.XXXXXX)
for k in master firstmate mac-node; do
  [[ -n ${now[$k]} ]] || continue
  v=${now[$k]} was=${prev[$k]:-up}
  if [[ $v != $was ]] && ! $notify "${says[$k-$v]}" >/dev/null 2>&1; then v=$was; fi
  print -r -- "$k $v" >> $new
done
mv $new $STATE

if [[ ${now[master]} == up && ${now[mac-node]} == up ]]; then $macnode pull-alerts >/dev/null 2>&1 || true; fi
exit 0
