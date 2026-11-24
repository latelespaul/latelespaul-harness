# Operating model: who does the work, where it runs, how it ships

**Short answer.** The user talks to one master session. The master session plans, routes and checks.
It does not do long work itself. Workers do the work: firstmate and its crews, background agents,
cloud sessions and hcron jobs. Code reaches the default branch only through a pull request (PR) that
passed the review gate. Everything the user asked for is on one status board.

**Where it fits.** [master-session.md](master-session.md) says how the master session picks its next
step (priorities, swaps, alerts). This file shows the whole system around it: the roles, the places
where work runs, and the path from an ask to a merged change. [retro.md](retro.md) closes the loop.

**The whole flow**
```
 user (phone, Telegram) ──ask──► master session ──► status board (<profile>/tasks/OPEN.md)
                                   │  route by kind of work
        ┌──────────────┬───────────┼───────────────┬──────────────────┐
        ▼              ▼           ▼               ▼                  ▼
   background     firstmate ──► second mate   cloud session      hcron job
   agent          (router)      (one project)  (remote repo)     (schedule)
                     └──► crew worker (own worktree)
        └──────────────┴─────┬─────┴───────────────┘
                     branch + PR ──► review gate (no-mistakes) ──► merge ──► pull + restart
                                                                    │
                     sessions/, learnings, memories ──► weekly retro ──► harness PRs
```

## Roles

| Role | What it does | What it does not do |
|---|---|---|
| User | Gives asks and decisions. Types passwords, 2FA codes and CAPTCHAs. | Babysit workers or answer routine questions. |
| Master session | Answers the user at once. Routes work, watches workers, merges what passed the gate, fixes alerts. | Long foreground work (more than about 20 s). |
| Firstmate | Takes delegated code work, runs crews, routes project work to second mates. | Talk to the user directly, unless set up for it. |
| Second mate | A firstmate-like lead that owns one project: its design, crews, PRs and context. | Work on other projects. |
| Crew worker | Does one task in its own git worktree and opens a PR. | Merge its own PR, unless the project allows it. |
| Background agent | A subagent or tmux session for a one-off multi-step job (research, a batch, a setup). | Outlive its task. |
| Cloud session | A Claude session in the cloud for self-contained repo work. It pushes a branch and opens a PR. | Anything that needs local logins, the screen or local services. |
| hcron job | Runs a command on a schedule (the cron module). | Ask questions. It reports failures to the master session. |

**The chain of command.** The user talks only to the master session. The master session talks to
firstmate. Firstmate talks to the second mates. Each second mate owns its project, so the master
session does not brief crews of a project directly. The master session answers firstmate's approval
prompts itself, when the user has said so. The user then approves only the master session.

## Where work runs

| Place | Use it for | Do not use it for |
|---|---|---|
| The Mac | The master session, the screen (eyes and hands, Hammerspoon), browsers with the user's logins, the Keychain, local OAuth tokens, tests in a real browser. | Heavy parallel code work: a loaded Mac freezes and stops answering. |
| Always-on VM (with the [macnode](../modules/macnode) module) | Firstmate and crews for code work, servers, jobs that must run 24/7. | Anything that needs the Mac's screen or logins. Ask the Mac through mac-node. |
| Cloud session | Self-contained coding in one repo: a feature or a fix with tests. | Hosting, hcron, the screen, browsers, local secrets. |

**How to choose.**
1. Does the work need the screen, a logged-in browser or a local secret? Run it on the Mac.
2. Is it code work in a repo? Send it to firstmate (on the VM when there is one).
3. Is it self-contained, and is the Mac or VM busy? Give it to a cloud session. Track it on the
   status board ("cloud: <task> — PR #n — state"). Do not give the same task to firstmate too.
4. Must it recur? Make it an hcron job. Never add a new launchd plist.
5. Is it a short one-off job with many steps? Give it to a background agent.

## Step by step: the path of a change

1. **Brief.** The master session adds the ask to the status board. Then it writes a self-contained
   brief: goal, current state, rules, what "done" means, report format.
2. **Design first for big work.** The owner of the project (a second mate) reads the project's
   design and code and updates the design before it builds. The master session only checks that
   the ask does not contradict a recent decision. If it changes one, the brief says "this replaces X".
3. **Build.** A worker builds on a branch in its own worktree and opens a PR.
4. **Gate.** The branch goes through the review gate (no-mistakes): review, tests, docs, lint and
   continuous integration (CI).
   A PR has passed when the gate's attestation in the PR body names the PR's current head commit.
5. **Merge.** Whoever the user allowed merges it (`scripts/pr-merge.sh`). That script refuses drafts,
   conflicts, red or running checks and stacked PRs.
6. **Run the new code.** Pull the checkout that a scheduler or service runs from. Restart runs that
   still use the old code. Run `install.sh` after a harness merge.
7. **Test where the user is.** For user-facing work, test it on the Mac in a browser. Attach
   screenshots to the PR.
8. **Close.** Move the item to Done on the status board, with the date. Tell the user in one line.

**The gate is not optional.** If the review tool freezes, fixing it comes before feature work.
Skipping the gate needs the user's explicit word.

## The status board

- Keep one board in the profile (`tasks/OPEN.md`): one numbered line per item,
  `N. item — owner — status`, in a few groups.
- Add every ask the moment the user makes it, including the ones you delegate.
- When a worker reports "done", check that its result closes the item that the user asked for.
- When the user asks what is open, send the whole list, not only your own items.
- Flag an item with no progress for 12 hours.

## Talking to the user

- The user reads on a phone. Keep replies to about 3 short lines, headline first.
- Push a message only when the user asked, when something they asked for ships, or for a real
  blocker. Some users want a periodic status; they say so.
- Alerts go to the master session, not to the user ([master-session.md](master-session.md)).
- Routine judgment calls are not blockers. Take the safe default, decide, and say what you chose.
  Go to the user only for facts that no source has, logins, 2FA, CAPTCHAs, money and legal matters.

## Terms
- **Master session**: the Claude session that the user talks to, for example over Telegram.
- **Firstmate**: an agent that runs a crew of coding agents in their own worktrees (the `firstmate` skill).
- **Second mate**: a firstmate-like lead for one project.
- **Review gate**: the no-mistakes pipeline. It reviews, tests and lints a branch before the merge.
- **Attestation**: the gate's record in the PR body. It names the commit that passed.
- **Status board**: the one list of everything the user asked for.

## Worked example
1. The user sends "add a dark mode to the web app".
2. The master session adds "14. Dark mode — firstmate — queued" to the board. It replies "on it".
3. It sends firstmate a brief. Firstmate routes it to the web app's second mate.
4. The second mate updates the design. A crew worker builds it and opens PR #52.
5. The gate passes on the head commit. The master session merges #52 and pulls the checkout.
6. It opens the app on the Mac, takes two screenshots and adds them to the PR.
7. It changes item 14 to Done and sends the user one line with a screenshot.

## Warnings
- Some limits stay with the user, even after "no approval needed". These are messages to people the
  user knows, passwords of the user's own accounts, payments and CAPTCHAs.
- Never stop a run in the middle of an irreversible step (a submit, a send, a payment). Check its
  result first.
- One driver per browser. Two workers on one browser break each other's forms.

**Next.** Set up the parts you use. [master-session.md](master-session.md) has priorities and alerts.
The `firstmate` skill has delegation. The cron module has schedules. [retro.md](retro.md) has the
weekly review.
