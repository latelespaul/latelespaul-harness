-- Loads the real init.lua under plain Lua with a stub `hs` (used by port.test.mjs), then drives the
-- harness port it opened.  lua init-smoke.lua <configdir>   (configdir/init.lua links to init.lua)
--   lua init-smoke.lua <configdir> awake   instead reports awake mode right after the load (holds
--   restored from configdir/harness-awake.json), runs the Lua in $SMOKE_THEN if set, and reports again.
-- Prints one JSON object with what happened. Never touches Hammerspoon or the screen.
local here = arg[0]:match("^(.*)/") or "."
local fakes = dofile(here .. "/fakes.lua")
local json = fakes.json
local function sh(cmd) local f = io.popen(cmd); local out = f:read("a"); f:close(); return out end
local function q(s) return "'" .. tostring(s):gsub("'", "'\\''") .. "'" end
local function stub()
  return setmetatable({}, { __index = function(t, k) local v = stub(); rawset(t, k, v); return v end,
    __call = function() return stub() end })
end
local R = { ports = {}, alerts = {}, tasks = {}, caffeinate = {}, done = {} }
local function timer() return { stop = function() end } end

hs = stub()
hs.configdir = arg[1]
hs.processInfo = { version = "test" }
hs.accessibilityState = function() return true end
hs.screenRecordingState = function() return true end
hs.caffeinate.sessionProperties = function() return {} end
hs.caffeinate.set = function(what, on) R.caffeinate[what] = on end
hs.caffeinate.watcher = { new = function() return { start = function() end } end, screensDidLock = 1 }
hs.application.frontmostApplication = function() return nil end
hs.settings = { get = function() return nil end, set = function() end, clear = function() end }
hs.host.idleTime = function() return 0 end
hs.json, hs.hash = json, { hmacSHA256 = fakes.hmacSHA256 }
hs.execute = sh
-- A doEvery timer keeps its callback (t.fn) so a test can tick it. doAfter runs short delays (the
-- access reload) at once and never long ones (awake deadlines).
hs.timer = { doEvery = function(_, fn) local t = timer(); t.fn = fn; return t end,
  doAfter = function(secs, fn) if secs < 5 then fn() end; return timer() end, secondsSinceEpoch = os.time }
hs.alert = { show = function(text) R.alerts[#R.alerts + 1] = text end }
-- A stub notifier: start() records the run, and its exit (NOTIFY_EXIT, default 0) is delivered
-- later, like a real hs.task, by finishTasks().
hs.task = { new = function(cmd, done, args)
  return { start = function(self)
    R.tasks[#R.tasks + 1] = { cmd, table.unpack(args) }
    R.done[#R.done + 1] = done
    return self
  end }
end }
local function finishTasks()
  for _, done in ipairs(R.done) do done(tonumber(os.getenv("NOTIFY_EXIT") or "0"), "", "") end
  R.done = {}
end
-- An event tap keeps its callback, so a test can post an event to it from SMOKE_THEN:
--   SMOKE.taps[i].fn(SMOKE.event("keyDown", tag))   (taps in the order init.lua made them)
-- hs.caffeinate.lockScreen() only records the lock in SMOKE.locked.
local T = { keyDown = 10, leftMouseDown = 1, rightMouseDown = 3, otherMouseDown = 25, mouseMoved = 5, scrollWheel = 22 }
local P = { eventSourceUserData = 42, mouseEventDeltaX = 4, mouseEventDeltaY = 5 }
R.taps = {}
hs.eventtap = { event = { types = T, properties = P }, new = function(_, fn)
  local tap = { fn = fn, on = false }
  function tap:start() self.on = true; return self end
  function tap:stop() self.on = false; return self end
  function tap:isEnabled() return self.on end
  R.taps[#R.taps + 1] = tap
  return tap
end }
SMOKE = { taps = R.taps, locked = 0 }
function SMOKE.event(kind, tag)
  return { getType = function() return T[kind] end,
    getProperty = function(_, p) if p == P.eventSourceUserData then return tag or 0 end; return 50 end }
end
hs.caffeinate.lockScreen = function() SMOKE.locked = SMOKE.locked + 1 end
hs.pathwatcher = { new = function(dir, fn) R.watched = dir; return { start = function(self) R.watch = fn; return self end } end }
hs.ipc = { cliInstall = function() end, __default = { delete = function() R.genericClosed = true end },
  localPort = function(name, fn) R.ports[name] = fn; return {} end }
hs.fs = {
  pathToAbsolute = function(p) local out = sh("realpath " .. q(p) .. " 2>/dev/null"):gsub("\n$", ""); return out ~= "" and out or nil end,
  attributes = function(p, key)
    local kind = sh("stat -f %HT " .. q(p) .. " 2>/dev/null"):gsub("\n$", "")
    if kind == "" then return nil end
    if key == "mode" then return kind == "Directory" and "directory" or "file" end
    if key == "size" then return tonumber(sh("stat -f %z " .. q(p))) end
    if key == "modification" then return tonumber(sh("stat -f %m " .. q(p))) end
    return {}
  end,
  dir = function(p) return sh("ls " .. q(p)):gmatch("[^\n]+") end,
}
print = function(...) io.stderr:write(table.concat({ ... }, " "), "\n") end
package.loaded["hs.ipc"] = hs.ipc
require = function(name) return package.loaded[name] or stub() end

dofile(hs.configdir .. "/init.lua")

if arg[2] == "awake" then
  local out = { loaded = harness.awakeInfo(), caffeinate = R.caffeinate, config = harness.configHash }
  local chunk = os.getenv("SMOKE_THEN")
  if chunk then out.result = assert(load(chunk))(); out.after = harness.awakeInfo() end
  io.write(json.encode(out), "\n")
  return
end

local port = R.ports.harness
local function call(t) return json.decode(port(nil, 0, json.encode(t))) end
local function signed(key, owner, cmd, args, seq)
  return call({ cmd = cmd, owner = owner, args = args, seq = seq, mac = fakes.hmacSHA256(key, seq .. "|" .. cmd .. "|" .. args) })
end
local key = string.rep("ab", 32)
local access = os.getenv("ACCESS_FILE")
local function write(text) local f = io.open(access, "w"); f:write(text); f:close() end
local out = { genericClosed = R.genericClosed == true, opened = port ~= nil, watched = R.watched }
if os.getenv("LATE") == "watch" or os.getenv("LATE") == "poll" then
  -- The access file (and its folder) did not exist at load: it appears afterwards.
  out.before = call({ cmd = "status" })
  out.dirMade = hs.fs.attributes(access:match("^(.*)/"), "mode") == "directory"
  write('{"owners":{"runner":{"enabled":true,"capabilities":["hands"]}}}')
  if os.getenv("LATE") == "watch" then
    R.watch({ "/private" .. access })   -- FSEvents may report the real path
  else
    harness._accessPoll.fn()   -- one tick of the backstop poll, with no watch event
  end
end
out.status = call({ cmd = "status" })
out.arm = call({ cmd = "arm", args = json.encode({ owner = "runner", secret = key }) })
out.click = signed(key, "runner", "smoke.click", '{"x":2}', 1)
-- Revoke in the file, then let the folder watcher fire: the next call must be refused.
write('{"owners":{"runner":{"enabled":false}}}')
R.watch({ access })
out.afterRevoke = signed(key, "runner", "smoke.click", '{"x":3}', 2)
finishTasks()
out.alerts, out.tasks = R.alerts, R.tasks
io.write(json.encode(out), "\n")
