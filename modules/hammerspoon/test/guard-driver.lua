-- Test driver for guard.lua (used by guard.test.mjs): the real guard and the real port logic,
-- wired the way init.lua wires them, over a fake awake mode. Reads one Lua chunk per stdin line
-- and prints its return value as JSON (or "ERROR ..."). The chunk sees:
--   port, guard, T (clock), LOCKED (awake refuses while true), HOLDS (owner -> opts), AWAKE (calls),
--   ALERTS, LOG, KEY (an armed secret), call(cmd, args) (a signed call as runner)
local here = arg[0]:match("^(.*)/") or "."
local fakes = dofile(here .. "/fakes.lua")
local json = fakes.json

T, LOCKED, HOLDS, AWAKE, ALERTS, LOG = 1800000000, false, {}, {}, {}, {}
local function info()
  local owners = {}
  for o in pairs(HOLDS) do owners[#owners + 1] = o end
  table.sort(owners)
  return { on = #owners > 0, owners = owners }
end
-- Like harness.awake: refuses on a locked screen, otherwise holds or releases the owner.
local function awake(on, opts)
  AWAKE[#AWAKE + 1] = { on = on, owner = opts.owner, pid = opts.pid, minutes = opts.minutes, lock = opts.lock }
  if on then
    if LOCKED then local i = info(); i.reason = "screen already locked"; return i end
    HOLDS[opts.owner] = { pid = opts.pid, minutes = opts.minutes }
  else
    HOLDS[opts.owner] = nil
  end
  return info()
end
guard = dofile(here .. "/../guard.lua")({
  awake = awake, awakeInfo = info, now = function() return T end,
  log = function(line) LOG[#LOG + 1] = line end,
  alert = function(text) ALERTS[#ALERTS + 1] = text end,
})
port = dofile(here .. "/../port.lua")({
  hmac = fakes.hmacSHA256, json = json, now = function() return T end, minuteOfDay = function() return 22 * 60 end,
  pidAlive = function() return true end, log = function(line) LOG[#LOG + 1] = line end,
  alert = function(text) ALERTS[#ALERTS + 1] = text end,
  armed = guard.armed, disarmed = guard.disarmed, beforeCall = guard.beforeCall,
})
port.register("hands.click", function(a) return { clicked = a and a.x or true } end, { cap = "hands" })
port.setPolicy('{"owners":{"runner":{"enabled":true,"capabilities":["eyes","hands"]}}}')
KEY = string.rep("cd", 32)
local seq = 0
function call(cmd, args)
  seq = seq + 1
  args = args or "{}"
  return json.decode(port.handle(json.encode({ cmd = cmd, owner = "runner", args = args, seq = seq,
    mac = fakes.hmacSHA256(KEY, seq .. "|" .. cmd .. "|" .. args) })))
end
function owners() return info().owners end

for line in io.lines() do
  local ok, res = pcall(assert(load(line)))
  io.write(ok and json.encode(res) or ("ERROR " .. tostring(res)), "\n")
  io.flush()
end
