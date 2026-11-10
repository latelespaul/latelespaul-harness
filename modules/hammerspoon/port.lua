-- The narrow, authenticated "harness" port (loaded by init.lua; see SETUP.md, "Harness port").
-- Pure logic with no hs.* calls: init.lua passes the Hammerspoon pieces in, the tests pass fakes.
--
-- One message is one JSON object; the reply is one JSON object, {"ok":true,"result":...} or
-- {"ok":false,"error":"..."}:
--   {"cmd":"<registered name>", "owner":"<name>", "args":"<JSON text>", "seq":<integer>, "mac":"<hex>"}
-- Only commands that a module registered run; nothing is evaluated. `args` travels as JSON TEXT,
-- so the MAC covers exactly the bytes that get decoded and neither side has to re-encode them.
-- Commands registered with auth=true need a capability (e.g. "hands") and a signed call:
--   mac = lowercase hex HMAC-SHA256(owner's secret, seq .. "|" .. cmd .. "|" .. args)
--   The HMAC key is the secret's hex TEXT exactly as armed (its ASCII bytes, case kept), not the
--   bytes it decodes to: in Node, createHmac('sha256', secret), never Buffer.from(secret, 'hex').
--   seq > the owner's last accepted seq (any increasing integer). Calls for one owner must be
--   serialized through one signer (`hsx session`, or one in-process signer): a lower seq that
--   arrives second counts as a replay and locks the owner.
-- Built in: "arm" (args {owner, secret, pid?, minutes?}) and "disarm" (owner in the envelope, signed).
--
-- Who may arm, and with which capabilities and target apps, comes from the access policy file
-- (HS_ACCESS_FILE; example: access.example.json). Default deny: an owner that is not listed and
-- enabled cannot arm, and an invalid file denies every authenticated call until it is fixed.
-- A bad MAC or a replay disarms the owner, locks it for lock_minutes (so a spoofer cannot re-arm it
-- with its own secret) and always sends one alert, even inside the throttle for refusals.
-- Optional deps hooks for the awake guard (guard.lua): armed(owner, pid, untilAt) after an arm,
-- disarmed(owner, reason) after a disarm, and beforeCall(owner, pid, untilAt) before every
-- authenticated command, which refuses the call when it returns a reason.
local MAX_BYTES = 4 * 1024 * 1024
local NAME = "^[%w._-]+$"
local OWNER_KEYS = { enabled = 1, capabilities = 1, apps = 1, window = 1, manual_runs = 1, max_arm_minutes = 1,
  lock_minutes = 1, alert = 1 }

local function parseWindow(spec)
  local h1, m1, h2, m2 = tostring(spec):match("^(%d%d?):(%d%d)%-(%d%d?):(%d%d)$")
  if not h1 then return nil end
  local a, b = tonumber(h1) * 60 + tonumber(m1), tonumber(h2) * 60 + tonumber(m2)
  if a >= 1440 or b >= 1440 or tonumber(m1) > 59 or tonumber(m2) > 59 then return nil end
  return { a, b }
end

local function nameList(v, what)
  if type(v) ~= "table" then return nil, what .. " must be a list of names" end
  local out = {}
  for k, x in pairs(v) do
    if math.type(k) ~= "integer" or type(x) ~= "string" or not x:match(NAME) then
      return nil, what .. " must be a list of names (letters, digits, . _ -)"
    end
    out[x] = true
  end
  return out
end

local function intIn(v, lo, hi) return math.type(v) == "integer" and v >= lo and v <= hi end

-- Parses and checks the policy text. Returns policy or nil, reason. Unknown keys are errors, so a
-- typo ("capabilites") fails closed instead of silently granting less (or more) than meant.
local function parsePolicy(json, text)
  local ok, doc = pcall(json.decode, text)
  if not ok or type(doc) ~= "table" then return nil, "not a JSON object" end
  for k in pairs(doc) do
    if k ~= "owners" and not tostring(k):match("^_") then return nil, "unknown top-level key " .. tostring(k) end
  end
  if doc.owners ~= nil and type(doc.owners) ~= "table" then return nil, "owners must be an object" end
  local owners = {}
  for name, o in pairs(doc.owners or {}) do
    if type(name) ~= "string" or not name:match(NAME) then return nil, "bad owner name " .. tostring(name) end
    if type(o) ~= "table" then return nil, name .. ": must be an object" end
    for k in pairs(o) do
      if not OWNER_KEYS[k] and not tostring(k):match("^_") then return nil, name .. ": unknown key " .. tostring(k) end
    end
    local p = { enabled = o.enabled == true, manual_runs = o.manual_runs == true }
    if o.enabled ~= nil and type(o.enabled) ~= "boolean" then return nil, name .. ": enabled must be true or false" end
    if o.manual_runs ~= nil and type(o.manual_runs) ~= "boolean" then return nil, name .. ": manual_runs must be true or false" end
    local err
    p.capabilities, err = nameList(o.capabilities or {}, name .. ": capabilities")
    if not p.capabilities then return nil, err end
    p.apps, err = nameList(o.apps or {}, name .. ": apps")
    if not p.apps then return nil, err end
    if o.window ~= nil then
      p.window = parseWindow(o.window)
      if not p.window then return nil, name .. ": window must look like 20:00-05:00" end
    end
    if o.max_arm_minutes ~= nil and not intIn(o.max_arm_minutes, 1, 1440) then return nil, name .. ": max_arm_minutes must be 1-1440" end
    if o.lock_minutes ~= nil and not intIn(o.lock_minutes, 1, 10080) then return nil, name .. ": lock_minutes must be 1-10080" end
    if o.alert ~= nil and o.alert ~= "telegram" and o.alert ~= "deny" then return nil, name .. ": alert must be telegram or deny" end
    p.max_arm_minutes = o.max_arm_minutes or 720
    p.lock_minutes = o.lock_minutes or 360
    p.alert = o.alert or "deny"
    owners[name] = p
  end
  return { owners = owners }
end

local function sortedKeys(set)
  local out = {}
  for k in pairs(set) do out[#out + 1] = k end
  table.sort(out)
  return out
end

-- One line per policy, the same for the same grants: "runner[eyes,hands]{chrome}@1200-300/600/360/deny".
local function summary(pol)
  local out = {}
  for _, name in ipairs(sortedKeys(pol.owners)) do
    local p = pol.owners[name]
    out[#out + 1] = string.format("%s%s[%s]{%s}%s%s/%d/%d/%s", name, p.enabled and "" or "(off)",
      table.concat(sortedKeys(p.capabilities), ","), table.concat(sortedKeys(p.apps), ","),
      p.window and string.format("@%d-%d", p.window[1], p.window[2]) or "", p.manual_runs and "+manual" or "",
      p.max_arm_minutes, p.lock_minutes, p.alert)
  end
  return #out > 0 and table.concat(out, " ") or "(no owners)"
end

return function(deps)
  local json, now = deps.json, deps.now
  local M = {}
  local cmds = {}                       -- name -> { fn, auth, cap, app }
  local state = {}                      -- owner -> { secret, seq, pid, untilAt, trippedUntil, allowUntil, lastAlert }
  local policy, policyError, loaded = { owners = {} }, "no access file yet", false

  local function clean(s) return (tostring(s or "-"):sub(1, 64):gsub("[^%w._:-]", "?")) end
  local function stamp(t) return os.date("!%Y-%m-%dT%H:%M:%SZ", math.floor(t)) end
  local function int(v) return type(v) == "number" and math.tointeger(v) or nil end
  local function st(owner) state[owner] = state[owner] or { seq = 0 }; return state[owner] end
  local function audit(what, owner, cmd, reason)
    deps.log(string.format("%s %s owner=%s cmd=%s%s", stamp(now()), what, clean(owner), clean(cmd),
      reason and (" reason=" .. clean(reason)) or ""))
  end
  -- Refusals and denials: one alert per owner per 10 minutes (owners not in the policy share one
  -- bucket), so a flood of bad calls is one message, not a hundred.
  local lastAlert = {}
  local function alert(owner, text, always)
    local key = (owner and policy.owners[owner]) and owner or "?"
    if not always and lastAlert[key] and now() - lastAlert[key] < 600 then return end
    lastAlert[key] = now()
    deps.alert(text)
  end
  local function notice(owner, text)   -- arm and disarm: Telegram only for owners with alert=telegram
    local p = policy.owners[owner]
    if p and p.alert == "telegram" then deps.alert(text) end
  end
  -- A guard hook that fails is logged and skipped: a bug there must not stop every call.
  local function hook(name, ...)
    if not deps[name] then return end
    local ok, res = pcall(deps[name], ...)
    if not ok then audit("error", (...), name, tostring(res)); return end
    return res
  end
  local function reply(ok, v) return json.encode(ok and { ok = true, result = v } or { ok = false, error = v }) end
  local function deny(owner, cmd, reason) audit("deny", owner, cmd, reason); return reply(false, reason) end
  local function denyLoud(owner, cmd, reason)
    alert(owner, string.format("%s: %s denied (%s)", clean(owner), clean(cmd), reason))
    return deny(owner, cmd, reason)
  end

  -- Constant time over the full length: the time taken does not tell how many characters match.
  local function same(a, b)
    if type(a) ~= "string" or type(b) ~= "string" or #a ~= #b then return false end
    local d = 0
    for i = 1, #a do d = d | (a:byte(i) ~ b:byte(i)) end
    return d == 0
  end

  local function inWindow(p, s)
    if p.manual_runs and s.allowUntil and now() < s.allowUntil then return true end
    if not p.window then return true end
    local m, a, b = deps.minuteOfDay(), p.window[1], p.window[2]
    if a == b then return true end
    if a < b then return m >= a and m < b end
    return m >= a or m < b   -- wraps midnight
  end

  function M.disarm(owner, reason)
    local s = state[owner]
    if not s or not s.secret then return false end
    s.secret, s.pid, s.untilAt = nil, nil, nil
    audit("disarm", owner, "disarm", reason or "released")
    notice(owner, owner .. ": disarmed (" .. (reason or "released") .. ")")
    hook("disarmed", owner, reason or "released")
    return true
  end

  -- Load (or reload) the access policy. text=nil means the file is missing: nothing may arm.
  -- An invalid file denies everything and alerts; it never falls back to an older or looser policy.
  function M.setPolicy(text)
    local before = summary(policy)
    local p, err
    if text == nil then p, err = { owners = {} }, "no access file"
    else p, err = parsePolicy(json, text) end
    if p then policy, policyError = p, (text == nil) and err or nil
    else policy, policyError = { owners = {} }, "invalid access file: " .. err end
    for owner, s in pairs(state) do   -- an owner that lost its place cannot stay armed
      local q = policy.owners[owner]
      if s.secret and not (q and q.enabled) then M.disarm(owner, "access policy changed") end
    end
    audit(p and "policy" or "deny", nil, "access", policyError or "loaded")
    -- A change while running is announced, so a program that edits the file to grant itself
    -- hands cannot do it silently.
    if not p then deps.alert("access policy " .. policyError .. "; every authenticated call is denied until it is fixed")
    elseif loaded and summary(policy) ~= before then deps.alert("access policy changed: " .. summary(policy)) end
    loaded = true
    return p ~= nil, policyError
  end

  -- harness.register(name, fn, {auth=true, cap="hands", app="chrome"}): fn(args, caller) runs when a
  -- valid call arrives; its return value is the result. For auth=true commands caller is
  -- {owner=, pid=} of the armed owner (pid nil if the arm had none), taken from the verified arm,
  -- never from the request; auth=false commands get no caller. A command may ignore it. auth defaults to true and then needs cap: only
  -- owners whose policy lists that capability may call it. app (a name, or function(args) -> name)
  -- is the target the command drives; the owner's policy must list it in apps. auth=false is for
  -- read-only or hold-only commands (status, awake), never for anything that posts input.
  function M.register(name, fn, opts)
    opts = opts or {}
    assert(type(name) == "string" and name:match(NAME) and #name <= 64, "command name: letters, digits, . _ - (64 max)")
    assert(name ~= "arm" and name ~= "disarm", "arm and disarm are built in")
    assert(type(fn) == "function", "register needs a function")
    assert(not cmds[name], "command already registered: " .. name)
    local auth = opts.auth ~= false
    if auth then assert(type(opts.cap) == "string" and opts.cap:match(NAME), "auth=true needs a capability (cap=)") end
    assert(opts.app == nil or type(opts.app) == "string" or type(opts.app) == "function", "app is a name or a function")
    cmds[name] = { fn = fn, auth = auth, cap = opts.cap, app = opts.app }
  end

  -- A failed check: disarm, keep the owner locked for lock_minutes, log, and alert once.
  local function trip(owner, cmd, reason)
    local s, p = st(owner), policy.owners[owner]
    M.disarm(owner, reason)
    s.trippedUntil = now() + (p and p.lock_minutes or 360) * 60
    alert(owner, string.format("%s: %s on %s; disarmed and locked until %s UTC", owner, reason, clean(cmd),
      stamp(s.trippedUntil):sub(12, 16)), true)
    return deny(owner, cmd, reason)
  end

  -- harness.arm(owner, secret, {pid=, minutes=}): the first arm wins until it is disarmed (or its
  -- pid exits, or it expires). Over the port use `hsx arm`, which sends the secret over stdin;
  -- `hs -c 'harness.arm(...)'` would put the secret on a command line that `ps` shows.
  function M.arm(owner, secret, opts)
    opts = opts or {}
    local function refuse(reason)
      audit("deny", owner, "arm", reason)
      alert(owner, clean(owner) .. ": arm refused (" .. reason .. ")")
      return false, reason
    end
    if policyError and policyError:match("^invalid") then return refuse(policyError) end
    local p = type(owner) == "string" and policy.owners[owner] or nil
    if not p then return refuse("owner not in the access policy") end
    if not p.enabled then return refuse("owner disabled in the access policy") end
    local s = st(owner)
    if s.trippedUntil and now() < s.trippedUntil then return refuse("locked after a failed check") end
    if s.secret then return refuse("already armed") end
    if not inWindow(p, s) then return refuse("outside the arm window") end
    if type(secret) ~= "string" or #secret < 64 or #secret > 256 or not secret:match("^%x+$") then
      audit("deny", owner, "arm", "bad secret"); return false, "secret must be 64-256 hex characters"
    end
    local minutes = math.min(tonumber(opts.minutes) or p.max_arm_minutes, p.max_arm_minutes)
    s.secret, s.seq = secret, 0
    s.pid = int(opts.pid)
    s.untilAt = now() + minutes * 60
    s.allowUntil = nil   -- a one-off allowance is used up by the arm it allowed
    audit("arm", owner, "arm")
    notice(owner, owner .. ": armed until " .. stamp(s.untilAt):sub(12, 16) .. " UTC")
    hook("armed", owner, s.pid, s.untilAt)
    return true, { owner = owner, ["until"] = stamp(s.untilAt) }
  end

  -- For a run you start yourself outside the window (owners with manual_runs=true): run this in
  -- the Hammerspoon console, then arm within `minutes`.
  function M.allowArm(owner, minutes)
    local p = policy.owners[owner]
    if not (p and p.enabled and p.manual_runs) then return false, "owner has no manual_runs in the access policy" end
    st(owner).allowUntil = now() + (tonumber(minutes) or 10) * 60
    audit("allow", owner, "arm")
    return true
  end

  -- Clear the lock after a failed check, once you know what caused it.
  function M.reset(owner)
    st(owner).trippedUntil = nil
    audit("reset", owner, "arm")
    return true
  end

  -- Release owners whose runner exited or whose time ran out (init.lua calls this on a timer).
  function M.sweep()
    for name, s in pairs(state) do
      if s.secret then
        if s.untilAt and now() >= s.untilAt then M.disarm(name, "expired")
        elseif s.pid and not deps.pidAlive(s.pid) then M.disarm(name, "runner gone") end
      end
    end
  end

  -- The effective policy and who is armed, for harness.status(); never a secret.
  function M.policyInfo()
    local owners = {}
    for name, p in pairs(policy.owners) do
      local s = state[name] or {}
      owners[name] = {
        enabled = p.enabled,
        capabilities = sortedKeys(p.capabilities),
        apps = sortedKeys(p.apps),
        window = p.window and string.format("%02d:%02d-%02d:%02d", p.window[1] // 60, p.window[1] % 60,
          p.window[2] // 60, p.window[2] % 60) or nil,
        armed = s.secret ~= nil,
        ["until"] = s.untilAt and stamp(s.untilAt) or nil,
        locked_until = (s.trippedUntil and now() < s.trippedUntil) and stamp(s.trippedUntil) or nil,
      }
    end
    return { policy = policyError or "ok", owners = owners }
  end

  local function verify(owner, env, cmd, args)
    local s = st(owner)
    if s.secret and s.untilAt and now() >= s.untilAt then M.disarm(owner, "expired") end
    if not s.secret then return deny(owner, cmd, "not armed") end
    local seq = int(env.seq)
    if not seq or seq <= 0 or type(env.mac) ~= "string" then return trip(owner, cmd, "unsigned call") end
    local want = deps.hmac(s.secret, string.format("%d|%s|%s", seq, cmd, args)):lower()
    if not same(want, env.mac:lower()) then return trip(owner, cmd, "bad mac") end
    if seq <= s.seq then return trip(owner, cmd, "replay") end
    s.seq = seq
  end

  local function decodeArgs(args)
    if args == "" then return true, nil end
    local ok, v = pcall(json.decode, args)
    if not ok or type(v) ~= "table" then return false end
    return true, v
  end

  -- The port callback: one request in, one JSON reply out.
  function M.handle(data)
    if type(data) ~= "string" or #data > MAX_BYTES then return deny(nil, nil, "message too large") end
    local okJ, env = pcall(json.decode, data)
    if not okJ or type(env) ~= "table" then return deny(nil, nil, "not a JSON object") end
    local cmd, args = env.cmd, env.args
    if type(cmd) ~= "string" or #cmd > 64 or not cmd:match(NAME) then return deny(nil, cmd, "bad command name") end
    if args == nil then args = "" end
    if type(args) ~= "string" then return deny(nil, cmd, "args must be JSON text") end
    local okA, a = decodeArgs(args)
    if not okA then return deny(nil, cmd, "args are not a JSON object or array") end

    if cmd == "arm" then
      a = a or {}
      local ok, res = M.arm(type(a.owner) == "string" and a.owner or nil, a.secret, { pid = a.pid, minutes = a.minutes })
      return reply(ok, res)
    end
    local c = cmds[cmd]
    if cmd ~= "disarm" and not c then return deny(nil, cmd, "unknown command") end
    if c and not c.auth then
      local ok, res = pcall(c.fn, a)
      if not ok then audit("error", nil, cmd); return reply(false, "command failed: " .. tostring(res):sub(1, 200)) end
      audit("ok", nil, cmd)
      return reply(true, res)
    end

    -- Authenticated: a valid policy, a listed and enabled owner, a good signature, then the
    -- owner's capability and target app.
    local owner = type(env.owner) == "string" and env.owner:match(NAME) and env.owner or nil
    if policyError and policyError:match("^invalid") then return denyLoud(owner, cmd, "access policy invalid") end
    local p = owner and policy.owners[owner]
    if not p then return denyLoud(owner, cmd, "owner not in the access policy") end
    if not p.enabled then return denyLoud(owner, cmd, "owner disabled in the access policy") end
    local refused = verify(owner, env, cmd, args)
    if refused then return refused end
    if cmd == "disarm" then M.disarm(owner, "released"); return reply(true, true) end
    if not p.capabilities[c.cap] then return denyLoud(owner, cmd, "capability " .. c.cap .. " not granted") end
    if c.app then
      local okApp, app = pcall(function() return type(c.app) == "function" and c.app(a) or c.app end)
      if not okApp or type(app) ~= "string" then return denyLoud(owner, cmd, "no target app") end
      if not p.apps[app] then return denyLoud(owner, cmd, "app " .. clean(app) .. " not granted") end
    end
    -- No eyes or hands without an awake hold (guard.lua takes one if it can).
    local s = state[owner]
    local noHold = hook("beforeCall", owner, s.pid, s.untilAt)
    if noHold then return deny(owner, cmd, noHold) end
    -- The caller comes from the verified arm, never from the request; a fresh table each call, so a
    -- command that changes it changes nothing in the port.
    local ok, res = pcall(c.fn, a, { owner = owner, pid = s.pid })
    if not ok then audit("error", owner, cmd); return reply(false, "command failed: " .. tostring(res):sub(1, 200)) end
    audit("ok", owner, cmd)
    return reply(true, res)
  end

  return M
end
