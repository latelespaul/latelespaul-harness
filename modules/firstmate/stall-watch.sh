#!/bin/zsh
# Stall watcher for firstmate workers (tmux session "firstmate", windows fm-*).
# A worker counts as stalled when its pane text has not changed for STALL_MIN minutes.
# 20+ min: note to firstmate (it steers or closes the worker). 45+ min: also a Telegram ping.
# State: one hash + first-seen time per window in $STATE. Schedule it every 5 min with hcron (docs/master-session.md).
STALL_MIN=${STALL_MIN:-20}
PING_MIN=${PING_MIN:-45}
HARNESS_DIR=${HARNESS_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}
source "$HARNESS_DIR/lib/env.sh"
STATE=${STATE:-$PROFILE_DIR/logs/fm-stall-watch.state}
ALERTS=${ALERTS:-$PROFILE_DIR/logs/fm-stall-watch.alerts}
FM=${FIRSTMATE_DIR}
SESSION=${FIRSTMATE_SESSION:-firstmate}
now=$(date +%s)
mkdir -p "${STATE:h}" "${ALERTS:h}"
touch "$STATE"
new_state=$(mktemp)
tmux list-windows -t "$SESSION" -F '#W' 2>/dev/null | grep '^fm-' | while read -r w; do
  pane=$(tmux capture-pane -p -t "$SESSION:$w" 2>/dev/null)
  # Strip spinner/timer lines so a frozen "Running… (44m 30s)" still counts as unchanged.
  h=$(print -r -- "$pane" | grep -vE '[0-9]+m [0-9]+s|[0-9]+s ·|esc to interrupt|Tip:' | shasum | cut -c1-16)
  prev=$(grep "^$w " "$STATE" | head -1)
  if [[ -n $prev && ${prev[(w)2]} == $h ]]; then since=${prev[(w)3]}; notified=${prev[(w)4]:-0}; else since=$now; notified=0; fi
  idle=$(( (now - since) / 60 ))
  last=$(print -r -- "$pane" | grep '⏺' | tail -1 | cut -c1-140)
  if (( idle >= STALL_MIN && notified < 1 )); then
    "$FM/bin/fm-inbox.sh" note --request-id "stall-$w-$since" -- "STALL WATCH: worker window $w has shown no change for $idle min. Last line: $last. Steer it, unblock it, or close it if it's done, then report." >/dev/null 2>&1 &&
      { echo "$(date -u +%FT%TZ) $w idle ${idle}m (firstmate told): $last" >> "$ALERTS"; notified=1; }
  fi
  if (( idle >= PING_MIN && notified < 2 )); then
    python3 "$HARNESS_DIR/modules/cron/tg-notify.py" "Stall watch: firstmate worker $w idle ${idle} min. Last: $last" >/dev/null 2>&1 &&
      { echo "$(date -u +%FT%TZ) $w idle ${idle}m (Telegram ping)" >> "$ALERTS"; notified=2; }
  fi
  echo "$w $h $since $notified" >> "$new_state"
done
mv "$new_state" "$STATE"
