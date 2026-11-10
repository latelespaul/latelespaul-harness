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
    awake = harness.awakeInfo and harness.awakeInfo() or nil,
  })
end

-- Ask macOS to show the permission prompts (System Settings opens if they are off).
function harness.request()
  hs.accessibilityState(true)
  if hs.screenRecordingState then hs.screenRecordingState(true) end
  return harness.status()
end

-- Awake mode: keep the screen from idle-locking during an unattended GUI run (for example a night
-- job that drives Chrome). macOS drops all input to a locked screen and no tool can get past it,
-- so instead the screen is kept awake, dimmed to black, and locked the moment a person touches it.
--   harness.awake(true,  {owner="job-hunt", minutes=600, dim=true})  -> JSON
--   harness.awake(false, {owner="job-hunt", lock=true})               -> JSON
-- Several owners may hold it; it ends when the last one leaves, the deadline passes, a person
-- types or moves the mouse (then the screen locks at once), or the screen locks some other way
-- (lid closed, Ctrl-Cmd-Q). It cannot stop those manual locks.
-- Tools that post their own mouse or key events must tag them, or the watcher takes them for a
-- person:  event:setProperty(hs.eventtap.event.properties.eventSourceUserData, harness.EVENT_TAG)
harness.EVENT_TAG = 0x484E
local BKEY = "harness.awake.brightness"
local aw = { owners = {}, timers = {} }

local function restoreBrightness()
  local b = hs.settings.get(BKEY)
  if b then hs.brightness.set(b); hs.settings.clear(BKEY) end
end
restoreBrightness()   -- a reload or crash while dimmed must not leave the screen black

local function awakeOn() return next(aw.owners) ~= nil end

function harness.awakeInfo()
  local owners = {}
  for k in pairs(aw.owners) do table.insert(owners, k) end
  table.sort(owners)
  return { on = awakeOn(), owners = owners, ["until"] = aw.untilAt, last_end = aw.lastEnd }
end

local function stopAll(reason, lock)
  if not awakeOn() and not aw.watch then return end
  aw.owners = {}
  for _, t in pairs(aw.timers) do t:stop() end
  aw.timers = {}
  if aw.watch then aw.watch:stop(); aw.watch = nil end
  hs.caffeinate.set("displayIdle", false)
  hs.caffeinate.set("systemIdle", false)
  restoreBrightness()
  aw.untilAt = nil
  aw.lastEnd = { reason = reason, at = os.date("!%Y-%m-%dT%H:%M:%SZ") }
  print("harness: awake mode off (" .. reason .. ")")
  if lock then hs.caffeinate.lockScreen() end
end

local function humanWatcher()
  local T = hs.eventtap.event.types
  local P = hs.eventtap.event.properties
  local armedAt = hs.timer.secondsSinceEpoch() + 3   -- ignore the keystroke that started it
  return hs.eventtap.new({ T.keyDown, T.leftMouseDown, T.rightMouseDown, T.otherMouseDown,
                           T.mouseMoved, T.scrollWheel }, function(e)
    if hs.timer.secondsSinceEpoch() < armedAt then return false end
    if e:getProperty(P.eventSourceUserData) == harness.EVENT_TAG then return false end
    if e:getType() == T.mouseMoved then
      local d = math.abs(e:getProperty(P.mouseEventDeltaX)) + math.abs(e:getProperty(P.mouseEventDeltaY))
      if d < 4 then return false end   -- desk bumps and sensor jitter
    end
    hs.timer.doAfter(0, function() stopAll("person at the Mac", true) end)
    return false
  end)
end

function harness.awake(on, opts)
  opts = opts or {}
  local owner = opts.owner or "default"
  if on then
    if not awakeOn() then
      hs.caffeinate.set("displayIdle", true)   -- no display sleep, so no idle lock
      hs.caffeinate.set("systemIdle", true)
      -- Also reset the idle clock every minute, which keeps the screen saver from starting.
      aw.timers.activity = hs.timer.doEvery(60, function() hs.caffeinate.declareUserActivity() end)
      aw.watch = humanWatcher(); aw.watch:start()
    end
    aw.owners[owner] = true
    if opts.dim ~= false and hs.settings.get(BKEY) == nil then
      local b = hs.brightness.get()
      if b then hs.settings.set(BKEY, b); hs.brightness.set(0) end
    end
    local minutes = tonumber(opts.minutes) or 600
    if aw.timers[owner] then aw.timers[owner]:stop() end
    aw.timers[owner] = hs.timer.doAfter(minutes * 60, function()
      harness.awake(false, { owner = owner, lock = true, reason = "deadline" })
    end)
    local untilAt = os.time() + minutes * 60
    if not aw.untilAt or untilAt > aw.untilAt then aw.untilAt = untilAt end
  else
    aw.owners[owner] = nil
    if aw.timers[owner] then aw.timers[owner]:stop(); aw.timers[owner] = nil end
    if not awakeOn() then stopAll(opts.reason or ("released by " .. owner), opts.lock == true) end
  end
  return hs.json.encode(harness.awakeInfo())
end

-- A lock from outside (lid, Ctrl-Cmd-Q) ends awake mode; nothing can type into a locked screen.
aw.lockWatch = hs.caffeinate.watcher.new(function(ev)
  if ev == hs.caffeinate.watcher.screensDidLock then stopAll("screen locked", false) end
end)
aw.lockWatch:start()

-- Load local extensions (e.g. job-hunt's eyes/hands) from ~/.hammerspoon/local/.
local localDir = hs.configdir .. "/local"
-- hs.fs.dir returns an iterator AND a directory object; the loop needs both.
if hs.fs.attributes(localDir, "mode") == "directory" then
  local files = {}
  for f in hs.fs.dir(localDir) do if f:match("%.lua$") then table.insert(files, f) end end
  table.sort(files)
  for _, f in ipairs(files) do
    local ok, err = pcall(dofile, localDir .. "/" .. f)
    if not ok then print("harness: failed to load " .. f .. ": " .. tostring(err)) end
  end
end

hs.alert.show("Harness Hammerspoon ready")
