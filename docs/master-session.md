# The master session: priorities and swaps

The session that answers the user (for example the Telegram session) is the master agent. It
stays reachable, keeps the work moving, and watches the workers it delegates to (firstmate crews,
background agents, scheduled jobs). This file is how it decides what to do next.

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

## Alerts to the master session

The user may not want every alert. Create `<profile>/telegram/ALERTS_TO_MASTER` (an empty file) to
send them to the master session instead. Then `modules/cron/tg-notify.py` (used by hcron, the stall
watch, the Hammerspoon awake guard and the Eyes & Hands loader) appends each alert to
`<profile>/logs/master-alerts.log` while the master session's screen (`claude-tg`) runs. The master
session watches that file, fixes what it can and tells the user only about real blockers. If the
master session is down, the alert goes to Telegram as before, marked "(master session down)".
`TG_NOTIFY_DIRECT=1` always sends. The Telegram watchdog and the morning brief send on their own and
are not affected.

**Warnings**
- A process can sit in the stopped state (`ps` shows `T`) and look "running" for hours. When a run
  is far over its usual time, check `ps -o stat` and send `SIGCONT` before `SIGTERM`.
- Don't restart a run in the middle of a step that cannot be repeated (a submit or a send). Check
  its result first.
