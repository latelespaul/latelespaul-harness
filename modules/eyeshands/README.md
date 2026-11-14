# Eyes & Hands

Give an artificial intelligence (AI) agent eyes and hands on your Mac. The agent reads an app's screen and moves the mouse and types, like a person. You always win: when you touch the mouse or keyboard, the agent stops at once.

This page is for a person who does not run the rest of this repository. Inside the harness, use `SETUP.md` instead.

## Short answer

1. Install Hammerspoon, a free macOS app, and give it Accessibility and Screen Recording once.
2. Clone this repository, or open the disk image (DMG), then run `eyeshands install`. It shows each change and asks first.
3. Reload the Hammerspoon config, run `eyeshands doctor`, then allow one agent in the access file.
4. Connect the agent through MCP (Model Context Protocol) or let it run the `eyeshands` command.

Access is default deny. No agent can read or drive anything until you list it.

## Where it fits

Eyes & Hands has three parts:
- `EyesHands.spoon`, a Hammerspoon plug-in (a Spoon). It does the reading and the input.
- `eyeshands`, a command-line tool (CLI) in Python 3, with no packages to install.
- `eyeshands mcp`, an MCP server inside the same tool. Claude Code, Codex, Cursor and other agents use it.

Hammerspoon is the only app that macOS asks about. Hammerspoon's developers sign and notarize it, so macOS trusts it. Every Eyes & Hands file is plain text: Lua, Python and Markdown. Thus a `git clone` install shows no Gatekeeper prompt, and you need no Apple Developer ID (Apple's paid signing certificate).

The agent never gets a general way into Hammerspoon. It talks to the Spoon through one named message port, `eyeshands`. The port runs only the Eyes & Hands commands, and it checks a signature on every call.

## The whole flow

```
 agent (Claude Code, Codex, Cursor, a script)
   |  MCP over stdio          | or a shell command
   v                          v
 eyeshands mcp --owner O    eyeshands eyes fields --owner O ...
   |  makes a fresh secret per run, signs each call
   v
 port "eyeshands"  -- checks: owner allowed? signature? capability? app?
   v
 Hammerspoon + EyesHands.spoon
   |  guards: stop switch, you present?, screen locked?, focus
   |  eyes: read the app's controls (AX), optional screenshots
   |  hands: human-like mouse moves and typing
   v
 the app or browser window you allowed
```

## Install from the disk image

The disk image `EyesHands.dmg` holds the official Hammerspoon app (not changed), the Spoon, this page and the licences. The build makes it with `modules/eyeshands/packaging/build-dmg.sh`. The automatic build on GitHub keeps a copy with each workflow run, as an artifact.

1. Open `EyesHands.dmg`. Drag Hammerspoon to the Applications folder. If you have Hammerspoon already, skip this step.
2. Open Hammerspoon from Applications. macOS asks once whether to open an app from the Internet. Apple notarized the app, so click Open.
3. In the disk image, double-click `EyesHands.spoon`. Hammerspoon copies it to `~/.hammerspoon/Spoons/`.
4. In Terminal, run the install from the copied Spoon:
   ```sh
   python3 ~/.hammerspoon/Spoons/EyesHands.spoon/bin/eyeshands install
   ```
5. Continue at step 4 of "Install, step by step" below. Those steps reload the config, give the grants and allow an agent.

This install is the same as the install from a clone, with two differences:
- The Spoon stays where Hammerspoon put it, so the install does not link it.
- `~/.local/bin/eyeshands` is a new small script that runs the Spoon's copy of the CLI. A new file has no quarantine flag (the macOS mark on downloaded files), so it starts from Terminal with no prompt.

The disk image holds no app of its own, no installer and no `.command` script. macOS asks only about Hammerspoon. To update, open a newer disk image and double-click its `EyesHands.spoon`. Hammerspoon replaces the old Spoon.

## Install, step by step

**Before you start: requirements**
- A Mac with macOS 13 or later.
- A current Hammerspoon release in `/Applications`.
- `git` and `python3`. The Apple Command Line Tools give both: `xcode-select --install`.
- About 10 minutes, and access to System Settings to give the two grants.

**1. Install Hammerspoon**
1. Run `brew install --cask hammerspoon`, or get the official download from hammerspoon.org.
2. Open Hammerspoon once. macOS asks whether to open an app from the Internet. Click Open.
3. Optional: in the Hammerspoon preferences, turn on "Launch Hammerspoon at login".

**2. Get the code**
```sh
git clone https://github.com/<owner>/agent-harness ~/agent-harness
cd ~/agent-harness
```
Keep this folder. The install links to it, so `git pull` later updates Eyes & Hands.

**3. Run the install**
```sh
modules/eyeshands/bin/eyeshands install
```
The install prints every change and asks "Make these changes?". It makes these changes only after you answer `y`:
- It links `~/.hammerspoon/Spoons/EyesHands.spoon` to the Spoon in your clone.
- It links `~/.local/bin/eyeshands` to the CLI in your clone.
- It copies `~/.hammerspoon/init.lua` to `~/.config/eyeshands/backups/`, then adds one marked block at its end.
- It creates `~/.config/eyeshands/access.json` with no owners (default deny).
- It writes a record of these changes to `~/.config/eyeshands/install.json`.
- It runs `eyeshands doctor`.

The block that it adds to `init.lua` is this:
```lua
-- >>> eyeshands: added by `eyeshands install`; `eyeshands uninstall` removes this block
do
  local ok, err = pcall(function() hs.loadSpoon("EyesHands"):start() end)
  if not ok then print("eyeshands: the Spoon did not start: " .. tostring(err)) end
end
-- <<< eyeshands
```

Options:
- `--dry-run` prints the changes and makes none.
- `--yes` skips the question. Use it only in a script.
- `--mcp claude-code,codex,cursor` also connects those agents (step 7). `--mcp all` connects all three.

The install never reloads Hammerspoon. It never changes any other Hammerspoon file. It refuses to run when `init.lua` is a link, because another tool then owns your config. In that case, it prints the block, and you add it to that config yourself.

If `~/.local/bin` is not on your `PATH` (the list of folders that your shell searches for commands), add it:
```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```
Then open a new terminal window.

**4. Reload the Hammerspoon config**

WARNING: A reload restarts every Hammerspoon tool that you use. Do it when none of them is working.

1. Click the Hammerspoon icon in the menu bar.
2. Click Reload Config.
3. Look for the new `EH` item in the menu bar. It shows the Eyes & Hands state.

**5. Give Hammerspoon its two grants**

Hammerspoon gets every grant. Eyes & Hands adds no app that macOS asks about.

| Grant | Why Eyes & Hands needs it | Without it |
|---|---|---|
| Accessibility | To read the controls of an app (eyes), post mouse and key events (hands), and see your takeover | Nothing works |
| Screen Recording | Screenshots and pixel checks | Eyes that read controls, and hands, still work |

1. Run `eyeshands doctor --fix`. It opens System Settings > Privacy & Security > Accessibility.
2. Turn on Hammerspoon. The doctor waits up to 3 minutes for the grant.
3. For screenshots, turn on Hammerspoon in Privacy & Security > Screen Recording too.
4. After a new Screen Recording grant, quit and open Hammerspoon again.

Hammerspoon does not need Input Monitoring, Automation or Full Disk Access.

**6. Run the doctor**
```sh
eyeshands doctor
```
The doctor prints `PASS`, `WARN` or `FAIL` for each check, with the exact fix. It checks the macOS version, the Hammerspoon signature, the Spoon and its port, and the two grants. It also checks the access file, the targets file, the `PATH` and the agent connections. After you allow an owner, `eyeshands doctor --smoke --owner <name>` reads the front app as a test. It asks first.

**7. Give an agent access**

Each agent session uses its own owner name, because the first session that arms an owner wins. These examples use `claude-code`, `codex` and `cursor`.

First, allow the owner in the access file. This example lets `claude-code` read and drive TextEdit only:
```sh
eyeshands access allow claude-code eyes,hands --apps com.apple.TextEdit
eyeshands access list
```

The three capabilities:
- `eyes`: read the accessibility tree of an app (its buttons, fields, labels and values).
- `shot`: read screen pixels (screenshots). It works only together with `eyes`.
- `hands`: post mouse and keyboard input.

`--apps` lists each app that the owner may use, by bundle id (for example `com.apple.TextEdit` or `com.google.Chrome`). To find a bundle id, run `osascript -e 'id of app "TextEdit"'`. Other options are `--window 20:00-05:00` (only at these local times) and `--max-minutes 60`. Hammerspoon reads the file again within a second, so no reload is necessary.

Then connect the agent. `eyeshands install --mcp ...` can do this for you, or you can do it by hand.

Claude Code:
```sh
claude mcp add --scope user eyeshands -- ~/.local/bin/eyeshands mcp --owner claude-code
```

Codex, in `~/.codex/config.toml` (the table name must be `mcp_servers`):
```toml
[mcp_servers.eyeshands]
command = "/Users/<you>/.local/bin/eyeshands"
args = ["mcp", "--owner", "codex"]
```

Cursor, in `~/.cursor/mcp.json`:
```json
{ "mcpServers": { "eyeshands": { "command": "/Users/<you>/.local/bin/eyeshands", "args": ["mcp", "--owner", "cursor"] } } }
```

Any other MCP client: start `eyeshands mcp --owner <name>` as a local server over standard input and output (stdio). Use the full path, because an app that you open from the Dock often does not get your shell's `PATH`.

The MCP server gives 22 tools. Their names start with `eyes_` and `hands_`, for example `eyes_fields`, `hands_click` and `hands_type`. The server arms the owner at the first tool call, not at start, and disarms it when the agent closes.

**An agent without MCP** runs the CLI in a shell:
```sh
eyeshands status
eyeshands eyes fields --owner claude-code --target com.apple.TextEdit
eyeshands hands click --owner claude-code --target com.apple.TextEdit '{"to":{"field":"f3"}}'
echo '{"text":"hello"}' | eyeshands hands type --owner claude-code --target com.apple.TextEdit -
```
Each `eyes` or `hands` command arms the owner, makes one call and disarms. A script that makes many calls uses `eyeshands session --owner <name>`, which reads one JSON line per call. `-` reads the arguments from stdin, so typed text does not show in the process list.

**8. Give the agent the skill**

The skill `skills/eyes-hands/SKILL.md` teaches the safe way to work. Its loop is "look, act one step, check". It also covers when to pause, and what to hand back to you. Ignore the steps that it marks "Harness only".
- Claude Code: `mkdir -p ~/.claude/skills && ln -s ~/agent-harness/skills/eyes-hands ~/.claude/skills/eyes-hands`
- Other agents: tell the agent to read that file before it uses the tools, for example from your `AGENTS.md`.

**Optional: name your targets**

A target is an app or one browser profile. A bundle id works as a target with no setup. To give a target a short name, or to pick one Chrome profile, copy `targets.example.json` to `~/.config/eyeshands/targets.json` and edit it. A `profile` entry picks the Chrome process that runs with exactly that `--user-data-dir` folder.

## You always win: takeover, the present rule and the stop switch

**Takeover.** While the hands work, Hammerspoon watches the mouse and keyboard. Any input that Eyes & Hands did not post stops the job at once. The agent gets `interrupted`. The hands then refuse until the agent calls `hands_resume`, and that call works only after you stop for the idle buffer.

**The present rule.** The hands start only when nobody used the Mac for the idle buffer, 20 seconds by default. Otherwise the agent gets `present` and waits. Eyes work while you use the Mac. To let an agent drive while you watch, click "Let agents drive for 10 minutes" in the `EH` menu. Your next touch still stops it.

**The stop switch.** Each of these stops every job and disarms every agent:
- the hotkey ctrl+alt+cmd+escape;
- the menu item `EH` > Stop agents;
- the command `eyeshands stop`;
- `"enabled": false` for an owner in the access file (that owner only);
- quitting Hammerspoon.

The hotkey and the menu item also refuse new hands for 30 minutes. `EH` > Allow agents again ends that time early.

**Optional: the hold file.** Another tool, or you, can keep the hands and eyes off for a time with a lock file. The hold file is off by default. To turn it on, change the `pcall` line in the `init.lua` block to this:
```lua
  local ok, err = pcall(function() hs.loadSpoon("EyesHands"):start({ hold_file = "~/.config/eyeshands/driver.lock" }) end)
```
While the file holds a manual hold, or the process id (pid) of a live process, Eyes & Hands refuses with `held`. A manual hold looks like `{"pid": 0, "who": "me", "since": 1794400000000, "manual": true, "until": 1794403600000}`. The times are epoch milliseconds. A file that is not valid JSON also counts as held. With a hold file set, each hands job takes the lock itself, so two tools that share the file never drive at the same time.

**Other settings.** `start({...})` takes more keys, for example `idle_buffer_s = 30` or `stop_hotkey = false`. `EyesHands.spoon/config.lua` lists each key and its default.

## Terms

| Term | Meaning |
|---|---|
| Hammerspoon | A free, open-source macOS app that runs Lua code with the permissions that the app holds. |
| Spoon | A Hammerspoon plug-in: a folder `Name.spoon` with an `init.lua`. |
| AX | The macOS Accessibility interface. Apps publish their controls (buttons, fields) with labels, values and positions. The eyes read it. |
| MCP | Model Context Protocol: the standard way for an agent to call tools in a local server. |
| CLI | Command-line interface: here, the `eyeshands` command. |
| Owner | A name in the access file, for example `claude-code`. One agent session arms one owner at a time. |
| Arm | The start of a session for an owner: the CLI or MCP server sends a fresh secret to the port. |
| Capability | A right in the access file: `eyes`, `shot` or `hands`. |
| Target | The app or browser profile that a call reads or drives. |
| Idle buffer | The time with no input from you that the hands wait for. Default 20 seconds. |
| Takeover | You move the mouse or press a key while the hands work. The hands stop at once. |
| Bundle id | The unique name of a Mac app, for example `com.apple.TextEdit`. |
| Gatekeeper | The macOS check that runs when you open a downloaded app. |
| HMAC | Hash-based message authentication code: a signature of each call, made with the secret of the run. |
| JSON | JavaScript Object Notation: the text format of the access file. |
| PATH | The list of folders that your shell searches for commands. |

## Worked example

You want Claude Code to fill a TextEdit document.

1. Allow the owner: `eyeshands access allow claude-code eyes,hands --apps com.apple.TextEdit`.
2. Connect it: `claude mcp add --scope user eyeshands -- ~/.local/bin/eyeshands mcp --owner claude-code`.
3. Open TextEdit with a new document, then start Claude Code.
4. Ask: "Use eyes_fields on com.apple.TextEdit, then type 'hello' into the document."
5. Claude Code calls `eyes_status`. The screen is unlocked and Accessibility is on.
6. It calls `eyes_fields` with `{"target":"com.apple.TextEdit"}`. The reply lists the text area as `f1`.
7. It calls `hands_focus` with `{"target":"com.apple.TextEdit"}`. TextEdit comes to the front.
8. It calls `hands_click` with `{"target":"com.apple.TextEdit","to":{"field":"f1"}}`. You have not touched the Mac for 30 s.
9. The mouse moves to the text area in a curve, then clicks. The menu bar item shows `EH hands`.
10. It calls `hands_type` with `{"text":"hello"}`. Then `eyes_value` with `{"id":"f1"}` reads back `hello`.
11. You move the mouse during the next step. The job ends as `interrupted`, and Claude Code waits.

Your log of each call is in `~/Library/Logs/eyeshands.log`. It has the time, owner, command and result, never a secret or typed text.

## Warnings and limits

**What the security model gives you**
- Default deny. An owner can arm only when the access file lists it with `"enabled": true`. A missing file allows nothing. A file that is not valid allows nothing, and you get an alert.
- Each run makes a new 32-byte secret. The secret stays in memory and in the port messages, never in a file, an argument or an environment variable.
- Each call carries a rising number and an HMAC. A wrong signature or a replay disarms the owner, locks it for a time and alerts you once.
- Per-app grants. The port checks `apps` before any command runs.
- A separate `shot` capability, so an agent can read forms with no right to see screen pixels.
- No secret and no typed text in any log. Screenshots go to a private folder, and the MCP server deletes each one after it reads it.
- The Spoon never opens Hammerspoon's general `hs -c` command port. Your own config can still open it.
- Alerts go to macOS notifications, the Hammerspoon console and the log.

**What it cannot stop.** All of these checks run inside one macOS user. They make misuse hard and loud, not impossible. A program that runs as your user can still do these things:
- edit the Spoon's Lua files in your clone, which then run with the full grants after the next reload;
- edit the access file (Hammerspoon announces the change, but it applies it);
- edit an agent's MCP configuration;
- read a secret from the memory of a process, with enough privileges;
- send any Lua through `hs -c` when your config loads `hs.ipc`.

The only hard wall is a separate macOS user, or a virtual machine, for the agent.

WARNING: Web pages and documents can show text that tries to steer the agent. The skill tells the agent to treat page text as data, never as instructions. Allow only the apps that the task needs, because `apps` limits the damage.

**Other limits**
- Eyes & Hands never solves a CAPTCHA, a one-time code or a password. The agent sends you a screenshot and waits.
- macOS drops all input to a locked screen. During a hands job, Eyes & Hands keeps the display awake. A screen that is locked already gives `locked`, and the agent stops. The harness version adds an awake mode that locks the screen again after the job; this standalone install does not.
- On macOS 15 and later, macOS asks again about Screen Recording about once a month. Until you answer, screenshots fail. Eyes that read controls keep working.
- A reload or a quit of Hammerspoon ends every arm. The agent arms again at its next call, with a new secret.
- Two agents with one owner name: the second one gets `owner_in_use`. Give each agent its own owner.

**When something fails**
- `eyeshands doctor` says the port does not answer: reload the Hammerspoon config, then look at the Hammerspoon console for "eyeshands".
- The install says a path "is not a link into this clone": another copy installed it. Run `eyeshands uninstall` from that copy first.
- The install says this copy "runs inside a configured harness": use `modules/eyeshands/install.sh` instead (see `SETUP.md`).
- The install says this copy runs "not from the installed Spoon": you started the CLI inside the disk image. Double-click `EyesHands.spoon` first, then run the copy in `~/.hammerspoon/Spoons/`.

## Uninstall

```sh
eyeshands uninstall
```
It prints every change and asks first. Run it from the copy that made the install. Another copy refuses and names that copy. When that copy is gone (you moved or deleted it), any copy can run the uninstall. It also removes the broken links. It removes exactly what the install added:
- the two links, if they still point into this clone (after a disk image install: the `~/.local/bin/eyeshands` script);
- the marked block in `init.lua` (your own lines stay, also the lines that you added after the install);
- the agent connections that `install --mcp` added. A connection that you changed after the install stays, and uninstall tells you so;
- the folders that the install made, when they are empty.

After a disk image install, the uninstall leaves the Spoon in `~/.hammerspoon/Spoons/`, because Hammerspoon put it there. Delete that folder yourself after the reload.

It keeps the access file, the targets file and the backups. Add `--purge` to delete them too, with the log and the screenshot folder. Then reload the Hammerspoon config, so the Spoon that still runs stops.

The grants stay in System Settings, because other Hammerspoon tools may need them. To remove them, open System Settings > Privacy & Security. Then turn off Hammerspoon in Accessibility and in Screen Recording.

## Spoon only (you already use Hammerspoon)

You can use the Spoon without the install:
1. Copy the Spoon: `cp -R ~/agent-harness/modules/eyeshands/EyesHands.spoon ~/.hammerspoon/Spoons/`.
2. Add `hs.loadSpoon("EyesHands"):start()` to your `~/.hammerspoon/init.lua`.
3. Reload the config.
4. Link the CLI: `ln -s ~/agent-harness/modules/eyeshands/bin/eyeshands ~/.local/bin/eyeshands`.

The build also makes `EyesHands.spoon.zip`, next to the disk image. Unzip it and double-click `EyesHands.spoon`, so Hammerspoon installs it. That Spoon carries the CLI and `hsx` in its `bin` folder. Run the install from it, as for the disk image, or link `~/.hammerspoon/Spoons/EyesHands.spoon/bin/eyeshands` yourself.

A copy of the Spoon does not update with `git pull`. The CLI of a clone needs the clone, because it loads `hsx` from the same folder.

## Test it on a real form (optional)

`modules/eyeshands/test/live.test.mjs` fills a generic test form in a throwaway Chrome with real hands. It also checks takeover, the stop command and the hold file. It runs only when you set `EYESHANDS_LIVE=1`, and never on continuous integration (CI).

WARNING: Run it only when no other program drives the mouse and keyboard. It checks, and it skips when one does.

It needs a hold file, because every live run takes the driver lock:
```sh
EYESHANDS_LIVE=1 EYESHANDS_HOLD_FILE=~/.config/eyeshands/driver.lock node --test modules/eyeshands/test/live.test.mjs
```
`SETUP.md` ("Live fixture test") lists what it checks first, what it does and how it cleans up.

## What to do next

1. Run `eyeshands doctor` until every check passes.
2. Allow one owner for one app, and try the worked example.
3. Read `skills/eyes-hands/SKILL.md` for the rules that the agent follows.
4. Read `docs/eyes-hands-design.md` for the full design.

## Licence

TODO(licence): the maintainer has not chosen a licence yet, so this repository has no LICENSE file. Until one exists, ask the maintainer before you reuse this code. Hammerspoon itself has the MIT (Massachusetts Institute of Technology) licence. The disk image has a `Licenses` folder with both texts.
