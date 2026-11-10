# Cron module (hcron)

One scheduler for every job on this Mac instead of one launchd plist per job. A single LaunchAgent runs `hcron tick` every minute; jobs live in `<profile>/cron/jobs.json` and any project registers with `hcron add`.

- **Install:** add `cron` to `MODULES` in `harness.env`, run `./install.sh` (or `modules/cron/install.sh`). It links `~/.local/bin/hcron` and loads `com.<prefix>.hcron`.
- **Add a job:** `hcron add backup --cron "30 2 * * *" --cmd "scripts/backup.sh" --cwd ~/Projects/x --timeout 30m --catchup`
- **Look:** `hcron status` (with lock state), `hcron logs <id>`, `hcron next <id>`, `hcron run <id>` (now).
- **Stop:** `hcron pause <id>` / `hcron pause all` (kill switch); `resume` undoes it.

Behaviour: a job never runs twice at once; it runs under `caffeinate -i`, so the Mac stays awake only while it works; `--window` limits it to a time range (may cross midnight); `--catchup` runs a slot missed while the Mac slept, once, on wake; `--awake` holds Hammerspoon's awake mode while the job runs (automatic for `--needs gui`) (no idle lock; after 5 minutes with no human input the screen dims and locks on the next touch or when the job ends or its process dies, never while a person uses the Mac; see the hammerspoon module); `--needs unlocked|gui` skips while the screen is locked (asking Hammerspoon when the `hammerspoon` module is on, else `ioreg`) and tells you. Failures, timeouts and skips go to Telegram through the `telegram` module's bot (send-only, so it never steals messages); without that module they are only logged in `~/Library/Logs/hcron/`.

Tests: `node --test modules/cron/hcron.test.mjs`.
