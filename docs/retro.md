# The harness retro: improve the harness from how you work

**Short answer.** Once a week, `scripts/retro.sh` reviews what your profile captured since the last
run. A headless Claude session sorts each item into PERSONAL, GENERAL or STALE. GENERAL items become
harness pull requests (PRs). The session prunes STALE items from the profile. You get a summary of at most 3 lines.

**Where it fits.** Sessions write to the profile all the time: `scripts/session-learn.sh` appends to
`knowledge/sessions/` and `knowledge/learnings.md`, and agents add memories. Without a review, that
material only grows, and general rules stay hidden in one user's memory. The retro closes the loop.

**The whole flow**
```
 sessions/  learnings.md  memory/        rule-lint.mjs
      └──────────┬─────────┘                  │
        retro.sh: items since knowledge/retro/last-run ──► logs/retro/<date>-input.md
                         │
        claude -p on commands/retro.md
          ├─ GENERAL ──► upstream.sh new ► commit ► upstream.sh pr ► no-mistakes ► (merge)
          ├─ PERSONAL ─► stays; duplicates merged
          └─ STALE ────► memory pruned, MEMORY.md updated, learnings.md compacted
                         │
        knowledge/retro/<date>.md (report) + 3-line summary ──► tg-notify.py ──► you or the master session
```

**Step by step**
1. hcron starts `scripts/retro.sh` once a week.
2. The script reads the marker `<profile>/knowledge/retro/last-run`. On the first run there is no
   marker, so it takes everything.
3. It collects the session entries, learnings and changed memories from that time, and the output of
   `scripts/rule-lint.mjs --profile`. It writes them to `logs/retro/<date>-input.md`.
4. It runs `claude -p` with the steps in `commands/retro.md`. The session gets only these tools:
   file tools, simple shell commands (`ls`, `cat`, `grep`, `mkdir` and a few more), and local git
   commands (no push). It also gets `gh pr list`/`gh pr view`, the rule lint, `upstream.sh` and
   `no-mistakes`. It gets `pr-merge.sh` and `install.sh` only with `RETRO_MERGE=1`. Claude refuses
   any other tool call.
5. The session opens at most 3 PRs, edits the profile, and writes the report and the summary.
6. The script copies the summary to `<profile>/logs/retro-summary.txt` and sends it through
   `modules/cron/tg-notify.py`. With `ALERTS_TO_MASTER` on, it goes to the master session's alert log
   (see [master-session.md](master-session.md)).
7. The script writes the new marker only when the run succeeded.

**Terms**
- **PERSONAL**: about the user, their accounts, hosts, projects or decisions. It stays in the profile.
- **GENERAL**: useful to anyone who runs this harness. It goes to the harness through a PR.
- **STALE**: a duplicate, a fact that a later item replaced, or finished one-off status.
- **Rule lint**: `scripts/rule-lint.mjs`. It finds rules that say the same thing twice (`duplicate`),
  a rule and its negation (`conflict`), and skills with the same name or description. It checks
  `AGENTS.md`, `CONTRIBUTING.md`, `docs/`, `commands/`, the harness's own skills and, with `--profile`,
  the profile's `ABOUT.md`, memories and skills. The lint skips skills copied from elsewhere (with
  `UPSTREAM.md`). It is a hint: the retro session decides which findings are real.

**Set it up.** Add the job from the harness folder, so `$PWD` expands to the full path:
```sh
hcron add harness-retro --cron "0 4 * * 0" --cmd "$PWD/scripts/retro.sh" --timeout 2h --catchup
```
Settings in `harness.env`:
- `RETRO_MODEL` (default `opus`): the model for the review.
- `RETRO_MERGE` (default `0`): `1` lets the run merge its own PRs with `scripts/pr-merge.sh` after the
  no-mistakes gate passes, then run `install.sh`. Leave it `0` to review the PRs yourself.

**By hand.** Type `/retro` in a session. It runs `scripts/retro.sh --collect` and does the same steps
with you watching. `scripts/retro.sh --since 2026-01-01` reviews from a date of your choice.
`node scripts/rule-lint.mjs --profile <profile>` runs the lint alone.

**Example.** A memory says "send long work to a background worker so the session stays free". The
user said it on a given date. The retro adds the rule to `docs/master-session.md` in a PR. The memory
keeps only the date, the quote and a link to that doc.

**Warnings**
- The retro never deletes a memory that records a user decision. It marks doubtful ones in the report.
- Other sessions append to `learnings.md` while the retro runs. The session reads the file again
  just before it writes it.
- A failed run sends one alert and keeps the old marker, so the next run covers the same period.
- `logs/retro/lock` stops a second run while the first one is alive. The next run takes over a lock
  that a dead run left.

**Next.** Read the latest report in `<profile>/knowledge/retro/`. Review the open PRs with
`scripts/upstream.sh status`.
