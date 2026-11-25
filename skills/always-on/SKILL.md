---
name: always-on
description: Keep this Mac running 24/7 for the harness's always-on agents (Telegram Claude session, watchdog, keep-awake, Claude Chrome, hcron, Hammerspoon), even with the lid closed, and recover them after a crash, sleep, freeze or reboot. Use whenever the user wants the bot or Claude to "never stop", run overnight or while away, keep working with the lid shut, survive restarts or power cuts, or asks why the Telegram bot went silent after the Mac slept or rebooted, why the bot or master went down, about a bot crash loop, or why there are too many alerts, even if they don't say "always-on".
---

# Always-on Mac

The harness's launchd agents already self-heal *while the user is logged in and the Mac is awake*:
KeepAlive restarts the Telegram screen session, `run.sh` restarts Claude when it exits, and the
watchdog (every 60 s) fixes hangs, stray pollers and Claude Chrome, the hcron agent runs scheduled
jobs, and Hammerspoon starts itself at login (it holds the GUI permissions). This skill covers the layer
underneath, which only the user can change with sudo:

```
power on ─► auto-login ─► launchd RunAtLoad agents ─► bot + watchdog + Chrome + hcron
                         └─► Hammerspoon (login item)
lid closed / idle ─► pmset disablesleep, sleep 0 ─► stays awake
system freeze ─► restartfreeze ─► reboot ─► (back to power on)
bot crash / hang ─► KeepAlive + watchdog (already handled by the telegram module)
```

## Workflow

1. **Check.** Run `scripts/check.sh` (read-only, no sudo). Each line is `ok` or `FIX` with the
   exact command. Show the user only the FIX lines.
2. **Hand over the sudo commands in one batch.** The agent can't type the user's password, so collect
   only the `sudo pmset` FIX commands into one block the user can paste, each line prefixed with `! `
   so it runs in this session. Say in one line what each does. Don't run sudo yourself. List the
   other FIX items separately as plain steps: auto-login goes through System Settings, not
   `sysadminctl -password` (on the command line the password ends up in shell history, and a
   mistyped one fails without any error), and battery means plugging in the charger.
3. **Recover agents.** If any agent is unloaded or down, run `scripts/recover.sh` yourself (no sudo),
   and `open -a Hammerspoon` if that line is a FIX. It leaves healthy agents alone (restarting the
   Telegram session interrupts its conversation) and skips the bot and keep-awake on a Mac that is
   not the bot's owner (`telegram/ACTIVE_HOST`), since the watchdog stops them there on purpose.
4. **Verify.** Re-run `check.sh` and report the result plainly. For the bot itself also run
   `$HARNESS_DIR/modules/telegram/install.sh --status`.

## Diagnose

Use this when the user asks why the bot or master went down, why the bot went silent, or why
there are too many alerts. First run `TG=~/.claude/channels/telegram`.

1. **Crash loop.** Count fast exits per hour in the log that `run.sh` writes:
   `grep -E 'exited code=.* after [0-2]s' $TG/logs/launchd.log | cut -c1-13 | uniq -c | tail`.
   Then make sure that launchd has the agents:
   `launchctl print gui/$UID/com.$LABEL_PREFIX.<label>` for `telegram`, `telegram-watchdog` and `keep-awake`.
   A known cause: `install.sh` ran inside the Telegram session and unloaded the agents (fixed in
   #95 and #96). The watchdog now stops fast-exit loops itself (#94).
2. **Strays.** Find the kills: `grep 'killed stray' $TG/logs/watchdog.log | tail`. Then list
   the Telegram processes: `pgrep -fl 'telegram-settings.json|plugins/.*/telegram|telegram/run.sh'`.
   Only `run.sh` and `claude`, `node` or `bun` programs count; ignore shells and editors that only
   name the paths. Such a process outside the agent's tree is a stray. Do not stop firstmate's own
   bot (under `run-firstmate.sh`).
3. **Alert flood.** Group today's alerts by type:
   `grep "^$(date -u +%F)" $PROFILE_DIR/logs/master-alerts.log | sed -E 's/^[^ ]+ //; s/[0-9]+/N/g' | cut -c1-60 | sort | uniq -c | sort -rn`.
   Match each group to its cause:

   | Group | Cause | Fix |
   |---|---|---|
   | Many failures at the same minute | network or name lookup (DNS) drop | none; tell the user once |
   | hcron "has not run for N min" | the Mac slept | none; one overdue summary is normal |
   | Sweep line for the same pull request (PR) | a parked PR | add it to `ignore` in `$PROFILE_DIR/orchestrator/sweep.json` |
   | "idle N min" for a crew | an idle crew | none; information only |
   | `Sync:` lines (pull error, stuck mid-rebase) | two syncs at the same time (a race) | re-run `$HARNESS_DIR/scripts/sync.sh` once; for a conflict or a stuck rebase, run `git status` in that repo, fix by hand, report it |
   | "master session down" | the master session stopped | step 1; `tg-notify.py` sends one note per outage |

4. **Fix and report.** Do only the safe fixes. Reload agents with `scripts/recover.sh` from a
   normal shell, never from the Telegram session. Stop strays with `kill <pid>`. Report in 3 lines:
   the cause, what you fixed, what is still open.

## Things to tell the user (once, briefly)

- **Lid closed needs `disablesleep 1`**, which also applies on battery. A closed, awake MacBook in a
  bag gets hot and drains to shutdown, so keep it on the charger. `check.sh` flags battery power.
  To undo: `sudo pmset -a disablesleep 0`.
- **Auto-login** means anyone with the Mac in hand is logged in. It's impossible while FileVault is on.
  In that case the agents only start after the user logs in once following a reboot, and `check.sh`
  shows it as a note, not a FIX. Let the user choose; don't push them to turn FileVault off.
- **Laptops usually can't power themselves back on after a power cut** (`autorestart` is often
  unsupported). A battery covers short cuts. After a full shutdown someone has to press power.
- macOS updates can reboot the Mac overnight. Auto-login is what brings everything back afterwards.

## Don'ts

- Don't start a second Telegram session or run `claude mcp list` inside it: a second poller steals
  messages. Attach with `screen -r claude-tg` if you need to look.
- Don't edit the launchd plists by hand. They are rendered by the module `install.sh` scripts, so
  re-run those instead.
