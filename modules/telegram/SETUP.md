# Telegram module: setup steps for the agent

How it works: [README.md](README.md). `H` = HARNESS_DIR, `P` = PROFILE_DIR. Ask before installing anything. The bot token is a secret: the user puts it on disk themselves; never ask for it in chat and never print it.

1. **Profile remote.** The one-Mac-at-a-time rule reads `telegram/ACTIVE_HOST` from the profile's remote. Check: `git -C P remote get-url origin`. Without a remote the bot still works on one Mac; tell the user.
2. **Bun and the plugin.** Offer: `brew install oven-sh/bun/bun` and `claude plugin install telegram@claude-plugins-official`. The harness settings keep the plugin off for normal sessions; only the bot session turns it on.
   It must come from the `claude-plugins-official` marketplace: Claude only delivers inbound messages from plugins on its channels allowlist. If `claude plugin install` says that marketplace is missing (some accounts only have `anthropic-plugin-directory`), don't install it from the other one; that copy polls Telegram but every message is dropped. Instead: `claude plugin marketplace add anthropics/claude-plugins-official`, then the install above. If it is already installed from elsewhere, first `claude plugin uninstall telegram@<that marketplace>` (installing it enabled it for every session, which would start a second poller). Installing re-enables the plugin in `settings.json`; step 5's `install.sh` turns it off again for normal sessions.
   Verify: `command -v bun && test -d ~/.claude/plugins/cache/claude-plugins-official/telegram && echo ok`
3. **Create the bot (needs the user).** Tell them: "In Telegram, open @BotFather, send /newbot, pick a name and a username ending in `bot`. Keep the token it gives you private; don't paste it here."
4. **Store the token (needs the user).** Tell them to run this in a separate Terminal window (it prompts without echoing; the value never reaches the chat):
   ```
   mkdir -p ~/.claude/channels/telegram && ( umask 077; read -rs "t?Bot token: " && print "TELEGRAM_BOT_TOKEN=$t" > ~/.claude/channels/telegram/.env ); echo
   ```
   Then add a row to `P/secrets.md`: "Telegram bot token | `~/.claude/channels/telegram/.env` (chmod 600) | read by the Telegram plugin; don't open it in chat".
   If they would rather paste it into a file, any editor works, but the line must be exactly `TELEGRAM_BOT_TOKEN=<token>` with no spaces or quotes, and they should close the file afterwards: an editor left open (TextEdit autosaves) can write an old version back over a fix.
   Verify (prints only the mode, not the token): `stat -f %Lp ~/.claude/channels/telegram/.env` → `600`, and `grep -Eq '^TELEGRAM_BOT_TOKEN=[0-9]+:[A-Za-z0-9_-]+$' ~/.claude/channels/telegram/.env && echo clean`
5. **Install.** `H/modules/telegram/install.sh` (or `--take-over` if another Mac had the bot). Add `telegram` to MODULES if it isn't there (`H/install.sh MODULES="... telegram"`), so CLAUDE.md and settings pick it up.
   Verify: `H/modules/telegram/install.sh --status` lists the agents as `running`.
6. **Trust the folder (needs the user, first time only).** If the installer said Claude will ask to trust the working folder, tell them: run `! screen -r claude-tg`, choose Yes, then press Ctrl-A then D to detach. (In Claude Code, the `! ` prefix runs it in this session.)
7. **Pair (needs the user).** Tell them: "Send any message to your bot; it replies with a pairing code." Then in the bot session: `screen -r claude-tg`, run `/telegram:access pair <code>`, then `/telegram:access policy allowlist`, and detach with Ctrl-A D.
   Verify: `python3 -c 'import json,os;print(bool(json.load(open(os.path.expanduser("~/.claude/channels/telegram/access.json"))).get("allowFrom")))'` → `True`
8. **Test.** Ask the user to send the bot "hello" and confirm it answers. No answer: run `--status`; it flags a messy token and a session that drops messages. The plugin's own log is in `~/Library/Caches/claude-cli-nodejs/<workdir with / as ->/mcp-logs-plugin-telegram-telegram/` (look for "Channel notifications skipped").
   Verify: `H/modules/telegram/install.sh --status` exits 0 and shows `bot process: running`.
9. **Morning brief (optional).** Ask if they want a daily brief. If yes: `mkdir -p P/telegram && cp H/modules/telegram/morning-brief.example.md P/telegram/morning-brief.md`, adapt it with them (topics, country, tone), optionally list names to follow in `P/telegram/watchlist.txt` (one per line), set `TELEGRAM_BRIEF_TIME` if not 08:30, then re-run `H/modules/telegram/install.sh`.
   Verify: `H/modules/telegram/morning-brief.py --now` delivers a brief to Telegram.

Moving the bot to another Mac later: on that Mac, do steps 2, 4 and 7 (token and pairing are per Mac), then `install.sh --take-over`.
