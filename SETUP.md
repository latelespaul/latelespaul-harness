# SETUP: playbook for the agent

You are an AI agent setting up this harness for the user in front of you. Follow the steps in order. Each step ends with a **Verify** command; run it and only move on when it passes. Keep a list of each step's result for the final table.

## Rules
- **Ask before** installing anything, creating a GitHub repo, pushing, or starting a background service. Say exactly what you will run.
- **Never ask the user to paste a secret into the chat.** When a secret must be stored, give them the exact command to run themselves, in their own terminal (for example `security add-generic-password -a "$USER" -s <name> -w`, which prompts without echoing). In Claude Code they can run a command in this session by typing it with a `! ` prefix; anything that prompts for input is better run in a separate Terminal window.
- **When a step needs the human** (a login, BotFather, pairing, an approval prompt), stop, tell them the exact command or action, and wait for them to say done.
- **Report failures** as they happen, with the error. Don't paper over a failed check.
- **Safe to re-run.** Every step checks what is already there; `install.sh` backs up anything it replaces into `~/.claude/backups/harness-<time>/`.
- Keep messages short. In the commands below, `H` is this repo's folder (where this file is) and `P` is the profile folder.

## 1. Prerequisites
Check what is installed:
```sh
xcode-select -p >/dev/null 2>&1 && echo "xcode-clt ok" || echo "xcode-clt MISSING"
for c in brew git gh claude tmux jq python3 node bun screen; do printf '%-8s %s\n' $c "$(command -v $c || echo MISSING)"; done
test -d "/Applications/Google Chrome.app" && echo "chrome   ok" || echo "chrome   MISSING"
gh auth status 2>&1 | head -3
```
Offer to install everything missing in one go (ask once, list what you will run). Exact commands:

| Missing | Needed for | Install |
|---|---|---|
| Xcode command-line tools (git, python3) | everything | `xcode-select --install` (opens a macOS dialog; the user clicks Install) |
| Homebrew | installing the rest | `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`, then the two `eval` lines it prints (needs the user's password, so they run it: `! <command>`) |
| Claude Code | everything | `curl -fsSL https://claude.ai/install.sh \| bash` |
| gh, jq, tmux, node | core, firstmate, agent tools | `brew install gh jq tmux node` |
| bun, screen | telegram module | `brew install oven-sh/bun/bun screen` |
| Google Chrome | browser module | `brew install --cask google-chrome` |

Only install the module rows for modules the user picks in step 2; it is fine to come back to them after the interview. The firstmate module's installer adds the rest of firstmate's toolchain itself.
`gh` not logged in: ask them to run `! gh auth login` (browser flow; they handle it).

**Verify:** `command -v git jq gh claude python3 && gh auth status`

## 2. Interview
Ask these together in one short message, with the default in brackets, and wait for the answers:
1. What should I call you?
2. How do you like explanations? [the harness explaining standard, `docs/explaining-standard.md`: short answer first, then the whole process]
3. Where do your projects live? [`~/Projects`]
4. GitHub handle? [from `gh api user -q .login`]
5. Anything agents should always know about you or your setup? (machine, accounts, tone)
6. Will you often drive sessions from your phone? If yes, offer the **telegram** module (an always-on Claude session you message through your own Telegram bot).
7. Do you want agents to have their own browser with its own logins? If yes, offer the **browser** module (Claude Chrome). A second browser for another account is possible (BROWSER_EXTRA).
8. Do you want a crew of agents that takes coding tasks and hands back PRs? If yes, offer the **firstmate** module.
9. Will agents need to read the screen or drive the mouse and keyboard? If yes, offer the **hammerspoon** module (one signed app that holds Accessibility and Screen Recording, granted once; needs `brew install --cask hammerspoon`).
10. Do you want scheduled jobs on this Mac? If yes, offer the **cron** module (`hcron`, one scheduler for every job). Failure alerts on Telegram need the telegram module.

Derive: `GH_USER`, `PROJECTS_DIR`, `PROFILE_DIR` [`$PROJECTS_DIR/agent-profile`], `LABEL_PREFIX` [the handle, lowercased], `MODULES` (space separated). Read them back and get a yes.

**Verify:** the user confirmed the values.

## 3. Private profile repo
The profile holds their memory and personal data, so it must be private. Check whether it exists first (a second Mac reuses it):
```sh
gh repo view <GH_USER>/agent-profile --json visibility -q .visibility 2>/dev/null || echo none
```
- `none`: ask, then create it empty: `gh repo create <GH_USER>/agent-profile --private --description "Private profile for my agent harness"`.
- `PUBLIC`: stop and tell them; it must be private (`gh repo edit <GH_USER>/agent-profile --visibility private --accept-visibility-change-consequences`, with their OK).
- They may choose another name; use it everywhere below. If they want no GitHub sync at all, skip this step and leave PROFILE_REMOTE empty (memory then stays on this machine).

**Verify:** `gh repo view <GH_USER>/agent-profile --json visibility -q .visibility` → `PRIVATE`

## 4. Write harness.env
```sh
H/install.sh --env-only --yes GH_USER=<handle> PROJECTS_DIR=<dir> PROFILE_DIR=<dir> \
  PROFILE_REMOTE=https://github.com/<handle>/agent-profile.git LABEL_PREFIX=<prefix> MODULES="<modules>"
```
Paths must be absolute with no spaces. Show them the result.

**Verify:** `grep -E '^(GH_USER|PROFILE_DIR|PROFILE_REMOTE|MODULES|LABEL_PREFIX)=' H/harness.env`

## 5. Install
First show what it will do, summarise it for the user (it writes `~/.claude/CLAUDE.md` and `settings.json`, links skills and memory, adds a LaunchAgent that syncs the profile every 2 h, runs the module installers) and ask:
```sh
H/install.sh --dry-run --yes
```
Then run it: `H/install.sh --yes`. Exit 0 = done; exit 2 = core installed but a module needs its SETUP steps (expected at this point when modules are on); exit 1 = failure, report it.

It clones the profile repo into `P` (or creates `P`), fills an empty profile from `profile.example/`, merges any existing Claude auto-memories into it, and backs up what it replaces.

**Verify:** `H/scripts/check.sh` passes every core line (module lines may fail until step 8).

## 6. Fill in ABOUT.md
Write `P/ABOUT.md` from the interview: name, GitHub, machine, projects folder, how they drive sessions (phone → "keep replies short and readable on a small screen"), explanation preferences (only if they differ from AGENTS.md), and anything from question 5. Keep it short and plain, in their voice ("I ..."). Replace every `<...>`. Emails and account names are fine here: the profile is private. Never put them in the framework.

**Verify:** `grep -n "<[a-z][^>]*>" P/ABOUT.md || echo "no placeholders left"`

## 7. Agent tools (optional)
The framework ships skills for these CLI tools (pinned versions; see each skill's `UPSTREAM.md`):
- `lavish-axi`: plans and reviews as annotatable HTML pages.
- `gnhf`: long unattended coding runs on their own branch.
- `chrome-devtools-axi`: drives the browser module's Claude Chrome (needed when `browser` is on).
- `gh-axi`: an agent-friendly wrapper around the GitHub CLI.
- `no-mistakes`: a gate that reviews, tests and opens the PR before code is pushed.

Recommend all of them; ask once, then install the chosen ones:
```sh
npm i -g lavish-axi@0.1.92 gnhf@0.1.51 chrome-devtools-axi@0.1.44 gh-axi@0.1.46
```
`no-mistakes` installs with its own script, which downloads and runs code, so the user runs it: `! curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh`. It is turned on per repo with `no-mistakes init` (it pushes and opens PRs there), so only run that in a repo with the user's OK.

**Verify:** `for t in lavish-axi gnhf chrome-devtools-axi gh-axi no-mistakes; do printf '%-20s %s\n' $t "$(command -v $t || echo not installed)"; done`

## 8. Modules
For each module in MODULES, follow `H/modules/<name>/SETUP.md` step by step (they include the steps that need the human). Order: browser, telegram, hammerspoon, cron, firstmate. To add or drop a module later: `H/install.sh MODULES="..."`.

**Verify:** `H/modules/<name>/install.sh --status` exits 0 for each.

## 9. First sync
Ask, then push the profile for the first time: `H/scripts/sync.sh`. From now on the LaunchAgent does this every 2 h and at login, and every Claude session pulls at start.

**Verify:** `git -C P status -sb | head -1` shows no `[ahead N]`, and `git -C P log --oneline -1` shows a commit.

## 10. Verify the whole setup
1. **A fresh session loads the rules.**
   `claude -p "Answer from your instructions only, one line: what is my name, and what comes first when you explain something?"` → their name and "short answer first" (or their own preference).
2. **Memory write and read.** Create `P/memory/setup-test.md`:
   ```markdown
   ---
   name: setup-test
   description: temporary memory written by SETUP.md to test the memory path
   metadata:
     type: reference
   ---

   The setup test word is "lighthouse".
   ```
   add `- [Setup test](setup-test.md) — temporary; the test word` to `P/memory/MEMORY.md`, then:
   `claude -p "What is the setup test word in my memory? One word."` → `lighthouse`.
   Also check the auto-memory link: `ls ~/.claude/projects/*/memory/setup-test.md`. Then delete the file and its index line.
3. **Everything else.** `H/scripts/check.sh` → `All checks passed.`

## 11. Report
Finish with a table, one row per step, and the next things the user must do (logins, pairing), if any:

| Step | Result | Notes |
|---|---|---|
| 1 Prerequisites | PASS / FAIL / SKIPPED | |
| ... | | |

Then tell them, in two or three lines: their rules are in `H/AGENTS.md` (shared) and `P/ABOUT.md` (theirs); memory and knowledge sync to their private repo; `/learn` saves a session's findings on demand; re-run `H/install.sh` after adding a skill.
