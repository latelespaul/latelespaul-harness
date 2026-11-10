-- Test driver for port.lua (used by port.test.mjs): runs the real port logic with fake Hammerspoon
-- pieces. Reads one line at a time from stdin and prints one line per input line:
--   a JSON envelope  -> the port's reply (as Hammerspoon would return it)
--   !<lua chunk>     -> the chunk's return value (JSON); the chunk sees port, T, MINUTE, DEAD, LOG, ALERTS
-- HMAC-SHA256 and JSON come from fakes.lua (pure-Lua stand-ins for hs.hash and hs.json).
local here = arg[0]:match("^(.*)/") or "."
local fakes = dofile(here .. "/fakes.lua")
local hmacSHA256, json = fakes.hmacSHA256, fakes.json

T, MINUTE, DEAD, LOG, ALERTS = 1800000000, 22 * 60, {}, {}, {}
port = dofile(here .. "/../port.lua")({
  hmac = hmacSHA256,
  json = json,
  now = function() return T end,
  minuteOfDay = function() return MINUTE end,
  pidAlive = function(pid) return not DEAD[pid] end,
  log = function(line) LOG[#LOG + 1] = line end,
  alert = function(text) ALERTS[#ALERTS + 1] = text end,
})
HMAC = hmacSHA256
port.register("status", function() return { ok = "status" } end, { auth = false })
port.register("hands.click", function(a) return { clicked = a and a.x or false } end, { cap = "hands", app = "chrome" })
port.register("hands.type", function() return "typed" end, { cap = "hands", app = function(a) return a and a.app end })
port.register("eyes.read", function() return "seen" end, { cap = "eyes" })
port.register("hands.fail", function() error("boom") end, { cap = "hands" })
POLICY = [[{"owners":{"runner":{"enabled":true,"capabilities":["eyes","hands"],"apps":["chrome"],
  "window":"20:00-05:00","manual_runs":true,"max_arm_minutes":600},
  "looker":{"enabled":true,"capabilities":["eyes"]},"off":{"enabled":false,"capabilities":["hands"]}}}]]
port.setPolicy(POLICY)

for line in io.lines() do
  local out
  if line:sub(1, 1) == "!" then
    local ok, res = pcall(assert(load(line:sub(2))))
    out = ok and json.encode(res) or ("ERROR " .. tostring(res))
  else
    out = port.handle(line)
  end
  io.write(out, "\n")
  io.flush()
end
