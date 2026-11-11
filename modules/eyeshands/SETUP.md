# Eyes & Hands module

Eyes & Hands lets an agent read an app's screen ("eyes") and drive its mouse and keyboard ("hands") on this Mac. The person always wins: hands start only after a 20 s idle buffer, and any human input stops them. The engine is a Hammerspoon Spoon, `EyesHands.spoon`. The `eyeshands` command-line tool (CLI) and its Model Context Protocol (MCP) server talk to it through its own authenticated port, `eyeshands`. The design is `docs/eyes-hands-design.md`.

This module runs Eyes & Hands inside the harness Hammerspoon. It needs the hammerspoon module, because Hammerspoon holds the Accessibility and Screen Recording grants.

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
- Before that, this install also defers while an Eyes & Hands owner has an arm, a hands job runs, or an owner holds the hands lease.
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

**Tests.** `node --test modules/eyeshands/install.test.mjs` runs the install against a throwaway home folder (`HOME`) and profile, with stub `pgrep`, `hs`, `osascript`, `open` and `claude`, and a fake `eyeshands` port. It never touches the real Hammerspoon. The loader test needs Lua 5.4 (`brew install lua@5.4`).
