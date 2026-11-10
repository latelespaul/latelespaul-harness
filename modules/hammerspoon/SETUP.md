# Hammerspoon module

Gives agent tools one signed, notarized app ([Hammerspoon](https://www.hammerspoon.org), MIT) to run screen-reading and mouse/keyboard work in. macOS ties Accessibility and Screen Recording to an app's code signature, so a tool you rebuild yourself needs re-granting every time; code that runs inside Hammerspoon inherits its grants, which you give once.

1. `brew install --cask hammerspoon`, then open it once.
2. Add `hammerspoon` to `MODULES` in `harness.env` and run `./install.sh` (or `modules/hammerspoon/install.sh`). This links `~/.hammerspoon/init.lua` to the harness config, installs the `hs` CLI and restarts the app.
3. System Settings → Privacy & Security → turn on **Accessibility** and **Screen Recording** for Hammerspoon (`hs -c 'return harness.request()'` opens the prompts).
4. Check: `modules/hammerspoon/install.sh --status` prints `{"accessibility":true,"screen_recording":true,...}`.

Project code (for example a job-apply driver's eyes and hands) goes in `~/.hammerspoon/local/<name>.lua`, usually a symlink into that project; the harness config loads every file there. Anything there has full screen and keyboard control, so keep it reviewed.
