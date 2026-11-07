# Firstmate module: setup steps for the agent

[Firstmate](https://github.com/kunchenguid/firstmate) is an agent distro: you talk to one agent (the first mate) and it runs a crew of agents, each in its own git worktree, and hands back PRs or reports. With this module on, everyday sessions delegate code work to it through its inbox (`bin/fm-inbox.sh note`) instead of doing it themselves.

```
 this session --fm-inbox note--> firstmate (tmux "firstmate") --spawns--> crewmates (worktrees) --> PRs / reports
      ^                                   |
      +---------- fm-inbox status --------+          approvals: the user, in firstmate's own session
```

`H` = HARNESS_DIR. Ask before cloning, installing or starting anything.

1. **Toolchain.** Firstmate and its crew call these CLIs (the same list its own bootstrap checks, tmux backend). `H/modules/firstmate/tools.sh` installs whatever is missing or older than the pin, without sudo; the module installer in step 4 runs it too. Show the user `tools.sh --dry-run` first and ask before running it.

   | Tool | Installed with | Pin |
   |---|---|---|
   | git, tmux, gh, node, jq | Homebrew (`brew install <name>`) | Homebrew's current |
   | curl | ships with macOS | - |
   | gh-axi, chrome-devtools-axi, tasks-axi, quota-axi | `npm i -g <name>@<pin>`; a first install also runs `<name> setup hooks` (not tasks-axi, quota-axi) | 0.1.46, 0.1.44, 0.2.6, 0.1.69 |
   | lavish-axi (optional: visual plans and reports) | `npm i -g lavish-axi@0.1.92`; a first install also runs `lavish-axi setup hooks` | 0.1.92 |
   | treehouse | GitHub release archive, SHA-256 checked, into `~/.local/bin` | 3.1.8 |
   | no-mistakes | GitHub release archive, SHA-256 checked, into `~/.no-mistakes/bin` (linked from `~/.local/bin`) | 1.84.0 |
   | claude | not installed by the script (its installer is an unpinned `curl \| bash`); it prints the command | - |

   No Homebrew: point them to https://brew.sh (it asks for their password) and re-run. Tools newer than the pin are left alone; firstmate's bootstrap reports if its own floors move past them.
   Needs the user, the script only prints these: `gh auth login`, the Claude Code login (`claude`, then `/login`), and `no-mistakes init` once inside each repo whose work should go through the gate. `~/.local/bin` must be on PATH.
   Verify: `H/modules/firstmate/tools.sh --status` exits 0 (one line per tool: ok, old or MISSING, with its version).
2. **Upstream or fork.** Ask whether they want upstream (default) or their own fork. For a fork: `gh repo fork kunchenguid/firstmate --clone=false` (ask first: it creates a repo), then `H/install.sh --env-only FIRSTMATE_REPO=https://github.com/<user>/firstmate.git FIRSTMATE_UPSTREAM=https://github.com/kunchenguid/firstmate.git`.
   Verify: `grep FIRSTMATE_ H/harness.env`
3. **Own Telegram bot (optional).** If the telegram module is on and they want to approve firstmate from the phone, firstmate can have a second bot: do the telegram SETUP steps 3-4 for it with the state folder `~/.claude/channels/telegram-firstmate` instead, and set `FIRSTMATE_TELEGRAM=1`. Otherwise approvals go through Claude Remote Control (`/remote-control` in the session, then the Claude app).
4. **Install.** `H/modules/firstmate/install.sh` (the main `install.sh` runs it when `firstmate` is in MODULES). It runs `tools.sh`, clones into `FIRSTMATE_DIR` if missing and writes the `firstmate` skill into `~/.claude/skills/firstmate/`.
   Verify: `test -x $FIRSTMATE_DIR/bin/fm-inbox.sh && test -f ~/.claude/skills/firstmate/SKILL.md && echo ok`
5. **Start it.** `H/modules/firstmate/install.sh --start` starts the tmux session. The install also adds a LaunchAgent (`com.<prefix>.firstmate`) that starts it again at every login, so a reboot doesn't leave it down; `FIRSTMATE_AUTOSTART=0` in harness.env turns that off.
   Verify: `H/modules/firstmate/install.sh --status`
6. **First run (needs the user).** Firstmate checks its own toolchain on the first start (with step 1 done it should find nothing missing) and asks the user before installing anything, plus Claude's one-time "trust this folder" prompt. Tell them: run `! tmux attach -t firstmate`, answer the prompts there, then detach with Ctrl-B then D. Never answer firstmate's prompts for them.
7. **Test a delegation.** With the user's OK, send a harmless note: `$FIRSTMATE_DIR/bin/fm-inbox.sh note --request-id setup-test - <<<"Setup test from the harness: reply that you received this; no work needed."`
   Verify: exit code 0, then `$FIRSTMATE_DIR/bin/fm-inbox.sh receipts` shows it picked up.
