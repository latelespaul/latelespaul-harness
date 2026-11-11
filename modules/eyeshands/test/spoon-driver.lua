-- Test driver for the Spoon skeleton (used by spoon.test.mjs). Runs EyesHands.spoon under a plain
-- Lua 5.4 with a fake `hs`; never touches Hammerspoon, the screen or the input. Reads one Lua
-- chunk per stdin line and prints its return value as one JSON line (or "ERROR <message>").
-- The chunks see:
--   T, IDLE                 the clock and hs.host.idleTime() (seconds)
--   SESSION                 what hs.caffeinate.sessionProperties() returns
--   APPS, FRONT, PS         running apps per bundle id ({pid, name} lists), the frontmost pid, the
--                           text `ps -axww -o pid=,command=` prints
--   guards(over)            a guards.lua instance over fake deps (over: fields to replace)
--   targets(text)           a targets.lua instance reading `text` as the targets file (nil = missing)
--   config(user)            config.merge(user, "/home/test")
--   boot(cfg)               loads init.lua in a sealed environment (a global write is an error) and
--                           starts it with cfg; returns the Spoon object (also SPOON)
--   call(env)               sends one envelope (a table) to the Spoon's port; returns the reply
--   signed(key, owner, cmd, args, seq)  a signed call
--   R                       what the fake hs saw: ports, closed, hotkeys, menus, notes, touched,
--                           caf (the caffeinate watcher callback), timers
--   snapshot(t)             a deep text image of a table (to show it did not change)
local here = arg[0]:match("^(.*)/") or "."
local SPOON = here .. "/../EyesHands.spoon"
local fakes = dofile(here .. "/../../hammerspoon/test/fakes.lua")
local json = fakes.json

T, IDLE = 1800000000, 600
SESSION = {}
APPS, FRONT, PS = {}, nil, ""

local function encode(v)
  local t = type(v)
  if t == "nil" then return "null"
  elseif t == "boolean" then return tostring(v)
  elseif t == "number" then
    if math.type(v) == "integer" then return string.format("%d", v) end
    local i = math.tointeger(v)
    if i then return string.format("%d", i) end
    return string.format("%.17g", v)
  elseif t == "string" then
    return '"' .. v:gsub('[%c"\\]', function(c) return string.format("\\u%04x", c:byte()) end) .. '"'
  elseif t == "table" then
    local n, keys = #v, {}
    for k in pairs(v) do keys[#keys + 1] = k end
    if #keys == n and n > 0 then
      local out = {}
      for i = 1, n do out[i] = encode(v[i]) end
      return "[" .. table.concat(out, ",") .. "]"
    end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    local out = {}
    for _, k in ipairs(keys) do out[#out + 1] = encode(tostring(k)) .. ":" .. encode(v[k]) end
    return "{" .. table.concat(out, ",") .. "}"
  elseif t == "function" then return '"<function>"'
  end
  error("cannot encode " .. t)
end

function snapshot(t, seen)
  seen = seen or {}
  if type(t) ~= "table" then return tostring(t) end
  if seen[t] then return "<cycle>" end
  seen[t] = true
  local keys = {}
  for k in pairs(t) do keys[#keys + 1] = k end
  table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
  local out = {}
  for _, k in ipairs(keys) do out[#out + 1] = tostring(k) .. "=" .. snapshot(t[k], seen) end
  return "{" .. table.concat(out, ",") .. "}"
end

function config(user) return dofile(SPOON .. "/config.lua").merge(user, "/home/test") end

function guards(over)
  local deps = {
    now = function() return T end, idleTime = function() return IDLE end,
    session = function() return SESSION end, global = function(name) return rawget(_G, name) end,
    json = json, idleBuffer = 20, stopMinutes = 30, consentMinutes = 10, detectors = {}, machineTags = {},
    ownTag = 0x45484E44, tagRegistered = function() return true end,
  }
  for k, v in pairs(over or {}) do deps[k] = v end
  return dofile(SPOON .. "/guards.lua")(deps)
end

function targets(text)
  return dofile(SPOON .. "/targets.lua")({
    json = json, readFile = function() return text end, targetsFile = "/cfg/targets.json", home = "/home/test",
    ps = function() return PS end,
    apps = function(bundle) return APPS[bundle] or {} end,
    frontPid = function() return FRONT end,
  })
end

-- ---- the fake hs ---------------------------------------------------------------------------------
R = { ports = {}, closed = {}, hotkeys = {}, menus = {}, notes = {}, touched = {}, timers = {} }
local function sh(cmd) local f = io.popen(cmd); local out = f:read("a"); f:close(); return out end
local function q(s) return "'" .. tostring(s):gsub("'", "'\\''") .. "'" end
local function app(pid, name) return { pid = function() return pid end, name = function() return name end } end
local fakeHs = {
  json = json, hash = { hmacSHA256 = fakes.hmacSHA256 },
  accessibilityState = function() return true end,
  screenRecordingState = function() return false end,
  host = { idleTime = function() return IDLE end },
  timer = {
    secondsSinceEpoch = function() return T end,
    doEvery = function(secs, fn)
      local t = { secs = secs, fn = fn, on = true }
      function t:stop() self.on = false end
      R.timers[#R.timers + 1] = t
      return t
    end,
    doAfter = function(_, fn) fn(); return { stop = function() end } end,
  },
  caffeinate = {
    sessionProperties = function() return SESSION end,
    watcher = { screensDidSleep = 1, screensDidWake = 2, screensaverDidStart = 3, screensaverDidStop = 4,
      screensDidLock = 5, screensDidUnlock = 6,
      new = function(fn) R.caf = fn; return { start = function(self) return self end, stop = function() R.cafStopped = true end } end },
  },
  application = {
    applicationsForBundleID = function(bundle)
      local out = {}
      for _, a in ipairs(APPS[bundle] or {}) do out[#out + 1] = app(a.pid, a.name) end
      return out
    end,
    frontmostApplication = function() return FRONT and app(FRONT, "front") or nil end,
  },
  hotkey = { bind = function(mods, key, fn)
    local hk = { mods = mods, key = key, fn = fn }
    function hk:delete() self.deleted = true end
    R.hotkeys[#R.hotkeys + 1] = hk
    return hk
  end },
  menubar = { new = function()
    local m = {}
    function m:setMenu(fn) self.items = fn end
    function m:setTitle(t) self.title = t end
    function m:delete() self.deleted = true end
    R.menus[#R.menus + 1] = m
    return m
  end },
  notify = { new = function(t) return { send = function() R.notes[#R.notes + 1] = t.informativeText end } end },
  pathwatcher = { new = function(dir, fn)
    R.watched, R.watch = dir, fn
    return { start = function(self) return self end, stop = function() R.watchStopped = true end }
  end },
  fs = { attributes = function(p, key)
    local kind = sh("stat -f %HT " .. q(p) .. " 2>/dev/null"):gsub("\n$", "")
    if kind == "" then return nil end
    if key == "mode" then return kind == "Directory" and "directory" or "file" end
    if key == "size" then return tonumber(sh("stat -f %z " .. q(p))) end
    if key == "modification" then return tonumber(sh("stat -f %m " .. q(p))) end
    return {}
  end },
}
-- Any other hs.* (hs.ipc above all) is recorded and fails, so a test sees it.
hs = setmetatable({}, {
  __index = function(_, k)
    if fakeHs[k] ~= nil then return fakeHs[k] end
    R.touched[#R.touched + 1] = k
    error("touched hs." .. tostring(k))
  end,
  __newindex = function(_, k) error("wrote hs." .. tostring(k)) end,
})
package.preload["hs.libipc"] = function()
  return { localPort = function(name, fn)
    if PORT_TAKEN then error("port name in use") end
    R.ports[name] = fn
    return { delete = function() R.closed[name] = true end }
  end }
end
package.preload["hs.ipc"] = function() R.ipcLoaded = true; return {} end
local realPopen = io.popen
io.popen = function(cmd, ...)
  if cmd == "/bin/ps -axww -o pid=,command=" then
    return { read = function() return PS end, close = function() return true end }
  end
  return realPopen(cmd, ...)
end
print = function(...) io.stderr:write(table.concat({ ... }, " "), "\n") end

local env = setmetatable({}, {
  __index = _G,
  __newindex = function(_, k) error("wrote global " .. tostring(k)) end,
})
function boot(cfg)
  local chunk = assert(loadfile(SPOON .. "/init.lua", "t", env))
  SPOONOBJ = chunk()
  SPOONOBJ:start(cfg)
  return SPOONOBJ
end
function call(e)
  local name = SPOONOBJ._s.cfg.port
  return json.decode(R.ports[name](nil, 0, json.encode(e)))
end
function signed(key, owner, cmd, args, seq)
  return call({ cmd = cmd, owner = owner, args = args, seq = seq, mac = fakes.hmacSHA256(key, seq .. "|" .. cmd .. "|" .. args) })
end

for line in io.lines() do
  local ok, res = pcall(function() return encode(assert(load(line))()) end)
  io.write(ok and res or ("ERROR " .. tostring(res):gsub("\n", " ")), "\n")
  io.flush()
end
