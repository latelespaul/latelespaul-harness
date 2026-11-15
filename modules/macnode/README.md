# mac-node: the VM asks, the Mac does

**Short answer.** An agent on a Linux VM runs `mac-node <action> [args]`. The request travels over an
SSH link that the Mac opened to the VM. The Mac checks the action against a fixed allowlist, runs one
fixed program without a shell, and sends back the output. When the Mac is away, the VM queues the
request and runs it when the link returns. Setup and test steps: [SETUP.md](SETUP.md).

## Where it fits

The VM is the brain: the master session and firstmate run there all day. The Mac is the hands:
Hammerspoon (eyes and hands), Chrome, the Keychain, job-hunt and the GUI hcron jobs. Secrets stay on
the Mac. The VM gets only the output of the actions it asked for.

## The whole flow

```
 VM                                                 Mac
 mac-node hcron status                              hcron job "mac-node" (every minute, one copy)
   │ 1 check the allowlist (actions.mjs)              └─ mac-node serve
   │ 2 newest link/<name>.sock that says hello            ├─ runner on ~/.local/state/mac-node/runner.sock
   │   none in 8 s → mac-offline (exit 75) + queue        └─ ssh -F none -N -R <VM>/link/<name>.sock:<runner.sock>
   ▼                                                           (reconnect loop, 2 s → 60 s backoff)
 ~/.local/state/mac-node/link/<name>.sock ◄── sshd ◄═══ SSH, opened by the Mac ═══┘
   │ 3 {"id","argv":["hcron","status"]}  ─────────────────────► runner
   │                                                        4 allowlist again, with this Mac's config
   │                                                        5 locked screen? (GUI actions only) → "locked"
   │                                                        6 run one program with argv; no shell
   │ 7 {"status","exit","stdout","stderr"} ◄────────────────── 
   ▼
 prints the output, exits with the action's code; both sides log one line
```

## Step by step
1. The client checks the request against the allowlist in `actions.mjs`. A refused request is logged
   and never sent or queued (exit 77).
2. It lists the sockets in `$MACNODE_DIR/link/`, newest first. A socket that refuses the connection
   is stale (its sshd is gone), and the client deletes it. A socket that accepts but sends no hello
   line within 3 seconds belongs to a Mac that went away. If no socket greets within 8 seconds, the
   result is mac-offline (exit 75).
3. When offline, the request goes to `queue/<id>.json` with an expiry time (`--ttl`, default 60
   minutes, at most 24 hours). A background `mac-node drain --wait` then polls for the link every 3
   seconds and runs the queue in order. The result lands in `results/<id>.json`, and
   `mac-node result <id>` prints it. `--no-queue` skips the queue.
4. The Mac runner parses the request again with its own `harness.env`. This check is the one that
   decides. Config turns actions on (`MACNODE_JOBHUNT_SUBS`, `MACNODE_GH_CODE`,
   `MACNODE_PORTAL_PASS`, `MACNODE_REPOS`) and gives every program path.
5. A GUI action (`hands call`, `hands batch`, `portal-pass`) first asks Hammerspoon whether the screen
   is locked (`hsx status`, then `ioreg`). A locked screen returns `locked` (exit 76) once. The request
   is not queued, and a queued one that meets a locked screen is dropped with that result. Nothing
   retries in a loop.
6. A hands request arms the port owner (`MACNODE_HS_OWNER`, default `mac-node`) for that request only:
   `hsx arm --new` makes a fresh secret, kept in memory. `awake run` holds awake mode while
   `hsx session` signs the calls, and `hsx disarm` ends the arm. One hands request runs at a time.
7. The output goes back to the VM, capped at 1 MB per stream. If the link drops before the answer,
   the client reports `mac-link-lost` (exit 74). It does not retry, because the action may have run.

## Terms
- **Link**: one `ssh -N -R` connection from the Mac. sshd on the VM listens on a Unix socket for it and
  forwards each connection to the Mac's runner socket. Each connection uses a new socket name, so a
  stale socket never blocks a reconnect.
- **Runner**: the Mac's request handler inside `mac-node serve`.
- **Hello**: the line the runner sends first on every connection. It proves that a live Mac is at the far end.
- **Drainer**: `mac-node drain --wait`. The client starts it when it queues a request. Only one runs at a time (`drain.pid`).
- **GUI action**: an action that needs the graphical user interface, that is, an unlocked screen.
- Other short forms: JSON (JavaScript Object Notation), PTY (pseudo-terminal), TCP (Transmission
  Control Protocol, network ports), KB and MB (kilobyte, megabyte).

## Actions
| Action | Runs on the Mac |
|---|---|
| `ping` | nothing; answers the version and the lock state |
| `eyes status` | `hsx status` |
| `hands call <port-cmd> [args-json]`, `hands batch <json-array>` | `hsx arm` → `awake run mac-node -- hsx session` → `hsx disarm` |
| `chrome-mode <profile> [agent\|desktop]` | `modules/browser/chrome-mode.sh` (writer `mac-node`) |
| `jobhunt <sub> [args]` | `$MACNODE_JOBHUNT_DIR/bin/jobhunt`, only the subcommands in `MACNODE_JOBHUNT_SUBS` (default `status`) |
| `hcron status\|list\|pause <id\|all>\|resume <id\|all>\|run <id>` | `hcron` |
| `gh-code <company> [max-age-min]` | `node $MACNODE_GH_CODE` (off while empty) |
| `portal-pass <portal-id> [--create]` | `node $MACNODE_PORTAL_PASS` (off while empty; GUI) |
| `git pull <repo>` | `git -C <path> pull --ff-only` for a name in `MACNODE_REPOS` |

Arguments must be plain words: letters, digits and `._:@/=,+-`, or `--flags`. No `..` path parts, no
spaces (a company name may have spaces), no shell characters. JSON arguments are parsed and limited
to 16 KB. Everything else is refused.

## Worked example

```
vm$ mac-node jobhunt status
applied=41 queued=12 failed=2
vm$ mac-node log -n 1
{"ts":"2026-11-15T18:02:11.204Z","side":"vm","id":"mi0x3k2a-9f1c2e","action":"jobhunt status","ms":412,"status":"ok","exit":0}
vm$ mac-node hands call chrome.click '{"x":10}'      # with the Mac's screen locked
locked: screen is locked (via hammerspoon); unlock the Mac, then ask again
vm$ echo $?
76
```

## Security
- **No inbound port on the Mac.** The Mac's ssh dials out. Remote Login stays off. No reverse
  tunnel reaches the Mac's sshd.
- **A dedicated key, restricted on the VM:**
  `restrict,port-forwarding,permitlisten="127.0.0.1:1",permitopen="127.0.0.1:1",command="/bin/false"`.
  `restrict` turns off the PTY, agent and X11 forwarding and `~/.ssh/rc`. `command="/bin/false"`
  means the key cannot run a shell or a command. `permitlisten` and `permitopen` leave TCP forwards
  only a port that cannot be used (a non-root sshd cannot bind port 1). OpenSSH has no per-path
  limit for Unix-socket forwards, so the key can listen on any socket path the VM user may write.
  It is still only a listener that forwards to the Mac's runner.
- **`ssh -F none`**: only this key and these options, whatever `~/.ssh/config` says.
- **Private sockets and state**: sshd makes the VM socket with mode 600 (StreamLocalBindMask), and
  `$MACNODE_DIR` is mode 700 on both sides. Anyone who can act as the VM user can send requests: this
  is the trust boundary. The allowlist limits what such a request can do.
- **Logs** (`$MACNODE_DIR/requests.log`, JSON lines, rotated at 5 MB): time, id, an action summary,
  outcome, exit code and duration. Never the output, the hands arguments (they can hold typed text)
  or a secret. Results of queued requests (`results/`, mode 600) do hold the output, because the
  caller needs it.

## Edge cases
- A request that ran when the link dropped is not repeated. Check its effect before you send it again.
- The VM queue keeps working without the Mac. Requests expire after their ttl with `"status": "expired"`.
- `--unchecked` skips the VM check so you can see the Mac refuse something. It is never queued.
- hcron runs the service under `caffeinate -i`, so the Mac does not idle-sleep while it serves.

## Files
- `mac-node.mjs`: the CLI (both sides). `actions.mjs`: the allowlist. `install.sh`: both roles.
- Tests: `node --test modules/macnode/*.test.mjs`. They use a fake ssh (`test/fake-ssh.mjs`, which
  pipes a local socket) and stub `hsx`, `awake`, `hcron` and `jobhunt` in a throwaway folder. They
  never run real ssh, Hammerspoon or Chrome.
