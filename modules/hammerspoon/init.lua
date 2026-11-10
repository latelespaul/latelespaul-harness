-- Harness Hammerspoon config (linked to ~/.hammerspoon/init.lua by modules/hammerspoon/install.sh).
-- Hammerspoon is the ONE signed app that holds Accessibility and Screen Recording, so agent tools
-- that need to read the screen or drive the mouse and keyboard run inside it, and macOS asks for
-- those permissions only once. Tools call in through the `hs` CLI:  hs -c 'return harness.status()'
-- or through the narrow, authenticated "harness" port (`hsx`, see below); anything that posts input
-- must use the port. Per-machine or per-project code goes in ~/.hammerspoon/local/*.lua (loaded
-- last, not in this repo).

-- This file is a symlink into the harness; its real folder holds port.lua, and two levels up is
-- the harness with harness.env.
local moduleDir = (hs.fs.pathToAbsolute(hs.configdir .. "/init.lua") or ""):match("^(.*)/") or hs.configdir
local harnessDir = moduleDir:match("^(.*)/modules/hammerspoon$")
-- harness.env values (with the harness defaults), read the way every harness script reads them.
local env = {}
if harnessDir then
  local out = hs.execute(string.format([[/bin/zsh -c 'source "$1/lib/env.sh"; print -r -- "$HS_IPC_GENERIC"; print -r -- "$HS_ACCESS_FILE"' hs %q]], harnessDir))
  env.HS_IPC_GENERIC, env.HS_ACCESS_FILE = (out or ""):match("^([^\n]*)\n([^\n]*)")
end

require("hs.ipc")                      -- enables the `hs` command-line tool
-- puts `hs` in Homebrew's bin (/opt/homebrew on Apple Silicon, /usr/local on Intel); no-op if there
hs.ipc.cliInstall(hs.fs.attributes("/opt/homebrew/bin") and "/opt/homebrew" or "/usr/local")
-- HS_IPC_GENERIC=0 in harness.env closes the generic port behind `hs -c`, which runs ANY Lua with
-- Hammerspoon's grants. Then only the harness port answers; awake, hcron and install.sh --status
-- fall back to it by themselves.
if env.HS_IPC_GENERIC == "0" and hs.ipc.__default then
  hs.ipc.__default:delete()
  rawset(hs.ipc, "__default", nil)
  print("harness: generic hs.ipc port closed (HS_IPC_GENERIC=0); use hsx")
end
hs.autoLaunch(true)                    -- start at login
hs.menuIcon(true)
hs.console.clearConsole()

harness = {}

local function shq(s) return "'" .. tostring(s):gsub("'", "'\\''") .. "'" end
-- What this Hammerspoon loaded from the harness: the module folder, the harness.env values read
-- above, and every harness file it loads (init.lua, port.lua). install.sh --config-hash computes
-- the same fingerprint and restarts Hammerspoon only when the two differ.
harness.configHash = (hs.execute(string.format(
  [[/bin/sh -c '{ printf "%%s\n" "$1" "HS_IPC_GENERIC=$2" "HS_ACCESS_FILE=$3"; cd "$1" && /bin/cat init.lua port.lua; } | /usr/bin/shasum -a 256' hs %s %s %s]],
  shq(moduleDir), shq(env.HS_IPC_GENERIC or ""), shq(env.HS_ACCESS_FILE or ""))) or ""):match("^(%x+)")

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
    port = harness._port and harness.portInfo() or nil,
    config = harness.configHash,
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
-- It never does that to someone using the Mac: while a person is active it only blocks the idle lock
-- ("present"); after AWAY_SECS with no human input it dims and arms the lock ("away").
--   harness.awake(true,  {owner="job-hunt", minutes=600, dim=true, pid=1234})  -> JSON
--   harness.awake(false, {owner="job-hunt", lock=true})               -> JSON
-- Several owners may hold it; it ends when the last one leaves (or its pid exits), the deadline
-- passes, a person types or moves the mouse in away mode (then the screen locks at once), or the
-- screen locks some other way (lid closed, Ctrl-Cmd-Q). It cannot stop those manual locks.
-- Holds survive a Hammerspoon restart or reload: each one (owner, pid, deadline, dim) is saved in
-- HOLDS_FILE, and the next load takes back every hold from this boot whose pid still runs and
-- whose deadline has not passed (see restoreHolds below).
-- Tools that post their own mouse or key events must tag them, or the watcher takes them for a
-- person:  event:setProperty(hs.eventtap.event.properties.eventSourceUserData, harness.EVENT_TAG)
harness.EVENT_TAG = 0x484E
local BKEY = "harness.awake.brightness"
local aw = { owners = {}, timers = {}, pids = {}, untils = {}, dims = {} }
local AWAY_SECS = 300   -- no human input for this long = the person has left
-- No secret goes in it (arm secrets stay in memory, so armed owners re-arm after a restart).
local HOLDS_FILE = hs.configdir .. "/harness-awake.json"
-- Pids from an earlier boot mean nothing (the jobs died and the numbers are reused).
local BOOT = (hs.execute("/usr/sbin/sysctl -n kern.boottime") or ""):match("sec = (%d+)")

-- With opts.pid, an owner is released (and the screen locked) when that process is gone, so a
-- crashed job never leaves the Mac dimmed and unlocked until the deadline.
local function pidAlive(pid) return os.execute("/bin/kill -0 " .. math.floor(pid) .. " 2>/dev/null") == true end

local function restoreBrightness()
  local b = hs.settings.get(BKEY)
  if b then hs.brightness.set(b); hs.settings.clear(BKEY) end
end
restoreBrightness()   -- a reload or crash while dimmed must not leave the screen black

local function awakeOn() return next(aw.owners) ~= nil end

-- Write the current holds to HOLDS_FILE: mode 600, replaced atomically.
local function saveHolds()
  local holds = {}
  for o in pairs(aw.owners) do holds[o] = { pid = aw.pids[o], ["until"] = aw.untils[o], dim = aw.dims[o] } end
  local tmp = HOLDS_FILE .. ".tmp"
  local f = io.open(tmp, "w")
  if not f then print("harness: cannot save awake holds to " .. HOLDS_FILE); return end
  os.execute("/bin/chmod 600 " .. shq(tmp))   -- before any content goes in
  f:write(hs.json.encode({ boot = BOOT, holds = holds }))
  f:close()
  os.rename(tmp, HOLDS_FILE)
end

function harness.awakeInfo()
  local owners = {}
  for k in pairs(aw.owners) do table.insert(owners, k) end
  table.sort(owners)
  return { on = awakeOn(), mode = awakeOn() and aw.mode or nil, owners = owners, ["until"] = aw.untilAt, last_end = aw.lastEnd }
end

local function stopAll(reason, lock)
  if not awakeOn() and not aw.watch then return end
  aw.owners = {}
  for _, t in pairs(aw.timers) do t:stop() end
  aw.timers = {}
  aw.pids, aw.untils, aw.dims = {}, {}, {}
  saveHolds()
  if aw.pidCheck then aw.pidCheck:stop(); aw.pidCheck = nil end
  if aw.activity then aw.activity:stop(); aw.activity = nil end
  if aw.watch then aw.watch:stop(); aw.watch = nil end
  hs.caffeinate.set("displayIdle", false)
  hs.caffeinate.set("systemIdle", false)
  restoreBrightness()
  aw.untilAt = nil
  local wasAway = aw.mode == "away"
  aw.mode, aw.dim = nil, nil
  aw.lastEnd = { reason = reason, at = os.date("!%Y-%m-%dT%H:%M:%SZ") }
  print("harness: awake mode off (" .. reason .. ")")
  if lock and wasAway then hs.caffeinate.lockScreen() end   -- never lock on a person who is using it
end

local function dimNow()
  if aw.dim and hs.settings.get(BKEY) == nil then
    local b = hs.brightness.get()
    if b then hs.settings.set(BKEY, b); hs.brightness.set(0) end
  end
end

-- The person left: dim the screen and lock on the next human input.
local function goAway()
  aw.mode = "away"
  aw.armedAt = hs.timer.secondsSinceEpoch() + 3   -- ignore the keystroke that started it
  dimNow()
  print("harness: awake mode away (screen dimmed, locks on touch)")
end

local function humanWatcher()
  local T = hs.eventtap.event.types
  local P = hs.eventtap.event.properties
  return hs.eventtap.new({ T.keyDown, T.leftMouseDown, T.rightMouseDown, T.otherMouseDown,
                           T.mouseMoved, T.scrollWheel }, function(e)
    if e:getProperty(P.eventSourceUserData) == harness.EVENT_TAG then return false end
    local now = hs.timer.secondsSinceEpoch()
    if aw.mode ~= "away" then aw.lastHuman = now; return false end   -- present: let the person work
    if now < (aw.armedAt or 0) then return false end
    local moved = e:getType() == T.mouseMoved
    if moved then
      local d = math.abs(e:getProperty(P.mouseEventDeltaX)) + math.abs(e:getProperty(P.mouseEventDeltaY))
      if d < 4 then return false end   -- desk bumps and sensor jitter
    end
    hs.timer.doAfter(0, function() stopAll("person at the Mac", true) end)
    return not moved   -- a person's key, click or scroll must not reach the job's app
  end)
end

function harness.awake(on, opts)
  opts = opts or {}
  local owner = opts.owner or "default"
  if on then
    if (hs.caffeinate.sessionProperties() or {}).CGSSessionScreenIsLocked == true then
      local info = harness.awakeInfo()
      info.reason = "screen already locked"
      return hs.json.encode(info)
    end
    aw.dim = aw.dim or opts.dim ~= false
    if not awakeOn() then
      hs.caffeinate.set("displayIdle", true)   -- no display sleep, so no idle lock
      hs.caffeinate.set("systemIdle", true)
      aw.lastHuman = hs.timer.secondsSinceEpoch() - hs.host.idleTime()
      aw.mode = "present"
      -- Every 30 s: reset the idle clock (so the screen saver never starts) and check whether the
      -- person has left.
      aw.activity = hs.timer.doEvery(30, function()
        hs.caffeinate.declareUserActivity()
        if aw.mode == "present" and hs.timer.secondsSinceEpoch() - aw.lastHuman >= AWAY_SECS then goAway() end
      end)
      aw.watch = humanWatcher(); aw.watch:start()
      if hs.timer.secondsSinceEpoch() - aw.lastHuman >= AWAY_SECS then goAway() end
    elseif aw.mode == "away" then
      dimNow()   -- a later holder may want the dim the first one skipped
    end
    aw.owners[owner] = true
    if tonumber(opts.pid) then
      aw.pids[owner] = tonumber(opts.pid)
      aw.pidCheck = aw.pidCheck or hs.timer.doEvery(30, function()
        for o, pid in pairs(aw.pids) do
          if not pidAlive(pid) then harness.awake(false, { owner = o, lock = true, reason = o .. " process gone" }) end
        end
      end)
    end
    -- opts["until"] (epoch seconds) is the deadline a restored hold already had.
    local untilAt = tonumber(opts["until"]) or os.time() + (tonumber(opts.minutes) or 600) * 60
    if aw.timers[owner] then aw.timers[owner]:stop() end
    aw.timers[owner] = hs.timer.doAfter(math.max(untilAt - os.time(), 1), function()
      harness.awake(false, { owner = owner, lock = true, reason = "deadline" })
    end)
    aw.untils[owner], aw.dims[owner] = untilAt, opts.dim ~= false
    if not aw.untilAt or untilAt > aw.untilAt then aw.untilAt = untilAt end
    saveHolds()
  else
    aw.owners[owner] = nil
    aw.pids[owner], aw.untils[owner], aw.dims[owner] = nil, nil, nil
    if aw.timers[owner] then aw.timers[owner]:stop(); aw.timers[owner] = nil end
    if awakeOn() then saveHolds() else stopAll(opts.reason or ("released by " .. owner), opts.lock == true) end
  end
  return hs.json.encode(harness.awakeInfo())
end

-- A lock from outside (lid, Ctrl-Cmd-Q) ends awake mode; nothing can type into a locked screen.
aw.lockWatch = hs.caffeinate.watcher.new(function(ev)
  if ev == hs.caffeinate.watcher.screensDidLock then stopAll("screen locked", false) end
end)
aw.lockWatch:start()

-- Take back the holds saved before a restart or reload. A missing file means none; an unreadable
-- one is ignored (and replaced on the next save). Holds from an earlier boot, with a deadline
-- that passed, or whose pid has exited are dropped, and so is everything when the screen is
-- locked (awake mode refuses a locked screen).
local function restoreHolds()
  local f = io.open(HOLDS_FILE)
  if not f then return end
  local text = f:read("a")
  f:close()
  local ok, doc = pcall(hs.json.decode, text)
  if not ok or type(doc) ~= "table" or type(doc.holds) ~= "table" then
    print("harness: ignoring unreadable " .. HOLDS_FILE)
    return
  end
  local now = os.time()
  for owner, h in pairs(doc.holds) do
    local untilAt = type(h) == "table" and tonumber(h["until"]) or nil
    local pid = type(h) == "table" and tonumber(h.pid) or nil
    local why = (type(owner) ~= "string" or not owner:match("^[%w._-]+$") or not untilAt) and "unreadable"
      or doc.boot ~= BOOT and "earlier boot" or untilAt <= now and "deadline passed"
      or (pid and not pidAlive(pid)) and "process gone" or nil
    if why then
      print("harness: awake hold " .. tostring(owner) .. " not restored (" .. why .. ")")
    else
      harness.awake(true, { owner = owner, pid = pid, dim = h.dim ~= false, ["until"] = untilAt })
      print("harness: awake hold " .. owner .. (aw.owners[owner] and " restored" or " not restored (screen locked)"))
    end
  end
  saveHolds()   -- drop what was not restored
end
restoreHolds()

-- The harness port: a named CFMessagePort ("harness") that runs only registered commands, never
-- Lua, and checks an HMAC with a per-run secret on every command that posts input. Logic and wire
-- format: port.lua; client: hsx. Modules register their commands with the capability they need:
--   harness.register("myapp.click", fn, {cap="hands", app="chrome"})   -- auth=true is the default
-- the access policy file (HS_ACCESS_FILE) grants owners capabilities and apps, and the runner arms
-- with a fresh secret:  hsx arm my-runner --new | node runner.mjs
-- Same-user isolation is not a hard wall (another program running as you can still read the
-- runner's memory); a separate macOS user is. This makes spoofing hard and loud, not impossible.
local LOG = os.getenv("HOME") .. "/Library/Logs/hammerspoon-harness.log"
local function auditLog(line)
  if (hs.fs.attributes(LOG, "size") or 0) > 5 * 1024 * 1024 then os.rename(LOG, LOG .. ".1") end
  local f = io.open(LOG, "a")
  if f then f:write(line, "\n"); f:close() end
end
local function securityAlert(text)
  print("harness: " .. text)
  hs.alert.show("harness: " .. text, 8)
  -- One Telegram ping through the cron module's send-only notifier (never getUpdates).
  local notify = harnessDir and harnessDir .. "/modules/cron/tg-notify.py"
  local py
  for _, p in ipairs({ "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3" }) do
    if hs.fs.attributes(p) then py = p; break end
  end
  if py and notify and hs.fs.attributes(notify) then
    hs.task.new(py, nil, { notify, "Hammerspoon harness port: " .. text }):start()
  end
end
local portOk, portCore = pcall(function() return dofile(moduleDir .. "/port.lua") end)
if portOk then
  local core = portCore({
    hmac = hs.hash.hmacSHA256,
    json = hs.json,
    now = hs.timer.secondsSinceEpoch,
    minuteOfDay = function() local t = os.date("*t"); return t.hour * 60 + t.min end,
    pidAlive = pidAlive,
    log = auditLog,
    alert = securityAlert,
  })
  harness.register, harness.arm, harness.disarm = core.register, core.arm, core.disarm
  harness.allowArm, harness.resetOwner, harness.portInfo = core.allowArm, core.reset, core.policyInfo
  -- The access policy (HS_ACCESS_FILE): who may arm, with which capabilities and target apps.
  -- Missing = nothing may arm; invalid = every authenticated call denied, with an alert. Edits
  -- (by hand or `hsx access`) apply within a second, and a change is announced.
  local accessFile = env.HS_ACCESS_FILE ~= "" and env.HS_ACCESS_FILE or nil
  local seen
  local function loadAccess()
    local f = accessFile and io.open(accessFile)
    local text = f and f:read("a")
    if f then f:close() end
    seen = accessFile and hs.fs.attributes(accessFile, "modification") or false
    core.setPolicy(text)
  end
  harness.reloadAccess = loadAccess
  loadAccess()
  if accessFile then
    -- Backstop for a folder that did not exist yet (no watch on it): check the file every 30 s.
    harness._accessPoll = hs.timer.doEvery(30, function()
      if (hs.fs.attributes(accessFile, "modification") or false) ~= seen then loadAccess() end
    end)
    -- Watch the folder: an atomic save replaces the file, which a watch on the file itself misses.
    local dir = accessFile:match("^(.*)/")
    if dir and hs.fs.attributes(dir, "mode") == "directory" then
      harness._accessWatch = hs.pathwatcher.new(dir, function(paths)
        for _, p in ipairs(paths) do
          if p == accessFile or (hs.fs.pathToAbsolute(p) or p) == (hs.fs.pathToAbsolute(accessFile) or accessFile) then
            hs.timer.doAfter(0.3, loadAccess); return
          end
        end
      end):start()
    end
  end
  -- Read and hold only, so no secret: status and awake mode.
  local function str(v) return type(v) == "string" and v or nil end
  harness.register("status", function() return hs.json.decode(harness.status()) end, { auth = false })
  harness.register("awake.status", function() return harness.awakeInfo() end, { auth = false })
  harness.register("awake.on", function(a)
    a = a or {}
    return hs.json.decode(harness.awake(true, { owner = str(a.owner), minutes = tonumber(a.minutes), pid = tonumber(a.pid), dim = a.dim ~= false }))
  end, { auth = false })
  harness.register("awake.off", function(a)
    a = a or {}
    return hs.json.decode(harness.awake(false, { owner = str(a.owner), lock = a.lock == true, reason = str(a.reason) }))
  end, { auth = false })
  local made, port = pcall(hs.ipc.localPort, "harness", function(_, _, data)
    local ok, out = pcall(core.handle, data)
    return ok and out or '{"ok":false,"error":"internal error"}'
  end)
  if made and port then
    harness._port = port
  else
    securityAlert("could not open the harness port (is another program holding the name?)")
  end
  harness._portSweep = hs.timer.doEvery(15, core.sweep)   -- runner gone or time up -> disarm
else
  print("harness: port.lua failed to load: " .. tostring(portCore))
end

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
