--- === EyesHands ===
---
--- Eyes & Hands: lets an AI agent read the screen ("eyes") and drive the mouse and keyboard
--- ("hands") of a Mac app, through one authenticated port, while the person always wins.
--- Design: docs/eyes-hands-design.md in the harness repo. So far (part 19, PRs 5 and 6): its own
--- port, config, targets, `status`, `eh.targets`, `stop`, the guards, and the eyes (eyes.lua). The
--- hands commands come in the next PR.
---
--- Load and start it (it writes no global; hs.loadSpoon keeps it in spoon.EyesHands):
---   hs.loadSpoon("EyesHands"):start({ access_file = "~/.config/eyeshands/access.json" })
--- Config keys and defaults: config.lua. Stop it (closes the port, timers, hotkey and menu, and
--- removes its event tag from the harness) with spoon.EyesHands:stop().
---
--- What it never does: load hs.ipc (so it opens no generic `hs -c` port), write the global
--- `jobhunt` or `harness` tables, or call a function that changes another driver's state. It reads
--- job-hunt's and the harness port's state only to refuse hands while they drive (guards.lua), and
--- registers its own event tag with harness.addEventTag when the harness has it.
---
--- Port commands, over the CFMessagePort named by cfg.port (default "eyeshands"; same wire
--- format, policy file schema and client as the harness port, e.g. `hsx --port eyeshands status`):
---   status       (no secret) grants, session, present state, policy summary, hands state,
---                foreign drivers, stop state; never a secret
---   eh.targets   (no secret) each target in the targets file: name, bundle, profile, running, pid
---   stop         (no secret) stops every job and disarms every owner; stopping is always safe
---   arm, disarm  built into port.lua
---   eh.eyes.fields, .value, .text, .focused, .dialog, .tree   (signed; capability eyes and the
---                args.target in the owner's apps) AX reads of the target, see eyes.lua
---   eh.eyes.frontmost  (signed; capability eyes) the front app and the targets it matches
---   eh.eyes.pixels, .shot  (signed; capabilities eyes and shot, and the target) the target
---                window's own pixels; a shot goes to cfg.shot_dir (mode 700)
--- Eyes only read: no command here posts input or moves the cursor.
local obj = {}
obj.__index = obj

obj.name = "EyesHands"
obj.version = "0.1.0"
obj.author = "Eyes & Hands contributors"

--- EyesHands.EVENT_TAG
--- Constant
--- The tag ("EHND") that the hands write into every posted event (eventSourceUserData).
obj.EVENT_TAG = 0x45484E44

-- This file's folder, which holds the other parts. Works for hs.loadSpoon and for a dofile.
local spoonPath = (debug.getinfo(1, "S").source or ""):match("^@(.*)/[^/]*$") or "."
obj.spoonPath = spoonPath
local function part(name) return dofile(spoonPath .. "/" .. name .. ".lua") end

local function stamp(t) return os.date("!%Y-%m-%dT%H:%M:%SZ", math.floor(t or os.time())) end
local function clean(s) return (tostring(s or "-"):sub(1, 64):gsub("[^%w._:-]", "?")) end
local function harnessFn(name)
  local h = rawget(_G, "harness")
  local f = type(h) == "table" and rawget(h, name)
  return type(f) == "function" and f or nil
end
local function pidAlive(pid) return os.execute("/bin/kill -0 " .. math.floor(pid) .. " 2>/dev/null") == true end
local function readFile(path)
  local f = io.open(path)
  if not f then return nil end
  local text = f:read("a")
  f:close()
  return text
end

--- EyesHands:start([cfg]) -> self
--- Method
--- Opens the port and starts the watchers. `cfg` overrides the defaults in config.lua; a bad key
--- or value is an error. Starting a started Spoon does nothing.
function obj:start(user)
  if self._s then return self end
  local cfg, err = part("config").merge(user, os.getenv("HOME"))
  if not cfg then error("EyesHands: " .. err, 2) end
  local s = { cfg = cfg, timers = {}, display = { asleep = false, saver = false } }

  -- The audit log (port.lua writes one line per call, never a secret or arguments).
  function s.log(line)
    if (hs.fs.attributes(cfg.log_file, "size") or 0) > 5 * 1024 * 1024 then os.rename(cfg.log_file, cfg.log_file .. ".1") end
    local f = io.open(cfg.log_file, "a")
    if f then f:write(line, "\n"); f:close() end
  end
  -- Security alerts: cfg.alert (a harness loader passes its notifier), else a macOS notification.
  function s.alert(text)
    print("EyesHands: " .. text)
    if cfg.alert then
      local ok, e = pcall(cfg.alert, text)
      if not ok then print("EyesHands: alert failed: " .. tostring(e)) end
    else
      pcall(function() hs.notify.new({ title = "Eyes & Hands", informativeText = text }):send() end)
    end
  end

  -- Our event tag counts as machine input for the harness awake watcher (when it can).
  local add = harnessFn("addEventTag")
  if add then
    local ok, res = pcall(add, obj.EVENT_TAG)
    s.tagRegistered = ok and res == true
  end

  -- Session state: the lock and console come from sessionProperties, display sleep and the
  -- screen saver from a watcher.
  local W = hs.caffeinate.watcher
  s.cafWatch = W.new(function(ev)
    if ev == W.screensDidSleep then s.display.asleep = true
    elseif ev == W.screensDidWake then s.display.asleep = false
    elseif ev == W.screensaverDidStart then s.display.saver = true
    elseif ev == W.screensaverDidStop then s.display.saver = false end
  end)
  s.cafWatch:start()
  function s.session()
    local p = hs.caffeinate.sessionProperties() or {}
    return { locked = p.CGSSessionScreenIsLocked == true, on_console = p.kCGSSessionOnConsoleKey ~= false,
      display_asleep = s.display.asleep, screensaver = s.display.saver }
  end

  s.guards = part("guards")({
    now = hs.timer.secondsSinceEpoch,
    idleTime = function() return hs.host.idleTime() end,
    session = s.session,
    global = function(name) return rawget(_G, name) end,
    json = hs.json,
    idleBuffer = cfg.idle_buffer_s, stopMinutes = cfg.stop_minutes, consentMinutes = cfg.consent_minutes,
    detectors = cfg.detectors,
    ownTag = obj.EVENT_TAG,
    tagRegistered = function() return s.tagRegistered == true end,
  })

  s.targets = part("targets")({
    json = hs.json,
    readFile = readFile,
    targetsFile = cfg.targets_file,
    home = os.getenv("HOME"),
    ps = function()
      local p = io.popen("/bin/ps -axww -o pid=,command=")
      if not p then return "" end
      local out = p:read("a")
      p:close()
      return out
    end,
    apps = function(bundle)
      local out = {}
      for _, a in ipairs(hs.application.applicationsForBundleID(bundle) or {}) do out[#out + 1] = { pid = a:pid(), name = a:name() } end
      return out
    end,
    frontPid = function()
      local a = hs.application.frontmostApplication()
      return a and a:pid() or nil
    end,
  })

  -- The port: a private instance of the harness port.lua (a vendored copy; a test checks it).
  s.core = part("port")({
    hmac = hs.hash.hmacSHA256,
    json = hs.json,
    now = hs.timer.secondsSinceEpoch,
    minuteOfDay = function() local t = os.date("*t"); return t.hour * 60 + t.min end,
    pidAlive = pidAlive,
    log = s.log,
    alert = s.alert,
    -- An owner's field ids (AX elements) end with its arm.
    disarmed = function(owner) if s.eyes then s.eyes.forget(owner) end end,
  })
  self._s = s

  -- The eyes: AX reads and the target window's own pixels. Nothing here posts input.
  local function hasCap(owner, cap)
    local o = owner and s.core.policyInfo().owners[owner]
    for _, c in ipairs(o and o.capabilities or {}) do if c == cap then return true end end
    return false
  end
  -- The target's front window: focused or main when it is a visible standard window, else the
  -- first visible window larger than 100 x 100 points.
  local function targetWindow(pid)
    local app = hs.application.applicationForPID(pid)
    if not app then return nil end
    local win = app:focusedWindow() or app:mainWindow()
    if win and win:isStandard() and win:isVisible() then return win end
    for _, w in ipairs(app:allWindows() or {}) do
      local f = w:frame()
      if w:isVisible() and f.w > 100 and f.h > 100 then return w end
    end
    return nil
  end
  -- A window's own pixels (no other window shows in them), never on a locked screen.
  local function snapshot(pid)
    if s.session().locked then return nil, "locked" end
    local win = targetWindow(pid)
    if not win then return nil, "no_window" end
    local img = win:snapshot()
    if not img then return nil, "no_screen_recording" end
    return win, img
  end
  s.eyes = part("eyes")({
    axTrusted = function() return hs.accessibilityState(false) == true end,
    appElement = function(pid) return hs.axuielement.applicationElementForPID(pid) end,
    resolve = s.targets.resolve,
    targetsList = s.targets.list,
    front = function()
      local a = hs.application.frontmostApplication()
      return a and { pid = a:pid(), name = a:name(), bundle = a:bundleID() } or nil
    end,
    nowMs = function() return hs.timer.absoluteTime() / 1e6 end,
    sleepMs = function(ms) hs.timer.usleep(math.floor(ms * 1000)) end,
    hasCap = hasCap,
    windowImage = function(pid)
      local win, img = snapshot(pid)
      if not win then return nil, img end
      local f, sz = win:frame(), img:size()
      return { frame = { f.x, f.y, f.w, f.h }, w = sz.w, h = sz.h, color = function(px, py)
        local c = img:colorAt({ x = px, y = py })
        if type(c) == "table" and c.red then return c.red, c.green, c.blue end
      end }
    end,
    windowShot = function(pid, maxPx)
      local win, img = snapshot(pid)
      if not win then return nil, img end
      local sz = img:size()
      local long = math.max(sz.w, sz.h)
      if maxPx and long > maxPx then
        local k = maxPx / long
        img = img:setSize({ w = math.floor(sz.w * k), h = math.floor(sz.h * k) }, true) or img
        sz = img:size()
      end
      local dir = cfg.shot_dir
      os.execute("/bin/mkdir -p -m 700 '" .. dir:gsub("'", "'\\''") .. "' && /bin/chmod 700 '" .. dir:gsub("'", "'\\''") .. "'")
      local path = string.format("%s/shot-%d-%04x.png", dir, math.floor(hs.timer.secondsSinceEpoch() * 1000), math.random(0, 0xffff))
      if not img:saveToFile(path) then return nil, "write_failed" end
      local f = win:frame()
      return { path = path, bounds = { f.x, f.y, f.w, f.h }, size = { sz.w, sz.h }, bytes = hs.fs.attributes(path, "size") or 0 }
    end,
  })

  -- The access policy file: missing = nothing may arm; invalid = every authenticated call denied,
  -- with an alert. Edits apply within a second (folder watch) or 5 s (poll), and are announced.
  local accessFile, seen = cfg.access_file, nil
  local function loadAccess()
    seen = hs.fs.attributes(accessFile, "modification") or false
    s.core.setPolicy(readFile(accessFile))
  end
  loadAccess()
  local dir, base = accessFile:match("^(.*)/([^/]+)$")
  -- Watch the folder, not the file: an atomic save replaces the file. The folder must exist for a
  -- watch to start, so it is made (mode 700) first.
  local function watchAccess()
    if s.accessWatch or not dir then return end
    if hs.fs.attributes(dir, "mode") ~= "directory" then
      os.execute("/bin/mkdir -p -m 700 '" .. dir:gsub("'", "'\\''") .. "' 2>/dev/null")
    end
    if hs.fs.attributes(dir, "mode") ~= "directory" then return end
    s.accessWatch = hs.pathwatcher.new(dir, function(paths)
      for _, p in ipairs(paths) do
        if p:match("([^/]+)$") == base then hs.timer.doAfter(0.3, loadAccess); return end
      end
    end):start()
  end
  watchAccess()
  s.timers[#s.timers + 1] = hs.timer.doEvery(5, function()
    if (hs.fs.attributes(accessFile, "modification") or false) ~= seen then loadAccess() end
    watchAccess()
    self:_menuUpdate()
  end)
  s.timers[#s.timers + 1] = hs.timer.doEvery(15, s.core.sweep)   -- runner gone or time up -> disarm

  -- Read-only and stop-only, so no secret.
  s.core.register("status", function() return self:status() end, { auth = false })
  s.core.register("eh.targets", function() return s.targets.list() end, { auth = false })
  s.core.register("stop", function() return self:stopAgents("command", false) end, { auth = false })

  -- The eyes, signed. The port checks the capability and that args.target is in the owner's apps;
  -- pixels and shot are registered under shot and check eyes here (a command has one capability).
  local function target(a) return type(a) == "table" and a.target or nil end
  local function args(a) return type(a) == "table" and a or {} end
  for _, name in ipairs({ "fields", "value", "text", "focused", "dialog", "tree" }) do
    s.core.register("eh.eyes." .. name, function(a, caller) return s.eyes[name](args(a), caller.owner) end,
      { cap = "eyes", app = target })
  end
  s.core.register("eh.eyes.frontmost", function() return s.eyes.frontmost() end, { cap = "eyes" })
  for _, name in ipairs({ "pixels", "shot" }) do
    s.core.register("eh.eyes." .. name, function(a, caller)
      if not hasCap(caller.owner, "eyes") then
        s.log(string.format("%s deny owner=%s cmd=eh.eyes.%s reason=capability?eyes?not?granted", stamp(), clean(caller.owner), name))
        return { ok = false, reason = "capability", hint = "eh.eyes." .. name .. " needs the eyes and shot capabilities" }
      end
      return s.eyes[name](args(a))
    end, { cap = "shot", app = target })
  end

  -- hs.libipc is the message-port part of hs.ipc without the generic "Hammerspoon" port that
  -- loading hs.ipc opens; this Spoon never loads hs.ipc.
  local okLib, ipc = pcall(require, "hs.libipc")
  local made, port = false, nil
  if okLib and type(ipc) == "table" and ipc.localPort then
    made, port = pcall(ipc.localPort, cfg.port, function(_, _, data)
      local ok, out = pcall(s.core.handle, data)
      return ok and out or '{"ok":false,"error":"internal error"}'
    end)
  end
  if made and port then s.port = port
  else s.alert("could not open the " .. cfg.port .. " port (is another program holding the name?)") end

  -- The stop switch: the hotkey and the menu bar item also refuse new hands for stop_minutes.
  if cfg.stop_hotkey then
    local ok, hk = pcall(hs.hotkey.bind, cfg.stop_hotkey.mods, cfg.stop_hotkey.key, function() self:stopAgents("hotkey", true) end)
    if ok then s.hotkey = hk else s.alert("could not bind the stop hotkey: " .. tostring(hk)) end
  end
  if cfg.menubar then
    s.menu = hs.menubar.new()
    if s.menu then s.menu:setMenu(function() return self:_menuItems() end) end
  end
  self:_menuUpdate()
  s.log(stamp() .. " start port=" .. clean(cfg.port) .. " tag=" .. (s.tagRegistered and "registered" or "own"))
  return self
end

--- EyesHands:stop() -> self
--- Method
--- Unloads: disarms every owner, closes the port, stops timers and watchers, removes the hotkey
--- and the menu bar item, and removes the event tag from the harness. Not the stop switch: that is
--- EyesHands:stopAgents().
function obj:stop()
  local s = self._s
  if not s then return self end
  self._s = nil
  for name, o in pairs(s.core.policyInfo().owners) do if o.armed then s.core.disarm(name, "unloaded") end end
  if s.port then pcall(function() s.port:delete() end) end
  for _, t in ipairs(s.timers) do pcall(function() t:stop() end) end
  for _, w in ipairs({ s.accessWatch, s.cafWatch }) do pcall(function() w:stop() end) end
  if s.hotkey then pcall(function() s.hotkey:delete() end) end
  if s.menu then pcall(function() s.menu:delete() end) end
  if s.tagRegistered then
    local remove = harnessFn("removeEventTag")
    if remove then pcall(remove, obj.EVENT_TAG) end
  end
  s.log(stamp() .. " stop port=" .. clean(s.cfg.port))
  return self
end

--- EyesHands:status() -> table
--- Method
--- What the `status` command returns. Never a secret.
function obj:status()
  local s = self._s
  if not s then return { name = obj.name, version = obj.version, running = false } end
  local grants = { accessibility = hs.accessibilityState(false) == true }
  if hs.screenRecordingState then grants.screen_recording = hs.screenRecordingState(false) == true end
  return {
    name = obj.name, version = obj.version, running = true,
    port = s.cfg.port, port_open = s.port ~= nil,
    event_tag = obj.EVENT_TAG, tag_registered = s.tagRegistered == true, harness = rawget(_G, "harness") ~= nil,
    grants = grants,
    session = s.session(),
    present = s.guards.presentInfo(),
    idle_buffer_s = s.cfg.idle_buffer_s,
    access = s.core.policyInfo(),
    hands = { lease = false, busy = false },
    foreign = s.guards.foreign(),
    stop = s.guards.stopInfo(),
    targets = s.targets.fileState(),
  }
end

--- EyesHands:stopAgents(by, hold) -> table
--- Method
--- The stop switch: stops every job and disarms every owner. With `hold` (the hotkey and the menu
--- item), new hands are also refused for stop_minutes. The `stop` command passes no hold.
function obj:stopAgents(by, hold)
  local s = self._s
  if not s then return { stopped = false, error = "not started" } end
  -- (The hands PR aborts the running job here, before the disarm.)
  local disarmed = {}
  for name, o in pairs(s.core.policyInfo().owners) do
    if o.armed and s.core.disarm(name, "stop switch") then disarmed[#disarmed + 1] = name end
  end
  table.sort(disarmed)
  local untilAt = hold and s.guards.stopFor(by) or nil
  s.log(string.format("%s stop-switch by=%s hold=%s disarmed=%d", stamp(), clean(by), hold and "yes" or "no", #disarmed))
  if hold then s.alert(string.format("agents stopped (%s); no new hands for %d minutes", tostring(by), s.cfg.stop_minutes)) end
  self:_menuUpdate()
  return { stopped = true, disarmed = disarmed, ["until"] = untilAt and stamp(untilAt) or nil }
end

--- EyesHands:clearStop() -> self
--- Method
--- Ends a stop switch hold early (from the Hammerspoon console or the menu bar item).
function obj:clearStop()
  if self._s then self._s.guards.clearStop(); self:_menuUpdate() end
  return self
end

--- EyesHands:consent([minutes]) -> self
--- Method
--- The person lets agents drive now, for `minutes` (default consent_minutes), even while present.
--- Only the person can do this: the menu bar item calls it; no port command does.
function obj:consent(minutes)
  if self._s then self._s.guards.consent(minutes); self:_menuUpdate() end
  return self
end

-- The menu bar: its state (idle, eyes active, stopped) and items. Hands active comes with the
-- hands PR.
function obj:_menuState()
  local s = self._s
  if not s then return "off" end
  if s.guards.stopInfo().stopped then return "stopped" end
  for _, o in pairs(s.core.policyInfo().owners) do if o.armed then return "eyes" end end
  return "idle"
end
local TITLES = { idle = "EH", eyes = "EH eyes", hands = "EH hands", stopped = "EH stop", off = "EH" }
function obj:_menuUpdate()
  local s = self._s
  if s and s.menu then pcall(function() s.menu:setTitle(TITLES[self:_menuState()]) end) end
end
function obj:_menuItems()
  local s = self._s
  if not s then return {} end
  local state = self:_menuState()
  local items = {
    { title = "Eyes & Hands: " .. state, disabled = true },
    { title = "Stop agents", fn = function() self:stopAgents("menu", true) end },
    { title = string.format("Let agents drive for %d minutes", s.cfg.consent_minutes), fn = function() self:consent() end },
  }
  if state == "stopped" then items[#items + 1] = { title = "Allow agents again", fn = function() self:clearStop() end } end
  return items
end

return obj
