---
name: always-on
description: Keep this Mac running 24/7 for the harness's always-on agents (Telegram Claude session, watchdog, keep-awake, Claude Chrome), even with the lid closed, and recover them after a crash, sleep, freeze or reboot. Use whenever the user wants the bot or Claude to "never stop", run overnight or while away, keep working with the lid shut, survive restarts or power cuts, or asks why the Telegram bot went silent after the Mac slept or rebooted, even if they don't say "always-on".
---

# Always-on Mac

The harness's launchd agents already self-heal *while the user is logged in and the Mac is awake*:
KeepAlive restarts the Telegram screen session, `run.sh` restarts Claude when it exits, and the
watchdog (every 60 s) fixes hangs, stray pollers and Claude Chrome. This skill covers the layer
underneath, which only the user can change with sudo:

```
power on ─► auto-login ─► launchd RunAtLoad agents ─► bot + watchdog + Chrome
lid closed / idle ─► pmset disablesleep, sleep 0 ─► stays awake
system freeze ─► restartfreeze ─► reboot ─► (back to power on)
bot crash / hang ─► KeepAlive + watchdog (already handled by the telegram module)
```

## Workflow

1. **Check.** Run `scripts/check.sh` (read-only, no sudo). Each line is `ok` or `FIX` with the
   exact command. Show the user only the FIX lines.
2. **Hand over the sudo commands in one batch.** The agent can't type the user's password, so collect
   every FIX command into one block the user can paste, each line prefixed with `! ` so it runs in
   this session. Say in one line what each does. Don't run sudo yourself. Send auto-login through
   System Settings, not `sysadminctl -password`: on the command line the password ends up in shell
   history, and a mistyped one fails without any error.
3. **Recover agents.** If any agent is unloaded or down, run `scripts/recover.sh` yourself (no sudo).
   It leaves healthy agents alone: restarting the Telegram session interrupts its conversation.
4. **Verify.** Re-run `check.sh` and report the result plainly. For the bot itself also run
   `$HARNESS_DIR/modules/telegram/install.sh --status`.

## Things to tell the user (once, briefly)

- **Lid closed needs `disablesleep 1`**, which also applies on battery. A closed, awake MacBook in a
  bag gets hot and drains to shutdown, so keep it on the charger. `check.sh` flags battery power.
  To undo: `sudo pmset -a disablesleep 0`.
- **Auto-login** means anyone with the Mac in hand is logged in. It's impossible while FileVault is on.
  In that case the agents only start after the user logs in once following a reboot. Let the user
  choose; don't push them to turn FileVault off.
- **Laptops usually can't power themselves back on after a power cut** (`autorestart` is often
  unsupported). A battery covers short cuts. After a full shutdown someone has to press power.
- macOS updates can reboot the Mac overnight. Auto-login is what brings everything back afterwards.

## Don'ts

- Don't start a second Telegram session or run `claude mcp list` inside it: a second poller steals
  messages. Attach with `screen -r claude-tg` if you need to look.
- Don't edit the launchd plists by hand. They are rendered by the module `install.sh` scripts, so
  re-run those instead.
