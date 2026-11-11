#!/bin/zsh
# Eyes & Hands module: the EyesHands.spoon engine plus the `eyeshands` CLI and MCP server, run inside
# the harness Hammerspoon (docs/eyes-hands-design.md). Needs the hammerspoon module.
#   install.sh              link ~/.hammerspoon/Spoons/EyesHands.spoon, the loader
#                           ~/.hammerspoon/local/eyeshands.lua and ~/.local/bin/eyeshands to this
#                           module, then restart Hammerspoon once so the loader runs (through
#                           modules/hammerspoon/install.sh --restart: deferred while awake mode is
#                           held or a port owner is armed; also deferred while Eyes & Hands is busy)
#   install.sh --no-restart link only; the Spoon starts at the next Hammerspoon start
#   install.sh --restart    restart even when the Spoon already runs (to load changed Spoon code)
#   install.sh --mcp        also register the MCP server with Claude Code (owner harness-session);
#                           without it, install only prints the claude mcp add line
#   install.sh --status     links, Hammerspoon, the eyeshands port, grants, policy (exit 1 if not ok)
#   install.sh --uninstall  remove the three links (never the access or targets file), then the same
#                           deferred restart so the Spoon stops; with --mcp also the MCP entry
#                           (without it, only the claude mcp remove line is printed)
#   --dry-run               print what it would do, change nothing
set -e
(( ${argv[(Ie)--dry-run]} )) && { export HARNESS_DRY_RUN=1; argv=(${argv:#--dry-run}) }
source ${0:A:h:h:h}/lib/common.sh
mod=$HARNESS_DIR/modules/eyeshands
hsmod=$HARNESS_DIR/modules/hammerspoon
cli=$mod/bin/eyeshands
owner=harness-session
spoon_link=$HOME/.hammerspoon/Spoons/EyesHands.spoon
loader_link=$HOME/.hammerspoon/local/eyeshands.lua
cli_link=$HOME/.local/bin/eyeshands
typeset -A source_of=($spoon_link $mod/EyesHands.spoon $loader_link $mod/loader.lua $cli_link $cli)
links=($spoon_link $loader_link $cli_link)
mcp_line="claude mcp add --scope user eyeshands -- $cli_link mcp --owner $owner"

mode=install restart=auto mcp=0
for a in "$@"; do
  case $a in
    --status) mode=status ;;
    --uninstall) mode=uninstall ;;
    --restart) restart=force ;;
    --no-restart) restart=never ;;
    --mcp) mcp=1 ;;
    *) print -u2 "usage: $0 [--status | --uninstall] [--restart | --no-restart] [--mcp] [--dry-run]"; exit 1 ;;
  esac
done

# Is ~/.hammerspoon/init.lua the harness config (the hammerspoon module), which loads the loader?
harness_config() { local f=$HOME/.hammerspoon/init.lua; [[ -L $f && ${f:A} == ${${:-$hsmod/init.lua}:A} ]] }

# is_ours <link>: is it a symlink into this module's file for that path?
is_ours() { [[ -L $1 && ${1:A} == ${source_of[$1]:A} ]] }

# The Spoon's status JSON over its own port (no secret), or a non-zero exit when it does not answer.
eh_status() { $cli --timeout 3 status 2>/dev/null }

# Does the harness Hammerspoon config answer (hs -c, or the harness port when that is closed)?
harness_up() {
  { command -v hs >/dev/null && [[ $(hs -t 3 -c 'return harness and "up" or "no"' 2>/dev/null) == up ]] } \
    || $hsmod/hsx --timeout 3 status >/dev/null 2>&1
}

# Reads the Spoon's status JSON on stdin. `busy` prints what a restart would cut short; `summary`
# prints the --status lines and exits 1 when the Spoon is not started or Accessibility is off.
eh_py='
import json, sys
try: s = json.loads(sys.stdin.read() or "{}")
except ValueError: s = {}
if not isinstance(s, dict): s = {}
acc = s.get("access") if isinstance(s.get("access"), dict) else {}
owners = acc.get("owners") if isinstance(acc.get("owners"), dict) else {}
armed = sorted(o for o, v in owners.items() if isinstance(v, dict) and v.get("armed"))
hands = s.get("hands") if isinstance(s.get("hands"), dict) else {}
if sys.argv[1] == "busy":
    if armed: print("armed: " + ", ".join(armed))
    if hands.get("busy") not in (None, False): print("a hands job runs (job %s)" % hands.get("busy"))
    if hands.get("lease") not in (None, False): print("%s holds the hands lease" % hands.get("lease"))
    stop = s.get("stop") if isinstance(s.get("stop"), dict) else {}
    if stop.get("stopped") is True: print("the stop switch is on until %s" % stop.get("until", "?"))
    sys.exit(0)
bad = 0
if s.get("running") is not True:
    print("Eyes & Hands: the Spoon is loaded but not started"); bad = 1
else:
    print("Eyes & Hands %s runs on port %s" % (s.get("version", "?"), s.get("port", "?")))
g = s.get("grants") if isinstance(s.get("grants"), dict) else {}
sr = g.get("screen_recording")
print("Accessibility: " + ("on" if g.get("accessibility") is True else "OFF (System Settings > Privacy & Security > Accessibility > Hammerspoon)"))
print("Screen Recording: " + ("on" if sr is True else "off (no shots or pixels; AX eyes and hands still work)" if sr is False else "unknown"))
if g.get("accessibility") is not True: bad = 1
on = sorted(o for o, v in owners.items() if isinstance(v, dict) and v.get("enabled"))
print("access policy: %s; enabled owners: %s" % (acc.get("policy", "?"), ", ".join(on) or "none (default deny)")
      + ("; armed: " + ", ".join(armed) if armed else ""))
t = s.get("targets") if isinstance(s.get("targets"), dict) else {}
if t: print("targets file: %s (%s)" % (t.get("file", "?"), t.get("error") or "%s, %s target(s)" % (t.get("state", "?"), t.get("count", 0))))
sys.exit(bad)
'

# restart_hs <why> <again>: the hammerspoon module's restart, unless Eyes & Hands itself is busy.
restart_hs() {
  local why=$1 again=$2 st busy=()
  if st=$(eh_status); then
    busy=("${(@f)$(print -r -- "$st" | python3 -c "$eh_py" busy)}")
    busy=(${busy:#})
  fi
  if (( $#busy )); then
    print -r -- "restart deferred: $why, but Eyes & Hands is busy (${(j:; :)busy}). Run $again again once it is done."
    return 0
  fi
  $hsmod/install.sh --restart "$why" "$again"
}

# The MCP entry Claude Code keeps in ~/.claude.json (scope user).
mcp_registered() { [[ -f $HOME/.claude.json ]] && jq -e '.mcpServers.eyeshands' $HOME/.claude.json >/dev/null 2>&1 }

case $mode in
status)
  bad=0
  for l in $links; do
    if is_ours $l; then print -r -- "ok      $l"
    else print -r -- "MISSING $l -> ${source_of[$l]} (run $0)"; bad=1; fi
  done
  if ! harness_config; then
    print "The harness Hammerspoon config is not installed, so nothing runs the loader: $hsmod/install.sh"; bad=1
  fi
  mcp_registered && print "MCP: Claude Code has an eyeshands server" || print -r -- "MCP: not registered with Claude Code ($mcp_line)"
  if ! pgrep -xq Hammerspoon; then
    print "Hammerspoon is not running (open -a Hammerspoon)."; exit 1
  fi
  if st=$(eh_status); then
    print -r -- "$st" | python3 -c "$eh_py" summary || bad=1
  else
    print "The eyeshands port does not answer: the Spoon is not loaded (run $0, or $0 --restart)."; bad=1
  fi
  print "Full check: eyeshands doctor"
  exit $bad ;;

uninstall)
  for l in $links; do
    if is_ours $l; then
      act rm $l; dry || print -r -- "removed $l"
    elif [[ -e $l || -L $l ]]; then
      print -r -- "left $l: it is not a link into this module"
    fi
  done
  if mcp_registered; then
    if (( mcp )); then act claude mcp remove --scope user eyeshands
    else print "Claude Code still has the eyeshands MCP server: claude mcp remove --scope user eyeshands"; fi
  fi
  print -r -- "Kept: the access policy file ($HS_ACCESS_FILE) and the targets file ($EYESHANDS_TARGETS_FILE)."
  if [[ $restart != never ]] && pgrep -xq Hammerspoon && eh_status >/dev/null; then
    restart_hs "Eyes & Hands was uninstalled and its Spoon still runs" "$0 --uninstall"
  fi
  exit 0 ;;
esac

# --- install --------------------------------------------------------------------------------
if ! harness_config; then
  print "Install the hammerspoon module first ($hsmod/install.sh): the harness config runs the loader."
  dry || exit 1
fi
command -v python3 >/dev/null || { print "python3 is needed for the eyeshands CLI: xcode-select --install"; dry || exit 1 }

ensure_dir $HOME/.hammerspoon/Spoons
link $mod/EyesHands.spoon $spoon_link     # hs.loadSpoon("EyesHands") finds it here
ensure_dir $HOME/.hammerspoon/local
link $mod/loader.lua $loader_link         # the harness config loads ~/.hammerspoon/local/*.lua last
ensure_dir $HOME/.local/bin
act chmod +x $cli
link $cli $cli_link                       # CLI and MCP server

# Claude Code's MCP server for this harness: only when asked (--mcp).
if mcp_registered; then
  print "MCP: Claude Code already has an eyeshands server."
elif (( mcp )); then
  act ${(z)mcp_line}
else
  print -r -- "MCP (not registered): $mcp_line"
fi

# Default deny: say what grants harness-session, never write the access file here.
if ! jq -e --arg o $owner '.owners[$o].enabled == true' $HS_ACCESS_FILE >/dev/null 2>&1; then
  print -r -- "Access (default deny; $owner has none): eyeshands access allow $owner eyes,shot,hands --apps chrome-agent,com.apple.TextEdit"
fi
[[ -f $EYESHANDS_TARGETS_FILE ]] || print -r -- "Targets (optional; bundle ids work without): cp $mod/targets.example.json $EYESHANDS_TARGETS_FILE"

# One Hammerspoon restart so the loader runs (design part 19, decision 5).
if [[ $restart == never ]]; then
  print "Not restarting (--no-restart): the Spoon starts at the next Hammerspoon start."
  exit 0
fi
if ! pgrep -xq Hammerspoon; then
  print "Hammerspoon is not running; the Spoon starts with it (open -a Hammerspoon)."
  exit 0
fi
# Right after the hammerspoon module restarted Hammerspoon, give the config time to load (the
# loader runs at its end), so a slow start never costs a second restart.
wait_end=$(( SECONDS + ${EYESHANDS_WAIT_SECS:-15} ))
until harness_up || (( SECONDS >= wait_end )) || dry; do sleep 1; done
if st=$(eh_status); then
  if [[ $restart != force ]]; then
    print "Eyes & Hands already runs; not restarting. To load changed Spoon code: $0 --restart"
    exit 0
  fi
  why="--restart asked to load the Spoon again"
else
  why="the Eyes & Hands Spoon is not loaded yet"
fi
again=$0
[[ $restart == force ]] && again+=" --restart"
restart_hs "$why" "$again"
