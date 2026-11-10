#!/bin/zsh
# Browser module: what the LaunchAgent com.<prefix>.chrome-<id> runs (launchd/chrome.plist.tmpl).
# Starts Chrome on ~/.chrome-<id> with its debug port, unless the profile is in desktop mode
# (chrome-mode.sh) or already open in another Chrome. A launch on an open profile is handed to that
# Chrome, which only opens one more empty window, and launchd would repeat it after every exit.
#   chrome-launch.sh <id> <port>
# Exit 0 = Chrome left stopped (the plist's KeepAlive restarts only after a non-zero exit).
# Exit 1 = Chrome quit or crashed; launchd starts it again after ThrottleInterval.
source ${0:A:h}/chrome-mode.sh
id=$1 port=$2
profile=$HOME/.chrome-$id
chrome=${CHROME_BIN:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
note() { print -r -- "$(date '+%Y-%m-%d %H:%M:%S') chrome-launch: $*" }

[[ -n $id && $port == <-> ]] || { note "usage: $0 <id> <port>"; exit 1 }
if [[ $(chrome_mode $id) == desktop ]]; then note "desktop mode: agent left stopped"; exit 0; fi
# Chrome keeps the symlink SingletonLock -> "<host>-<pid>" while it has the profile open.
lock=$(readlink $profile/SingletonLock 2>/dev/null)
pid=${lock##*-}
if [[ $pid == <-> ]] && [[ $(ps -p $pid -o args= 2>/dev/null) == *$profile* ]]; then
  note "profile already open in another Chrome (pid $pid): agent left stopped"
  exit 0
fi

$chrome --user-data-dir=$profile --remote-debugging-port=$port --remote-debugging-address=127.0.0.1 \
  --no-first-run --no-default-browser-check &
pid=$!
# Stopped by launchd (bootout, unload): stop Chrome with it, and stay stopped.
trap 'kill -TERM $pid 2>/dev/null; wait $pid; exit 0' TERM INT HUP
wait $pid
rc=$?
if [[ $(chrome_mode $id) == desktop ]]; then note "Chrome exited ($rc); desktop mode: agent left stopped"; exit 0; fi
note "Chrome exited ($rc)"
exit 1
