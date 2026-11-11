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
--   ax(spec), fixture(name) fake AX elements from a table or a JSON file in test/ (AX[id] names them;
--                           AXAPPS[pid] is the app element hs.axuielement returns; CLOCK the ms clock)
--   image(w, h, fn)         a synthetic hs.image; WINDOWS[pid] = { frame, img } the app's front window
--   eyes(over)              an eyes.lua instance over fake deps (TARGETS, CAPS, WIMG, AXOK, FRONTAPP)
--   POSTED                  every event the fake hs.eventtap posted: {type, x, y, key, flags, chars,
--                           tag (its eventSourceUserData), dx, dy, clicks}
--   TAPS                    every event tap made: {types, fn, on}; human(kind, x, y, dx, dy, tag)
--                           sends one event to each running tap (tag nil = a person)
--   PB                      the fake clipboard {data, change}; MOUSE the cursor {x, y}
--   WINS[pid]               the visible window frames hands see ({ {x, y, w, h} }, default a big one)
--   ACTIVATED               pids that hs.application...:activate() was called for
--   CAF                     hs.caffeinate.set calls ("displayIdle=true")
--   run(ms)                 advances CLOCK in 4 ms steps, firing each running 4 ms timer
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
    json = json, idleBuffer = 20, stopMinutes = 30, consentMinutes = 10, detectors = {},
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

-- ---- fake AX trees, windows and images (the eyes) ---------------------------------------------------
-- ax(spec) builds fake hs.axuielement objects from a table (a decoded JSON fixture): each node has
-- "role" (AXRole), "rect" [x, y, w, h] (AXPosition and AXSize), "children", any other AX attribute
-- by name, "_id" (a name for {"$ref": "<id>"} values elsewhere in the tree) and "_cost" (ms that
-- reading its AXRole takes on CLOCK). Returns the root element; AX[id] is each named element.
-- Reading any attribute of an element with dead = true fails, as a stale AX element does.
CLOCK = 0                                -- hs.timer.absoluteTime() in ms
AX, AXAPPS, AXSET = {}, {}, {}           -- named elements; pid -> app element; attributes set
function ax(spec)
  AX = {}
  local function make(node, parent)
    local el = { node = node, parent = parent }
    function el:attributeValue(name)
      if self.dead then error("invalid element") end
      local n = self.node
      if name == "AXRole" then CLOCK = CLOCK + (n._cost or 0); return n.role end
      if name == "AXChildren" then return self.kids end
      if name == "AXParent" then return self.parent end
      if name == "AXPosition" then return n.rect and { x = n.rect[1], y = n.rect[2] } or nil end
      if name == "AXSize" then return n.rect and { w = n.rect[3], h = n.rect[4] } or nil end
      local v = n[name]
      if type(v) == "table" and v["$ref"] then return AX[v["$ref"]] end
      if type(v) == "table" and v["$refs"] then
        local out = {}
        for i, id in ipairs(v["$refs"]) do out[i] = AX[id] end
        return out
      end
      return v
    end
    function el:setAttributeValue(name, v) AXSET[#AXSET + 1] = name .. "=" .. tostring(v); return self end
    function el:setTimeout() return self end
    function el:isValid() return not self.dead end
    el.kids = {}
    for i, c in ipairs(node.children or {}) do el.kids[i] = make(c, el) end
    if node._id then AX[node._id] = el end
    return el
  end
  return make(spec, nil)
end
function fixture(name)
  local f = assert(io.open(here .. "/" .. name))
  local text = f:read("a")
  f:close()
  return json.decode(text)
end
-- image(w, h, fn): a synthetic hs.image of w x h pixels; fn(px, py) -> r, g, b (0-1).
function image(w, h, fn)
  local img = { w = w, h = h }
  function img:size() return { w = self.w, h = self.h } end
  function img:colorAt(p)
    local r, g, b = fn(p.x, p.y)
    return { red = r, green = g, blue = b, alpha = 1 }
  end
  function img:saveToFile(path)
    local out = io.open(path, "w")
    if not out then return false end
    out:write("PNG ", self.w, "x", self.h); out:close()
    return true
  end
  function img:setSize(sz) return image(sz.w, sz.h, fn) end
  return img
end
-- WINDOWS[pid] = { frame = {x, y, w, h}, img = image(...) or nil }: the app's front window.
WINDOWS, SNAPS = {}, 0
local function fakeWindow(w)
  local win = {}
  function win:frame() return { x = w.frame[1], y = w.frame[2], w = w.frame[3], h = w.frame[4] } end
  function win:isStandard() return true end
  function win:isVisible() return true end
  function win:snapshot() SNAPS = SNAPS + 1; return w.img end
  return win
end
-- eyes(): an eyes.lua instance over fake deps, for unit tests. TARGETS[name] is what resolve
-- returns; CAPS[owner] the owner's capabilities (a set); WIMG[pid] what windowImage returns.
TARGETS, CAPS, WIMG, AXOK, FRONTAPP, TLIST = {}, {}, {}, true, nil, {}
IMGREADS = 0
function eyes(over)
  local deps = {
    axTrusted = function() return AXOK end,
    appElement = function(pid) return AXAPPS[pid] end,
    resolve = function(name) return TARGETS[name] or { ok = false, reason = "target_not_running", name = name } end,
    targetsList = function() return { targets = TLIST } end,
    front = function() return FRONTAPP end,
    nowMs = function() return CLOCK end,
    sleepMs = function(ms) CLOCK = CLOCK + ms end,
    hasCap = function(owner, cap) return (CAPS[owner] or {})[cap] == true end,
    windowImage = function(pid)
      IMGREADS = IMGREADS + 1
      if WIMG[pid] then return WIMG[pid] end
      return nil, "no_screen_recording"
    end,
    windowShot = function(pid, maxPx) return { path = "/shots/x.png", bounds = { 0, 0, 10, 10 }, max_px = maxPx, pid = pid } end,
  }
  for k, v in pairs(over or {}) do deps[k] = v end
  return dofile(SPOON .. "/eyes.lua")(deps)
end

-- ---- the fake hs ---------------------------------------------------------------------------------
R = { ports = {}, closed = {}, hotkeys = {}, menus = {}, notes = {}, touched = {}, timers = {} }
local function sh(cmd) local f = io.popen(cmd); local out = f:read("a"); f:close(); return out end
local function q(s) return "'" .. tostring(s):gsub("'", "'\\''") .. "'" end
local function app(pid, name, bundle)
  local a = { pid = function() return pid end, name = function() return name end, bundleID = function() return bundle end }
  local w = WINDOWS[pid] and fakeWindow(WINDOWS[pid])
  function a:focusedWindow() return w end
  function a:mainWindow() return w end
  function a:allWindows()
    if WINS[pid] or not w then
      local out = {}
      for _, f in ipairs(WINS[pid] or { { 0, 0, 3000, 2000 } }) do out[#out + 1] = fakeWindow({ frame = f }) end
      return out
    end
    return { w }
  end
  function a:activate() ACTIVATED[#ACTIVATED + 1] = pid; FRONT = pid; return true end
  return a
end
-- ---- fake input (the hands): nothing reaches the real screen ------------------------------------
POSTED, TAPS, ACTIVATED, CAF = {}, {}, {}, {}
PB = { data = { ["public.utf8-plain-text"] = "old clip" }, change = 1 }
MOUSE = { x = 100, y = 100 }
WINS = {}
local TYPES = { mouseMoved = 5, leftMouseDown = 1, leftMouseUp = 2, rightMouseDown = 3, rightMouseUp = 4,
  leftMouseDragged = 6, rightMouseDragged = 7, keyDown = 10, keyUp = 11, flagsChanged = 12, scrollWheel = 22,
  otherMouseDown = 25, otherMouseUp = 26, otherMouseDragged = 27 }
local TYPENAME = {}
for k, v in pairs(TYPES) do TYPENAME[v] = k end
local PROPS = { eventSourceUserData = 42, mouseEventDeltaX = 4, mouseEventDeltaY = 5, mouseEventClickState = 1 }
local function newEvent(rec)
  local ev = { rec = rec, props = {} }
  function ev:setProperty(k, v) self.props[k] = v; return self end
  function ev:getProperty(k) return self.props[k] or 0 end
  function ev:setUnicodeString(s) self.rec.chars = s; return self end
  function ev:setFlags(f) local t = {}; for k in pairs(f) do t[#t + 1] = k end; table.sort(t); self.rec.flags = table.concat(t, "+"); return self end
  function ev:getType() return TYPES[self.rec.type] end
  function ev:location() return { x = self.rec.x or MOUSE.x, y = self.rec.y or MOUSE.y } end
  function ev:post()
    local r = self.rec
    r.tag = self.props[PROPS.eventSourceUserData]
    r.dx, r.dy = r.dx or self.props[PROPS.mouseEventDeltaX], r.dy or self.props[PROPS.mouseEventDeltaY]
    r.clicks = self.props[PROPS.mouseEventClickState]
    if r.x then MOUSE = { x = r.x, y = r.y } end
    POSTED[#POSTED + 1] = r
    -- A posted event also reaches every running tap, as on a real Mac.
    for _, t in ipairs(TAPS) do if t.on then t.fn(self) end end
  end
  return ev
end
local fakeEvent = {
  types = TYPES, properties = PROPS,
  newMouseEvent = function(t, p) return newEvent({ type = TYPENAME[t], x = p.x, y = p.y }) end,
  newKeyEvent = function(_, key, down)
    local isMod = key == 55 or key == 56 or key == 58 or key == 59
    return newEvent({ type = isMod and "flagsChanged" or (down and "keyDown" or "keyUp"), key = key, down = down })
  end,
  newScrollEvent = function(o) return newEvent({ type = "scrollWheel", dx = o[1], dy = o[2] }) end,
}
-- human(kind, x, y, dx, dy, tag): one event from someone else (a person when tag is nil).
function human(kind, x, y, dx, dy, tag)
  local ev = newEvent({ type = kind or "mouseMoved", x = x or MOUSE.x + 6, y = y or MOUSE.y + 4 })
  ev.props[PROPS.mouseEventDeltaX], ev.props[PROPS.mouseEventDeltaY] = dx or 6, dy or 4
  if tag then ev.props[PROPS.eventSourceUserData] = tag end
  local passed = {}
  for _, t in ipairs(TAPS) do if t.on then passed[#passed + 1] = t.fn(ev) end end
  return passed
end
function run(ms)
  for _ = 1, math.ceil(ms / 4) do
    CLOCK = CLOCK + 4
    for _, t in ipairs(R.timers) do if t.on and t.secs == 0.004 then t.fn() end end
  end
end

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
    absoluteTime = function() return CLOCK * 1e6 end,
    new = function(secs, fn)
      local t = { secs = secs, fn = fn, on = false }
      function t:start() self.on = true; return self end
      function t:stop() self.on = false end
      R.timers[#R.timers + 1] = t
      return t
    end,
    usleep = function(us) CLOCK = CLOCK + us / 1000 end,
  },
  axuielement = { applicationElementForPID = function(pid) return AXAPPS[pid] end },
  caffeinate = {
    sessionProperties = function() return SESSION end,
    set = function(k, v) CAF[#CAF + 1] = k .. "=" .. tostring(v) end,
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
    frontmostApplication = function() return FRONT and app(FRONT, "front", FRONTBUNDLE) or nil end,
    applicationForPID = function(pid) return app(pid, "app") end,
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
  eventtap = {
    event = fakeEvent,
    new = function(types, fn)
      local t = { types = types, fn = fn, on = false }
      function t:start() self.on = true; return self end
      function t:stop() self.on = false end
      function t:isEnabled() return self.on end
      TAPS[#TAPS + 1] = t
      return t
    end,
  },
  pasteboard = {
    readAllData = function() local c = {}; for k, v in pairs(PB.data) do c[k] = v end; return c end,
    writeAllData = function(d) PB.data = d; PB.change = PB.change + 1; return true end,
    setContents = function(s) PB.data = { ["public.utf8-plain-text"] = s }; PB.change = PB.change + 1; return true end,
    clearContents = function() PB.data = {}; PB.change = PB.change + 1 end,
    changeCount = function() return PB.change end,
  },
  mouse = { absolutePosition = function() return { x = MOUSE.x, y = MOUSE.y } end },
  keycodes = { map = dofile(SPOON .. "/planner.lua").US_MAP, currentLayout = function() return "U.S." end },
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
