#!/bin/zsh
# Telegram module: an always-on Claude session you drive from your phone, kept healthy by a watchdog.
# Runs on one Mac at a time: the one named in $PROFILE_DIR/telegram/ACTIVE_HOST.
#   install.sh              install here (refuses if another Mac owns the bot)
#   install.sh --take-over  move the bot to this Mac; the old Mac stops within ~10 min
#   install.sh --uninstall  stop and remove it from this Mac
#   install.sh --status     show who owns the bot and how it is doing (exit 1 if not running here)
set -e
# --dry-run anywhere: print actions only (same as HARNESS_DRY_RUN=1).
(( ${argv[(Ie)--dry-run]} )) && { export HARNESS_DRY_RUN=1; argv=(${argv:#--dry-run}) }
source ${0:A:h:h:h}/lib/common.sh
mod=$HARNESS_DIR/modules/telegram
data=$PROFILE_DIR/telegram               # synced: ACTIVE_HOST, morning-brief.md, watchlist.txt
state=$HOME/.claude/channels/telegram    # per Mac, never in git: .env (token), access.json (pairing), logs
all=(telegram keep-awake telegram-watchdog morning-brief)
names=(telegram keep-awake telegram-watchdog)
[[ -f $data/morning-brief.md ]] && names+=morning-brief
label() { print com.$LABEL_PREFIX.$1 }
host=$(scutil --get LocalHostName 2>/dev/null || hostname -s)
uid=$(id -u)
mode=${1:-install}
BRIEF_HOUR=$((10#${TELEGRAM_BRIEF_TIME%%:*})) BRIEF_MINUTE=$((10#${TELEGRAM_BRIEF_TIME#*:}))
render_keys+=(BRIEF_HOUR BRIEF_MINUTE)

owner() { git -C $PROFILE_DIR show '@{u}:telegram/ACTIVE_HOST' 2>/dev/null || cat $data/ACTIVE_HOST 2>/dev/null || true }
stop_agents() { for n in $all; do launchd_unload $(label $n); done }
set_owner() {
  if dry; then print "would set $data/ACTIVE_HOST to '${1:-}' and commit + push the profile"; return 0; fi
  mkdir -p $data
  print -r -- "$1" > $data/ACTIVE_HOST
  git -C $PROFILE_DIR add telegram/ACTIVE_HOST
  git -C $PROFILE_DIR commit -q -m "Telegram bot owner: ${1:-none}" -- telegram/ACTIVE_HOST || true
  if git -C $PROFILE_DIR rev-parse -q --verify '@{u}' >/dev/null 2>&1; then
    git -C $PROFILE_DIR pull --rebase --autostash -q && git -C $PROFILE_DIR push -q || print "note: could not push the new owner; sync.sh will retry"
  elif git -C $PROFILE_DIR remote get-url origin >/dev/null 2>&1; then
    git -C $PROFILE_DIR push -q -u origin HEAD || print "note: could not push the new owner; sync.sh will retry"
  fi
  return 0
}
# 409 from getUpdates means some other process (another Mac) is polling this bot right now.
# getUpdates without an offset does not mark messages as read.
polled_elsewhere() {
  dry && return 1
  local token=$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' $state/.env | tr -d "\"'")
  curl -s --max-time 15 "https://api.telegram.org/bot$token/getUpdates?timeout=0&limit=1" | grep -q '"error_code":409'
}
bot_running() { pgrep -f 'bun server.ts' >/dev/null }
# Claude Code only delivers inbound messages from plugins on its channels allowlist, which names the
# claude-plugins-official marketplace. The same plugin installed from another marketplace (some
# accounts only have "anthropic-plugin-directory") starts and polls Telegram, but every message is
# dropped. Prints the problem, if any.
plugin_problem() {
  local cache=~/.claude/plugins/cache other
  [[ -d $cache/claude-plugins-official/telegram ]] && return 0
  other=(${cache}/*/telegram(N/:h:t))
  if (( $#other )); then
    # Remove the other copy too: installing it enabled it in settings.json, so every normal session
    # would start a second poller that steals the bot's messages.
    print -r -- "the plugin is installed from '${other[1]}', whose messages Claude drops (not on the channels allowlist). Fix:"
    print -r -- "  claude plugin uninstall telegram@${other[1]}"
    print -r -- "  claude plugin marketplace add anthropics/claude-plugins-official"
    print -r -- "  claude plugin install telegram@claude-plugins-official"
  else
    print -r -- "the plugin: claude plugin install telegram@claude-plugins-official (settings.json keeps it off for normal sessions)"
  fi
}
# Checks the token's shape without printing it. A space or quote around it (easy to leave behind in
# an editor) makes every Telegram call fail.
token_problem() {
  [[ -s $state/.env ]] || { print -r -- "the bot token in $state/.env (TELEGRAM_BOT_TOKEN=..., chmod 600); see modules/telegram/SETUP.md"; return }
  grep -Eq '^TELEGRAM_BOT_TOKEN=[0-9]+:[A-Za-z0-9_-]+$' $state/.env ||
    print -r -- "$state/.env has no clean TELEGRAM_BOT_TOKEN=<digits>:<letters> line (check for spaces, quotes or blank lines around the token)"
}
# Messages Claude dropped, per the plugin's MCP log for the bot's working folder.
dropped_messages() {
  local logs=(~/Library/Caches/claude-cli-nodejs/${TELEGRAM_WORKDIR//[^A-Za-z0-9]/-}/mcp-logs-plugin-telegram-*/*.jsonl(N.om))
  (( $#logs )) && grep -q 'Channel notifications skipped' $logs[1]
}
# need <message>: a prerequisite is missing; stop (a dry run only reports it).
need() { print -r -- "missing: $1"; dry || exit 1 }

case $mode in
--status)
  print "owner: $(owner) (this Mac: $host)"
  for n in $names; do
    printf '%-40s %s\n' $(label $n) "$(launchctl print gui/$uid/$(label $n) 2>/dev/null | sed -n 's/^\tstate = //p' | head -1 || true)"
  done
  bot_running && print "bot process: running" || print "bot process: not running"
  problem=$(plugin_problem; token_problem); [[ -n $problem ]] && print -r -- "problem: $problem"
  dropped_messages && print "problem: the running session drops incoming messages (plugin not on the channels allowlist); fix the plugin, then restart the bot"
  tail -5 $state/logs/watchdog.log 2>/dev/null || true
  # Healthy = this Mac owns the bot and it runs, or another Mac owns it and nothing runs here.
  if [[ $(owner) == $host ]]; then bot_running && [[ -z $problem ]] && ! dropped_messages && exit 0
  elif [[ -n $(owner) ]] && ! launchd_loaded $(label telegram); then exit 0; fi
  exit 1 ;;
--uninstall)
  stop_agents
  for n in $all; do act rm -f $agents_dir/$(label $n).plist; done
  [[ $(owner) == $host ]] && set_owner ""
  print "Telegram bot removed from $host."
  exit 0 ;;
install|--take-over) ;;
*) print "usage: $0 [--take-over|--uninstall|--status]"; exit 1 ;;
esac

[[ -d $PROFILE_DIR/.git ]] && git -C $PROFILE_DIR fetch -q 2>/dev/null || true
current=$(owner)
if [[ -n $current && $current != $host && $mode != --take-over ]]; then
  print "The bot runs on $current, so nothing to do here. To move it to this Mac: $0 --take-over"
  exit 0
fi

# Prerequisites. Secrets and pairing stay on each Mac; nothing secret is in git.
command -v claude >/dev/null || need "Claude Code (see SETUP.md step 1)"
command -v bun >/dev/null || need "Bun: brew install oven-sh/bun/bun"
command -v screen >/dev/null || need "screen (ships with macOS)"
problem=$(plugin_problem); [[ -z $problem ]] || need "$problem"
problem=$(token_problem); [[ -z $problem ]] || need "$problem"

# Render the plists first: if they match what is installed and the bot is healthy, leave it alone
# (install.sh re-runs often, and a restart interrupts the conversation).
ensure_dir $agents_dir
typeset -A rendered
same=1
for n in $names; do
  rendered[$n]="$(render $mod/launchd/$n.plist.tmpl)"
  [[ -f $agents_dir/$(label $n).plist && "$(<$agents_dir/$(label $n).plist)" == "${rendered[$n]}" ]] || same=0
  launchd_loaded $(label $n) || same=0
done
if [[ $mode == install && $current == $host && $same == 1 ]] && bot_running && ! dropped_messages; then
  print "Telegram bot already running on $host; left it alone."
  exit 0
fi

stop_agents
if [[ ! -f $data/morning-brief.md ]]; then   # brief turned off: retire its agent
  [[ -f $agents_dir/$(label morning-brief).plist ]] && act rm -f $agents_dir/$(label morning-brief).plist
fi

if [[ $current != $host ]]; then
  set_owner $host
  print "This Mac now owns the bot. Waiting for ${current:-any other Mac} to stop polling..."
  for i in {1..90}; do polled_elsewhere || break; sleep 10; done
  polled_elsewhere && { print "Something else still polls the bot after 15 min. Check $current, then re-run."; exit 1 }
elif [[ -s $state/.env ]] && polled_elsewhere; then
  print "Another process is polling this bot (a manual session, or another Mac). Stop it and re-run."
  exit 1
fi

act mkdir -p $state/logs $state/watchdog $TELEGRAM_WORKDIR
link $mod/session-settings.json $HOME/.claude/telegram-settings.json
link_memory $TELEGRAM_WORKDIR

# Claude asks to trust a new working folder once; an unattended session would sit on that prompt.
trusted=$(/usr/bin/python3 -c 'import json,os,sys;d=json.load(open(os.path.expanduser("~/.claude.json")));print(d.get("projects",{}).get(sys.argv[1],{}).get("hasTrustDialogAccepted",False))' $TELEGRAM_WORKDIR 2>/dev/null || echo False)
if [[ $trusted != True ]]; then
  print "First start: Claude will ask whether to trust $TELEGRAM_WORKDIR."
  print "Answer it once with: screen -r claude-tg  (choose Yes, then Ctrl-A D to detach)."
fi

for n in $names; do
  write_file $agents_dir/$(label $n).plist "${rendered[$n]}"
  launchd_load $(label $n) $agents_dir/$(label $n).plist
done
if [[ $HARNESS_SKIP_LAUNCHD == 1 ]] || dry; then exit 0; fi

sleep 20
bot_running && print "Telegram bot is running on $host." \
  || print "Session started; the bot connects once any startup prompt is answered (screen -r claude-tg)."
/usr/bin/python3 -c 'import json,sys;sys.exit(bool(json.load(open(sys.argv[1])).get("allowFrom")))' $state/access.json 2>/dev/null && \
  print "Not paired yet: DM the bot, then in screen -r claude-tg run /telegram:access pair <code>."
true
