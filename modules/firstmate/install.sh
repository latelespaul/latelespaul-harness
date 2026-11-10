#!/bin/zsh
# Firstmate module: clones firstmate (kunchenguid/firstmate, or your fork) and installs the
# skill that delegates code work to it. Firstmate itself runs in tmux via run-firstmate.sh.
#   install.sh           clone if missing, install the skill
#   install.sh --start   also start the tmux session if it is not running
#   install.sh --status  is the session up? (exit 1 if not)
set -e
# --dry-run anywhere: print actions only (same as HARNESS_DRY_RUN=1).
(( ${argv[(Ie)--dry-run]} )) && { export HARNESS_DRY_RUN=1; argv=(${argv:#--dry-run}) }
source ${0:A:h:h:h}/lib/common.sh
mod=$HARNESS_DIR/modules/firstmate
mode=${1:-install}

case $mode in
--status)
  if tmux has-session -t $FIRSTMATE_SESSION 2>/dev/null; then
    print "firstmate is running in tmux session $FIRSTMATE_SESSION ($FIRSTMATE_DIR)."
    [[ -x $FIRSTMATE_DIR/bin/fm-inbox.sh ]] && $FIRSTMATE_DIR/bin/fm-inbox.sh status 2>/dev/null | head -20 || true
    exit 0
  fi
  print "firstmate is not running (start: $0 --start)."
  exit 1 ;;
install|--start) ;;
*) print "usage: $0 [--start|--status]"; exit 1 ;;
esac

command -v tmux >/dev/null || print "Note: firstmate runs in tmux: brew install tmux"
gh auth status >/dev/null 2>&1 || print "Note: firstmate needs an authenticated GitHub CLI: gh auth login"

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

if [[ $mode == --start ]]; then
  if tmux has-session -t $FIRSTMATE_SESSION 2>/dev/null; then
    print "firstmate already running in tmux session $FIRSTMATE_SESSION."
  else
    act tmux new -d -s $FIRSTMATE_SESSION $mod/run-firstmate.sh
    dry || print "started firstmate in tmux session $FIRSTMATE_SESSION (watch: tmux attach -t $FIRSTMATE_SESSION)."
  fi
else
  tmux has-session -t $FIRSTMATE_SESSION 2>/dev/null \
    || print "Start firstmate with: $0 --start  (it does not survive a reboot; start it again after one)"
fi
true
