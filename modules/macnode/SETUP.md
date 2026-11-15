# macnode module: setup

A VM (the brain: the master session, firstmate) asks this Mac (the hands: Hammerspoon, Chrome, the
Keychain, job-hunt) to run named actions. The Mac dials out to the VM over SSH. The Mac opens no port,
and Remote Login stays off. How it works: [README.md](README.md).

Both machines install the same module. `MACNODE_ROLE` picks the side: empty means `mac` where launchd
exists, else `vm`. Placeholders below: `<vm-user>` and `<vm-host>` are your VM login and address.
`<vm-login>` is any ssh command that already logs you in to the VM, for example a Host alias.

## VM side (once)

1. Add `macnode` to `MODULES` in the VM's `harness.env`, then run `./install.sh` (or
   `modules/macnode/install.sh`). It links `~/.local/bin/mac-node` and makes `~/.local/state/mac-node/`
   with `link/`, `queue/` and `results/` (mode 700).
2. Note the `ssh <vm-login> '... --key-line - ...'` command it prints. Mac install step 4 runs it.
   The VM's sshd needs no change: the Mac's key uses no forwarding, so `AllowTcpForwarding` and
   `AllowStreamLocalForwarding` can stay as they are, or be off.

## Mac side: install

Run these on the Mac, in the harness folder. Each step says what output proves it worked.

1. Get the module: `scripts/upstream.sh sync` (or `git pull` once it is merged).
   **Proof:** `ls modules/macnode/mac-node.mjs` lists the file.
2. Make the dedicated key. It has no passphrase, because the service starts unattended. It never
   leaves this Mac:
   ```
   ssh-keygen -t ed25519 -N '' -C mac-node -f ~/.ssh/mac-node_ed25519
   ```
   **Proof:** `ls ~/.ssh/mac-node_ed25519.pub` lists the file.
3. Set the values. Keep your current modules and add `macnode` (`cron` is required):
   ```
   ./install.sh --env-only MODULES="$(zsh -c 'source lib/env.sh; print -r -- $MODULES') macnode"
   echo 'MACNODE_VM="<vm-user>@<vm-host>"' >> harness.env
   ```
   Optional, in `harness.env`: `MACNODE_JOBHUNT_SUBS="status"` (the bin/jobhunt subcommands the VM
   may run; only `status` by default), `MACNODE_GH_CODE` and `MACNODE_PORTAL_PASS` (absolute paths
   of those scripts; empty keeps them off), and `MACNODE_REPOS="harness=/abs/path other=/abs/path"`.
   **Proof:** `grep MACNODE_VM harness.env` shows the line.
4. Put the public key on the VM. The VM's installer writes the line, so the paths in it are the VM's.
   `<vm-harness>` is the harness folder on the VM, as VM step 2 printed it:
   ```
   ssh <vm-login> 'umask 077; mkdir -p ~/.ssh; <vm-harness>/modules/macnode/install.sh --key-line - >> ~/.ssh/authorized_keys' < ~/.ssh/mac-node_ed25519.pub
   ```
   The line is `restrict,command="<node> <home>/.local/bin/mac-node bridge" ssh-ed25519 ... mac-node`.
   `restrict` turns off every kind of forwarding, the agent, X11 and the PTY. `command=` makes sshd run
   the bridge whatever the Mac asks for, so the key cannot start a shell.
   **Proof:** `ssh <vm-login> 'grep -c "^restrict,command=\".*mac-node bridge\" " ~/.ssh/authorized_keys'` prints `1`.
5. Trust the VM's host key for the address in `MACNODE_VM`, and check the key. The service uses
   `ssh -F none`, so a Host alias in `~/.ssh/config` does not apply. Run this once:
   ```
   ssh -F none -o StrictHostKeyChecking=accept-new -i ~/.ssh/mac-node_ed25519 <vm-user>@<vm-host> 'echo SHELL-RAN' < /dev/null; echo "exit $?"
   ```
   **Proof:** it prints `{"bridge":"mac-node","v":1}` and `exit 0`, and never `SHELL-RAN`: the key
   logged in, and sshd ran the bridge instead of the command. `ssh-keygen -F <vm-host>` now prints the
   host line. Then check that forwarding is off for this key:
   ```
   ssh -F none -i ~/.ssh/mac-node_ed25519 -o ExitOnForwardFailure=yes -N -R 127.0.0.1:22999:127.0.0.1:22 <vm-user>@<vm-host>; echo "exit $?"
   ```
   **Proof:** `Error: remote port forwarding failed for listen port 22999` and `exit 255`.
6. Install: `./install.sh` (or `modules/macnode/install.sh`). It registers the hcron job `mac-node`
   (`* * * * *`, runs `mac-node serve`; hcron starts it again within a minute if it stops). There is
   no new launchd plist.
   **Proof:** `hcron list | grep mac-node` shows the job. Within a minute,
   `modules/macnode/install.sh --status` prints `serve: running (pid N)` and
   `link: last event ... link: up (bridge v1)`.
7. For `hands call` and `hands batch` only: allow the port owner `mac-node` in the access policy, with
   the apps it may drive, for example:
   `hsx access allow mac-node eyes,hands --apps chrome --any-time`.
   Without it, every hands request fails at `hsx arm`. `eyes status` needs no grant.

Note: hcron runs each job under `caffeinate -i`, so the Mac does not idle-sleep while the service
runs. A lid close or Apple menu > Sleep still sleeps it. The display still locks as usual.

## Mac test steps (brief tests 1-4)

Run each command on the VM unless the step says Mac. Exit codes: 0 or the action's own code,
74 link lost, 75 mac-offline (queued, except GUI actions), 76 locked, 77 refused.

**Test 1: the status actions answer.**
1. VM: `mac-node ping`
   **Proof:** `{"pong":true,"version":1,"screen_locked":false,"gui":true,"via":"hammerspoon"}`.
2. VM: `mac-node eyes status`
   **Proof:** the JSON from `hsx status`, with `screen_locked` and `accessibility` (the lock and
   grant state).
3. VM: `mac-node hcron status; echo "exit $?"`
   **Proof:** the Mac's `hcron status` table, then `exit 0`.
4. VM: `mac-node jobhunt status; echo "exit $?"`
   **Proof:** the job-hunt counts, then `exit 0`.
5. VM: `mac-node log -n 4`; Mac: `tail -4 ~/.local/state/mac-node/requests.log`
   **Proof:** each side has one JSON line per request with `"status":"ok"`.

**Test 2: a denied action is refused and logged.**
1. VM: `mac-node rm -rf /; echo "exit $?"`
   **Proof:** `refused: not on the allowlist: rm`, `exit 77`. The VM log has `"status":"refused","where":"vm"`.
2. VM: `mac-node --unchecked rm -rf /; echo "exit $?"` (skips the VM check, so the Mac decides)
   **Proof:** the same refusal and `exit 77`. Mac: `tail -1 ~/.local/state/mac-node/requests.log`
   shows `"side":"mac","action":"rm (refused)","status":"refused"`.
3. VM: `mac-node jobhunt apply; echo "exit $?"`
   **Proof:** `refused: jobhunt apply: not enabled on this Mac`, `exit 77` (unless you added `apply`
   to `MACNODE_JOBHUNT_SUBS`).

**Test 3: kill the link, then the queued job runs after reconnect.**
1. Mac: stop the service and keep hcron from starting it again:
   `hcron pause mac-node && pkill -f 'mac-node serve'`
   **Proof:** `modules/macnode/install.sh --status` says the service is not running. VM:
   `tail -1 ~/.local/state/mac-node/link.log` shows `down: the Mac closed the link`.
2. VM: `time mac-node hcron status; echo "exit $?"`
   **Proof:** `mac-offline: queued <id>; it runs when the Mac link returns ...`, `exit 75`, and `real`
   under 10 seconds. Note the `<id>`. `mac-node queue` lists it.
3. VM: `time mac-node hands call status; echo "exit $?"`
   **Proof:** `mac-offline (not queued: GUI action)`, `exit 75`, `real` under 10 seconds.
   `mac-node queue` still lists only the `hcron status` request.
4. Mac: `hcron resume mac-node`. Within a minute hcron starts the service and the link returns.
5. VM: `mac-node result <id>`
   **Proof:** JSON with `"status": "ok"`, `"via": "queue"` and the `hcron status` output in
   `stdout`. `mac-node queue` is empty. Before the link returns it prints `queued: waiting for the Mac link`.
   Mac: `tail -3 ~/.local/state/mac-node/requests.log` has no `hands call` line: the GUI request never ran.

**Test 4: a locked or sleeping Mac reports locked or offline once and never retries.**
1. Mac: lock the screen (Control-Command-Q). Leave the Mac on.
2. VM: `mac-node hands call status; echo "exit $?"`
   **Proof:** one line `locked: screen is locked (via hammerspoon); unlock the Mac, then ask again`,
   then `exit 76`. Nothing is queued (`mac-node queue` is empty).
3. VM, a minute later: `mac-node log -n 3`. Mac: `tail -3 ~/.local/state/mac-node/requests.log`
   **Proof:** one `"status":"locked"` line on each side for that request and no newer ones: nothing retried.
4. Sleep: Mac: Apple menu > Sleep. VM: `time mac-node hands call status; echo "exit $?"`
   **Proof:** `mac-offline (not queued: GUI action)`, `exit 75`, in under 10 seconds. `mac-node queue`
   is empty. Within 10 seconds of the sleep, VM `tail -1 ~/.local/state/mac-node/link.log` shows
   `down: no word from the Mac for 10s` (or `the Mac closed the link`).
5. VM, still asleep: `mac-node --ttl 30m hcron status; echo "exit $?"`
   **Proof:** `mac-offline: queued <id>`, `exit 75`.
6. Wake the Mac and leave it at the lock screen. Wait a minute. VM: `mac-node result <id>`
   **Proof:** `"status": "ok"`: a non-GUI request runs on a locked Mac. `mac-node log -n 5` shows no
   new hands line: the GUI request from step 4 was never queued, so nothing retried it.

## Mac alerts to a master session on the VM

1. On both machines: `touch <profile>/telegram/ALERTS_TO_MASTER`.
2. On the VM, add the heartbeat line from the top of `modules/telegram/heartbeat.sh` to the crontab
   (`crontab -e`). It pulls the Mac's alerts every minute while the master session and the link are up.
3. Test by hand on the VM: `mac-node pull-alerts`.
   **Proof:** `pulled 0 Mac alerts` (the first pull starts at the end), and the Mac now has
   `~/.local/state/mac-node/alerts-pulled`.
4. On the Mac: `python3 modules/cron/tg-notify.py "relay test"`. Then on the VM: `mac-node pull-alerts`.
   **Proof:** `pulled 1 Mac alert`, and `tail -1 <profile>/logs/master-alerts.log` on the VM ends in
   `[mac] relay test`.

## Troubleshooting
- Mac: `tail ~/.local/state/mac-node/link.log` shows each ssh start and exit with ssh's last error
  line, and `link: up (bridge v1)` when the bridge answered. `Permission denied (publickey)` means
  step 4 did not land. `Host key verification failed` means step 5. An ssh that exits at once without
  `link: up` means the key line has no forced command or a wrong path in it (run step 4 again).
  Reconnects back off from 2 seconds to 1 minute.
- VM: `tail ~/.local/state/mac-node/link.log` shows each bridge `up: <socket>` and `down: <why>`.
- Mac: `hcron logs mac-node` shows the service's own output and exits.
- VM: `mac-node status` prints `link: up (<socket>)` or `link: down`. It removes link sockets that
  refuse connections (left by a bridge that was killed).
- Uninstall on the Mac: `modules/macnode/install.sh --uninstall`, then `pkill -f 'mac-node serve'`.
  On the VM, remove the `mac-node bridge` line from `~/.ssh/authorized_keys` to cut the Mac off.
