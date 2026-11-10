#!/bin/zsh
# Bring every harness launchd agent back: load any that are unloaded and restart any KeepAlive
# agent that is not running. Leaves healthy agents alone (restarting the Telegram session would
# interrupt its conversation) and skips the bot on a Mac that does not own it. Needs no sudo.
source ${0:A:h:h:h:h}/lib/env.sh
source ${0:A:h}/common.sh
for p in $HOME/Library/LaunchAgents/com.$LABEL_PREFIX.*.plist(N); do
  l=${p:t:r}
  bot_elsewhere $l && continue
  if ! launchctl print gui/$uid/$l >/dev/null 2>&1; then
    launchctl bootstrap gui/$uid $p && print "loaded $l" || print "could not load $l"
  elif plutil -extract KeepAlive raw $p >/dev/null 2>&1 &&
       [[ $(launchctl print gui/$uid/$l | sed -n 's/^\tstate = //p' | head -1) != running ]]; then
    launchctl kickstart -k gui/$uid/$l && print "restarted $l" || print "could not restart $l"
  fi
done
print "done; run ${0:A:h}/check.sh to confirm"
