# The master session: priorities and swaps

The session that answers the user (for example the Telegram session) is the master agent. It
stays reachable, keeps the work moving, and watches the workers it delegates to (firstmate crews,
background agents, scheduled jobs). This file is how it decides what to do next.
To move it from the Mac to a Linux VM, follow [master-cutover.md](master-cutover.md).

**How it fits**

```
user ──► master session ──► background agents / firstmate workers / hcron jobs
            ▲    │
            │    └── status board (profile tasks/OPEN.md) + heartbeat to the user
            └────── stall watcher (modules/firstmate/stall-watch.sh) flags idle workers
```

## Priority levels

Highest first. A higher level interrupts a lower one at the next step.

| Level | What | Target |
|---|---|---|
| P0 | A message from the user | Reply within 1 min, even "on it" |
| P1 | A pipeline is down: its output stopped, a loop is stopped or frozen, the screen is locked, a security problem | Act now, report every 15 min |
| P2 | Time-sensitive outward work: replies others wait for, CAPTCHA/OTP hand-offs | Within 15 min |
| P3 | Unblock workers: a stalled worker, a gate decision, merge → pull → restart | Within 20 min of the signal |
| P4 | Diagnose failures (screenshots, logs) and brief the fixes | Each loop pass |
| P5 | New features and design | When P0-P4 are clear |
| P6 | Housekeeping: memory, notes, cleanup | Idle time |

## How a swap works

1. **Never block.** No foreground step longer than about 20 s. Send long work to a background agent
   or a firstmate worker, so a swap costs nothing and the user can always reach the session.
2. **Log, then switch.** On a higher-level event, write one line in the status board ("paused X at
   step Y, next: Z"), handle the event, then resume X from that line.
3. **The user overrides.** "P1: <task>", "first X then Y", "drop X" or "pause X" re-orders the list
   at once. The user's order beats this table until the task ends.
4. **Aging.** A P4/P5 item waiting more than 2 h moves up one level, so nothing starves.
5. **Heartbeat.** Every 15 min while work runs, check the workers, the alerts and the open pull
   requests. Send the user a short status with the top 3 items. If the user asked for no periodic
   status, send only what they asked for, what shipped, and real blockers instead.
6. **Ties.** The item closer to the user's real goal (a delivered result) wins.

## Watching workers

A worker that shows no change for a long time has usually stalled: it waits at a gate, waits for
an answer, or hangs on a command. `modules/firstmate/stall-watch.sh` checks every `fm-*` window in
the firstmate tmux session. After `STALL_MIN` (20) idle minutes it sends firstmate a note to steer,
unblock or close the worker. After `PING_MIN` (45) it also pings the user through
`modules/cron/tg-notify.py`. Schedule it with hcron. Run this from the harness folder, so `$PWD` expands
to the full harness path when you add the job:

```sh
hcron add fm-stall-watch --cron "*/5 * * * *" --cmd "$PWD/modules/firstmate/stall-watch.sh" --timeout 2m
```

**Freeze watch.** The same script also watches firstmate itself (the first window that is not `fm-*`).
Firstmate can freeze after an API error: the prompt keeps unsent text, Enter does nothing and the
process ignores SIGTERM. A stall note to firstmate cannot help then. The script calls firstmate
frozen when inbox notes wait and its pane shows no progress for 15 min, or when the pane shows
"API Error" with an idle prompt for 5 min. No progress means no pane change and no drained note. A
busy pane whose spinner still redraws is not frozen. The script then presses Enter once. If firstmate
is still frozen 3 min later, it stops the `claude` child of `run-firstmate.sh` (SIGTERM, then SIGKILL
after 20 s). The loop starts it again with `--continue`, and the script types `check inbox`. For a
second mate (`fm-*` window) with "API Error", an idle prompt and inbox messages, it presses Enter, then
sends one nudge. It never stops a second mate. Each step goes straight to `master-alerts.log`, with
one summary line for each freeze, so the user's Telegram never gets these lines. State:
`<profile>/logs/fm-freeze-watch.state`.

**The orchestrator sweep** (`modules/orchestrator/sweep.mjs`) looks at every executor in one
read-only pass and writes one line per problem through `tg-notify.py`, so with `ALERTS_TO_MASTER`
the lines land in `master-alerts.log`. It finds: the hcron global pause, jobs not run for twice their
interval since the Mac woke (several share one line), a failing job; firstmate workers that are
registered as working but have no window, `fm-*` windows idle 20 min (only info, not sent, unless
inbox notes are waiting), inbox notes waiting 10 min; no-mistakes runs parked or at a gate for 15 min
(run id, branch, checkout); PRs green and mergeable for 30 min but not merged, and conflicting PRs;
unhealthy health targets; a high load average; a locked screen while a gui job is due. When DNS
fails for every health URL, it sends one "network down" line and holds back the PR, health and
hcron-failure lines that follow from it. It repeats a line (same key or same text) only after 120 min.
It never merges, kills or resumes anything: you act on each line. The repos, health addresses, load
limit and an `ignore` list (`owner/name#N` or `label:NAME`, for parked PRs) come from
`<profile>/orchestrator/sweep.json` (format in the file header).
`--dry-run` prints what it finds and sends nothing.

```sh
hcron add orchestrator-sweep --cron "*/5 * * * *" --cmd "node $PWD/modules/orchestrator/sweep.mjs" --timeout 3m
```

**Nudging a worker in tmux**
- Send the submit key (`C-m`) in a separate `send-keys` call. If the text and the submit key go in one
  call, a Claude Code input box sometimes keeps the text unsent. The stall watch then flags the
  worker as idle. Type the text with `tmux send-keys -t <pane> -l "<text>"`. Then send
  `tmux send-keys -t <pane> C-m`.
- Send `/clear` as its own message, then send the brief as a second message. If you send them
  together, `/clear` clears the input and drops the brief.
- A large session file (about 60 megabytes or more) can make `claude --continue` hang at startup.
  The launchers here fall back to a fresh start only when a resume exits within 30 s, not when it
  hangs. A restarted worker can show no prompt after about 30 s. Then use the recovery for its launcher:
  - Telegram session (`modules/telegram/run.sh`): create the watchdog's `fresh-next` file, then stop
    the hung `claude`. The loop then starts a fresh session.
  - Firstmate (`modules/firstmate/run-firstmate.sh`): after a run of 30 s or more, the loop always
    resumes with `--continue`. Stop the loop (close its tmux window), then start `claude` without
    `--continue`.
- On a heavily loaded Mac, monitors and watchers can miss their confirm window and stop. Check the
  load average (`uptime`) before you decide that the watcher is broken.
- A relaunch tool can refuse a worker whose tmux window is gone. It cannot prove that no agent
  still runs there. Find the worker's process first (`ps`). Do not recreate the window only to get
  past that check.

## Delegating and recovering

These rules keep work moving without the user. Each one came from a real stall.

**Delegate**
- Give every job with more than a few quick commands to a worker: a background agent, a tmux
  session, firstmate or a cloud session (see [operating-model.md](operating-model.md)). Do only
  quick lookups and decisions in the master session.
- Write the brief so that the worker needs nothing else: goal, current state, rules, what "done"
  means, report format. Tell the user in one line what you handed off.
- Add each delegated ask to the status board at once. When the worker reports "done", check that
  its result closes the item that the user asked for.

**Clear your own blockers**
- When your own system blocks the plan, clear it at once. Examples are a run that holds a lock, a
  paused job and an idle worker. Do not wait, and do not report it as the reason for a delay.
- Before you stop something, make sure that it is yours and that it is not in an irreversible step.
- Try every blocker yourself first: saved answers, a retry, a fix brief. Report only the blockers
  that you could not clear, in one message per run, grouped by reason ("Upload failed: A, B",
  "Job closed: C").
- A config or setup judgment call is not a blocker. Take the safe default, decide, and say what you
  chose. Tell workers to do the same.

**Answer from the user's data**
- Workers, crews and sub-agents must not ask the user a question that the user's own data answers.
  That data is the profile, the curriculum vitae (CV), the answer bank and memory.
- When the data does not answer it, the worker picks the most reasonable truthful answer. It logs
  the answer as a guess and continues.
- Only these go to the user: passwords, 2FA, CAPTCHA, payments, legal terms to accept, and real
  product or business decisions.
- Put this rule in every brief that you send to a worker.
- When a worker asks the user something that breaks this rule, do not pass it on. Answer it
  yourself, or rewrite it into one of the allowed kinds.

**Diagnose before you brief a fix**
- Open the evidence first: the screenshot of the stuck screen, the log, the saved plan or state file.
- Put the cause, the evidence path and a test that proves the fix in the brief. Do not forward only
  the error text.

**Restart stale runs**
- A run can take far longer than usual and fail on a bug that merged code already fixes. Do not wait
  for it to end. Stop it, pull the new code, clear its stale lock files, and start it again.
- Stop the run's child processes too. A "pause" flag can take minutes to reach a running loop.

**Do it by hand first, then automate**
- When a bot fails on a new site or flow, stop the bot. Do the task by hand once with eyes and hands.
- Write down each step as a playbook: the fields, the control types, what worked and what failed.
- Give the playbooks to the builders. Turn the bot on for that flow only after the new code passes.

**After a restart or a freeze**
- Check `hcron status` for a global pause and for jobs with an old last-run time.
- Check that firstmate and its workers have a live prompt (see "Nudging a worker in tmux" above).
- A review-gate run that looks frozen can wait at a gate, because the agent that drove it died. Run
  `no-mistakes axi status` from that branch's checkout. If it shows `awaiting_agent: parked`, look
  at the decision that the gate asks for. Answer it with `no-mistakes axi respond` only when the
  user's standing rules give you that authority. Send all other gate decisions to the user. Then
  start a new driver.
- If the review gate itself is stuck, fixing it comes before feature work. Skip the gate only when
  the user says so.

## Alerts to the master session

The user may not want every alert. Create `<profile>/telegram/ALERTS_TO_MASTER` (an empty file) to
send them to the master session instead. Then `modules/cron/tg-notify.py` (used by hcron, the stall
watch, the Hammerspoon awake guard and the Eyes & Hands loader) appends each alert to
`<profile>/logs/master-alerts.log` while the master session (`claude-tg`) runs: a screen session on
macOS, a tmux session on Linux. The master session watches that file, fixes what it can and tells the
user only about real blockers. If the master session is down, the alert is still logged, and Telegram
gets one note per outage ("master session down since HH:MM; N alerts queued"), then at most one
reminder every 6 h, never one message per alert. `TG_NOTIFY_DIRECT=1` always sends the alert itself.
The Telegram watchdog and the morning brief send on their own and are not affected.

**Master session on a VM (virtual machine), Mac as the hands**
**Warning:** agents no longer run on the always-on VM. Plain watch scripts may run there. See
[operating-model.md](operating-model.md).
```
 Mac                                              VM
 tg-notify.py ─► Mac master-alerts.log            heartbeat.sh (crontab, every minute)
  (queues while a VM pulled < 10 min ago)          ├─ master claude-tg, firstmate, mac-node link
        ▲                                          │   a change ─► tg-notify.py ─► VM master-alerts.log
        └──── mac-node alerts since <cursor> ◄─────┴─ master and link up: mac-node pull-alerts
                                                        appends "<time> [mac] <text>" to the same log
```
- On the VM, create `<profile>/telegram/ALERTS_TO_MASTER` and add the heartbeat line from
  `modules/telegram/heartbeat.sh` to the crontab (`crontab -e`). Nothing installs it for you.
- Each run checks the master session, firstmate's tmux session and, with the `macnode` module, the
  link to the Mac. It writes one line only when one of them changes (down, or up again). The line
  goes through `tg-notify.py`, so it reaches Telegram only when the master session itself is down.
- While the master session and the link are up, it runs `mac-node pull-alerts`. The Mac's new alert
  lines land in the VM's log with a `[mac]` tag. The cursor (`~/.local/state/mac-node/alerts.cursor`
  on the VM) moves only after `pull-alerts` writes the lines, so a Mac that was away catches up on reconnect.
- The Mac keeps `ALERTS_TO_MASTER` too. Its `tg-notify.py` counts the VM's master session as up while
  a pull came in the last 10 minutes (`~/.local/state/mac-node/alerts-pulled` on the Mac). When the
  VM master or the link is down for longer, Mac alerts are logged and Telegram gets the one outage note.
- Alerts from hcron, the stall watch and anything else on the VM that calls `tg-notify.py` reach the
  VM's log the same way.

**Handling an alert**
- Do not forward a raw alert to the user. Find its cause, fix it, and log what you did. Tell the
  user only about a blocker that only they can clear, such as a permission or a password prompt.
- The same alert again means the cause is still there. Fix its source, not the alert.
- hcron reports a skip once per reason, then stays quiet until the job runs again. A `--needs gui`
  job that skips because Hammerspoon has no Accessibility permission can stay silent for days. Look
  for an old last-run time in `hcron status`, then check `hs -c 'return harness.status()'`.
- After the user turns Accessibility back on in System Settings, Hammerspoon still reports it off
  until Hammerspoon restarts. Restart it with `modules/hammerspoon/install.sh --restart`. The
  command defers: while a job holds awake mode or an armed owner runs, it prints "restart deferred"
  and does not restart. Run it again when they finish. Then run
  `modules/hammerspoon/install.sh --status` and make sure that Accessibility is on.
- An awake guard alert means that a run used eyes or hands without its own awake hold. Fix that
  run (`awake run`, or `--needs gui` for an hcron job).

**Warnings**
- A process can sit in the stopped state (`ps` shows `T`) and look "running" for hours. When a run
  is far over its usual time, check `ps -o stat` and send `SIGCONT` before `SIGTERM`.
- Don't restart a run in the middle of a step that cannot be repeated (a submit or a send). Check
  its result first.
