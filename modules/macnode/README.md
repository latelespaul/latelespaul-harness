# mac-node: the VM asks, the Mac does

**Short answer.** An agent on a Linux VM runs `mac-node <action> [args]`. The request travels over an
SSH session that the Mac opened to the VM, with no forwarding. The Mac checks the action against a
fixed allowlist, runs one fixed program without a shell, and sends back the output. When the Mac is
away, the VM queues the request (never a GUI action) and runs it when the link returns. Setup and test
steps: [SETUP.md](SETUP.md).

## Where it fits

The VM is the brain: the master session and firstmate run there all day. The Mac is the hands:
Hammerspoon (eyes and hands), Chrome, the Keychain, job-hunt and the GUI hcron jobs. Secrets stay on
the Mac. The VM gets only the output of the actions it asked for.

## The whole flow

```
 VM                                                  Mac
 mac-node hcron status                               hcron job "mac-node" (every minute, one copy)
   │ 1 check the allowlist (actions.mjs)               └─ mac-node serve
   │ 2 newest link/<name>.sock that says hello              └─ ssh -F none -T <VM> (no -N, -R or -L)
   │   none in 8 s → mac-offline (exit 75)                     reconnect loop, 2 s → 60 s backoff
   │   + queue, unless a GUI action                                │
   ▼                                                               │
 mac-node bridge ◄══ sshd forced command ◄══ SSH session, opened by the Mac
   listens on link/<name>.sock                     JSON lines on the session's stdin/stdout
   │ 3 probe ─────────────────────────────────────────────────► pong (the Mac is there now)
   │ 4 {"id","argv":["hcron","status"]} ──────────────────────► runner
   │                                                         5 allowlist again, with this Mac's config
   │                                                         6 locked screen? (GUI actions only) → "locked"
   │                                                         7 run one program with argv; no shell
   │ 8 {"status","exit","stdout","stderr"} ◄────────────────── 
   ▼
 prints the output, exits with the action's code; both sides log one line
```

## Step by step
1. The client checks the request against the allowlist in `actions.mjs`. A refused request is logged
   and never sent or queued (exit 77).
2. It lists the sockets in `$MACNODE_DIR/link/`, newest first. Each socket belongs to one bridge, that
   is, one SSH session from the Mac. A socket that refuses the connection is stale, and the client
   deletes it. On each connection the bridge sends the Mac a probe and greets the client only when the
   Mac answers within 3 seconds. If no socket greets within 8 seconds, the result is mac-offline (exit 75).
3. When offline, a non-GUI request goes to `queue/<id>.json` with an expiry time (`--ttl`, default 60
   minutes, at most 24 hours). A background `mac-node drain --wait` then polls for the link every 3
   seconds and runs the queue in order. The result lands in `results/<id>.json`, and
   `mac-node result <id>` prints it. `--no-queue` skips the queue.
4. A GUI action (`hands call`, `hands batch`, `portal-pass`) is never queued. While offline it returns
   `mac-offline (not queued: GUI action)` at once. Run later, it would click or type into whatever the
   screen shows then.
5. The Mac runner parses the request again with its own `harness.env`. This check is the one that
   decides. Config turns actions on (`MACNODE_JOBHUNT_SUBS`, `MACNODE_GH_CODE`,
   `MACNODE_PORTAL_PASS`, `MACNODE_REPOS`) and gives every program path.
6. A GUI action first asks Hammerspoon whether the screen is locked (`hsx status`, then `ioreg`). A
   locked screen returns `locked` (exit 76) once. The request is not queued, and nothing retries in a loop.
7. A hands request arms the port owner (`MACNODE_HS_OWNER`, default `mac-node`) for that request only:
   `hsx arm --new` makes a fresh secret, kept in memory. `awake run` holds awake mode while
   `hsx session` signs the calls, and `hsx disarm` ends the arm. One hands request runs at a time.
8. The output goes back to the VM, capped at 1 MB per stream. If the link drops before the answer,
   the client reports `mac-link-lost` (exit 74). It does not retry, because the action may have run.

## Terms
- **Link**: one SSH session from the Mac to the VM, with no forwarding. The VM's sshd runs the forced
  command of the Mac's key, `mac-node bridge`, on it. The Mac and the bridge exchange JSON lines over
  the session's stdin and stdout.
- **Bridge**: `mac-node bridge` on the VM. It listens on a new `link/<name>.sock` per session for the
  VM's own clients and relays their requests to the Mac. It exits, and removes its socket, when the
  session ends or the Mac sends nothing for 10 seconds (the Mac sends a beat every 3 seconds).
- **Runner**: the Mac's request handler inside `mac-node serve`.
- **Probe and hello**: the bridge probes the Mac for each client connection, then sends the client a
  hello line. The hello proves that a live Mac is at the far end now.
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
- **A dedicated key, restricted on the VM:** `restrict,command="<node> ~/.local/bin/mac-node bridge"`.
  `restrict` turns off every kind of forwarding (TCP ports and Unix sockets, local and remote), the
  agent, X11, the PTY and `~/.ssh/rc`, and nothing turns any of it back on. `command=` makes sshd run
  the bridge whatever command the Mac sends, so the key cannot start a shell or another program.
  `install.sh --key-line` on the VM writes this line with absolute paths, because sshd runs the forced
  command with a bare environment.
- **What a stolen key can do**: it can only start a bridge. Its holder could then pose as the Mac: get
  the requests the VM sends while that bridge is the newest, and send back false results. It cannot run
  anything on the VM or reach the Mac. Remove the key's line from `~/.ssh/authorized_keys` to cut it off.
- **`ssh -F none`**: only this key and these options, whatever `~/.ssh/config` says.
- **Private sockets and state**: the bridge makes its socket with mode 600, and `$MACNODE_DIR` is mode
  700 on both sides. Anyone who can act as the VM user can send requests: this is the trust boundary.
  The allowlist limits what such a request can do.
- **Logs** (`$MACNODE_DIR/requests.log`, JSON lines, rotated at 5 MB): time, id, an action summary,
  outcome, exit code and duration. Never the output, the hands arguments (they can hold typed text)
  or a secret. Results of queued requests (`results/`, mode 600) do hold the output, because the
  caller needs it. `link.log` on each side records when the link comes up and goes down.

## Edge cases
- A request that ran when the link dropped is not repeated. Check its effect before you send it again.
- The VM queue keeps working without the Mac. Requests expire after their ttl with `"status": "expired"`.
- `--unchecked` skips the VM check so you can see the Mac refuse something. It is never queued.
- A Mac that goes silent without closing the session (sleep, lost network) shows as offline at once:
  its bridge gets no answer to the probe. The bridge exits 10 seconds after the last beat.
- hcron runs the service under `caffeinate -i`, so the Mac does not idle-sleep while it serves.

## Files
- `mac-node.mjs`: the CLI (both sides). `actions.mjs`: the allowlist. `install.sh`: both roles.
- Tests: `node --test modules/macnode/*.test.mjs`. They use a fake ssh (`test/fake-ssh.mjs`, which
  runs the bridge on its own stdin and stdout, as sshd would) and stub `hsx`, `awake`, `hcron` and
  `jobhunt` in a throwaway folder. They never run real ssh, Hammerspoon or Chrome.
