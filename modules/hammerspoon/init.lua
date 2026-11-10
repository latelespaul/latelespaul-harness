-- Harness Hammerspoon config (linked to ~/.hammerspoon/init.lua by modules/hammerspoon/install.sh).
-- Hammerspoon is the ONE signed app that holds Accessibility and Screen Recording, so agent tools
-- that need to read the screen or drive the mouse and keyboard run inside it, and macOS asks for
-- those permissions only once. Tools call in through the `hs` CLI:  hs -c 'return harness.status()'
-- Per-machine or per-project code goes in ~/.hammerspoon/local/*.lua (loaded last, not in this repo).

require("hs.ipc")                      -- enables the `hs` command-line tool
-- puts `hs` in Homebrew's bin (/opt/homebrew on Apple Silicon, /usr/local on Intel); no-op if there
hs.ipc.cliInstall(hs.fs.attributes("/opt/homebrew/bin") and "/opt/homebrew" or "/usr/local")
hs.autoLaunch(true)                    -- start at login
hs.menuIcon(true)
hs.console.clearConsole()

harness = {}

-- One JSON line describing what this Mac can do right now. Tools check it before a GUI step.
function harness.status()
  local s = hs.caffeinate.sessionProperties() or {}
  return hs.json.encode({
    version = hs.processInfo.version,
    accessibility = hs.accessibilityState(false),
    screen_recording = hs.screenRecordingState(false),
    screen_locked = s.CGSSessionScreenIsLocked == true,
    on_console = s.kCGSSessionOnConsoleKey ~= false,
    frontmost = (hs.application.frontmostApplication() or {}).name and hs.application.frontmostApplication():name() or nil,
  })
end

-- Ask macOS to show the permission prompts (System Settings opens if they are off).
function harness.request()
  hs.accessibilityState(true)
  if hs.screenRecordingState then hs.screenRecordingState(true) end
  return harness.status()
end

-- Load local extensions (e.g. job-hunt's eyes/hands) from ~/.hammerspoon/local/.
local localDir = hs.configdir .. "/local"
local iter = hs.fs.dir(localDir)
if iter then
  local files = {}
  for f in iter do if f:match("%.lua$") then table.insert(files, f) end end
  table.sort(files)
  for _, f in ipairs(files) do
    local ok, err = pcall(dofile, localDir .. "/" .. f)
    if not ok then print("harness: failed to load " .. f .. ": " .. tostring(err)) end
  end
end

hs.alert.show("Harness Hammerspoon ready")
