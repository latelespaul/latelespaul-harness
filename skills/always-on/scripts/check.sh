#!/bin/zsh
# Read-only check: is this Mac set up to keep the harness agents running 24/7, lid closed included?
# Prints one line per item: "ok", or "FIX" followed by the exact command the user runs.
# Exit 0 when everything is ok, 1 otherwise. Never changes anything and never needs sudo.
source ${0:A:h:h:h:h}/lib/env.sh
uid=$(id -u) bad=0
ok()  { printf '  ok   %s\n' "$1" }
fix() { printf '  FIX  %s\n       → %s\n' "$1" "$2"; bad=1 }
pm() { pmset -g custom | awk -v sec="$1" -v k="$2" '$0 ~ sec {f=1; next} /Power:$/ {f=0} f && $1==k {print $2}' }
pmg() { pmset -g | awk -v k="$1" '$1==k {print $2}' }

print "Power (pmset)"
[[ $(pmg SleepDisabled) == 1 ]] && ok "sleep disabled: lid can be closed" \
  || fix "Mac sleeps when the lid closes" "sudo pmset -a disablesleep 1"
[[ $(pm 'AC Power' sleep) == 0 ]] && ok "no idle sleep on charger" \
  || fix "idle sleep on charger is $(pm 'AC Power' sleep) min" "sudo pmset -c sleep 0 disksleep 0"
[[ $(pm 'AC Power' powernap) == 0 ]] && ok "Power Nap off on charger" \
  || fix "Power Nap on (half-wakes instead of staying up)" "sudo pmset -c powernap 0"
[[ $(pm 'AC Power' womp) == 1 ]] && ok "wake on network on" \
  || fix "wake on network off" "sudo pmset -c womp 1"
ar=$(pmg autorestart)
if [[ -z $ar ]]; then ok "auto-restart after power loss: not supported on this Mac (normal for laptops)"
elif [[ $ar == 1 ]]; then ok "auto-restart after power loss"
else fix "no auto-restart after power loss" "sudo pmset -a autorestart 1"; fi

print "Login"
fv=$(fdesetup status 2>/dev/null)
al=$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null)
if [[ $fv == *"is On"* ]]; then
  fix "FileVault is on, so after a reboot the Mac waits for a password (auto-login impossible)" \
      "accept it (agents start once you log in), or turn FileVault off in System Settings > Privacy & Security"
elif [[ $al == $USER ]]; then ok "auto-login as $USER"
else fix "no auto-login: after a reboot nothing starts until someone logs in" \
         "System Settings > Users & Groups > Automatically log in as: $USER (asks for your password)"; fi
# Apple Silicon restarts by itself after a kernel panic; systemsetup needs Full Disk Access to even read it.
print "  note restart-after-freeze is not checked (macOS restarts after a crash by default)"

print "Agents (launchd)"
for p in $HOME/Library/LaunchAgents/com.$LABEL_PREFIX.*.plist(N); do
  l=${p:t:r}
  if ! launchctl print gui/$uid/$l >/dev/null 2>&1; then fix "$l not loaded" "${0:A:h}/recover.sh"; continue; fi
  st=$(launchctl print gui/$uid/$l | sed -n 's/^\tstate = //p' | head -1)
  # Interval jobs (watchdog, sync, brief) are "not running" between runs; that is fine.
  if [[ $st == running ]] || ! plutil -extract KeepAlive raw $p >/dev/null 2>&1; then ok "$l ($st)"
  else fix "$l should stay up but is $st" "${0:A:h}/recover.sh"; fi
done

print "Battery"
b=$(pmset -g batt | head -1)
if [[ $b == *"AC Power"* ]]; then ok "on charger"
else fix "running on battery: with sleep disabled it drains to shutdown" "plug in the charger"; fi

exit $bad
