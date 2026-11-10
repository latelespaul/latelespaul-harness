# Hammerspoon module

Gives agent tools one signed, notarized app ([Hammerspoon](https://www.hammerspoon.org), MIT) to run screen-reading and mouse/keyboard work in. macOS ties Accessibility and Screen Recording to an app's code signature, so a tool you rebuild yourself needs re-granting every time; code that runs inside Hammerspoon inherits its grants, which you give once.

1. `brew install --cask hammerspoon`, then open it once.
2. Add `hammerspoon` to `MODULES` in `harness.env` and run `./install.sh` (or `modules/hammerspoon/install.sh`). This links `~/.hammerspoon/init.lua` to the harness config, links `awake` and `hsx` into `~/.local/bin`, installs the `hs` CLI and restarts the app.
3. System Settings → Privacy & Security → turn on **Accessibility** and **Screen Recording** for Hammerspoon (`hs -c 'return harness.request()'` opens the prompts).
4. Check: `modules/hammerspoon/install.sh --status` prints `{"accessibility":true,"screen_recording":true,...}`.

Project code (for example a job-apply driver's eyes and hands) goes in `~/.hammerspoon/local/<name>.lua`, usually a symlink into that project; the harness config loads every file there. Anything there has full screen and keyboard control, so keep it reviewed.

**Harness port (eyes and hands).** `hs -c` runs *any* Lua with Hammerspoon's grants, and every program that runs as you can call it. So commands that read the screen or post input go through a second, narrow port instead: a named CFMessagePort, `harness`, that runs only registered commands and never evaluates Lua (`port.lua`; tests: `node --test modules/hammerspoon/port.test.mjs`, which need `brew install lua@5.4`).

```
runner ──stdin: secret──► hsx ──CFMessagePort "harness"──► port.lua ──► registered command
           (never argv,         {cmd, owner, args, seq, mac}     checks: access file,
            never env)                                           HMAC, seq, capability, app
```

1. A module registers each command with the capability it needs: `harness.register("myapp.click", fn, {cap="hands", app="chrome"})`. `auth=true` is the default; `{auth=false}` is only for read-only or hold-only commands. `status`, `awake.status`, `awake.on` and `awake.off` are built in with `auth=false`, so `hsx status` and the `awake` CLI need no secret.
2. The access policy file says who may use which capability, on which apps, and when. It lives in your profile: `HS_ACCESS_FILE`, default `<PROFILE_DIR>/hammerspoon/access.json`. The harness ships only `access.example.json`. **Default deny:** an owner without `"enabled": true` cannot arm, and with no file nothing can. Per owner:
   - `capabilities`: what its commands may need, e.g. `["eyes", "hands"]`.
   - `apps`: the targets it may drive. Omitted = none.
   - `window`: local time when it may arm, e.g. `20:00-05:00`. Omitted = any time.
   - `manual_runs`: `true` lets you allow one arm outside the window.
   - `max_arm_minutes` (default 720) and `lock_minutes` (lock after a failed check, default 360).
   - `alert`: `telegram` also sends arm and disarm notices; `deny` (the default) sends only denials.

   Unknown keys make the file invalid. **An invalid file denies every authenticated call** and alerts you until you fix it. Hammerspoon reloads the file within a second of a save and announces each change, so a program cannot grant itself hands silently. Edit the file by hand, or with `hsx access list`, `hsx access allow <owner> eyes,hands --apps chrome --window 20:00-05:00` and `hsx access deny <owner>`. `hsx access` checks the result first, then writes it atomically with mode 600.
3. The runner arms its owner once per run with a fresh 32-byte secret and keeps it in memory: `hsx arm my-runner --new | node runner.mjs` (the secret goes only through the pipe; `--pid` defaults to the caller, so the arm ends within 15 s of it exiting). The first arm wins: a second arm is refused and alerts you. Arming is refused outside the owner's window, unless the owner has `manual_runs` and you ran `harness.allowArm("my-runner", 10)` in the Hammerspoon console.
4. Every authenticated call carries `seq` (strictly increasing) and `mac = HMAC-SHA256(secret, seq|cmd|args)`, where `args` is the JSON *text* in the message. The HMAC key is the secret's hex *text* exactly as armed (its ASCII bytes, case kept), not the 32 bytes it decodes to: in Node, `createHmac('sha256', secret)`, never `Buffer.from(secret, 'hex')`. Hammerspoon compares the MAC in constant time. `hsx call --owner O <cmd> [args]` and `hsx session O` sign for you (secret on the first stdin line); `hsx raw` relays messages the caller signed itself. Send one owner's calls through one signer, one at a time (`hsx session`, or one signer inside the runner): two signers that overlap can deliver a lower `seq` second, which counts as a replay and locks the owner.
5. A bad MAC, a replay or an unsigned call disarms the owner, locks it for `lock_minutes` (so a spoofer cannot re-arm it with its own secret; `harness.resetOwner("my-runner")` in the console clears it) and sends **one** Telegram alert through the cron module's send-only notifier (`tg-notify.py`, never getUpdates). Refused arms and denied calls alert too, at most once per owner per 10 minutes.
6. Every call is logged to `~/Library/Logs/hammerspoon-harness.log` (time, owner, command, ok or deny and why; never a secret or the arguments). `harness.status()` shows the policy state and each owner's capabilities, apps, window and arm state.

`hsx` is Python calling CoreFoundation's CFMessagePort through `ctypes`: no compile step, no Xcode, and no new binary that macOS would ask permissions for. Exit codes: 0 ok, 1 refused, 2 usage, 3 Hammerspoon not reachable.

**Live verification after install.** The node tests use a stub `hs`, so check the real app once, right after `install.sh` reloads Hammerspoon. Use a throwaway owner: `hsx access allow hs-test eyes,hands --apps test-app --any-time`, plus `hsx access allow hs-eyes eyes` and a disabled `hs-off`. In the Hammerspoon console, register a test command: `harness.register("test.hands", function(a) return a end, {cap="hands", app="test-app"})` (and one with `app="other-app"`). Then:
1. Load and port: the console shows no error, `hsx status` answers without a secret and lists the policy, and `install.sh --status` still works.
2. Unsigned: `hsx call test.hands` is refused.
3. Signed: `S=$(hsx arm hs-test --new)`, then `printf '%s\n{"cmd":"test.hands","args":{}}\n' "$S" | hsx session hs-test` succeeds (this proves `hs.hash.hmacSHA256`).
4. First arm wins: a second `hsx arm hs-test --new` is refused and a Telegram alert arrives through `tg-notify.py`.
5. Forged MAC: send an envelope with a wrong `mac` through `hsx raw`. It is denied, the owner is disarmed, a new arm is refused (locked), and a trip alert arrives even right after the step 4 alert. Run `harness.resetOwner("hs-test")` and re-arm.
6. Replay: send the same signed envelope twice through `hsx raw`. The second is denied.
7. Policy: `hsx arm` for an unknown owner and for `hs-off` is refused; `hs-eyes` calling `test.hands` is denied; the `other-app` command is denied.
8. Window: set a window that excludes now (`hsx access allow hs-test eyes,hands --apps test-app --window <closed>`). Arm is refused; add `--manual-runs`, run `harness.allowArm("hs-test", 10)`, and it succeeds.
9. Fail closed: break the JSON in the access file. Within a second an alert arrives and every signed call is denied; fix the file and calls work again (this proves the pathwatcher).
10. Audit: `~/Library/Logs/hammerspoon-harness.log` has time, owner, command and ok or deny for each step, and `grep "$S"` on it finds nothing.

Afterwards remove the test owners from the access file (`hsx access deny` only disables them) and reload Hammerspoon to drop the test commands.

**Close `hs -c` (opt-in).** While the generic port is open, any program running as you can skip the harness port and post input with plain Lua, so the checks above only stop tools that play by the rules. When every caller uses `hsx`, set `HS_IPC_GENERIC=0` in `harness.env` and reload Hammerspoon: the generic port closes, and `awake`, hcron and `install.sh --status` switch to the harness port by themselves. The `hs` CLI then stops working; set it back to `1` to debug.

**The limit, stated plainly.** Inside one macOS user this makes spoofing hard and loud, not impossible: another program running as you can still read the runner's memory, edit your files or wait and act like you (Hammerspoon announces a policy edit, but it still applies it). Only a separate macOS user for the runner is a hard wall.

**Awake mode** (for unattended GUI runs): macOS drops all mouse and keyboard input to a locked screen, so a night job that drives an app cannot work after the idle lock. `hs -c 'return harness.awake(true, {owner="my-job", minutes=600})'` keeps the display and the Mac from idle-sleeping and resets the idle clock every 30 s so the screen saver never starts. While a person is using the Mac it does nothing else (`mode: present`); after 5 minutes with no human input it dims the built-in screen to black and arms the lock (`mode: away`). If the screen is already locked it refuses (`on=false`, `reason`). In away mode the first real key press, click or mouse move locks the screen at once (the key, click or scroll does not reach the app); the deadline, `harness.awake(false, {owner="my-job", lock=true})` or any other lock (lid closed, Ctrl-Cmd-Q) ends it and restores the brightness; `lock=true` locks only in away mode, never on someone at the Mac. It cannot stop a manual lock. With `pid=` it is released (and the screen locked) within 30 s of that process exiting, so a crashed task never leaves the Mac dark and unlocked. For any command, use the `awake` CLI (linked to `~/.local/bin/awake`): `awake run <name> [--minutes N] -- <command>` holds it while the command runs and passes its exit code through; `awake on|off <name>` and `awake status` do the parts by hand. hcron jobs with `--needs gui` hold it by themselves (`--awake` forces it for other jobs). Tests: `node --test modules/hammerspoon/awake.test.mjs`. Tools that post their own events must tag them with `harness.EVENT_TAG` (`event:setProperty(hs.eventtap.event.properties.eventSourceUserData, harness.EVENT_TAG)`), or the watcher takes them for a person. Leave it for a Mac in a private place: the session is unlocked, only dark, while it runs.
