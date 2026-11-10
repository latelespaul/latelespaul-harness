# How I work

These are my standing instructions for any AI coding agent (Claude, or whatever model or tool I switch to). They hold in every project unless that project's own instructions say otherwise.

Who I am, my machine and my own preferences are in `ABOUT.md` in my profile. Where ABOUT.md and this file disagree, ABOUT.md wins.

## Where things are
- **Harness**: the folder holding this file. Shared framework: these rules, scripts, skills, modules. Nothing personal goes here.
- **Profile**: my private repo (`PROFILE_DIR` in the harness's `harness.env`): `ABOUT.md`, `memory/`, `knowledge/`, `secrets.md`, my own skills and module data. It syncs to my private GitHub repo.
- In Claude Code the exact paths are under "Paths" in `~/.claude/CLAUDE.md`.

## Working style
- When you have enough information to act, act. Ask only when the decision is genuinely mine.
- Give a recommendation, not a survey of every option.
- Prefer small, reversible steps. Before deleting, overwriting, pushing, or anything outward-facing, confirm with me unless I already said to go ahead.
- Report results honestly: if something failed or was skipped, say so.
- Match the existing code's style, naming and comment density.

## Explaining things
Whenever you explain something technical to me (a concept, how something works, how to do a task, why something broke, which option to pick), follow the explaining standard in this harness: `docs/explaining-standard.md`. The `explain` skill applies it. In short:

- **Show the whole process**, start to end, in order, never only a fragment. Use the eight parts in order: short answer, where it fits, diagram of the whole flow, step-by-step walk-through, terms, worked example with real values, edge cases and warnings, what to do next.
- **Scale it.** A one-line fact gets the short answer and what to do next; "how does X work" gets all eight parts. When unsure, use the larger size.
- **Write STE-style** (ASD-STE100 Simplified Technical English): sentences of 25 words or fewer (instructions 20), active voice, one name for one thing, every term defined at first use, one action per step, warnings before the step they apply to.
- **Keep it phone-readable**: bold labels instead of headings, small ASCII diagrams in code blocks, short paragraphs. The short answer must stand on its own.

`scripts/ste-check.mjs <file|->` checks a draft against the standard.

## Delegating to firstmate
Only when the firstmate module is on (`firstmate` in MODULES in `harness.env`; listed under "Modules" in `~/.claude/CLAUDE.md`). Firstmate runs a crew of agents in their own worktrees and hands back PRs or reports. It is then the default executor for code.

- Send implementation, fixes, refactors, tests, code reviews, investigations and other unattended multi-step work in any project to firstmate instead of doing it in the current session. How: the `firstmate` skill (a self-contained brief via firstmate's `bin/fm-inbox.sh note`).
- Do it directly instead for: questions and explanations, quick lookups, the harness and profile repos, firstmate's own repo, personal tasks (mail, calendar, notes, browser), or when I say "do it here".
- After delegating, tell me what was sent in a line or two, then check with `fm-inbox.sh status` when I ask. Approvals stay with me in firstmate's own session.

## Git
- Commit or push only when I ask. The profile repo syncs itself and is the exception.
- Branch off the default branch before committing feature work.
- Short imperative commit subjects ("Add X", "Fix Y").

## Secrets
- Never ask me to paste a secret into chat, and never write a secret value into a tracked file. When a secret has to be stored, give me the exact command to run myself.
- `secrets.md` in my profile says WHERE each secret lives (Keychain item, file path, env var). Read it to find a secret; load the value at runtime.
- Never print secret values in output or logs.

## Memory
My long-term memory is the `memory/` folder in my profile. It is plain markdown so any model can use it.

- `memory/MEMORY.md` is the index: one line per memory, `- [Title](file.md) — hook`. Read it at the start of a session.
- Each memory is one file holding one fact, with frontmatter:

  ```markdown
  ---
  name: short-kebab-case-slug
  description: one-line summary used to decide relevance
  metadata:
    type: user | feedback | project | reference
  ---

  The fact. For feedback/project add **Why:** and **How to apply:** lines. Link related memories with [[their-name]].
  ```

- Types: `user` = who I am and what I prefer; `feedback` = how I want you to work (corrections and approaches I confirmed); `project` = ongoing work, goals or constraints, with absolute dates; `reference` = pointers to external resources.
- Update an existing memory instead of adding a duplicate; delete memories that turn out to be wrong. Don't store what the code or git history already records.
- Never store secret values in memory; store where they live instead.

## Knowledge
`knowledge/` in my profile collects what sessions produce, separate from memory (memory = about me and how I work; knowledge = facts and findings).

- `knowledge/sessions/<YYYY-MM>.md`: a short entry per session (title + findings). Written automatically when a Claude session ends, or on demand with `/learn`.
- `knowledge/learnings.md`: reusable, non-obvious knowledge (gotchas, commands, how things work). Check it when a task touches something that may have come up before.
- When you discover something worth keeping mid-session, add it to `learnings.md` yourself rather than waiting for the end.

## Changing the harness
- A rule for everyone who uses this framework goes in the harness; anything about me goes in the profile (ABOUT.md, memory, my own skills). Never put personal data, paths, hostnames or account names in the harness.
- After adding a skill, command or subagent, run the harness's `install.sh` so it gets linked.
- The harness is shared and grows from both sides. Every harness change goes upstream as a PR, following `CONTRIBUTING.md` in the harness: `scripts/upstream.sh new <name>` for a worktree, one change per PR, the PR template filled in, and `scripts/upstream.sh pr` to check and send it. Never commit on `main` or the running branch.
- When working in the harness, run `scripts/upstream.sh status` first. If the other side has open PRs, offer to review them. If upstream has commits that aren't running here, run `upstream.sh sync`.
