#!/bin/zsh
# Browser module: the mode of each browser profile (~/.chrome-<id>), kept in one state file per profile.
#   chrome-mode.sh <id>                                   print its mode: agent or desktop
#   chrome-mode.sh <id> agent|desktop [--writer <name>]   record a switch (a tool that switches calls this)
# agent   (the default) the LaunchAgent com.<prefix>.chrome-<id> runs Chrome on the profile with its debug port.
# desktop another tool runs the profile as a normal Chrome, without the debug port. install.sh and
#         chrome-launch.sh then leave the LaunchAgent stopped: a launch on a profile that is already open
#         is handed to that Chrome, which only opens one more empty window.
# State file: $CHROME_MODE_DIR/<id>.json (default ~/.local/state/harness/chrome-mode), replaced whole:
#   {"mode": "desktop", "updated": "2026-01-31T12:00:00Z", "writer": "<tool>"}
# A missing or unreadable file means agent. Sourcing this file only defines the two functions below.

# chrome_mode_file <id>: path of the profile's state file.
chrome_mode_file() { print -r -- ${CHROME_MODE_DIR:-$HOME/.local/state/harness/chrome-mode}/$1.json }

# chrome_mode <id>: print agent or desktop.
chrome_mode() {
  local f=$(chrome_mode_file $1) key=mode
  # Legacy fallback, remove once job-hunt writes the file above: its chrome-mode tool records the
  # personal browser's mode in ~/.local/state/job-hunt/chrome-mode.json. While it switches, "mode" is
  # still the old one, so its "intent" key (the mode it switches to) decides when present.
  if [[ ! -e $f && $1 == personal ]]; then
    f=$HOME/.local/state/job-hunt/chrome-mode.json
    [[ -r $f && "$(<$f)" == *'"intent"'* ]] && key=intent
  fi
  local re="\"$key\"[[:space:]]*:[[:space:]]*\"desktop\""
  if [[ -r $f && "$(<$f)" =~ $re ]]; then print desktop; else print agent; fi
}

[[ $ZSH_EVAL_CONTEXT == toplevel ]] || return 0

usage() { print -u2 "usage: $0 <id> [agent|desktop [--writer <name>]]"; exit 1 }
id=$1 mode=$2 writer=chrome-mode.sh
[[ $id =~ '^[A-Za-z0-9_-]+$' ]] || usage
if (( $# == 1 )); then chrome_mode $id; exit 0; fi
[[ $mode == (agent|desktop) ]] || usage
if (( $# > 2 )); then
  [[ $3 == --writer && $4 =~ '^[A-Za-z0-9._-]+$' && $# == 4 ]] || usage
  writer=$4
fi
f=$(chrome_mode_file $id)
json="{\"mode\": \"$mode\", \"updated\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"writer\": \"$writer\"}"
if [[ $HARNESS_DRY_RUN == 1 ]]; then print -r -- "would write $f: $json"; exit 0; fi
mkdir -p ${f:h}
print -r -- $json > $f.tmp.$$ && mv $f.tmp.$$ $f
print -r -- "chrome-$id: $mode mode recorded in $f"
if [[ $mode == agent ]]; then
  print -r -- "Start its agent again with: ${0:A:h}/install.sh"
else
  print -r -- "Its agent now stays stopped (install.sh and launchd leave it alone)."
fi
