#!/bin/zsh -il
# Keeps the Telegram Claude session running; restarts it if it exits.
# Resumes the previous conversation unless the watchdog asked for a clean start.
source ${0:A:h:h:h}/lib/env.sh
mkdir -p $TELEGRAM_WORKDIR
cd $TELEGRAM_WORKDIR
WD=~/.claude/channels/telegram/watchdog
mkdir -p $WD
# Orphaned: our parent died, or the screen/tmux session we ran in is gone (run.sh's parent is login,
# which can outlive screen; a loop with no terminal then restarts claude every 11 s, each exiting at once).
orphaned() {
  [ "$(ps -o ppid= -p $$ | tr -d ' ')" = 1 ] && return 0
  [[ -n $STY ]] && ! kill -0 ${STY%%.*} 2>/dev/null && return 0
  [[ -n $TMUX ]] && ! tmux has-session -t '=claude-tg' 2>/dev/null && return 0
  return 1
}
# Polling off (TELEGRAM_POLLING=0): a plain session without the Telegram channel, so nothing here
# polls the bot (telegram-settings.json keeps the plugin off too).
channels=(--channels plugin:telegram@claude-plugins-official)
if [[ $TELEGRAM_POLLING == 0 ]]; then
  channels=()
  # The plugin's server polls whenever it runs, so refuse settings that still turn it on.
  if grep -Eq '"telegram@claude-plugins-official": *true' ~/.claude/telegram-settings.json 2>/dev/null; then
    print -r -- "$(date '+%Y-%m-%d %H:%M:%S') polling is off but telegram-settings.json turns the plugin on; not starting (re-run modules/telegram/install.sh)" | tee -a ~/.claude/channels/telegram/logs/launchd.log
    exit 1
  fi
fi
while true; do
  if [ -e $WD/fresh-next ]; then
    rm -f $WD/fresh-next
    args=()
  else
    args=(--continue)
  fi
  start=$(date +%s)
  claude $args --settings ~/.claude/telegram-settings.json $channels
  code=$? ran=$(( $(date +%s) - start ))
  print -r -- "$(date '+%Y-%m-%d %H:%M:%S') claude ${args:-fresh} exited code=$code after ${ran}s" >> ~/.claude/channels/telegram/logs/launchd.log
  # A resume that dies within 30s (no conversation, broken session) falls back to a fresh start.
  (( ran < 30 )) && touch $WD/fresh-next
  # Stop if our screen or tmux session is gone (orphaned), so restarts never leave a second bot running.
  orphaned && exit
  sleep 10
  orphaned && exit
done
