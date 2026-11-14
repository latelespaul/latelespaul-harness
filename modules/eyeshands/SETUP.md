# Eyes & Hands module

Eyes & Hands lets an agent read an app's screen ("eyes") and drive its mouse and keyboard ("hands") on this Mac. The person always wins: hands start only after a 20 s idle buffer, and any human input stops them. The engine is a Hammerspoon Spoon, `EyesHands.spoon`. The `eyeshands` command-line tool (CLI) and its Model Context Protocol (MCP) server talk to it through its own authenticated port, `eyeshands`. The design is `docs/eyes-hands-design.md`.

This module runs Eyes & Hands inside the harness Hammerspoon. It needs the hammerspoon module, because Hammerspoon holds the Accessibility and Screen Recording grants.

Without the harness, use `README.md` in this folder instead: `eyeshands install` links the same files and adds a marked block to `~/.hammerspoon/init.lua`. Inside a configured harness, `eyeshands install` refuses and names this module's install.

**What the install changes**
```
~/.hammerspoon/Spoons/EyesHands.spoon -> modules/eyeshands/EyesHands.spoon   the engine
~/.hammerspoon/local/eyeshands.lua    -> modules/eyeshands/loader.lua        starts the Spoon
~/.local/bin/eyeshands                -> modules/eyeshands/bin/eyeshands     CLI + MCP server
```
The harness config (`modules/hammerspoon/init.lua`) loads every file in `~/.hammerspoon/local/` last. So the loader starts the Spoon after the `harness` table exists, and the Spoon registers its event tag with the awake watcher. The install never edits `~/.hammerspoon/init.lua`, the access policy file, the targets file or Claude Code's MCP configuration by itself.

The loader starts the Spoon with three harness values:
- `access_file`: `HS_ACCESS_FILE` from `harness.env`. This is the one access policy file that the harness port reads too, so one list says who may use eyes and hands.
- `targets_file`: `EYESHANDS_TARGETS_FILE` from `harness.env`, default `<PROFILE_DIR>/eyeshands/targets.json`.
- `alert`: security alerts go to Telegram through the cron module's send-only notifier (`modules/cron/tg-notify.py`), and to the Hammerspoon console. Without the notifier, they go to a macOS notification.

**Install**
1. Install the hammerspoon module first, and grant Accessibility (and Screen Recording, for shots) to Hammerspoon. See `modules/hammerspoon/SETUP.md`.
2. Add `eyeshands` to `MODULES` in `harness.env`, after `hammerspoon`.
3. Run `./install.sh` (or `modules/eyeshands/install.sh`). The harness install also appends this module's notes to `~/.claude/CLAUDE.md`.
4. Give the owner `harness-session` its rights, if you want agents in this harness to use them. Access is default deny:
   ```sh
   eyeshands access allow harness-session eyes,shot,hands --apps chrome-agent,com.apple.TextEdit
   ```
   `eyes` reads the accessibility (AX) tree, `shot` reads screen pixels (only together with `eyes`), and `hands` posts input. `apps` lists every target the owner may read or drive. `access.example.json` shows a full file with `harness-session`, a night runner and a disabled owner.
5. Optional: name targets. Copy `targets.example.json` to the targets file and edit it. A target is an app (`bundle`) or one Chromium profile (`bundle` plus `profile`). A bundle id works as a target without an entry.
6. Optional: register the MCP server with Claude Code. The install only prints the line. `install.sh --mcp` runs it:
   ```sh
   claude mcp add --scope user eyeshands -- ~/.local/bin/eyeshands mcp --owner harness-session
   ```
   Give each agent its own owner name, because the first arm wins.
7. Check: `modules/eyeshands/install.sh --status`, then `eyeshands doctor` for the full first-run check.

**The one restart.** A running Hammerspoon loads the loader only when it starts. So the first install restarts Hammerspoon once, through `modules/hammerspoon/install.sh --restart`. That restart has the hammerspoon module's deferral:
- It never restarts while a job holds awake mode or a harness port owner has an arm. It prints `restart deferred: ...` with their names.
- Before that, this install also defers while an Eyes & Hands owner has an arm, a hands job runs, or an owner holds the hands lease. It also defers while the person's stop switch (ctrl+alt+cmd+escape) is on, because a restart clears it.
- When Hammerspoon does not run, nothing restarts. The Spoon starts with Hammerspoon.
- When the Spoon already runs, nothing restarts. After a Spoon update, run `install.sh --restart` to load the new code, with the same deferral.

WARNING: A restart drops every arm on both ports, and the runners arm again. Run the install outside the hours when a graphical (GUI) job, for example job-hunt, runs or may start. The deferral protects a run that holds awake mode or an arm, not a run that is about to start.

When the install defers the restart, run the same command again after the named jobs finish. `install.sh --no-restart` only links; the Spoon then starts at the next Hammerspoon start.

**Status.** `modules/eyeshands/install.sh --status` prints:
- each of the three links (`ok` or `MISSING`), and whether the harness config is installed;
- whether Claude Code has the MCP server;
- whether Hammerspoon runs and the `eyeshands` port answers;
- the grants, the access policy state with its enabled and armed owners, and the targets file state.

It exits 1 when a link is missing, Hammerspoon does not run, the port does not answer, or Accessibility is off.

**Uninstall and rollback**
1. `modules/eyeshands/install.sh --uninstall` removes the three links, but only links into this module. Then it restarts Hammerspoon with the same deferral, so the Spoon stops.
2. It keeps the access policy file and the targets file. Remove the owners you added with `eyeshands access deny <owner>`, or edit the file.
3. It prints the `claude mcp remove --scope user eyeshands` line when Claude Code has the MCP server. `--uninstall --mcp` runs it.
4. Remove `eyeshands` from `MODULES`, then run `./install.sh` again, so `~/.claude/CLAUDE.md` loses this module's notes.

When the install replaced a file or link at one of the three paths, it moved the old one to `~/.claude/backups/harness-<time>/` first. To go back to an older Eyes & Hands, check out that harness version, then run `install.sh --restart`.

Grants stay in System Settings, because other Hammerspoon tools need them.

**Live fixture test (one Mac, never on continuous integration, CI).** `modules/eyeshands/test/live.test.mjs` drives real hands on a throwaway Chrome. It fills a generic fixture form, then checks takeover, the stop command and foreign hands. It runs only with `EYESHANDS_LIVE=1`, and it skips when `CI` is set. A plain `node --test` run skips it before it starts any process. `node --test modules/eyeshands/live-offline.test.mjs` checks its logic with fakes, with no screen.

WARNING: Run it only when no other eyes and hands program runs or can start. Its hands share the one cursor with job-hunt and every other driver.

When to run it:
1. Pick a time outside job-hunt's window (its hcron `--window`) and outside every other `--needs gui` job.
2. Get "desktop free" from the session that owns the desktop. In this harness, that is the Telegram master session.
3. Find the driver lock file that the other drivers share. The test needs it.

How to run it:
```sh
EYESHANDS_LIVE=1 EYESHANDS_HOLD_FILE=<the driver lock file> EYESHANDS_LIVE_REPORT=/tmp/eh-live.json \
  awake run eh-live-test -- node --test modules/eyeshands/test/live.test.mjs
```
- `EYESHANDS_HOLD_FILE` names the driver lock. Without it, the test uses the `hold_file` of the running Spoon. With neither, it skips, because every live run takes the driver lock.
- `awake run` holds awake mode, so the idle lock cannot stop the run.
- `EYESHANDS_LIVE_REPORT` (optional) writes the outcome and the measurements as a JSON (JavaScript Object Notation) file. Keep that file as the record of the run.
- Keep your hands off the mouse and keyboard for about 60 s, then for the run (about 3 minutes).

What it checks first. The test checks each item and skips with the reason. It never forces one, and it reads these states only:
1. `hs -c` answers, and Hammerspoon has Accessibility and Screen Recording.
2. The screen is unlocked and on the console. Awake mode is not away, because one untagged test event would lock the screen.
3. job-hunt does not hold its hands (armed or busy). No owner with `hands` holds an arm on the harness port or on the running Spoon. That Spoon has no lease or job. No `--needs gui` hcron job runs. No `__eyeshands_test` stays from an earlier run.
4. The driver lock is free. The test skips on a manual hold, a live driver's pid, a borrowed hold, or a bad lock file.
5. Nobody used the Mac for the idle buffer (20 s). It waits up to 90 s, then checks items 1-4 again.

What it does (design part 18, run steps 1-8):
1. It makes a temporary folder with an access file (owner `eh-live-test`, target `chrome-test`), a targets file and a file to upload.
2. It serves the fixture form (`test/fixture/form.html`) on `127.0.0.1` at a random port.
3. It loads the Spoon with `dofile` as `__eyeshands_test`, on the port `eyeshands-test-<random>`. The driver lock is its `hold_file`. It has no hotkey and no menu bar item. The test never calls `hs.loadSpoon` or `hs.reload()`, and never writes in `~/.hammerspoon`.
4. It starts a throwaway Chrome with a temporary profile and no debugging port. It finds that Chrome by its profile path, never by app name.
5. An `eyeshands session` arms `eh-live-test`. Its first hands call takes the hands lease, and the lease takes the driver lock with the session's pid. The test checks the lock file.
6. It fills every field, uploads the file through the native dialog, and compares the eyes (AX) with the page (DOM). The page must see only trusted events, and a mouse move before every click.
7. One untagged 1-point nudge must stop the hands. `hands_resume` must refuse `present` until the idle buffer passes.
8. A fake detector in the test's own namespace must give `foreign_hands`. The stop command must end the job, disarm the owner and remove the driver lock.
9. It measures whether posted events reset `hs.host.idleTime()` (in the report: `measured`).

Outcomes: `pass`; a skip for a precondition; `fail`; or `inconclusive`, a skip with the reason. A run is inconclusive when job-hunt starts, a person takes over, or another driver takes the lock.

Clean-up. A `finally` step runs in every case and touches only what the run made:
- It aborts the job and closes the session, so the owner disarms.
- It unloads `__eyeshands_test` and checks that the global is gone and the port is closed. When the running Spoon had its event tag registered with the harness, the unload registers it again.
- It removes the driver lock only when the file still holds the run's exact entry. It never touches a manual, borrowed or foreign hold.
- It quits the throwaway Chrome by its pid, only while that pid still runs with the run's profile. Then it deletes the temporary folder.
- It compares `jobhunt.info()` from before and after the run, and fails when it changed.

After a crash, the lock names a dead pid, so the next taker treats it as stale. To unload a test Spoon that a crash left, run this:
```sh
hs -c '__eyeshands_test:stop(); __eyeshands_test = nil; if spoon and spoon.EyesHands and harness then harness.addEventTag(spoon.EyesHands.EVENT_TAG) end'
```

**Tests.** `node --test modules/eyeshands/install.test.mjs` runs the install against a throwaway home folder (`HOME`) and profile, with stub `pgrep`, `hs`, `osascript`, `open` and `claude`, and a fake `eyeshands` port. It never touches the real Hammerspoon. The loader test needs Lua 5.4 (`brew install lua@5.4`). `node --test modules/eyeshands/standalone.test.mjs` runs the standalone `eyeshands install` and `uninstall` against a throwaway home folder in the same way.
