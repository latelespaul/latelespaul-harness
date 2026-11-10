# Browser module: Claude Chrome

A separate Google Chrome that only agents use. It has its own profile (`~/.chrome-claude`), so its logins, cookies and tabs persist, and the user's normal Chrome is never touched. Agents drive it with `chrome-devtools-axi`.

```
 Claude Chrome (~/.chrome-claude, 127.0.0.1:BROWSER_PORT, LaunchAgent com.<prefix>.chrome-claude)
      ▲ CDP
 chrome-devtools-axi  ← any agent with a shell (incl. the Telegram bot)
 chrome-<id>          ← same tool, aimed at an extra browser from BROWSER_EXTRA
```

- Restarted automatically if it quits (launchd KeepAlive) or stops answering (Telegram watchdog, if that module is on).
- Google and others block sign-ins from automated browsers, and 2FA needs the user anyway, so the user logs in by hand in that window.
- Keep banking, health and government accounts out of it: any local process can drive the debug port.
- Extra browsers: `BROWSER_EXTRA="personal:9223"` adds `~/.chrome-personal` on port 9223 and a `chrome-personal` command in `~/.local/bin`. Sites listed in `$PROFILE_DIR/browser/personal-sites.txt` are blocked in Claude Chrome by a hook and must go through `chrome-personal`.
- Stop one: `install.sh --id <id> --uninstall` (keeps logins). Reset: also `rm -rf ~/.chrome-<id>`.
- The LaunchAgent runs `chrome-launch.sh <id> <port>`, not Chrome directly. It starts Chrome only when the profile is in agent mode and no other Chrome has it open; otherwise it exits 0 and launchd leaves it stopped. `KeepAlive` restarts it only after a non-zero exit, so after a quit or crash launchd still restarts Chrome in 30 s.

**Desktop mode.** A tool may run a profile as a normal Chrome, without the debug port (for example to let a person use it, or to get past a site that blocks automated browsers). Chrome hands every agent launch on that open profile to the running Chrome, which only opens one more empty window, and launchd repeats it. So the tool records the mode, and `install.sh` and the launcher leave that profile's agent stopped (`install.sh` prints `desktop mode: agent left stopped`, and boots out an agent from an older plist that is still relaunching). Tests: `node --test modules/browser/chrome-mode.test.mjs`.

```
 chrome-mode.sh <id> desktop --writer <tool>   before the tool quits the agent's Chrome and opens the profile as a normal Chrome
 chrome-mode.sh <id> agent --writer <tool>     after it quits that Chrome; then run install.sh to start the agent
 chrome-mode.sh <id>                           prints agent or desktop
```

- State file, one per profile: `~/.local/state/harness/chrome-mode/<id>.json` (`CHROME_MODE_DIR` moves the folder), written whole: `{"mode": "desktop", "updated": "2026-01-31T12:00:00Z", "writer": "<tool>"}`. `mode` is `agent` or `desktop`; `updated` is UTC; `writer` names the tool. No file means agent.
- Legacy, until the job-hunt tool writes that file: for the `personal` id only, the installer and launcher read `~/.local/state/job-hunt/chrome-mode.json` when the harness file is missing.
- The Telegram watchdog only watches Claude Chrome. Keep that profile in agent mode: in desktop mode the watchdog restarts its agent every 10 minutes (the launcher exits at once) and sends a message each time.

## Steps for the agent
Paths: `H` = HARNESS_DIR. Ask before installing anything.

1. **Chrome and the controller.** Check: `test -d "/Applications/Google Chrome.app" && command -v chrome-devtools-axi`.
   If missing, offer: `brew install --cask google-chrome` and `npm i -g chrome-devtools-axi@0.1.44` (needs Node: `brew install node`).
   Verify: `chrome-devtools-axi --help >/dev/null && echo ok`
2. **Extra browsers (optional).** Ask whether they want a second browser for another account (for example a personal Google account). If yes, set it with `H/install.sh --env-only BROWSER_EXTRA="personal:9223"` (keep any existing entries), and create `$PROFILE_DIR/browser/personal-sites.txt` with the domains that belong there, one per line.
   Verify: `grep BROWSER_EXTRA H/harness.env`
3. **Install.** `H/modules/browser/install.sh` (the main `install.sh` runs it when `browser` is in MODULES). Re-run `H/install.sh` too if you changed BROWSER_EXTRA, so the settings pick up the new command.
   Verify: `H/modules/browser/install.sh --status` (checks Claude Chrome, every extra browser and the controller; `--id <id> --status` checks one)
4. **Logins (needs the user).** Tell them: "A Chrome window called Claude Chrome is open. Sign in there to the accounts you want agents to use. Keep banking and similar accounts out of it." Wait until they say done.
   Verify: `chrome-devtools-axi open https://myaccount.google.com/ && chrome-devtools-axi snapshot | head -20` shows them signed in (or ask them to confirm).
