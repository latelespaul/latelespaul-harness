# Contributing: one harness, grown from both sides

This harness is shared by more than one person. Each of you runs it on your own Macs and finds
different gaps, so fixes should flow both ways: what you fix reaches the others through a PR, and
what they fix reaches you on the next sync. Agents follow this file too (AGENTS.md points here).

```
 upstream (shared repo) ──●──────────●───────────●──►  main
                          │          ▲           │
                    sync pulls    PR merged    sync pulls
                          ▼          │           ▼
 your Mac:  local  =  upstream main + your open PR branches   (what actually runs)
                                     ▲
              worktree on a branch ──┴─ upstream.sh pr (checks, push to your fork, open PR)
```

## Setup (once)
- Remotes: `origin` is the shared repo and `fork` is your fork (`gh repo fork --remote-name fork`).
  If you own the shared repo, there's no fork: PR branches go straight to `origin`.
- Have this checkout run the `local` branch: `scripts/upstream.sh sync`. From then on, `sync.sh`
  (launchd, every `SYNC_INTERVAL`) rebuilds it as upstream's `main` plus your open PRs. You get the
  other side's merged work automatically, and your own changes run before they're merged.
- Names are in `harness.env`: `UPSTREAM_REMOTE`, `FORK_REMOTE`, `LOCAL_BRANCH`.

## Making a change
1. `scripts/upstream.sh new <short-name>` prints a worktree path on a fresh branch off upstream.
   Work there. The live checkout stays on `local` and keeps running undisturbed.
2. Commit with a short imperative subject ("Add X", "Fix Y") and a body that says why.
3. Write the PR description from `.github/pull_request_template.md` into a file.
4. `scripts/upstream.sh pr --body-file <file>` runs the checks, pushes, opens the PR (or updates the
   existing one), then re-syncs `local` (if the live checkout runs it) so the change runs right away.
   If the repo is set up for [no-mistakes](https://github.com/kunchenguid/no-mistakes) (firstmate
   installs it), you can also run the branch through its gate for review, tests and lint; that adds
   to `upstream.sh pr`'s checks, it doesn't replace them.

## What makes a good PR here
- **One change per PR.** A skill and a script refactor are two PRs. Small PRs get merged, and if one
  needs reverting it doesn't take others with it.
- **No personal data.** No names, emails, hostnames, home paths, account names or tokens. Per-user
  values come from `harness.env` (add a default in `lib/env.sh` and a line in `harness.env.example`).
  `upstream.sh pr` refuses a diff containing your own values.
- **Works for someone else.** It should be safe on a Mac that isn't yours: honour `HARNESS_DRY_RUN`
  and `HARNESS_SKIP_LAUNCHD`, keep re-running idempotent, and don't restart a healthy bot.
- **Says what was tested.** "Checks run" lists what you actually ran and what you didn't.
- **Passes CI.** `.github/workflows/test.yml` runs every node test on macOS for each push and PR. `.github/workflows/package.yml` builds the Eyes & Hands disk image.
  Run them yourself first: `node --test $(find modules scripts -name '*.test.mjs')` (the Lua-backed
  ones need `brew install lua@5.4` and skip without it). Tests use fakes and a throwaway HOME, never
  this Mac's Hammerspoon, launchd or profile.
- **Documents itself.** Update the README, SETUP.md or the module's docs in the same PR.
- **Matches the style.** Same zsh idioms, comment density and wording as the code around it.

## Keeping both sides in sync
- `scripts/upstream.sh status` shows upstream commits not running here, your open PRs (and whether
  they conflict), the other side's open PRs, and local branches with no PR.
- **Review the other side's PRs.** That's how their work reaches you, and how you catch what would
  break your setup. Merged PRs arrive on your next sync.
- **A PR that conflicts** after upstream moves on is skipped from `local` (sync says so). Rebase it
  in its worktree (`git rebase origin/main`), fix the conflicts, then run `upstream.sh pr` again.
- **After a merge**, the PR drops out of `local` by itself and its commits arrive through upstream
  instead. Delete the worktree with `git worktree remove <path>` and the branch with `git branch -D`.
- Never commit straight on `main` or `local`. Sync rebuilds `local`, so it refuses to run while
  stray commits are there, and tells you to move them to a branch.
