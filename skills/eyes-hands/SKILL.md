---
name: eyes-hands
description: Work in a desktop app or browser like a person, with desktop "eyes" (read the screen through macOS Accessibility and screenshots) and "hands" (real mouse and keyboard input through Hammerspoon). Use for any browser or app task the user wants done on their Mac (fill a form, click through a site, check a page, book, submit, find why something is blocked), whenever eyes/hands tools are installed, even if the user doesn't say "eyes" or "hands". Covers the look-think-act-check loop, how to verify each step, how to pause and resume when the user touches the mouse or keyboard, and what to hand back to the user.
---

# Eyes and hands

Do browser and app work the way a person does: **look, decide one step, act, check**, in a loop, until the goal is done or only the user can continue.

- **Eyes** read the screen: the Accessibility tree (every control with role, label, value, position), visible text, focus, open dialogs, and screenshots.
- **Hands** post real mouse and keyboard events, with human timing, tagged so the user's own input can be told apart.
- Both run inside Hammerspoon, the one app that holds the Accessibility and Screen Recording permissions.

## 0. Before you start

1. **Find the tools on this machine.** Read `knowledge/eyes-hands.md` in the profile folder (the user's private notes; `PROFILE_DIR` in harness.env, the path is under Paths in `~/.claude/CLAUDE.md`) if it exists: it names the installed eyes/hands commands, the allowed apps and the lessons from earlier runs. If the Eyes & Hands product is installed, prefer its CLI or MCP tools.
2. **Check the screen can take input:** not locked, permissions on (`harness.status()` / the tool's `status`). A locked screen drops all input: stop and report, don't retry.
3. **Hold the screen awake** for anything longer than a minute: `awake run <name> -- <command>`, or the scheduler's `--needs gui`.
4. **Pick the browser by account** as the user's rules say. Never drive a browser or app the access policy doesn't grant.

## 0b. Choose the channel first (the router)

Two ways exist to drive a browser. Pick one, and write the choice and its reason in one line before you start.

```
task
 │
 ├─ default                                        → DESKTOP (eyes + hands, normal Chrome)
 │
 └─ only if the task QUALIFIES for CDP (list below) → CDP (Chrome with the debug port)
```

CDP (Chrome DevTools Protocol) is the browser module's `agent` mode (Chrome runs with its debug port); DESKTOP is its `desktop` mode.

**DESKTOP is the default** for every task that acts as the user or on a site that watches for bots: applying, signing up, logging in, filling or submitting forms, sending messages, editing account settings, anything on LinkedIn, ATS/job portals, Google, banks, shops.

**CDP qualifies only when at least one is true** (and no step submits, sends, pays or signs up):

| Qualifies | Why desktop can't do it well |
|---|---|
| Debugging a site: console errors, network calls, performance | the eyes can't see the network or console |
| Read-only bulk extraction (many pages) from a site with no API, where the user accepts the bot-detection risk | human-paced desktop is far too slow |
| Content the Accessibility tree and OCR both can't read (canvas apps, closed shadow DOM), read-only | no other way to read it |
| The user explicitly asks for CDP for this task | their call |

**Never use CDP for:** submitting an application, signing up, logging in, sending a message or mail, payments, account changes, or any site that showed a CAPTCHA or bot wall before. This list wins even over an explicit request: tell the user why, and do that step on DESKTOP.

**Switching costs:** one browser profile runs in one mode at a time, and a switch quits and reopens that browser. Record every switch with `modules/browser/chrome-mode.sh <id> agent|desktop`, or use the installed Eyes & Hands tool that calls it, so the recorded mode matches the running browser. Batch CDP-qualified work, run it when the user is away, switch back to desktop right after, and never switch while a desktop task or a hand-off tab is waiting.

## 1. The loop

```
goal
 │
 ▼
LOOK   eyes: fields / text / dialog / focused; a screenshot when text isn't enough
 │
THINK  compare screen to goal; choose ONE next step and the change it should cause
 │
ACT    hands: click / type / key / scroll / drag (one small step)
 │
CHECK  eyes again: did the expected change happen?
 ├─ yes ............................ next step (back to LOOK)
 ├─ unexpected (popup, error, moved) handle it, or re-plan
 ├─ user touched mouse/keyboard .... PAUSE (section 3)
 └─ only the user can do it ........ HAND OFF (section 4)
```

Rules for each step:
- One action per step, and say to yourself what should change before you act. A step without an expected change can't be checked.
- Read fresh positions before every click. Pages move (lazy content, banners, a resume upload that re-fills fields), so never reuse a rect from an earlier snapshot.
- Scroll the target into view first: a control with zero height or outside the viewport can't be clicked.
- Text fields: click → confirm `focused` is that field → select all → type → read the value back.
- Native file dialogs: click the upload control → wait for the dialog → Cmd+Shift+G → type the full path → Enter → Enter → wait for the dialog to close → check the file name shows.
- Selects: click → type the option's start → Enter → read the value back.
- After an upload or any step that changes layout, re-check every field you already filled.

## 2. How to know a step worked

| Signal | Read it with | Example |
|---|---|---|
| Page changed | url / title in the snapshot | `/apply` → `/thanks` |
| Value took | read the field's value | the email reads back exactly |
| Focus went to the right place | focused control | typing landed in "Phone", not "Email" |
| Success or error text | visible text | "Saved", "Invalid date", "Thank you for applying" |
| Something popped up | dialogs, new controls | cookie banner, "Leave site?", file picker |
| A wall | text wall detection | CAPTCHA, login, OTP |
| Visual-only content | screenshot (read it as an image) | charts, canvas apps, odd layouts |

If the expected change didn't happen, don't repeat the action blindly. Look again, find why, and fix the cause.

## 3. When the user touches the mouse or keyboard

Their input always wins. Any untagged mouse move, click, key or scroll stops the hands at once, and every hands call is refused until resumed.

1. **Stop.** Don't fight the cursor and don't retry.
2. **Wait for a short idle buffer:** by default **20 seconds** with no human input (the user may change it in their notes). Measure system idle time, which needs no Hammerspoon:
   ```sh
   idle() { ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'; }
   until [ "$(idle)" -ge 20 ]; do sleep 2; done
   ```
3. **Look again before acting:** the user may have changed the page. Re-read the form, keep their edits when they're valid, and continue from the first step that isn't done.
4. **Resume the hands** (the tool's `resume`), then continue the loop.
5. **Never repeat an irreversible step** (submit, pay, send, delete). If it may already have happened, check for its result instead.
6. After **3 interruptions on the same task**, stop and tell the user in one line: "You're using the Mac; I'll continue later. Say 'go' to resume now."

## 4. Hand off to the user

Stop and ask, with a screenshot, for:
- **CAPTCHA:** never solve it, never call a solver service, never guess. Send the user a screenshot (shrink it under 10 MB for Telegram). Act on their answer with the hands, or let them solve it.
- **OTP and passwords:** the user types them.
- **Real decisions:** purchases, sends, deletes, anything outward-facing the user hasn't approved, and facts no source has (age, salary).

Before any hand-off, make sure everything else is done and checked (for example, the form is fully filled and verified), so the user only does the one thing that needs them.

## 5. Get better after every use

This workflow improves with each task.
- When the user flags a problem or a preference (a wrong click, a too-long wait, a site quirk), write it down **the same day**:
  - **Machine- or user-specific** (paths, sites, timings, accounts) → `knowledge/eyes-hands.md` in the profile folder, under "Lessons".
  - **Useful for everyone** → improve this skill through a harness PR (`scripts/upstream.sh new <name>`, no-mistakes).
- Read the lessons before the next task, and apply them.

## 6. Limits

- The eyes see what a screen reader sees: no network calls or console errors. To debug a site, use a DevTools/CDP browser instead.
- The hands share the user's single cursor. If the user is clearly working at the Mac, ask before taking over.
- Human pace is slower than CDP. Bulk read-only lookups may use CDP only when they qualify under section 0b.
- A locked screen stops everything. So does a lid close.
