# Runbook: move the Telegram master session from the Mac to a Linux VM

**Short answer.** Only one Telegram poller may run at any time. Prepare and test the VM with
polling off. Get the user's OK. Stop the Mac poller, then start the VM poller. Telegram is down for
less than 2 minutes. To roll back, stop the VM poller and start the Mac poller again.

**Where it fits.** The master session ([master-session.md](master-session.md)) is the Claude session
that answers the user on Telegram. Today it runs on the Mac in the screen session `claude-tg`
([modules/telegram](../modules/telegram/README.md)). After the cutover it runs on the VM in the tmux
session `claude-tg`. The VM reaches the Mac only through `mac-node`
([modules/macnode](../modules/macnode/README.md)).

```
 before                     cutover (< 2 min)                    after
 Mac: claude-tg polls ──► 1 Mac: install.sh --uninstall ──►  Mac: no poller, mac-node serve runs
 VM : claude-tg, polling off  2 VM : TELEGRAM_POLLING=1       VM : claude-tg polls (ACTIVE_HOST=VM)
                              3 VM : install.sh --take-over        │
                              4 both: --status, one poller         └─ mac-node ──► Mac hands
 rollback: VM --uninstall ──► Mac install.sh ──► VM back to polling off
```

**Terms**
- **Poller**: the Telegram plugin's server (`bun server.ts`) under a `claude-tg` session. It calls
  Telegram's `getUpdates`. Telegram gives each bot token to one poller. Two pollers split the messages.
- **ACTIVE_HOST**: the file `$PROFILE_DIR/telegram/ACTIVE_HOST`. It names the machine that owns
  the bot. `install.sh` reads it from the profile's remote, and writes and pushes it.
- **Polling off**: `TELEGRAM_POLLING=0` in `harness.env`. The session runs with the plugin installed
  but turned off, so the machine never polls and never reads or claims ACTIVE_HOST.
- `$H` = the harness folder on that machine. `$P` = `PROFILE_DIR` on that machine. Set both in
  each shell first: `H=<harness folder>; P=$(zsh -c "source $H/lib/env.sh; print -r -- \$PROFILE_DIR")`.
  `<mac-host>` and `<vm-host>` = the names that `--status` prints for "this machine".
- **README**: a module's overview file (`README.md`).
- **SETUP**: a module's setup-steps file (`SETUP.md`).

**Warnings for the whole runbook**
- Never call Telegram's `getUpdates` by hand, and never start the VM poller before step C3. Only
  `install.sh --take-over` (step C4) may call it, at cutover time.
- Never print the bot token. The VM already has `~/.claude/channels/telegram/.env` and
  `access.json`; do not copy them again. Check them only with the commands in P0 below, which print
  the file mode and "clean", never the value.
- Never start a second Telegram session by hand (`claude --channels ...`) on either machine.

## 1. Preconditions (all on, before you ask for the OK)

Keep the evidence in one folder on the VM, one file per test. Example:

```sh
E=$P/telegram/cutover/$(date +%F); mkdir -p $E
# capture a command and its exit code:  { <command>; echo "exit $?"; } 2>&1 | tee -a $E/test1.txt
```

**P0. The VM is ready with polling off.** Run on the VM:

```sh
grep -E '^TELEGRAM_(POLLING|MAC_NODE)=' $H/harness.env      # TELEGRAM_POLLING='0', TELEGRAM_MAC_NODE='1'
                                                           # (install.sh --env-only adds the quotes)
$H/modules/telegram/install.sh --status; echo "exit $?"     # polling: off, tmux session claude-tg running,
                                                           # bot process: not running, exit 0
grep -c '"telegram@claude-plugins-official": false' ~/.claude/telegram-settings.json   # 1
stat -c %a ~/.claude/channels/telegram/.env                 # 600
grep -Eq '^TELEGRAM_BOT_TOKEN=[0-9]+:[A-Za-z0-9_-]+$' ~/.claude/channels/telegram/.env && echo clean
python3 -c 'import json,os;print(bool(json.load(open(os.path.expanduser("~/.claude/channels/telegram/access.json"))).get("allowFrom")))'  # True
command -v bun tmux                                         # both found: the poller needs Bun
crontab -l | grep -F modules/telegram/watchdog.py           # the watchdog line that install.sh printed
```

Run on the Mac: `$H/modules/telegram/install.sh --status; echo "exit $?"` → `owner: <mac-host>`,
`bot process: running`, `exit 0`. On the Mac, `$H/modules/macnode/install.sh --status` → `serve:
running (pid N)` and a last event that shows `link: up`, for example `link: last event link: up (bridge v1)`.

**P1-P6. The six tests.** The exact steps and proofs for tests 1-4 are in
[the macnode setup steps](../modules/macnode/SETUP.md) ("Mac test steps").

| Test | What it proves | How | Evidence file |
|---|---|---|---|
| 1 | From the VM: `mac-node eyes status` returns the lock and grant state; `mac-node hcron status` returns; `mac-node jobhunt status` returns counts | macnode setup steps, Test 1 | `$E/test1.txt` |
| 2 | A denied action is refused (exit 77) and logged on both sides | macnode setup steps, Test 2 | `$E/test2.txt` + the Mac's `requests.log` tail |
| 3 | Kill the link: the VM gets `mac-offline` within 10 s; the queued job runs after reconnect | macnode setup steps, Test 3 (`time` shows `real` < 10 s) | `$E/test3.txt` |
| 4 | Mac lock and sleep: the request reports `locked` (or `mac-offline`) once and never retries | macnode setup steps, Test 4 | `$E/test4.txt` |
| 5 | The VM Claude, plugin installed and polling off, reads the profile and answers a dry run | Below | `$E/test5.txt` |
| 6 | The rollback drill is written down and timed | Section 5 | `$E/test6.txt` (the filled-in table) |

**Test 5 on the VM.** Send the prompt to the running session, as Telegram would. Send the text and
the submit key in two calls:

```sh
tmux send-keys -t claude-tg -l "Dry run, no Telegram reply: read $P/ABOUT.md and $P/memory/MEMORY.md, then answer in 3 lines: my name, how many memories, and which machine runs you."
tmux send-keys -t claude-tg C-m
sleep 60; tmux capture-pane -p -t claude-tg -S -40 | tee $E/test5.txt
$H/modules/telegram/install.sh --status | tee -a $E/test5.txt   # still: polling: off, bot process: not running
```

**Proof:** the pane shows the three-line answer with values from the profile, and `--status` still
shows `bot process: not running`.

## 2. The OK step

The master session (on the Mac, the one that answers today) sends the user one message, for
example: "VM tests 1-6 passed (evidence: `$E`). OK to move Telegram to the VM now? Telegram is down
for less than 2 minutes. Rollback takes about the same time." Do not start section 3 without an
explicit yes in that conversation. A yes for a different time does not count.

## 3. Cutover (stop the Mac poller, then start the VM poller)

Open a shell on each machine before you start. Keep this order. Note the time of each step for the
table in section 5.

**C1. Mac: stop the Mac poller.**

```sh
$H/modules/telegram/install.sh --uninstall
```

It stops and removes the session, the watchdog, keep-awake and the morning-brief agents, so nothing
restarts the bot. It also clears ACTIVE_HOST and pushes the profile. Telegram is down from here.
The Mac's `mac-node serve` runs from hcron under `caffeinate -i`, so it keeps serving.

**C2. Mac: check that no poller runs.**

```sh
$H/modules/telegram/install.sh --status    # bot process: not running
pgrep -fl 'bun server.ts'                 # nothing from the claude-tg session
```

**C3. VM: turn polling on.**

```sh
$H/install.sh --env-only TELEGRAM_POLLING=1
grep '^TELEGRAM_POLLING=' $H/harness.env   # TELEGRAM_POLLING='1'
```

Go straight to C4. With polling on, the VM watchdog sees that ACTIVE_HOST does not name the VM yet.
So it stops the polling-off session at its next run (within a minute). C4 starts it again. It can also send one
"stopped its copy" message to Telegram (a send, not a poll).

**C4. VM: take the bot.**

```sh
$H/modules/telegram/install.sh --take-over
```

It fetches the profile, writes ACTIVE_HOST = `<vm-host>` and pushes it. Then it checks once that
nothing else polls the bot (a `getUpdates` call that never marks messages read). With the Mac
stopped, that check passes at once. It renders the settings with the plugin on, starts the tmux
session `claude-tg`, waits 20 s and prints `Telegram bot is running on <vm-host>.`

It always prints `This machine now owns the bot. Waiting for any other machine to stop polling...` first.
This line is normal. The Mac poller still runs only if `Telegram bot is running on <vm-host>.` does not
appear within about 30 s (the check failed and the command waits for its 10 s retry). Then go back to C2
on the Mac.

**C5. Verify that exactly one poller runs.**

| Where | Command | Expected |
|---|---|---|
| VM | `$H/modules/telegram/install.sh --status; echo "exit $?"` | `owner: <vm-host> (this machine: <vm-host>)`, `bot process: running`, no `problem:` line, `exit 0` |
| VM | `cat $P/telegram/ACTIVE_HOST; git -C $P show '@{u}:telegram/ACTIVE_HOST'` | `<vm-host>` twice |
| Mac | `$H/modules/telegram/install.sh --status; echo "exit $?"` (after `git -C $P pull`) | `owner: <vm-host>`, `bot process: not running`, `exit 0` |
| VM | `ls -t ${XDG_CACHE_HOME:-$HOME/.cache}/claude-cli-nodejs/*/mcp-logs-plugin-telegram-*/*.jsonl \| head -1 \| xargs tail -20` | no `409`/`Conflict` lines, no `Channel notifications skipped` |
| VM | `tail -5 ~/.claude/channels/telegram/logs/watchdog.log` | no restart loop |

**C6. Test with the user.** Ask the user to send the bot "hello". The VM session answers. If it
shows a "trust this folder" prompt first, answer it with `tmux attach -t claude-tg` (choose Yes,
then Ctrl-B D).

**C7. Finish.** Run `$H/modules/telegram/install.sh --status` once more on the VM and add the
crontab lines it prints (the morning brief now runs from the VM's crontab, if the profile has
`telegram/morning-brief.md`). Save the times in `$E/cutover.txt`.

**Expected downtime.** From C1 to the end of C4: about 1 minute. C1 is a few seconds plus a profile
push. C4 is a fetch, a push, one Telegram check and the 20 s wait. Telegram holds the messages
sent during the gap, and they arrive when the VM poller starts. If the gap passes 2 minutes and C4 has not
finished, roll back (section 4).

## 4. Rollback (stop the VM poller, then restart the Mac claude-tg)

Use it when C4 fails, when C5 or C6 shows a problem, or when the user asks.

**R1. VM: stop the VM poller.**

```sh
$H/modules/telegram/install.sh --uninstall
```

It kills the tmux session, makes the crontab watchdog idle, clears ACTIVE_HOST and pushes it.

**R2. VM: check that no poller runs.** `$H/modules/telegram/install.sh --status` → `bot process: not running`.

**R3. Mac: start the Mac claude-tg again.**

```sh
git -C $P pull --rebase --autostash    # sees the cleared ACTIVE_HOST
$H/modules/telegram/install.sh         # claims ACTIVE_HOST = <mac-host>, loads the agents
```

If ACTIVE_HOST still names the VM (R1 could not push), use `$H/modules/telegram/install.sh --take-over`.
Proof: `$H/modules/telegram/install.sh --status; echo "exit $?"` → `owner: <mac-host>`,
`bot process: running`, `exit 0`. Ask the user to send "hello".

**R4. VM: return to polling off** (prepared for the next try):

```sh
$H/install.sh --env-only TELEGRAM_POLLING=0
grep '^TELEGRAM_POLLING=' $H/harness.env   # TELEGRAM_POLLING='0'
$H/modules/telegram/install.sh          # tmux claude-tg again, plugin off, no poller
$H/modules/telegram/install.sh --status # polling: off, bot process: not running, exit 0
```

## 5. Rollback drill (test 6): timed, with only one poller

The drill never starts a second poller, and it never stops the live Mac bot. It times the parts that
can run with polling off, and estimates the rest in a tabletop table.

**Part A: time the real commands on the VM, polling off.** This part does not touch the live bot on the Mac.

```sh
{ time $H/modules/telegram/install.sh --uninstall; } 2>&1 | tee -a $E/test6.txt   # stands in for R1 (stop)
{ time $H/modules/telegram/install.sh; } 2>&1 | tee -a $E/test6.txt               # stands in for C4 / R4 (start)
$H/modules/telegram/install.sh --status | tee -a $E/test6.txt                     # polling: off, not running
```

With polling off, neither command calls Telegram or touches ACTIVE_HOST.

**Part B: see what the cutover would do, without doing it.** `--dry-run` prints the steps and
changes nothing; it skips the Telegram check and the ACTIVE_HOST write:

```sh
$H/modules/telegram/install.sh --take-over --dry-run | tee -a $E/test6.txt   # on the Mac: shows the R3 steps
```

Do not run this on the VM before C3: with polling off it only prints that there is nothing to take
over.

**Part C: the tabletop table.** Fill in the measured times from Part A and estimate the others.
Keep it in `$E/test6.txt`.

| Step | Machine | Command | Measured or estimated (s) |
|---|---|---|---|
| C1 / R1 stop | Mac / VM | `install.sh --uninstall` | |
| profile push of ACTIVE_HOST | both | part of `--uninstall` and `--take-over` | |
| C3 / R4 env change | VM | `install.sh --env-only TELEGRAM_POLLING=...` | |
| C4 start (fetch, push, one check, 20 s wait) | VM | `install.sh --take-over` | |
| R3 start (pull, claim, load agents) | Mac | `git -C $P pull` + `install.sh` | |
| first reply to "hello" | — | — | |
| **Total down (C1 → reply, or R1 → reply)** | | | **target < 120** |

If the total is over 120 s, find the slow step before you ask for the OK.

## Worked example (expected times)

```
18:00:00  C1  Mac: install.sh --uninstall     -> "Telegram bot removed from <mac-host>."   (~8 s)
18:00:10  C2  Mac: --status                   -> bot process: not running
18:00:15  C3  VM : --env-only POLLING=1        -> TELEGRAM_POLLING='1'
18:00:20  C4  VM : install.sh --take-over     -> "Telegram bot is running on <vm-host>."  (~35 s)
18:00:55  C5  VM : --status exit 0, Mac: --status exit 0, owner <vm-host> on both
18:01:10  C6  user sends "hello" -> the VM session answers                    down: ~70 s
```

## Edge cases
- **The Mac sleeps or is away during C1.** You cannot stop its poller. Do not start the VM poller.
  The Mac watchdog stops its own bot about 10 minutes after it sees another owner. Only
  `--take-over` writes that owner, and it then waits up to 15 minutes. Wait for the Mac instead.
- **The profile push fails.** `--status` on the other machine still shows the old owner. Run
  `git -C $P push` by hand, then check `git -C $P show '@{u}:telegram/ACTIVE_HOST'`.
- **A firstmate Telegram bot** (`FIRSTMATE_TELEGRAM=1`) is a different bot, so `pgrep` can show it.
  `--status` counts only the poller under `claude-tg`.
- **Alerts to the master.** `modules/cron/tg-notify.py` finds the master session through `screen -ls`.
  After the cutover the Mac has no `claude-tg`, and the VM uses tmux, so alerts go straight to
  Telegram, marked "(master session down)".
