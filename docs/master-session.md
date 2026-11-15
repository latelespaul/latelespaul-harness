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
5. **Heartbeat.** Every 15 min while work runs, send the user a short status with the top 3 items.
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

## Alerts to the master session

The user may not want every alert. Create `<profile>/telegram/ALERTS_TO_MASTER` (an empty file) to
send them to the master session instead. Then `modules/cron/tg-notify.py` (used by hcron, the stall
watch, the Hammerspoon awake guard and the Eyes & Hands loader) appends each alert to
`<profile>/logs/master-alerts.log` while the master session's screen (`claude-tg`) runs. The master
session watches that file, fixes what it can and tells the user only about real blockers. If the
master session is down, the alert goes to Telegram as before, marked "(master session down)".
`TG_NOTIFY_DIRECT=1` always sends. The Telegram watchdog and the morning brief send on their own and
are not affected.

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
