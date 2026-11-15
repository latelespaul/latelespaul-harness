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
2. Note the `MACNODE_VM_DIR=...` value it prints. The Mac needs it in step 3 below.
3. The VM's sshd must allow Unix-socket forwarding. This is the default. Check it (no output means the
   default, `yes`): `sudo sshd -T | grep -iE '^(allowstreamlocalforwarding|disableforwarding) '`.
   Optional: `ClientAliveInterval 15` in `/etc/ssh/sshd_config` lets the VM drop a dead link sooner.
   The client already skips a silent link within 3 seconds, so this is not required.

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
   cat >> harness.env <<'EOF'
   MACNODE_VM="<vm-user>@<vm-host>"
   MACNODE_VM_DIR="<the value the VM install printed>"
   EOF
   ```
   Optional, in `harness.env`: `MACNODE_JOBHUNT_SUBS="status"` (the bin/jobhunt subcommands the VM
   may run; only `status` by default), `MACNODE_GH_CODE` and `MACNODE_PORTAL_PASS` (absolute paths
   of those scripts; empty keeps them off), and `MACNODE_REPOS="harness=/abs/path other=/abs/path"`.
   **Proof:** `grep MACNODE_ harness.env` shows the two lines.
4. Put the key on the VM. The line allows only the socket forward: no shell, no TCP forward.
   ```
   modules/macnode/install.sh --key-line | ssh <vm-login> 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys'
   ```
   **Proof:** `ssh <vm-login> 'grep -c "command=\"/bin/false\".*mac-node" ~/.ssh/authorized_keys'` prints `1`.
5. Trust the VM's host key for the address in `MACNODE_VM`. The service uses `ssh -F none`, so a Host
   alias in `~/.ssh/config` does not apply. If `ssh-keygen -F <vm-host>` prints nothing, run this once:
   ```
   ssh -F none -o StrictHostKeyChecking=accept-new -i ~/.ssh/mac-node_ed25519 <vm-user>@<vm-host> true; echo "exit $?"
   ```
   **Proof:** it prints `exit 1` and no shell output: the key logged in, and `/bin/false` refused the
   command. `ssh-keygen -F <vm-host>` now prints the host line.
6. Install: `./install.sh` (or `modules/macnode/install.sh`). It registers the hcron job `mac-node`
   (`* * * * *`, runs `mac-node serve`; hcron starts it again within a minute if it stops). There is
   no new launchd plist.
   **Proof:** `hcron list | grep mac-node` shows the job. Within a minute,
   `modules/macnode/install.sh --status` prints `serve: running (pid N)`.
7. For `hands call` and `hands batch` only: allow the port owner `mac-node` in the access policy, with
   the apps it may drive, for example:
   `hsx access allow mac-node eyes,hands --apps chrome --any-time`.
   Without it, every hands request fails at `hsx arm`. `eyes status` needs no grant.

Note: hcron runs each job under `caffeinate -i`, so the Mac does not idle-sleep while the service
runs. A lid close or Apple menu > Sleep still sleeps it. The display still locks as usual.

## Mac test steps (brief tests 1-4)

Run each command on the VM unless the step says Mac. Exit codes: 0 or the action's own code,
74 link lost, 75 mac-offline (queued), 76 locked, 77 refused.

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
   **Proof:** `modules/macnode/install.sh --status` says the service is not running.
2. VM: `time mac-node hcron status; echo "exit $?"`
   **Proof:** `mac-offline: queued <id>; it runs when the Mac link returns ...`, `exit 75`, and `real`
   under 10 seconds. Note the `<id>`. `mac-node queue` lists it.
3. Mac: `hcron resume mac-node`. Within a minute hcron starts the service and the link returns.
4. VM: `mac-node result <id>`
   **Proof:** JSON with `"status": "ok"`, `"via": "queue"` and the `hcron status` output in
   `stdout`. `mac-node queue` is empty. Before the link returns it prints `queued: waiting for the Mac link`.

**Test 4: a locked or sleeping Mac reports locked once and never retries.**
1. Mac: lock the screen (Control-Command-Q). Leave the Mac on.
2. VM: `mac-node hands call status; echo "exit $?"`
   **Proof:** one line `locked: screen is locked (via hammerspoon); unlock the Mac, then ask again`,
   then `exit 76`. Nothing is queued (`mac-node queue` is empty).
3. VM, a minute later: `mac-node log -n 3`. Mac: `tail -3 ~/.local/state/mac-node/requests.log`
   **Proof:** one `"status":"locked"` line on each side for that request and no newer ones: nothing retried.
4. Sleep: Mac: Apple menu > Sleep. VM: `mac-node --ttl 30m hands call status; echo "exit $?"`
   **Proof:** `mac-offline: queued <id>`, `exit 75` (in under 10 seconds).
5. Wake the Mac and leave it at the lock screen. Wait a minute.
   VM: `mac-node result <id>`
   **Proof:** `"status": "locked"`. `mac-node queue` is empty, and the Mac log has one line for that
   id: the queued request ran once, saw the lock, and was dropped.

## Troubleshooting
- Mac: `tail ~/.local/state/mac-node/link.log` shows each ssh start and exit with ssh's last error
  line. `Permission denied (publickey)` means step 4 did not land. `Host key verification failed`
  means step 5. `remote port forwarding failed` means the VM folder is missing or wrong (VM step 1,
  `MACNODE_VM_DIR`). Reconnects back off from 2 seconds to 1 minute.
- Mac: `hcron logs mac-node` shows the service's own output and exits.
- VM: `mac-node status` prints `link: up (<socket>)` or `link: down`. It removes link sockets that
  refuse connections (left by a dropped link).
- Uninstall on the Mac: `modules/macnode/install.sh --uninstall`, then `pkill -f 'mac-node serve'`.
  On the VM, remove the `mac-node` line from `~/.ssh/authorized_keys` to cut the Mac off.
