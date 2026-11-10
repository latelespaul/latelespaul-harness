#!/bin/zsh
# Hammerspoon module: one signed app that holds Accessibility + Screen Recording for agent GUI tools.
#   install.sh            link ~/.hammerspoon/init.lua, ~/.local/bin/awake and ~/.local/bin/hsx to this module,
#                         start Hammerspoon, or restart it when its config changed (deferred while
#                         awake mode is held or an owner is armed; see SETUP.md)
#   install.sh --status   is it running, is the `hs` CLI reachable, are the permissions on? (exit 1 if not)
#   install.sh --config-hash   the fingerprint init.lua reports as "config" for this harness
set -e
(( ${argv[(Ie)--dry-run]} )) && { export HARNESS_DRY_RUN=1; argv=(${argv:#--dry-run}) }
source ${0:A:h:h:h}/lib/common.sh
mod=$HARNESS_DIR/modules/hammerspoon
hs_app=${HS_APP:-/Applications/Hammerspoon.app}

# `hs -c`, or the harness port when the generic one is closed (HS_IPC_GENERIC=0).
status_json() {
  { command -v hs >/dev/null && hs -t 3 -c 'return harness and harness.status() or "{}"' 2>/dev/null } \
    || $mod/hsx --timeout 3 status 2>/dev/null
}

# The same fingerprint init.lua computes at load (harness.configHash): the module folder, the
# harness.env values init.lua reads, and every harness file Hammerspoon loads.
config_hash() {
  local out
  out=$({ print -rl -- ${mod:A} "HS_IPC_GENERIC=$HS_IPC_GENERIC" "HS_ACCESS_FILE=$HS_ACCESS_FILE"
          cat ${mod:A}/init.lua ${mod:A}/port.lua ${mod:A}/guard.lua } | shasum -a 256)
  print -r -- ${out%% *}
}

# Who still needs the running Hammerspoon. `status` reads its status JSON on stdin; `file` reads
# the saved awake holds (for when it does not answer). Prints "config <hash>", "hold <owner>" and
# "arm <owner>" lines. Arm secrets live only in Hammerspoon's memory, so a restart drops every arm.
needs() { python3 -c "$needs_py" "$@" || true }
needs_py='
import json, os, sys, time
def alive(pid):
    try: os.kill(int(pid), 0)
    except PermissionError: return True
    except (OSError, ValueError, OverflowError): return False
    return True
try:
    if sys.argv[1] == "status":
        s = json.loads(sys.stdin.read() or "{}")
        print("config", s.get("config") or "-")
        aw, port = s.get("awake") or {}, s.get("port") or {}
        for o in aw.get("owners") or []: print("hold", o)
        owners = port.get("owners") if isinstance(port.get("owners"), dict) else {}
        for o, v in sorted(owners.items()):
            if isinstance(v, dict) and v.get("armed"): print("arm", o)
    else:
        with open(sys.argv[2]) as f: holds = json.load(f).get("holds") or {}
        for o, h in sorted(holds.items() if isinstance(holds, dict) else []):
            if isinstance(h, dict) and float(h.get("until") or 0) > time.time() and (h.get("pid") is None or alive(h["pid"])):
                print("hold", o)
except (OSError, ValueError, AttributeError, TypeError):
    pass   # unreadable: nothing known to protect
'

case ${1:-install} in
--status)
  pgrep -xq Hammerspoon || { print "Hammerspoon is not running (open -a Hammerspoon)."; exit 1 }
  j=$(status_json) || { print "Hammerspoon runs, but neither the hs CLI nor the harness port answers (reload the config)."; exit 1 }
  print -r -- "$j"
  [[ $j == *'"accessibility":true'* ]] || { print "Grant Accessibility: System Settings > Privacy & Security > Accessibility > Hammerspoon."; exit 1 }
  [[ $j == *'"screen_recording":false'* ]] && { print "Grant Screen Recording: System Settings > Privacy & Security > Screen Recording > Hammerspoon."; exit 1 }
  exit 0 ;;
--config-hash) config_hash; exit 0 ;;
install) ;;
*) print "usage: $0 [--status | --config-hash]"; exit 1 ;;
esac

[[ -d $hs_app ]] || { print "Install it first: brew install --cask hammerspoon"; dry || exit 1 }
ensure_dir $HOME/.hammerspoon
ensure_dir $HOME/.hammerspoon/local
link $mod/init.lua $HOME/.hammerspoon/init.lua
ensure_dir $HOME/.local/bin
link $mod/awake.sh $HOME/.local/bin/awake   # awake run <name> -- <cmd>: no idle lock while a GUI task runs
act chmod +x $mod/hsx
link $mod/hsx $HOME/.local/bin/hsx          # client for the authenticated harness port

if ! pgrep -xq Hammerspoon; then
  act open -a Hammerspoon
  print "Hammerspoon started with the harness config. Check: $0 --status"
  exit 0
fi

# Running: restart only for a changed config, and never under a job that needs it. A restart drops
# every arm (they re-arm) and, with a config older than hold restore, every awake hold.
want=$(config_hash)
if j=$(status_json); then
  info=("${(@f)$(print -r -- "$j" | needs status)}")
  have=${${(M)info:#config *}#config }
  if [[ $have == $want ]]; then
    print "Hammerspoon already runs this config (unchanged); not restarting."
    exit 0
  fi
  [[ $have == (-|) ]] && why="the running config does not report its fingerprint" || why="the config changed"
else
  info=("${(@f)$(needs file $HOME/.hammerspoon/harness-awake.json)}")
  why="Hammerspoon does not answer"
fi
holds=(${${(M)info:#hold *}#hold }) arms=(${${(M)info:#arm *}#arm })
busy=()
(( $#holds )) && busy+=("awake mode is held by ${(j:, :)holds}")
(( $#arms )) && busy+=("armed: ${(j:, :)arms}")
if (( $#busy )); then
  print -r -- "restart deferred: $why, but ${(j: and :)busy}. Run $0 again once they finish."
  exit 0
fi
print -r -- "restarting Hammerspoon: $why"
act osascript -e 'tell application "Hammerspoon" to quit'
dry || sleep 2
act open -a Hammerspoon
print "Hammerspoon restarted with the harness config. Check: $0 --status"
