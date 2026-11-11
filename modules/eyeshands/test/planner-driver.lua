-- Test driver for planner.lua (used by planner.test.mjs). Reads one Lua chunk per line from stdin
-- and prints its return value as one JSON line (or "ERROR <message>"). The chunks see:
--   P                                  the planner module
--   plan(kind, args, seed, from, map)  P.plan with a fresh P.Rng(seed); map is a layout map (optional)
--   seq(seed, steps)                   several {kind, args, from} steps sharing one RNG
--   raw(seed, n), unit(seed, n)        the first n RNG outputs (hex text) or unit() values
--   keyfor(cps, map)                   {cp, code, shift 0|1} for each code point
--   PLANNER                            the planner's path (to load it again in a sealed environment)
-- Numbers print so that JavaScript parses back the same double (%.17g), integers as integers.
local here = arg[0]:match("^(.*)/") or "."
PLANNER = here .. "/../EyesHands.spoon/planner.lua"
P = dofile(PLANNER)

local function encode(v)
  local t = type(v)
  if t == "nil" then return "null"
  elseif t == "boolean" then return tostring(v)
  elseif t == "number" then
    if math.type(v) == "integer" then return string.format("%d", v) end
    if v ~= v or v == math.huge or v == -math.huge then error("not a finite number") end
    local i = math.tointeger(v)
    if i and math.abs(v) < 2 ^ 53 then return string.format("%d", i) end
    return string.format("%.17g", v)
  elseif t == "string" then
    return '"' .. v:gsub('[%c"\\]', function(c) return string.format("\\u%04x", c:byte()) end) .. '"'
  elseif t == "table" then
    local n, keys = #v, {}
    for k in pairs(v) do keys[#keys + 1] = k end
    if #keys == n then
      local out = {}
      for i = 1, n do out[i] = encode(v[i]) end
      return "[" .. table.concat(out, ",") .. "]"
    end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    local out = {}
    for _, k in ipairs(keys) do out[#out + 1] = encode(tostring(k)) .. ":" .. encode(v[k]) end
    return "{" .. table.concat(out, ",") .. "}"
  end
  error("cannot encode " .. t)
end

function plan(kind, args, seed, from, map)
  return P.plan(kind, args, { rng = P.Rng(seed), from = from, layout = map and P.keys(map) or nil })
end

function seq(seed, steps)
  local rng, out = P.Rng(seed), {}
  for i, s in ipairs(steps) do out[i] = P.plan(s.kind, s.args, { rng = rng, from = s.from }) end
  return out
end

function raw(seed, n)
  local rng, out = P.Rng(seed), {}
  for i = 1, n do out[i] = string.format("%016x", rng:next()) end
  return out
end

function unit(seed, n)
  local rng, out = P.Rng(seed), {}
  for i = 1, n do out[i] = rng:unit() end
  return out
end

function keyfor(cps, map)
  local layout, out = map and P.keys(map) or P.US, {}
  for i, cp in ipairs(cps) do
    local code, shift = layout:keyFor(utf8.char(cp))
    out[i] = { cp, code, shift and 1 or 0 }
  end
  return out
end

for line in io.lines() do
  local ok, res = pcall(function() return encode(assert(load(line))()) end)
  io.write(ok and res or ("ERROR " .. tostring(res):gsub("\n", " ")), "\n")
  io.flush()
end
