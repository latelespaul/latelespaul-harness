#!/bin/zsh
# Firstmate module: installs the toolchain firstmate and its crew call (tools.sh), clones firstmate
# (kunchenguid/firstmate, or your fork) and installs the skill that delegates code work to it.
# Firstmate itself runs in tmux via run-firstmate.sh; start.sh starts that session when it is missing.
#   install.sh           install missing tools, clone if missing, install the skill, register autostart
#   install.sh --start   also start the tmux session if it is not running
#   install.sh --autostart  start the session only if missing (same as start.sh; installs nothing)
#   install.sh --status  tools present, autostart registered and the session up? (exit 1 if not)
# With FIRSTMATE_AUTOSTART=1 (default) the hcron job firstmate-start runs start.sh every 5 minutes
# with --catchup, so the session comes back after a login or reboot (hcron has no at-login trigger).
set -e
# --dry-run anywhere: print actions only (same as HARNESS_DRY_RUN=1).
(( ${argv[(Ie)--dry-run]} )) && { export HARNESS_DRY_RUN=1; argv=(${argv:#--dry-run}) }
source ${0:A:h:h:h}/lib/common.sh
mod=$HARNESS_DIR/modules/firstmate
mode=${1:-install}

case $mode in
--status)
  rc=0
  zsh $mod/tools.sh --status || rc=1
  zsh $mod/start.sh --status || rc=1
  if tmux has-session -t "=$FIRSTMATE_SESSION" 2>/dev/null; then
    print "firstmate is running in tmux session $FIRSTMATE_SESSION ($FIRSTMATE_DIR)."
    [[ -x $FIRSTMATE_DIR/bin/fm-inbox.sh ]] && $FIRSTMATE_DIR/bin/fm-inbox.sh status 2>/dev/null | head -20 || true
  else
    print "firstmate is not running (start: $0 --start)."
    rc=1
  fi
  exit $rc ;;
--autostart)
  # Only start the session if it is missing. No tool installs, clone or rendering, so an
  # unattended start never installs or upgrades anything.
  exec zsh $mod/start.sh ;;
install|--start) ;;
*) print "usage: $0 [--start|--autostart|--status]"; exit 1 ;;
esac

# A tool that could not be installed is reported but does not stop the clone and skill.
zsh $mod/tools.sh || print "Note: some firstmate tools are still missing (see above; check: $mod/tools.sh --status)."

if [[ ! -d $FIRSTMATE_DIR/.git ]]; then
  act mkdir -p ${FIRSTMATE_DIR:h}
  act git clone -q $FIRSTMATE_REPO $FIRSTMATE_DIR
  dry || print "cloned $FIRSTMATE_REPO into $FIRSTMATE_DIR"
else
  print "firstmate already at $FIRSTMATE_DIR; left it alone (update it from inside firstmate)."
fi
if [[ -n $FIRSTMATE_UPSTREAM ]] && ! git -C $FIRSTMATE_DIR remote get-url upstream >/dev/null 2>&1; then
  act git -C $FIRSTMATE_DIR remote add upstream $FIRSTMATE_UPSTREAM
fi

# The skill is rendered (it names this user's paths), so it is a real folder, not a link.
ensure_dir $claude_dir/skills/firstmate
write_file $claude_dir/skills/firstmate/SKILL.md "$(render $mod/skill/SKILL.md.tmpl)"

# Its own Telegram bot shares the plugin settings with the telegram module.
if [[ $FIRSTMATE_TELEGRAM == 1 ]]; then
  write_file $HOME/.claude/telegram-settings.json "$(render $HARNESS_DIR/modules/telegram/session-settings.json.tmpl)"
  act mkdir -p ~/.claude/channels/telegram-firstmate/logs
fi

# Start after a login or reboot, so firstmate doesn't stay down (FIRSTMATE_AUTOSTART=0 turns it off).
# Registered with hcron, the one scheduler, never a LaunchAgent of its own. Skipped under --start.
[[ $mode == install ]] && zsh $mod/start.sh --register

if [[ $mode == --start ]]; then
  zsh $mod/start.sh
elif ! tmux has-session -t "=$FIRSTMATE_SESSION" 2>/dev/null; then
  if [[ $FIRSTMATE_AUTOSTART == 1 ]]; then print "Start firstmate now with: $0 --start  (or wait: hcron job firstmate-start starts it within 5 minutes, and after every login)"
  else print "Start firstmate with: $0 --start  (FIRSTMATE_AUTOSTART=0: start it again after a reboot)"; fi
fi
true
