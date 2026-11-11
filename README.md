# agent-harness

A shareable setup for working with AI coding agents (Claude Code first, written so any model can follow it): standing rules for how agents work with you, file-based memory and knowledge that sync to your own private GitHub repo, reusable skills and slash commands, and optional modules (Telegram, an agent browser, a crew of coding agents).

It comes in two parts:
- **Framework** (this repo): rules, scripts, templates, skills, modules. No personal data. Share it, fork it, pull updates.
- **Profile** (your private repo): who you are (`ABOUT.md`), your memory, knowledge, secret locations, your own skills, module data.

> **Start here.** Open Claude Code and say:
>
> `Clone https://github.com/<owner>/agent-harness into ~/Projects/agent-harness and follow SETUP.md`
>
> On a fresh Mac, install Claude Code first: `curl -fsSL https://claude.ai/install.sh | bash`, then run `claude`.
>
> The agent checks prerequisites (and installs what is missing, after asking), interviews you, creates your private profile repo (after asking), installs, walks you through the modules you chose, and ends with a pass/fail table. It never asks you to paste a secret into the chat.

## Manual path
```sh
git clone https://github.com/<owner>/agent-harness ~/Projects/agent-harness   # or your fork
cd ~/Projects/agent-harness
gh repo create <you>/agent-profile --private        # optional: sync memory across machines
./install.sh --dry-run                              # asks for your values, shows what it would do
./install.sh                                        # does it; re-run any time
scripts/check.sh                                    # PASS/FAIL per item
```
Then fill in `ABOUT.md` in your profile, and follow `modules/<name>/SETUP.md` for each module you enabled. Non-interactive: `./install.sh --yes GH_USER=you MODULES="browser"`.

## Layout
```
 agent-harness/  (framework, shareable)            agent-profile/  (yours, private)
 ├─ AGENTS.md        rules for any agent            ├─ ABOUT.md       who you are; overrides AGENTS.md
 ├─ SETUP.md         playbook for the setup agent   ├─ memory/        MEMORY.md index + one fact per file
 ├─ install.sh       idempotent installer           ├─ knowledge/     sessions/<YYYY-MM>.md, learnings.md
 ├─ harness.env      your values (gitignored)       ├─ secrets.md     where secrets live, never values
 ├─ lib/             env loading, helpers           ├─ skills/ commands/ agents/   your own
 ├─ templates/       CLAUDE.md, settings, plist     ├─ settings.json  optional settings overlay
 ├─ scripts/         sync, learn, check, pr-merge,  └─ telegram/ browser/   module data
 │                   ste-check
 ├─ docs/            explaining-standard.md, eyes-hands-design.md, master-session.md, prompts/ (build prompts)
 ├─ skills/ commands/ agents/
 ├─ modules/         telegram, browser, firstmate, hammerspoon, cron
 └─ profile.example/ starting point for a profile

 install.sh renders and links into:
 ~/.claude/CLAUDE.md ──@imports──> AGENTS.md + ABOUT.md + memory/MEMORY.md
 ~/.claude/settings.json           hooks: pull at start, learn at end (+ module fragments + your overlay)
 ~/.claude/skills|commands/*  ───> framework and profile files (profile wins on a name clash)
 ~/.claude/projects/*/memory  ───> profile memory/
 ~/Library/LaunchAgents/com.<prefix>.harness-sync.plist   sync every 2 h and at login
```

## How it runs day to day
- Every Claude session pulls the profile and the framework when it starts (SessionStart hook).
- When a session ends, `scripts/session-learn.sh` has a small model write a short entry into `knowledge/sessions/` and any reusable gotchas into `knowledge/learnings.md`. `/learn` does the same on demand.
- `scripts/sync.sh` commits and pushes the profile every 2 hours and at login. Log: `logs/sync.log`. Change the interval with `SYNC_INTERVAL` in `harness.env`, then re-run `install.sh`.
- A pre-commit hook in both repos blocks commits that look like they contain a token or key.

## Customizing
- **About you:** edit `ABOUT.md` in your profile. It is loaded into every session and wins over `AGENTS.md`.
- **Rules for everyone:** edit `AGENTS.md` here (and send it upstream if it helps others).
- **How agents explain things:** `docs/explaining-standard.md` (whole process, STE-style writing), applied by the `explain` skill; `node scripts/ste-check.mjs <file|->` checks a draft (tests: `node --test scripts/ste-check.test.mjs`).
- **A skill, command or subagent:** add `skills/<name>/SKILL.md`, `commands/<name>.md` or `agents/<name>.md` to your profile (private) or to this repo (shared), then re-run `install.sh` to link it.
- **Claude settings on every machine:** put them in your profile's `settings.json` (for example `model`, `theme`, extra hooks); `install.sh` merges it into `~/.claude/settings.json`. Settings you change locally are kept too.
- **More working folders with shared memory:** add them to `MEMORY_DIRS` in `harness.env`.
- **A module:** `modules/<name>/` with an `install.sh` (supports `--status`, honours `HARNESS_DRY_RUN` and `HARNESS_SKIP_LAUNCHD` via `lib/common.sh`) and a `SETUP.md`; optional `claude-notes.md.tmpl` (appended to CLAUDE.md), `settings.json.tmpl` (merged into settings), `skill/SKILL.md.tmpl` (rendered into `~/.claude/skills/<name>/`). Templates use `__KEY__` placeholders for values from `harness.env`. Enable it with `MODULES` in `harness.env`.

| Module | What it does |
|---|---|
| `telegram` | Always-on Claude session you message from your phone, with a watchdog and an optional morning brief. One Mac at a time |
| `browser` | "Claude Chrome": a separate Chrome with its own logins that agents drive through `chrome-devtools-axi`; optional extra browsers per account |
| `hammerspoon` | Links a Hammerspoon config so screen-reading and mouse/keyboard tools run inside one signed app: permissions are granted once. Eyes and hands go through an authenticated port (`hsx`) with a default-deny access policy file |
| `cron` | `hcron`: one scheduler (a single LaunchAgent) for every job, with windows across midnight, catch-up after sleep, lock-aware GUI jobs and Telegram alerts |
| `firstmate` | Installs the toolchain [firstmate](https://github.com/kunchenguid/firstmate) needs (pinned npm and release tools, Homebrew for the rest), clones it and makes it the default executor for code work, via its inbox. Starts after login or reboot via the hcron job `firstmate-start` (`FIRSTMATE_AUTOSTART`, needs `cron`) |

## Updates
- The framework is pull-only by default: each session start and each sync pulls it (`--ff-only`), and when it changed, `install.sh` re-renders CLAUDE.md, settings and links on its own. Module changes need `install.sh` by hand.
- Changing the framework yourself? Follow [CONTRIBUTING.md](CONTRIBUTING.md): every change goes upstream as a PR from a worktree (`scripts/upstream.sh`), and your Mac runs upstream plus your open PRs. (`FRAMEWORK_PUSH=1` instead makes `sync.sh` commit and push changes to tracked framework files straight to your remote; new files are never committed.)
- Undo an install: everything replaced is in `~/.claude/backups/harness-<time>/`; move it back. Stop syncing: `launchctl bootout gui/$(id -u)/com.<prefix>.harness-sync`.

## Credits
Skills from [kunchenguid](https://github.com/kunchenguid) (chrome-devtools-axi, gnhf, lavish-axi) and [Anthropic](https://github.com/anthropics/skills) (skill-creator, Apache-2.0); see each skill's `UPSTREAM.md`. Firstmate is [kunchenguid/firstmate](https://github.com/kunchenguid/firstmate).
