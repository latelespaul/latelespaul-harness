#!/bin/zsh
# awake: hold Hammerspoon's awake mode (modules/hammerspoon/init.lua) for any task that needs the
# screen, so the idle lock cannot stop it. Linked to ~/.local/bin/awake by install.sh.
#   awake run <name> [--minutes N] -- <command...>
#        hold it while the command runs; release (and lock) when it ends, fails or is killed
#   awake on <name> [--minutes N] [--pid P]   hold it (released when P exits, or at the deadline)
#   awake off <name>                           release it; the last holder locks the screen
#   awake status                               JSON: is it on, who holds it
# The command always runs, even when Hammerspoon does not answer (a warning goes to stderr).
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

on() {
  local ans
  ans=$(hs_call "harness.awake(true, {owner='$name', minutes=$minutes, pid=$1})" awake.on "{\"owner\":\"$name\",\"minutes\":$minutes,\"pid\":$1}") \
    || { print -u2 "awake: Hammerspoon not answering; running without awake mode"; return }
  [[ $ans =~ '"on" *: *true' ]] && return
  [[ $ans =~ '"reason" *: *"([^"]*)"' ]] && print -u2 "awake: awake mode refused ($match[1]); running without it" \
    || print -u2 "awake: awake mode refused; running without it"
}
off() { hs_call "harness.awake(false, {owner='$name', lock=true, reason='$name finished'})" awake.off "{\"owner\":\"$name\",\"lock\":true,\"reason\":\"$name finished\"}" >/dev/null }

case $cmd in
on)  hs_call "harness.awake(true, {owner='$name', minutes=$minutes, pid=$pid})" awake.on "{\"owner\":\"$name\",\"minutes\":$minutes,\"pid\":$pid}" || { print -u2 "awake: Hammerspoon not answering"; exit 1 } ;;
off) hs_call "harness.awake(false, {owner='$name', lock=true, reason='$name released'})" awake.off "{\"owner\":\"$name\",\"lock\":true,\"reason\":\"$name released\"}" || { print -u2 "awake: Hammerspoon not answering"; exit 1 } ;;
run)
  (( $# )) || usage
  on $$
  trap 'off; exit 130' INT
  trap 'off; exit 143' TERM HUP
  "$@"; rc=$?
  off
  exit $rc ;;
esac
