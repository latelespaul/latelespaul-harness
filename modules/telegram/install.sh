#!/bin/zsh
# Telegram module: an always-on Claude session you drive from your phone, kept healthy by a watchdog.
# Runs on one machine at a time: the one named in $PROFILE_DIR/telegram/ACTIVE_HOST.
# macOS: launchd agents (screen session claude-tg). Linux (no launchd): a tmux session claude-tg,
# and the watchdog runs from a crontab line that the installer prints (never written for you).
# TELEGRAM_POLLING=0 (harness.env): the session runs without the Telegram plugin, so this machine
# never polls the bot and never claims ACTIVE_HOST (prepare a new host while another one runs it).
#   install.sh              install here (refuses if another machine owns the bot)
#   install.sh --take-over  move the bot to this machine; the old one stops within ~10 min
#   install.sh --uninstall  stop and remove it from this machine (Linux: the crontab watchdog then idles)
#   install.sh --status     show who owns the bot and how it is doing (exit 1 if not healthy here)
set -e
# --dry-run anywhere: print actions only (same as HARNESS_DRY_RUN=1).
(( ${argv[(Ie)--dry-run]} )) && { export HARNESS_DRY_RUN=1; argv=(${argv:#--dry-run}) }
source ${0:A:h:h:h}/lib/common.sh
mod=$HARNESS_DIR/modules/telegram
data=$PROFILE_DIR/telegram               # synced: ACTIVE_HOST, morning-brief.md, watchlist.txt
state=$HOME/.claude/channels/telegram    # per machine, never in git: .env (token), access.json (pairing), logs
all=(telegram keep-awake telegram-watchdog morning-brief)
names=(telegram keep-awake telegram-watchdog)
polling=1; [[ $TELEGRAM_POLLING == 0 ]] && polling=0
(( polling )) && [[ -f $data/morning-brief.md ]] && names+=morning-brief
label() { print com.$LABEL_PREFIX.$1 }
host=$(scutil --get LocalHostName 2>/dev/null || hostname -s)
uid=$(id -u)
mode=${1:-install}
BRIEF_HOUR=$((10#${TELEGRAM_BRIEF_TIME%%:*})) BRIEF_MINUTE=$((10#${TELEGRAM_BRIEF_TIME#*:}))
TELEGRAM_PLUGIN_ON=true; (( polling )) || TELEGRAM_PLUGIN_ON=false
render_keys+=(BRIEF_HOUR BRIEF_MINUTE TELEGRAM_PLUGIN_ON)
# No launchd (Linux): tmux runs the session and crontab the watchdog.
linux=0; have_launchd || linux=1
if (( linux )); then attach="tmux attach -t claude-tg" detach="Ctrl-B D"
else attach="screen -r claude-tg" detach="Ctrl-A D"; fi
watchdog_cron="* * * * * /usr/bin/python3 -I $mod/watchdog.py >> $state/logs/watchdog.out 2>&1"
brief_cron="$BRIEF_MINUTE $BRIEF_HOUR * * * /usr/bin/python3 -I $mod/morning-brief.py >> $state/logs/morning-brief.out 2>&1"

owner() { git -C $PROFILE_DIR show '@{u}:telegram/ACTIVE_HOST' 2>/dev/null || cat $data/ACTIVE_HOST 2>/dev/null || true }
tmux_up() { tmux has-session -t '=claude-tg' 2>/dev/null }
session_up() { if (( linux )); then tmux_up; else launchd_loaded $(label telegram); fi }
stop_agents() {
  if (( linux )); then tmux_up && act tmux kill-session -t '=claude-tg'; return 0; fi
  for n in $all; do launchd_unload $(label $n); done
}
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
# 409 from getUpdates means some other process (another machine) is polling this bot right now.
# getUpdates without an offset does not mark messages as read.
polled_elsewhere() {
  dry && return 1
  local token=$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' $state/.env | tr -d "\"'")
  # The URL goes in on stdin, so the token never shows up in the process list.
  print -r -- "url = \"https://api.telegram.org/bot$token/getUpdates?timeout=0&limit=1\"" |
    curl -s --max-time 15 -K - | grep -q '"error_code":409'
}
# The root process of the bot session: launchd's job (macOS) or the tmux pane (Linux).
session_pid() {
  if (( linux )); then tmux list-panes -t '=claude-tg' -F '#{pane_pid}' 2>/dev/null | head -1
  else launchctl print gui/$uid/$(label telegram) 2>/dev/null | sed -n 's/^[[:space:]]*pid = //p' | head -1; fi
}
# The bot's poller (bun server.ts) under this module's session; firstmate's own bot doesn't count.
bot_running() {
  local pid=$(session_pid)
  [[ -n $pid ]] || return 1
  ps -axo pid=,ppid=,command= | awk -v root=$pid '
    { parent[$1] = $2; if ($0 ~ /bun server\.ts/) bots[$1] = 1 }
    END { for (p in bots) for (q = p; q > 1; q = parent[q]) if (q == root) exit 0; exit 1 }'
}
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
  local cache=~/Library/Caches
  (( linux )) && cache=${XDG_CACHE_HOME:-$HOME/.cache}
  local logs=($cache/claude-cli-nodejs/${TELEGRAM_WORKDIR//[^A-Za-z0-9]/-}/mcp-logs-plugin-telegram-*/*.jsonl(N.om))
  (( $#logs )) && grep -q 'Channel notifications skipped' $logs[1]
}
# need <message>: a prerequisite is missing; stop (a dry run only reports it).
need() { print -r -- "missing: $1"; dry || exit 1 }
# The crontab lines this machine needs (Linux only), and whether they are there.
cron_lines() { print -r -- $watchdog_cron; (( polling )) && [[ -f $data/morning-brief.md ]] && print -r -- $brief_cron; true }
cron_hint() {
  local missing=() l
  # A line counts as there when crontab runs its script (word 8: after 5 time fields, python3, -I).
  for l in "${(@f)$(cron_lines)}"; do crontab -l 2>/dev/null | grep -qF -- "${l[(w)8]}" || missing+=$l; done
  (( $#missing )) || return 0
  print "note: no launchd here, so the watchdog runs from crontab. Add (crontab -e):"
  print -r -l -- "  "${^missing}
}

case $mode in
--status)
  print "owner: $(owner) (this machine: $host)"
  (( polling )) || print "polling: off (TELEGRAM_POLLING=0): the session runs without the Telegram plugin; nothing here polls the bot"
  if (( linux )); then
    printf '%-40s %s\n' "tmux session claude-tg" "$(tmux_up && print running || print 'not running')"
    cron_hint
  else
    for n in $names; do
      printf '%-40s %s\n' $(label $n) "$(launchctl print gui/$uid/$(label $n) 2>/dev/null | sed -n 's/^\tstate = //p' | head -1 || true)"
    done
  fi
  bot_running && print "bot process: running" || print "bot process: not running"
  if (( ! polling )); then
    problem=$(plugin_problem); [[ -n $problem ]] && print -r -- "problem: $problem"
    bot_running && print "problem: a Telegram poller runs here although polling is off; stop it: $0 --uninstall"
    tail -5 $state/logs/watchdog.log 2>/dev/null || true
    # Healthy = the session runs, the plugin is installed, and no poller runs here.
    session_up && [[ -z $problem ]] && ! bot_running && exit 0
    exit 1
  fi
  problem=$(plugin_problem; token_problem); [[ -n $problem ]] && print -r -- "problem: $problem"
  dropped_messages && print "problem: the running session drops incoming messages (plugin not on the channels allowlist); fix the plugin, then restart the bot"
  tail -5 $state/logs/watchdog.log 2>/dev/null || true
  # Healthy = this machine owns the bot and it runs, or another machine owns it and nothing runs here.
  if [[ $(owner) == $host ]]; then bot_running && [[ -z $problem ]] && ! dropped_messages && exit 0
  elif [[ -n $(owner) ]] && ! session_up; then exit 0; fi
  exit 1 ;;
--uninstall)
  if (( linux )); then act mkdir -p $state/watchdog; act touch $state/watchdog/uninstalled; fi
  stop_agents
  (( linux )) || for n in $all; do act rm -f $agents_dir/$(label $n).plist; done
  (( linux )) && print "The watchdog now does nothing here; remove its line from crontab (crontab -e) if you added it."
  (( polling )) && [[ $(owner) == $host ]] && set_owner ""
  print "Telegram bot removed from $host."
  exit 0 ;;
install|--take-over) ;;
*) print "usage: $0 [--take-over|--uninstall|--status]"; exit 1 ;;
esac

if (( ! polling )); then
  # Polling off: ACTIVE_HOST is never read or claimed, so this installs next to the running bot.
  if [[ $mode == --take-over ]]; then
    print "Polling is off here (TELEGRAM_POLLING=0), so there is nothing to take over. Set TELEGRAM_POLLING=1 first."
    exit 1
  fi
  current=
else
  [[ -d $PROFILE_DIR/.git ]] && git -C $PROFILE_DIR fetch -q 2>/dev/null || true
  current=$(owner)
  if [[ -n $current && $current != $host && $mode != --take-over ]]; then
    print "The bot runs on $current, so nothing to do here. To move it to this machine: $0 --take-over"
    exit 0
  fi
fi

# Prerequisites. Secrets and pairing stay on each machine; nothing secret is in git.
command -v claude >/dev/null || need "Claude Code (see SETUP.md step 1)"
if (( polling )); then
  command -v bun >/dev/null || need "Bun: brew install oven-sh/bun/bun (Linux: see https://bun.sh)"
elif ! command -v bun >/dev/null; then
  print "note: no Bun yet; polling is off so it is not needed now, but the plugin needs it before this machine polls."
fi
if (( linux )); then command -v tmux >/dev/null || need "tmux (your package manager, e.g. dnf install tmux)"
else command -v screen >/dev/null || need "screen (ships with macOS)"; fi
problem=$(plugin_problem); [[ -z $problem ]] || need "$problem"
if (( polling )); then problem=$(token_problem); [[ -z $problem ]] || need "$problem"; fi

# Render everything first: if it matches what is installed and the bot is healthy, leave it alone
# (install.sh re-runs often, and a restart interrupts the conversation).
settings="$(render $mod/session-settings.json.tmpl)"
same=1
[[ -f $HOME/.claude/telegram-settings.json && "$(<$HOME/.claude/telegram-settings.json)" == "$settings" ]] || same=0
typeset -A rendered
if (( ! linux )); then
  ensure_dir $agents_dir
  for n in $names; do
    rendered[$n]="$(render $mod/launchd/$n.plist.tmpl)"
    [[ -f $agents_dir/$(label $n).plist && "$(<$agents_dir/$(label $n).plist)" == "${rendered[$n]}" ]] || same=0
    launchd_loaded $(label $n) || same=0
  done
else
  tmux_up || same=0
fi
act rm -f $state/watchdog/uninstalled
if [[ $mode == install && $same == 1 ]]; then
  if (( ! polling )) && ! bot_running; then
    print "Telegram session (polling off) already running on $host; left it alone."
    (( linux )) && cron_hint
    exit 0
  elif (( polling )) && [[ $current == $host ]] && bot_running && ! dropped_messages; then
    print "Telegram bot already running on $host; left it alone."
    (( linux )) && cron_hint
    exit 0
  fi
fi

stop_agents
if (( ! linux && ! ${names[(Ie)morning-brief]} )); then   # brief off (or polling off): retire its agent
  [[ -f $agents_dir/$(label morning-brief).plist ]] && act rm -f $agents_dir/$(label morning-brief).plist
fi

if (( ! polling )); then
  :
elif [[ $current != $host ]]; then
  set_owner $host
  print "This machine now owns the bot. Waiting for ${current:-any other machine} to stop polling..."
  for i in {1..90}; do polled_elsewhere || break; sleep 10; done
  polled_elsewhere && { print "Something else still polls the bot after 15 min. Check $current, then re-run."; exit 1 }
elif [[ -s $state/.env ]] && polled_elsewhere; then
  print "Another process is polling this bot (a manual session, or another machine). Stop it and re-run."
  exit 1
fi

act mkdir -p $state/logs $state/watchdog $TELEGRAM_WORKDIR
write_file $HOME/.claude/telegram-settings.json "$settings"
link_memory $TELEGRAM_WORKDIR

# Claude asks to trust a new working folder once; an unattended session would sit on that prompt.
trusted=$(/usr/bin/python3 -c 'import json,os,sys;d=json.load(open(os.path.expanduser("~/.claude.json")));print(d.get("projects",{}).get(sys.argv[1],{}).get("hasTrustDialogAccepted",False))' $TELEGRAM_WORKDIR 2>/dev/null || echo False)
if [[ $trusted != True ]]; then
  print "First start: Claude will ask whether to trust $TELEGRAM_WORKDIR."
  print "Answer it once with: $attach  (choose Yes, then $detach to detach)."
fi

if (( linux )); then
  # tmux keeps the session; run.sh restarts claude inside it, and the watchdog restarts tmux.
  act tmux new -d -s claude-tg $mod/run.sh
  cron_hint
else
  for n in $names; do
    write_file $agents_dir/$(label $n).plist "${rendered[$n]}"
    launchd_load $(label $n) $agents_dir/$(label $n).plist
  done
fi
if dry || { (( ! linux )) && [[ $HARNESS_SKIP_LAUNCHD == 1 ]] }; then exit 0; fi

if (( ! polling )); then
  print "Telegram session started on $host with polling off (no poller; attach: $attach)."
  exit 0
fi
sleep 20
bot_running && print "Telegram bot is running on $host." \
  || print "Session started; the bot connects once any startup prompt is answered ($attach)."
/usr/bin/python3 -c 'import json,sys;sys.exit(bool(json.load(open(sys.argv[1])).get("allowFrom")))' $state/access.json 2>/dev/null && \
  print "Not paired yet: DM the bot, then in $attach run /telegram:access pair <code>."
true
