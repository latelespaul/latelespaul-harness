-- Eyes & Hands config: the defaults, and the check of what the person (or a loader) passes to
-- spoon.EyesHands:start(cfg). Pure Lua 5.4: no hs.* calls. Unknown keys are errors, so a typo
-- ("idle_bufer_s") fails at start instead of silently keeping a default.
--   local C = dofile(spoonPath .. "/config.lua")
--   local cfg, err = C.merge({ idle_buffer_s = 30 }, os.getenv("HOME"))
-- Paths may start with "~/"; merge expands them with `home`.
local C = {}

local NAME = "^[%w._-]+$"
local GLOBAL = "^[%a_][%w_]*$"

-- Every key, its default, and its check (returns the cleaned value, or nil and why).
local function int(lo, hi)
  return function(v)
    if math.type(v) ~= "integer" or v < lo or v > hi then return nil, string.format("must be a whole number %d-%d", lo, hi) end
    return v
  end
end
local function bool(v)
  if type(v) ~= "boolean" then return nil, "must be true or false" end
  return v
end
local function path(v, home)
  if type(v) ~= "string" or v == "" then return nil, "must be a path" end
  if v == "~" or v:sub(1, 2) == "~/" then
    if not home or home == "" then return nil, "starts with ~ but HOME is not set" end
    v = home .. v:sub(2)
  end
  if v:sub(1, 1) ~= "/" then return nil, "must be an absolute path (or start with ~/)" end
  return v
end
local function names(pattern, what)
  return function(v)
    if type(v) ~= "table" then return nil, "must be a list of " .. what end
    local out = {}
    for k, x in pairs(v) do
      if math.type(k) ~= "integer" or type(x) ~= "string" or not x:match(pattern) then return nil, "must be a list of " .. what end
      out[k] = x
    end
    return out
  end
end
local MODS = { cmd = true, alt = true, ctrl = true, shift = true, fn = true }
local function hotkey(v)
  if v == false then return false end
  if type(v) ~= "table" or type(v.key) ~= "string" or v.key == "" or type(v.mods) ~= "table" then
    return nil, 'must be false or { mods = {"ctrl","alt","cmd"}, key = "escape" }'
  end
  for k in pairs(v) do if k ~= "mods" and k ~= "key" then return nil, "unknown key " .. tostring(k) end end
  local mods = {}
  for k, m in pairs(v.mods) do
    if math.type(k) ~= "integer" or not MODS[m] then return nil, "mods are cmd, alt, ctrl, shift or fn" end
    mods[k] = m
  end
  return { mods = mods, key = v.key }
end
local function tags(v)
  if type(v) ~= "table" then return nil, "must be a list of non-zero integers" end
  local out = {}
  for k, x in pairs(v) do
    if math.type(k) ~= "integer" or math.type(x) ~= "integer" or x == 0 then return nil, "must be a list of non-zero integers" end
    out[k] = x
  end
  return out
end
local function fn(v)
  if v ~= nil and type(v) ~= "function" then return nil, "must be a function" end
  return v
end

local KEYS = {
  -- The CFMessagePort name ("eyeshands"; tests use "eyeshands-test-<random>").
  port = { "eyeshands", function(v)
    if type(v) ~= "string" or #v > 64 or not v:match(NAME) then return nil, "must be a name (letters, digits, . _ -; 64 max)" end
    return v
  end },
  -- The access policy file (port.lua schema). The harness loader passes HS_ACCESS_FILE.
  access_file = { "~/.config/eyeshands/access.json", path },
  -- The targets file (targets.lua schema).
  targets_file = { "~/.config/eyeshands/targets.json", path },
  -- The audit log: one line per call, never a secret or arguments.
  log_file = { "~/Library/Logs/eyeshands.log", path },
  -- Present rule: hands start only after this many seconds with no human input.
  idle_buffer_s = { 20, int(1, 3600) },
  -- The stop hotkey; false for none (tests).
  stop_hotkey = { { mods = { "ctrl", "alt", "cmd" }, key = "escape" }, hotkey },
  -- How long the hotkey or the menu item refuses new hands.
  stop_minutes = { 30, int(1, 1440) },
  -- How long "Let agents drive" (menu bar) lets hands start while a person is present.
  consent_minutes = { 10, int(1, 120) },
  -- The menu bar item; false for none (tests).
  menubar = { true, bool },
  -- More global tables to read as foreign drivers (<name>.hands.status() armed or busy), besides
  -- job-hunt's `jobhunt` and the harness port's armed hands owners.
  detectors = { {}, names(GLOBAL, "global names") },
  -- More event tags that count as machine input for the present rule (part 10 of the design),
  -- besides our own tag, harness.EVENT_TAG and job-hunt's tag.
  machine_tags = { {}, tags },
  -- alert(text): where security alerts go. Default: a macOS notification, the console and the log.
  alert = { nil, fn },
}

-- A fresh copy of the defaults (paths not yet expanded).
function C.defaults()
  local out = {}
  for k, spec in pairs(KEYS) do
    local d = spec[1]
    if type(d) == "table" then
      local copy = {}
      for kk, vv in pairs(d) do copy[kk] = type(vv) == "table" and table.move(vv, 1, #vv, 1, {}) or vv end
      d = copy
    end
    out[k] = d
  end
  return out
end

-- The defaults with `user` on top, every value checked. Returns cfg, or nil and why.
function C.merge(user, home)
  if user ~= nil and type(user) ~= "table" then return nil, "config must be a table" end
  user = user or {}
  for k in pairs(user) do
    if not KEYS[k] then return nil, "unknown config key " .. tostring(k) end
  end
  local out = C.defaults()
  for k, spec in pairs(KEYS) do
    local v = user[k]
    if v == nil then v = out[k] end
    if v ~= nil then
      local ok, why = spec[2](v, home)
      if ok == nil and why then return nil, k .. ": " .. why end
      out[k] = ok
    end
  end
  return out
end

return C
