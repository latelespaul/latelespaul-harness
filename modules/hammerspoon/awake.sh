#!/bin/zsh
# awake: hold Hammerspoon's awake mode (modules/hammerspoon/init.lua) for any task that needs the
# screen, so the idle lock cannot stop it. Linked to ~/.local/bin/awake by install.sh.
#   awake run <name> [--minutes N] -- <command...>
#        hold it while the command runs; release (and lock) when it ends, fails or is killed
#   awake on <name> [--minutes N] [--pid P]   hold it (released when P exits, or at the deadline)
#   awake off <name>                           release it; the last holder locks the screen
#   awake status                               JSON: is it on, who holds it
# The command always runs, even when Hammerspoon does not answer (a warning goes to stderr).
# While it runs, `run` checks its hold every AWAKE_RECHECK_SECS (default 60) seconds. A hold that
# Hammerspoon lost (it restarted or reloaded, or a person or a lock suspended it) is taken again;
# a hold that ended on purpose after `run` took it (an `awake off`, the deadline) stays ended. While
# Hammerspoon does not answer, `caffeinate -d -i -u -w <this pid>` keeps the display awake instead
# (no dim and no lock on touch; it ends with this process). AWAKE_CAFFEINATE=0 turns that fallback off.
export PATH=$PATH:/opt/homebrew/bin:/usr/local/bin   # callers (and tests) may put their own hs first

usage() { print -u2 "usage: awake run <name> [--minutes N] -- <command...> | on <name> [...] | off <name> | status"; exit 2 }

hs_call() {   # hs_call <lua expression> <port command> [port args JSON]; prints the JSON answer, exit 1 if Hammerspoon does not answer
  local out
  # `hs -c` first; with the generic port closed (HS_IPC_GENERIC=0) the harness port through hsx.
  out=$(hs -t 5 -c "return harness and harness.awake and $1 or 'no awake mode'" 2>/dev/null) \
    || out=$(hsx --timeout 5 call $2 ${3:+"$3"} 2>/dev/null) || return 1
  out=${out##*$'\n'}   # last line (Hammerspoon may print log lines first)
  [[ $out == '{'* ]] || return 1
  print -r -- $out
}

cmd=$1; shift 2>/dev/null
[[ $cmd == status ]] && { hs_call 'hs.json.encode(harness.awakeInfo())' awake.status || { print -u2 "awake: Hammerspoon not answering"; exit 1 }; exit 0 }
[[ $cmd == (run|on|off) ]] || usage
name=$1; shift 2>/dev/null
[[ $name =~ '^[A-Za-z0-9._-]+$' ]] || { print -u2 "awake: name must be letters, digits, . _ -"; exit 2 }

minutes=600 pid=$PPID
while (( $# )); do
  case $1 in
    --minutes) [[ $2 == <1-> ]] || usage; minutes=$2; shift 2 ;;
    --pid) [[ $2 == <1-> ]] || usage; pid=$2; shift 2 ;;
    --) shift; break ;;
    *) [[ $cmd == run ]] && break; usage ;;
  esac
done

on() {   # on <pid> [minutes]: 0 = held, 1 = Hammerspoon not answering, 2 = refused
  local ans m=${2:-$minutes}
  ans=$(hs_call "harness.awake(true, {owner='$name', minutes=$m, pid=$1})" awake.on "{\"owner\":\"$name\",\"minutes\":$m,\"pid\":$1}") \
    || { print -u2 "awake: Hammerspoon not answering; running without awake mode"; return 1 }
  [[ $ans =~ '"on" *: *true' ]] && return 0
  [[ $ans =~ '"reason" *: *"([^"]*)"' ]] && print -u2 "awake: awake mode refused ($match[1]); running without it" \
    || print -u2 "awake: awake mode refused; running without it"
  return 2
}

cpid=
fallback() {   # fallback on|off: caffeinate while Hammerspoon does not answer, tied to this run ($$)
  if [[ $1 == on ]]; then
    [[ -z $cpid && $AWAKE_CAFFEINATE != 0 ]] && command -v caffeinate >/dev/null || return 0
    caffeinate -d -i -u -w $$ &
    cpid=$!
    print -u2 "awake: keeping the display awake with caffeinate until Hammerspoon answers (no dim, no lock on touch)"
  elif [[ -n $cpid ]]; then
    kill $cpid 2>/dev/null; cpid=
  fi
}

# keeper <started (UTC)> <deadline (epoch)> <held (1/0)>: runs in the background during `run` and
# keeps its hold (see the header). Ends when `run` ends, at the deadline, or when the hold ended
# on purpose.
keeper() {
  local started=$1 deadline=$2 held=$3 every=${AWAKE_RECHECK_SECS:-60} spid= st
  local own="\"owners\" *: *[[][^]]*\"${name//./[.]}\"" re
  local mine="\"ended\" *: *[{].*\"${name//./[.]}\" *: *[{][^}]*\"at\" *: *\"([^\"]*)\"" ended='"last_end" *: *[{][^}]*"at" *: *"([^"]*)"'
  trap 'kill $spid $cpid 2>/dev/null; exit 0' TERM
  while kill -0 $$ 2>/dev/null; do
    sleep $every & spid=$!
    wait $spid
    kill -0 $$ 2>/dev/null && (( EPOCHSECONDS < deadline )) || break
    if ! st=$(hs_call 'hs.json.encode(harness.awakeInfo())' awake.status); then
      fallback on; continue
    fi
    fallback off
    [[ $st =~ $own ]] && { held=1; continue }
    # Ended after `run` held it (an `awake off`, the deadline): leave it ended. A suspended hold
    # has no end record, so it is asked for again (refused while the screen is locked).
    if (( held )); then
      for re in $mine $ended; do [[ $st =~ $re && ! $match[1] < $started ]] && break 2; done
    fi
    (( held )) && print -u2 "awake: Hammerspoon lost the hold; taking it again"
    on $$ $(( (deadline - EPOCHSECONDS + 59) / 60 )) 2>/dev/null && held=1
  done
  fallback off
}
off() { hs_call "harness.awake(false, {owner='$name', lock=true, reason='$name finished'})" awake.off "{\"owner\":\"$name\",\"lock\":true,\"reason\":\"$name finished\"}" >/dev/null }

case $cmd in
on)  hs_call "harness.awake(true, {owner='$name', minutes=$minutes, pid=$pid})" awake.on "{\"owner\":\"$name\",\"minutes\":$minutes,\"pid\":$pid}" || { print -u2 "awake: Hammerspoon not answering"; exit 1 } ;;
off) hs_call "harness.awake(false, {owner='$name', lock=true, reason='$name released'})" awake.off "{\"owner\":\"$name\",\"lock\":true,\"reason\":\"$name released\"}" || { print -u2 "awake: Hammerspoon not answering"; exit 1 } ;;
run)
  (( $# )) || usage
  zmodload zsh/datetime
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ) deadline=$(( EPOCHSECONDS + minutes * 60 ))
  on $$; got=$?
  (( got == 1 )) && fallback on
  keeper $started $deadline $(( got == 0 )) & kpid=$!
  # The keeper first, so it cannot take the hold again after the release.
  finish() { kill $kpid 2>/dev/null; wait $kpid 2>/dev/null; [[ -n $cpid ]] && kill $cpid 2>/dev/null; off }
  trap 'finish; exit 130' INT
  trap 'finish; exit 143' TERM HUP
  "$@"; rc=$?
  finish
  exit $rc ;;
esac
