# Shared by check.sh and recover.sh. The Telegram bot and its keep-awake run only on the Mac named
# in $PROFILE_DIR/telegram/ACTIVE_HOST; the watchdog unloads them on every other Mac on purpose.
uid=$(id -u)
host=$(scutil --get LocalHostName 2>/dev/null || hostname -s)
owner=$(git -C $PROFILE_DIR show '@{u}:telegram/ACTIVE_HOST' 2>/dev/null || cat $PROFILE_DIR/telegram/ACTIVE_HOST 2>/dev/null)
bot_elsewhere() { [[ $owner != $host && $1 == com.$LABEL_PREFIX.(telegram|keep-awake) ]] }
