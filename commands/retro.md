---
description: Review what the profile captured since the last retro and turn it into harness PRs and profile cleanups
---

Run the harness retro: review what my profile captured since the last run, and improve the harness and the profile from it. The whole loop is in the harness's `docs/retro.md`. The profile path is under "Paths" in my global CLAUDE.md, or `PROFILE_DIR` in the harness's `harness.env`.

**Input.** The input file is `$ARGUMENTS`. If that is empty, run the harness's `scripts/retro.sh --collect` and read the path it prints. The file has the new session entries, new learnings, changed memories and the rule lint output.

**Before you sort.** Read the harness's `AGENTS.md`, `CONTRIBUTING.md`, the list of `docs/` and `skills/`, and `scripts/upstream.sh status`. Then you know what the harness already says and which PRs are already open.

**1. Sort each item into one class.**
- **PERSONAL**: about me, my accounts, hosts, projects, people or decisions. It stays in the profile.
- **GENERAL**: a rule, gotcha or procedure that helps anyone who runs this harness. It goes to the harness as a doc, rule or skill change.
- **STALE**: a duplicate, a fact that a later item replaced, finished one-off status, or a lint finding that is a real duplicate.

Many memories are both: a general rule plus my decision to use it. Move the rule to the harness. Keep the decision (who said it, the date, the quote) in the memory.

**2. GENERAL items: harness PRs.**
- Group the items into changes. One change per PR. Open at most 3 PRs in one run; list the rest in the report.
- Skip a change when an open PR already covers it.
- Write it for any user: no names, emails, hostnames, home paths, account or project names. Say "the user" and `<profile>`.
- Follow `CONTRIBUTING.md`: `scripts/upstream.sh new <name>`, edit in that worktree, commit (short imperative subject, a body that says why), write the PR body from `.github/pull_request_template.md`, then `scripts/upstream.sh pr --body-file <file>`.
- Run the branch through no-mistakes (`no-mistakes axi run --intent "..."`, the `no-mistakes` skill) when the repo uses it. Approve or fix findings yourself. A finding that needs my product decision goes in the report.
- Merge only when this run allows it and the gate passed on the PR's head: `scripts/pr-merge.sh <repo> <n>`, then the harness's `install.sh`.
- Match the style of the file you change: STE-style, short sentences, same wording and comment density.

**3. Profile edits: make them directly** (the profile syncs itself).
- **Memories.** Merge duplicates. Delete stale ones. When a memory's rule moved to the harness, cut it to the personal part and link the harness file. Never delete a memory that records a decision of mine; mark a doubtful one in the report instead. Keep `memory/MEMORY.md` in step: one line per memory file, no line without a file.
- **Learnings.** In `knowledge/learnings.md`, file the new bullets at the bottom under the right `## Topic` heading. Merge duplicates and keep the newest date. Drop a bullet that a later one replaced. Keep commands, paths and error strings exact. Other sessions append to this file while you work: read it again just before you write it.
- **Lint.** For each real duplicate or conflict, fix it where it lives (harness: in a PR; profile: directly). Ignore false positives.

**4. Report.** Write `knowledge/retro/<YYYY-MM-DD>.md` in the profile:
- counts per class;
- the PRs (number, title, merged or open);
- what moved from the profile to the harness;
- what was pruned or merged;
- doubtful items and questions for me.

Then write a summary of at most 3 short lines, headline first. Never write secret values anywhere.
