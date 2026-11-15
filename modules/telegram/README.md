# Telegram module (always-on Claude session)

Lets you drive Claude Code from your phone. One Mac runs a Claude session with the Telegram plugin, and a watchdog keeps it healthy. Setup steps: [SETUP.md](SETUP.md).

```
 Login
   ├─ com.<prefix>.keep-awake ──────── caffeinate -i: no idle sleep
   ├─ com.<prefix>.telegram ────────── screen "claude-tg" → run.sh → claude --continue --channels telegram
   ├─ com.<prefix>.telegram-watchdog ─ watchdog.py every 60 s (catches up after wake)
   │    checks: owner? bot running? duplicates? messages unread? Claude error? reply stuck?
   │    fixes:  stops stray pollers · restarts the session · messages you on Telegram
   └─ com.<prefix>.morning-brief ───── optional daily brief (only if the profile has telegram/morning-brief.md)
```

## One Mac at a time
Telegram gives each bot token to one poller. Two Macs polling the same bot split the messages, so `$PROFILE_DIR/telegram/ACTIVE_HOST` names the Mac that runs it. A Mac's watchdog stops its own bot within about 10 minutes of seeing another Mac named there (it reads the profile's remote, so the profile needs one).

| Command | What it does |
|---|---|
| `install.sh` | Install on this Mac. Refuses if another Mac owns the bot |
| `install.sh --take-over` | Move the bot here; waits until the old Mac stops polling |
| `install.sh --status` | Owner, agent states, recent watchdog actions |
| `install.sh --uninstall` | Remove from this machine (Linux: the crontab watchdog then does nothing until the next install) |

The main `install.sh` runs this module's installer when `telegram` is in MODULES; it leaves a healthy bot alone.

## Linux and polling off
- **Linux** (no launchd): `install.sh` runs the session in a tmux session `claude-tg` (`tmux attach -t claude-tg`, Ctrl-B D detaches). It never edits your crontab: it prints the watchdog line (and the morning-brief line) to add with `crontab -e`, and `--status` repeats it while it is missing. Keep-awake and Claude Chrome checks are macOS-only.
- **Polling off** (`TELEGRAM_POLLING=0` in harness.env): the session runs with the plugin installed but off (`telegram-settings.json`) and without `--channels`, so this machine never polls the bot. It never reads or claims `ACTIVE_HOST`, so it installs next to the machine that runs the bot today; `--take-over` is refused. The watchdog only keeps the session running, makes no Telegram call, and stops any poller that starts under it. Use it to prepare a new host before a planned cutover; set `TELEGRAM_POLLING=1` and run `install.sh --take-over` to move the bot.
- **Brain and hands** (`TELEGRAM_MAC_NODE=1`): CLAUDE.md tells the session that the Mac is reached only through the `mac-node` command, with its action list.

## What the watchdog handles
| Problem | Action |
|---|---|
| Bot process missing for 2 min | Restart |
| Messages unread on Telegram for 3 min | Restart |
| Claude API error (e.g. login expired; these never reach Telegram) | Restart; a second auth error within 1 h → message you to run `/login` |
| Stuck mid-reply for 20 min (60 min if a permission prompt is showing) | Restart; a second hang within 2 h starts a fresh conversation |
| Usage-limit menu on screen (blocks queued messages even after the reset) | Message you once; press Esc every 30 min so it resumes |
| Claude Chrome (browser module) not answering | Restart it and tell you |
| Stray or duplicate poller | Kill it |
| 5 restarts in 30 min | Message you, then retry once per 15 min |

Restarts resume the conversation (`--continue`).

## Morning brief (optional)
If `$PROFILE_DIR/telegram/morning-brief.md` exists, `com.<prefix>.morning-brief` runs `morning-brief.py` at `TELEGRAM_BRIEF_TIME`: headless `claude -p` writes the brief from that prompt and the bot sends it (split under Telegram's 4096-char limit). Names in `watchlist.txt` next to it fill `{{WATCHLIST}}` in the prompt. If it fails twice, it sends a failure message instead. Only the `ACTIVE_HOST` Mac sends. Start from `morning-brief.example.md`. Test now: `morning-brief.py --now`. Log: `~/.claude/channels/telegram/logs/morning-brief.log`; each sent brief is kept as `~/.claude/channels/telegram/morning/<YYYY-MM-DD>.txt` for review.

## Files
- Here (framework): `run.sh` (restart loop), `watchdog.py`, `morning-brief.py`, `session-settings.json.tmpl` (rendered to `~/.claude/telegram-settings.json`: enables the plugin for this session only and pre-allows `scripts/pr-merge.sh`), `launchd/*.plist.tmpl`.
- In the profile (synced): `telegram/ACTIVE_HOST`, `telegram/morning-brief.md`, `telegram/watchlist.txt`.
- Per Mac, never in git: `~/.claude/channels/telegram/` holds `.env` (token), `access.json` (pairing), `logs/` and `watchdog/state.json`.

## Limits
- With the lid closed the Mac sleeps, and after a reboot nothing starts until you log in. The `always-on` skill checks and fixes both (`skills/always-on/scripts/check.sh`).
- Don't start a Telegram session by hand while this is installed: a second poller steals messages. Attach to the running one with `screen -r claude-tg` (Ctrl-A D detaches).
- Restart by hand: `launchctl kickstart -k gui/$(id -u)/com.<prefix>.telegram`.
