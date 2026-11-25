#!/bin/zsh
# Stall watcher for firstmate workers (tmux session "firstmate", windows fm-*).
# A worker counts as stalled when its pane text has not changed for STALL_MIN minutes.
# 20+ min: note to firstmate (it steers or closes the worker). 45+ min: also a Telegram ping.
# State: one hash + first-seen time per window in $STATE. Schedule it every 5 min with hcron (docs/master-session.md).
#
# Freeze watch (firstmate itself, the first window that is not fm-*). FROZEN means either
#   - inbox notes waiting and no progress for FREEZE_MIN (15) min: the pane is unchanged and no note
#     was drained (a busy pane whose spinner still redraws is not frozen), or
#   - "API Error" on the pane with an idle prompt for APIERR_MIN (5) min.
# Recovery ladder: (a) press Enter once; (b) still frozen RETRY_MIN (3) min later: SIGTERM the claude
# child of run-firstmate.sh, SIGKILL after TERM_WAIT (20) s, and the loop restarts it with --continue;
# (c) once the new claude (a new pid, seen on two polls) draws a fresh prompt, type "check inbox" + Enter.
# A pane that shows a permission or selection dialog gets no keys at all: one master line instead. Every step goes to master-alerts.log
# (written directly, so it never reaches the user's Telegram), plus one summary line per episode.
# Second mates (fm-* windows): "API Error" + idle prompt + their inbox not empty for APIERR_MIN min
# means Enter, then one nudge and one master line on the next run. They are never killed.
STALL_MIN=${STALL_MIN:-20}
PING_MIN=${PING_MIN:-45}
FREEZE_MIN=${FREEZE_MIN:-15}
APIERR_MIN=${APIERR_MIN:-5}
RETRY_MIN=${RETRY_MIN:-3}
TERM_WAIT=${TERM_WAIT:-20}
READY_WAIT=${READY_WAIT:-60}
HARNESS_DIR=${HARNESS_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}
source "$HARNESS_DIR/lib/env.sh"
STATE=${STATE:-$PROFILE_DIR/logs/fm-stall-watch.state}
ALERTS=${ALERTS:-$PROFILE_DIR/logs/fm-stall-watch.alerts}
FREEZE_STATE=${FREEZE_STATE:-$PROFILE_DIR/logs/fm-freeze-watch.state}
MASTER_LOG=${MASTER_LOG:-$PROFILE_DIR/logs/master-alerts.log}
FM=${FIRSTMATE_DIR}
SESSION=${FIRSTMATE_SESSION:-firstmate}
now=${NOW:-$(date +%s)}
mkdir -p "${STATE:h}" "${ALERTS:h}" "${FREEZE_STATE:h}" "${MASTER_LOG:h}"
touch "$STATE"

master() { print -r -- "$(date -u +%FT%TZ) $*" >> "$MASTER_LOG"; }
# Strip spinner/timer lines so a frozen "Running… (44m 30s)" still counts as unchanged.
calm_hash() { print -r -- "$1" | grep -vE '[0-9]+m [0-9]+s|[0-9]+s ·|esc to interrupt|Tip:' | shasum | cut -c1-16; }
raw_hash() { print -r -- "$1" | shasum | cut -c1-16; }
busy() { print -r -- "$1" | grep -q 'esc to interrupt'; }
api_error() { print -r -- "$1" | tail -25 | grep -q 'API Error'; }
submit() { tmux send-keys -t "$1" C-m; }
type_line() { tmux send-keys -t "$1" -l -- "$2"; sleep 1; submit "$1"; }
fm_claude() { pgrep -P "$1" -f '^claude( |$)' 2>/dev/null | head -1; }
alive() { kill -0 "$1" 2>/dev/null; }
dialog() { print -r -- "$1" | tail -25 | grep -qE 'Do you want to|^[[:space:]]*❯ *[0-9]+\.'; }
# The restarted claude is ready: a pid that is not the killed one, the same on two polls 2 s apart,
# and a pane that differs from the frame before the kill and shows an input prompt, not a dialog.
ready() {
  local a b p
  a=$(fm_claude "$pp"); [[ -n $a && $a != $kpid ]] || return 1
  sleep 2
  b=$(fm_claude "$pp"); [[ $b == $a ]] || return 1
  p=$(tmux capture-pane -p -t "$target" 2>/dev/null)
  [[ $(raw_hash "$p") != $kraw ]] && print -r -- "$p" | grep -q '^❯' && ! dialog "$p" && print -r -- "$a"
}

# ---------- firstmate itself ----------
freeze_watch() {
  local main target pane ph h raw notes since pnotes step stepat praw idle why pid pp new i kpid kraw
  main=$(tmux list-windows -t "$SESSION" -F '#{window_index} #W' 2>/dev/null | awk '$2 !~ /^fm-/ {print $1; exit}')
  [[ -n $main ]] || return 0
  target="$SESSION:$main"
  pane=$(tmux capture-pane -p -t "$target" 2>/dev/null)
  h=$(calm_hash "$pane"); raw=$(raw_hash "$pane")
  notes=$(print -l "$FM"/state/inbox/*.note(N) | grep -c .)
  [[ -f $FREEZE_STATE ]] && read -r ph praw since pnotes step stepat kpid kraw < "$FREEZE_STATE"
  step=${step:-0} stepat=${stepat:-0}
  # Progress: the pane changed, a note was drained, or a busy pane still redraws its spinner.
  if [[ $ph != $h ]] || (( notes < ${pnotes:-0} )) || { busy "$pane" && [[ $praw != $raw ]]; }; then
    (( step == 1 )) && master "Freeze watch: firstmate ($target) moved again after Enter; nothing else done."
    (( step == 3 )) && master "Freeze watch: firstmate ($target) moved again."
    since=$now; (( step == 2 )) || step=0
  fi
  idle=$(( (now - ${since:-$now}) / 60 ))
  why=
  if (( notes > 0 && idle >= FREEZE_MIN )); then why="$notes inbox note(s) waiting, no progress for ${idle} min"
  elif api_error "$pane" && ! busy "$pane" && (( idle >= APIERR_MIN )); then why="API Error with an idle prompt for ${idle} min"
  fi
  pp=$(tmux display-message -p -t "$target" '#{pane_pid}' 2>/dev/null)
  if (( step == 2 )); then
    # (c) after the restart: type "check inbox" once the new prompt shows.
    if new=$(ready); then
      type_line "$target" "check inbox"
      master "freeze-watch step c: firstmate restarted as pid $new; typed \"check inbox\" into $target."
      master "Freeze watch: firstmate was frozen and is restarted (--continue) and nudged. Check it: tmux capture-pane -p -t $target"
      step=0 since=$now
    elif (( now - stepat >= FREEZE_MIN * 60 )); then
      master "Freeze watch: firstmate ($target) did not come back with a prompt ${FREEZE_MIN} min after the restart; look at it by hand."
      step=3
    fi
  elif [[ -n $why ]] && (( step < 2 )) && dialog "$pane"; then
    master "Freeze watch: firstmate ($target) looks frozen ($why) but waits at a dialog; no keys sent, decide it by hand: tmux capture-pane -p -t $target"
    step=3
  elif [[ -n $why ]] && (( step == 0 )); then
    # (a) press Enter once.
    submit "$target"
    master "freeze-watch step a: firstmate looks frozen ($why); pressed Enter in $target."
    step=1 stepat=$now
  elif [[ -n $why ]] && (( step == 1 && now - stepat >= RETRY_MIN * 60 )); then
    # (b) restart the claude child of run-firstmate.sh; the loop starts it again with --continue.
    pid=$(fm_claude "$pp")
    if [[ -z $pid ]]; then
      master "Freeze watch: firstmate looks frozen ($why) but $target has no claude child of run-firstmate.sh; restart it by hand."
      step=3
    else
      kpid=$pid kraw=$raw
      kill -TERM "$pid" 2>/dev/null
      master "freeze-watch step b: Enter did not help; sent SIGTERM to firstmate claude pid $pid."
      for (( i = 0; i < TERM_WAIT; i++ )); do alive "$pid" || break; sleep 1; done
      if alive "$pid"; then kill -KILL "$pid" 2>/dev/null; master "freeze-watch step b: pid $pid ignored SIGTERM for ${TERM_WAIT}s; sent SIGKILL."; fi
      step=2 stepat=$now
      for (( i = 0; i < READY_WAIT; i += 2 )); do
        if new=$(ready); then
          type_line "$target" "check inbox"
          master "freeze-watch step c: firstmate restarted as pid $new; typed \"check inbox\"."
          master "Freeze watch: firstmate was frozen ($why); restarted (--continue) and nudged. Check it: tmux capture-pane -p -t $target"
          step=0; break
        fi
        sleep 2
      done
      pane=$(tmux capture-pane -p -t "$target" 2>/dev/null); h=$(calm_hash "$pane"); raw=$(raw_hash "$pane"); since=$now
    fi
  fi
  print -r -- "$h $raw ${since:-$now} $notes $step $stepat ${kpid:-0} ${kraw:-0}" > "$FREEZE_STATE"
}
freeze_watch

# ---------- second mates and workers (fm-*) ----------
new_state=$(mktemp)
tmux list-windows -t "$SESSION" -F '#W' 2>/dev/null | grep '^fm-' | while read -r w; do
  pane=$(tmux capture-pane -p -t "$SESSION:$w" 2>/dev/null)
  h=$(calm_hash "$pane")
  prev=$(grep "^$w " "$STATE" | head -1)
  if [[ -n $prev && ${prev[(w)2]} == $h ]]; then since=${prev[(w)3]}; notified=${prev[(w)4]:-0}; else since=$now; notified=0; fi
  idle=$(( (now - since) / 60 ))
  last=$(print -r -- "$pane" | grep '⏺' | tail -1 | cut -c1-140)
  if (( idle >= APIERR_MIN )) && api_error "$pane" && ! busy "$pane"; then
    meta=$(grep -lx "window=$SESSION:$w" "$FM"/state/*.meta(N) 2>/dev/null | head -1)
    inbox=${meta:+${meta%.meta}.inbox}
    msgs=$([[ -n $inbox ]] && print -l "$inbox"/*.msg(N) | grep -c .)
    if (( ${msgs:-0} > 0 )); then
      if dialog "$pane"; then
        (( notified & 16 )) || { master "Freeze watch: second mate $w shows API Error with ${msgs} inbox message(s) but waits at a dialog; no keys sent, decide it by hand."; (( notified |= 16 )); }
      elif (( !(notified & 4) )); then
        submit "$SESSION:$w"; (( notified |= 4 ))
        master "freeze-watch: second mate $w shows API Error, idle ${idle} min, ${msgs} inbox message(s); pressed Enter."
      elif (( !(notified & 8) )); then
        type_line "$SESSION:$w" "Firstmate instruction waiting: read and act on each *.msg in $inbox in numeric order, then mv each into its handled/."
        (( notified |= 8 ))
        master "Freeze watch: second mate $w stuck after an API Error with ${msgs} inbox message(s); Enter and a nudge sent. Not killed: if it stays frozen, restart it by hand."
      fi
    fi
  fi
  if (( idle >= STALL_MIN && !(notified & 1) )); then
    "$FM/bin/fm-inbox.sh" note --request-id "stall-$w-$since" -- "STALL WATCH: worker window $w has shown no change for $idle min. Last line: $last. Steer it, unblock it, or close it if it's done, then report." >/dev/null 2>&1 &&
      { echo "$(date -u +%FT%TZ) $w idle ${idle}m (firstmate told): $last" >> "$ALERTS"; (( notified |= 1 )); }
  fi
  if (( idle >= PING_MIN && !(notified & 2) )); then
    python3 "$HARNESS_DIR/modules/cron/tg-notify.py" "Stall watch: firstmate worker $w idle ${idle} min. Last: $last" >/dev/null 2>&1 &&
      { echo "$(date -u +%FT%TZ) $w idle ${idle}m (Telegram ping)" >> "$ALERTS"; (( notified |= 2 )); }
  fi
  echo "$w $h $since $notified" >> "$new_state"
done
mv "$new_state" "$STATE"
