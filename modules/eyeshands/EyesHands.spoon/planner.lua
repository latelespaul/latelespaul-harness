-- Eyes & Hands planner: turns one hands action (move, click, type, key, scroll) into a timed event
-- list. Pure Lua 5.4: no hs.* calls, no global writes, nothing posted; hands.lua plays the list.
-- A line-by-line port of job-hunt's plan.mjs with the same constants and the same SplitMix64 RNG,
-- so for one seed both planners give the same events (test/planner-golden.json checks it).
-- One change: key codes come from a layout (keys(hs.keycodes.map, hs.keycodes.currentLayout()) in
-- the Spoon), not a fixed US table; with the default US layout the output equals plan.mjs. The
-- planner never guesses a key: on a layout other than US, a character with no key in the map (and
-- no base letter in it) gets keyDown/keyUp events with no key field, only chars and flags, and
-- hands.lua posts them as Unicode-only key events without a key code. On the US layout such a
-- character uses key code 0, as in plan.mjs.
--
-- Times are milliseconds from the start of the action; positions are global screen points with the
-- origin at the top-left of the main display (what Accessibility reports).
--   local P = dofile(spoonPath .. "/planner.lua")
--   local plan = P.plan("click", { rect = { 412, 388, 320, 32 } },
--     { rng = P.Rng(seed), from = { x = 100, y = 200 },
--       layout = P.keys(hs.keycodes.map, hs.keycodes.currentLayout()) })
--   plan.events -> { {t = 0, type = "move", x = 101, y = 201, dx = 1, dy = 1, phase = "main"}, ... }
-- Event types: move (x, y, dx, dy, phase main|correct), down/up (x, y, clicks), flagsDown/flagsUp
-- (key, flags), keyDown/keyUp (key or none, flags, chars = the Unicode string), scroll (dx, dy wheel
-- values, positive = up/left), paste (text: put on the clipboard) and restore (old clipboard back).
local P = {}

-- ---- seedable RNG (SplitMix64) -------------------------------------------------------------------
-- Lua 5.4 integers are 64-bit and wrap on overflow, and >> is a logical shift, so this is the same
-- arithmetic as plan.mjs's BigInt code masked to 64 bits.

local Rng = {}
Rng.__index = Rng

--- A generator; `seed` is any number (its floor is used). Callers pass one (the Spoon uses a clock).
function P.Rng(seed)
  if seed == nil then seed = os.time() * 1000 + math.floor(os.clock() * 1000) end
  local s = math.tointeger(math.floor(seed))
  if not s then error("seed must be a number in the 64-bit integer range") end
  return setmetatable({ state = s }, Rng)
end

--- The next raw 64-bit output (a Lua integer; negative when the top bit is set).
function Rng:next()
  self.state = self.state + 0x9e3779b97f4a7c15
  local z = self.state
  z = (z ~ (z >> 30)) * 0xbf58476d1ce4e5b9
  z = (z ~ (z >> 27)) * 0x94d049bb133111eb
  return z ~ (z >> 31)
end

--- [0, 1)
function Rng:unit() return (self:next() >> 11) / 2 ^ 53 end
function Rng:uniform(a, b) return a + (b - a) * self:unit() end
function Rng:chance(p) return self:unit() < p end
--- Centre-biased value in [-1, 1] (mean of three uniforms).
function Rng:centred() return (self:unit() + self:unit() + self:unit()) / 1.5 - 1 end

-- JavaScript's Math.round (halves go up, also for negatives), as an integer.
local function round(v)
  local f = math.floor(v)
  if v - f >= 0.5 then f = f + 1 end
  return f
end
local function clamp(v, lo, hi) return math.min(math.max(v, lo), hi) end
local function r2(v) return round(v * 100) / 100 end
-- JavaScript's Math.hypot for two values (V8: scaled, with a Kahan sum), so distances match exactly.
local function hypot(a, b)
  a, b = math.abs(a), math.abs(b)
  local max = math.max(a, b)
  if max == 0 then return 0.0 end
  local sum, comp = 0.0, 0.0
  for _, v in ipairs({ a, b }) do
    local n = v / max
    local summand = n * n - comp
    local pre = sum + summand
    comp = (pre - sum) - summand
    sum = pre
  end
  return math.sqrt(sum) * max
end
P.round, P.r2 = round, r2

-- ---- mouse ---------------------------------------------------------------------------------------

P.MOVE_MIN_MS = 250
P.MOVE_MAX_MS = 900
P.OVERSHOOT_P = 0.2

--- {x, y, w, h} from a list {x, y, w, h} or a table with x, y, w, h; a point {x, y} becomes a 1x1 rect.
function P.toRect(r)
  if type(r) == "table" then
    if #r == 4 then return { x = tonumber(r[1]), y = tonumber(r[2]), w = tonumber(r[3]), h = tonumber(r[4]) } end
    if r.w ~= nil then return { x = tonumber(r.x), y = tonumber(r.y), w = tonumber(r.w), h = tonumber(r.h) } end
    if r.x ~= nil then return { x = tonumber(r.x) - 0.5, y = tonumber(r.y) - 0.5, w = 1, h = 1 } end
  end
  error("need a rect {x,y,w,h} or a point {x=,y=}")
end

--- A random point inside the rect, biased to its centre, kept off the very edge.
function P.targetPoint(r, rng)
  local ix = math.min(r.w / 2, math.max(1, r.w * 0.12))
  local iy = math.min(r.h / 2, math.max(1, r.h * 0.12))
  local hx = math.max(0, r.w / 2 - ix)
  local hy = math.max(0, r.h / 2 - iy)
  local x = r.x + r.w / 2 + rng:centred() * hx
  local y = r.y + r.h / 2 + rng:centred() * hy
  return { x = x, y = y }
end

--- Fitts's law: a + b*log2(D/W + 1), jittered, clamped to 250-900 ms.
function P.fittsMs(d, w, rng)
  local base = 230 + 125 * math.log(d / math.max(w, 4) + 1, 2)
  return clamp(base * rng:uniform(0.9, 1.12), P.MOVE_MIN_MS, P.MOVE_MAX_MS)
end

local function easeOut(s) return 1 - (1 - s) ^ 3 end
local function easeInOut(s)
  if s < 0.5 then return 4 * s * s * s end
  return 1 - (-2 * s + 2) ^ 3 / 2
end

local function bezier(p0, c1, c2, p1, t)
  local u = 1 - t
  local a, b, c, d = u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t
  return { x = a * p0.x + b * c1.x + c * c2.x + d * p1.x, y = a * p0.y + b * c1.y + c * c2.y + d * p1.y }
end

--- Cubic Bezier from `from` to a centre-biased point in `rect`, with ease-out timing; about one move
--- in five overshoots a little and corrects. The control points sit at ordered fractions along the
--- line, so progress along the start-to-end direction never goes backwards.
function P.planMove(from, rect, rng, startT)
  startT = startT or 0
  local r = P.toRect(rect)
  local p0 = { x = tonumber(from.x), y = tonumber(from.y) }
  local p1 = P.targetPoint(r, rng)
  local vx, vy = p1.x - p0.x, p1.y - p0.y
  local d = hypot(vx, vy)
  if d < 1 then return { events = {}, target = { r2(p0.x), r2(p0.y) }, ["end"] = p0, moveMs = 0, overshoot = false } end
  local ux, uy = vx / d, vy / d
  local nx, ny = -uy, ux
  local dur = P.fittsMs(d, math.min(r.w, r.h), rng)
  local overshoot = d > 60 and rng:chance(P.OVERSHOOT_P)
  local endMain = p1
  if overshoot then
    local o = clamp(d * rng:uniform(0.03, 0.08), 4, 25)
    local side = rng:uniform(-3, 3)
    endMain = { x = p1.x + ux * o + nx * side, y = p1.y + uy * o + ny * side }
  end
  local mvx, mvy = endMain.x - p0.x, endMain.y - p0.y
  local a1 = rng:uniform(0.2, 0.4)
  local a2 = rng:uniform(0.6, 0.8)
  local o1 = d * rng:uniform(-0.22, 0.22)
  local o2 = d * rng:uniform(-0.16, 0.16)
  local c1 = { x = p0.x + mvx * a1 + nx * o1, y = p0.y + mvy * a1 + ny * o1 }
  local c2 = { x = p0.x + mvx * a2 + nx * o2, y = p0.y + mvy * a2 + ny * o2 }
  local mainMs = overshoot and dur * 0.82 or dur
  local steps = clamp(round(mainMs / 14), 30, 80)
  local events = {}
  -- A mouse reports whole counts: a sample that stays on the same pixel is dropped, so every move
  -- carries a non-zero integer movementX/Y.
  local prev = { x = round(p0.x), y = round(p0.y) }
  local function push(t, p, phase)
    local q = { x = round(p.x), y = round(p.y) }
    if q.x == prev.x and q.y == prev.y then return end
    events[#events + 1] = { t = r2(startT + t), type = "move", x = q.x, y = q.y, dx = q.x - prev.x, dy = q.y - prev.y,
      phase = phase }
    prev = q
  end
  for i = 1, steps do
    local s = i / steps
    push(s * mainMs, bezier(p0, c1, c2, endMain, easeOut(s)), "main")
  end
  if overshoot then
    local pause = rng:uniform(25, 60)
    local rest = dur - mainMs - pause
    local m = round(rng:uniform(8, 14))
    for i = 1, m do
      local s = i / m
      local e = easeInOut(s)
      push(mainMs + pause + s * rest, { x = endMain.x + (p1.x - endMain.x) * e, y = endMain.y + (p1.y - endMain.y) * e },
        "correct")
    end
  end
  return { events = events, target = { r2(p1.x), r2(p1.y) }, ["end"] = #events > 0 and { x = prev.x, y = prev.y } or p0,
    moveMs = r2(dur), overshoot = overshoot }
end

P.HOLD_MIN_MS = 60
P.HOLD_MAX_MS = 140

--- Settle, mouse button down, held 60-140 ms, up; `clicks` 2 for a double click.
function P.planClick(at, clicks, rng, startT)
  local t = (startT or 0) + rng:uniform(40, 120)
  local events = {}
  for c = 1, math.max(1, clicks) do
    events[#events + 1] = { t = r2(t), type = "down", x = r2(at.x), y = r2(at.y), clicks = c }
    t = t + rng:uniform(P.HOLD_MIN_MS, P.HOLD_MAX_MS)
    events[#events + 1] = { t = r2(t), type = "up", x = r2(at.x), y = r2(at.y), clicks = c }
    t = t + rng:uniform(70, 130)
  end
  return events
end

-- ---- keyboard ------------------------------------------------------------------------------------

P.PASTE_THRESHOLD = 300
P.GAP_MIN_MS = 40
P.GAP_MAX_MS = 180
local SPACE_EXTRA = { 40, 160 }
local PUNCT_EXTRA = { 90, 260 }
local PUNCTUATION = { ["."] = true, [","] = true, [";"] = true, [":"] = true, ["!"] = true, ["?"] = true, ["\n"] = true }

P.FLAG = { shift = 0x20000, ctrl = 0x40000, alt = 0x80000, cmd = 0x100000 }

-- US-layout virtual key codes. Unshifted characters (the shape of hs.keycodes.map) and the shifted
-- symbols, each with the unshifted character of its key.
P.US_MAP = { a = 0, s = 1, d = 2, f = 3, h = 4, g = 5, z = 6, x = 7, c = 8, v = 9, b = 11, q = 12, w = 13, e = 14,
  r = 15, y = 16, t = 17, o = 31, u = 32, i = 34, p = 35, l = 37, j = 38, k = 40, n = 45, m = 46,
  ["1"] = 18, ["2"] = 19, ["3"] = 20, ["4"] = 21, ["6"] = 22, ["5"] = 23, ["="] = 24, ["9"] = 25, ["7"] = 26,
  ["-"] = 27, ["8"] = 28, ["0"] = 29, ["]"] = 30, ["["] = 33, ["'"] = 39, [";"] = 41, ["\\"] = 42, [","] = 43,
  ["/"] = 44, ["."] = 47, ["`"] = 50 }
P.US_SHIFTED = { ["!"] = "1", ["@"] = "2", ["#"] = "3", ["$"] = "4", ["^"] = "6", ["%"] = "5", ["+"] = "=",
  ["("] = "9", ["&"] = "7", ["_"] = "-", ["*"] = "8", [")"] = "0", ["}"] = "]", ["{"] = "[", ['"'] = "'",
  [":"] = ";", ["|"] = "\\", ["<"] = ",", ["?"] = "/", [">"] = ".", ["~"] = "`" }
-- Keys that are the same on every layout.
local FIXED = { [" "] = 49, ["\n"] = 36, ["\t"] = 48 }

-- Characters whose Unicode canonical decomposition (NFD) starts with a mapped character, grouped by
-- that base character: an accented letter uses its base letter's key. Shift is held for a base in
-- A-Z. This is the complete set for the US keys (what plan.mjs gets from String.normalize).
local DECOMPOSE = {
  A = "ÀÁÂÃÄÅĀĂĄǍǞǠǺȀȂȦḀẠẢẤẦẨẪẬẮẰẲẴẶ\u{212B}", a = "àáâãäåāăąǎǟǡǻȁȃȧḁạảấầẩẫậắằẳẵặ",
  B = "ḂḄḆ", b = "ḃḅḇ", C = "ÇĆĈĊČḈ", c = "çćĉċčḉ", D = "ĎḊḌḎḐḒ", d = "ďḋḍḏḑḓ",
  E = "ÈÉÊËĒĔĖĘĚȄȆȨḔḖḘḚḜẸẺẼẾỀỂỄỆ", e = "èéêëēĕėęěȅȇȩḕḗḙḛḝẹẻẽếềểễệ",
  F = "Ḟ", f = "ḟ", G = "ĜĞĠĢǦǴḠ", g = "ĝğġģǧǵḡ", H = "ĤȞḢḤḦḨḪ", h = "ĥȟḣḥḧḩḫẖ",
  I = "ÌÍÎÏĨĪĬĮİǏȈȊḬḮỈỊ", i = "ìíîïĩīĭįǐȉȋḭḯỉị", J = "Ĵ", j = "ĵǰ", K = "ĶǨḰḲḴ\u{212A}", k = "ķǩḱḳḵ",
  L = "ĹĻĽḶḸḺḼ", l = "ĺļľḷḹḻḽ", M = "ḾṀṂ", m = "ḿṁṃ", N = "ÑŃŅŇǸṄṆṈṊ", n = "ñńņňǹṅṇṉṋ",
  O = "ÒÓÔÕÖŌŎŐƠǑǪǬȌȎȪȬȮȰṌṎṐṒỌỎỐỒỔỖỘỚỜỞỠỢ", o = "òóôõöōŏőơǒǫǭȍȏȫȭȯȱṍṏṑṓọỏốồổỗộớờởỡợ",
  P = "ṔṖ", p = "ṕṗ", R = "ŔŖŘȐȒṘṚṜṞ", r = "ŕŗřȑȓṙṛṝṟ", S = "ŚŜŞŠȘṠṢṤṦṨ", s = "śŝşšșṡṣṥṧṩ",
  T = "ŢŤȚṪṬṮṰ", t = "ţťțṫṭṯṱẗ", U = "ÙÚÛÜŨŪŬŮŰŲƯǓǕǗǙǛȔȖṲṴṶṸṺỤỦỨỪỬỮỰ",
  u = "ùúûüũūŭůűųưǔǖǘǚǜȕȗṳṵṷṹṻụủứừửữự", V = "ṼṾ", v = "ṽṿ", W = "ŴẀẂẄẆẈ", w = "ŵẁẃẅẇẉẘ",
  X = "ẊẌ", x = "ẋẍ", Y = "ÝŶŸȲẎỲỴỶỸ", y = "ýÿŷȳẏẙỳỵỷỹ", Z = "ŹŻŽẐẒẔ", z = "źżžẑẓẕ",
  [";"] = "\u{37E}", ["`"] = "\u{1FEF}", ["="] = "≠", ["<"] = "≮", [">"] = "≯",
}
local BASE = {}
for base, list in pairs(DECOMPOSE) do
  for _, cp in utf8.codes(list) do BASE[utf8.char(cp)] = base end
end

local function isChar(s) return type(s) == "string" and utf8.len(s) == 1 end

local Layout = {}
Layout.__index = Layout

--- A keyboard layout from a character -> key code map (hs.keycodes.map for the current layout; its
--- numeric and named entries are ignored; read with rawget, since hs.keycodes.map answers any key
--- through an __index fallback, map["H"] = 4). Letters also get their capitals on Shift. `name` is the
--- layout name (hs.keycodes.currentLayout()); without it, the map is the US layout when every
--- US_MAP entry has the same code in it. Only the US layout ("U.S." or "ABC") gets the US shifted
--- symbols; other layouts get no key for a symbol their map does not have.
--- With no arguments: the US layout, the same table as plan.mjs.
function P.keys(map, name)
  map = map or P.US_MAP
  local us = name == "U.S." or name == "ABC"
  if name == nil then
    us = true
    for c, code in pairs(P.US_MAP) do
      if rawget(map, c) ~= code then us = false; break end
    end
  end
  local chars = {}
  for c, code in pairs(map) do
    if isChar(c) and math.type(code) == "integer" then
      chars[c] = { code, false }
      local up = c:upper()
      if up ~= c and rawget(map, up) == nil then chars[up] = { code, true } end
    end
  end
  for c, code in pairs(FIXED) do chars[c] = { code, false } end
  if us then
    for sym, base in pairs(P.US_SHIFTED) do
      local code = rawget(map, base)
      if chars[sym] == nil and code ~= nil then chars[sym] = { code, true } end
    end
  end
  return setmetatable({ map = map, chars = chars, us = us }, Layout)
end

--- Key code and whether Shift is held for a character: its own key, else the key of its base letter
--- (u for ü), else 0 on the US layout and nil (no key code; Shift not held) on any other layout.
--- The typed text always comes from the Unicode string.
function Layout:keyFor(c)
  local k = self.chars[c]
  if k then return k[1], k[2] end
  local base = BASE[c]
  local b = base and self.chars[base]
  if b then return b[1], base:match("^%u$") ~= nil end
  return self.us and 0 or nil, false
end

P.NAMED_KEYS = { enter = 36, ["return"] = 36, tab = 48, space = 49, delete = 51, backspace = 51, escape = 53,
  esc = 53, forwarddelete = 117, home = 115, ["end"] = 119, pageup = 116, pagedown = 121,
  left = 123, right = 124, down = 125, up = 126 }
P.MODIFIERS = {
  cmd = { 55, P.FLAG.cmd }, command = { 55, P.FLAG.cmd }, meta = { 55, P.FLAG.cmd },
  shift = { 56, P.FLAG.shift }, alt = { 58, P.FLAG.alt }, option = { 58, P.FLAG.alt }, opt = { 58, P.FLAG.alt },
  ctrl = { 59, P.FLAG.ctrl }, control = { 59, P.FLAG.ctrl },
}

--- "cmd+shift+g" -> {mods = {{55, cmd flag}, {56, shift flag}}, key = <code of g on this layout>}.
function Layout:parseCombo(s)
  s = tostring(s)
  local parts = {}
  for p in (s:lower() .. "+"):gmatch("(.-)%+") do parts[#parts + 1] = p:match("^%s*(.-)%s*$") end
  local last = parts[#parts]
  if last == "" then error('bad key combo "' .. s .. '"') end
  local mods = {}
  for i = 1, #parts - 1 do
    local m = P.MODIFIERS[parts[i]]
    if not m then error('unknown modifier "' .. parts[i] .. '"') end
    mods[#mods + 1] = m
  end
  if P.NAMED_KEYS[last] then return { mods = mods, key = P.NAMED_KEYS[last] } end
  if isChar(last) and self.chars[last] then return { mods = mods, key = self.chars[last][1] } end
  error('unknown key "' .. last .. '"')
end

P.US = P.keys()

--- Modifiers down one by one, the key, then modifiers up in reverse.
function P.planCombo(combo, rng, startT)
  local t = startT or 0
  local flags = 0
  local events = {}
  for _, m in ipairs(combo.mods) do
    flags = flags | m[2]
    events[#events + 1] = { t = r2(t), type = "flagsDown", key = m[1], flags = flags }
    t = t + rng:uniform(30, 70)
  end
  events[#events + 1] = { t = r2(t), type = "keyDown", key = combo.key, flags = flags }
  t = t + rng:uniform(50, 110)
  events[#events + 1] = { t = r2(t), type = "keyUp", key = combo.key, flags = flags }
  for i = #combo.mods, 1, -1 do
    local m = combo.mods[i]
    t = t + rng:uniform(25, 60)
    flags = flags & ~m[2]
    events[#events + 1] = { t = r2(t), type = "flagsUp", key = m[1], flags = flags }
  end
  return events
end

--- Per-character typing with human gaps, or a clipboard paste for long text (over 300 characters).
--- Gaps (key-down to key-down): 40-180 ms, plus 40-160 ms after a space and 90-260 ms after
--- punctuation. `text` is UTF-8; one character is one Unicode code point.
function P.planType(text, rng, layout)
  layout = layout or P.US
  text = tostring(text)
  if not utf8.len(text) then error("type needs UTF-8 text") end
  local chars = {}
  for _, cp in utf8.codes(text) do chars[#chars + 1] = utf8.char(cp) end
  if #chars > P.PASTE_THRESHOLD then
    local events = { { t = 0, type = "paste", text = text } }
    local v = layout.chars.v and layout.chars.v[1] or P.US_MAP.v
    for _, e in ipairs(P.planCombo({ mods = { P.MODIFIERS.cmd }, key = v }, rng, rng:uniform(80, 160))) do
      events[#events + 1] = e
    end
    events[#events + 1] = { t = r2(events[#events].t + rng:uniform(300, 450)), type = "restore" }
    return { events = events, paste = true, gaps = {}, chars = #chars }
  end
  local gapMs = { 0 }
  local gaps = {}
  for i = 2, #chars do
    local p = chars[i - 1]
    local g = rng:uniform(P.GAP_MIN_MS, P.GAP_MAX_MS)
    local after = "char"
    if p == " " then g = g + rng:uniform(SPACE_EXTRA[1], SPACE_EXTRA[2]); after = "space"
    elseif PUNCTUATION[p] then g = g + rng:uniform(PUNCT_EXTRA[1], PUNCT_EXTRA[2]); after = "punct" end
    gaps[#gaps + 1] = { ms = r2(g), after = after }
    gapMs[#gapMs + 1] = g
  end
  local events = {}
  local t = 0
  for i, c in ipairs(chars) do
    t = t + gapMs[i]
    local code, shift = layout:keyFor(c)
    local nextShift = i < #chars and select(2, layout:keyFor(chars[i + 1]))
    -- A key may overlap the next one (rollover), but never a Shift press, so the modifier state on
    -- every key event is the real one.
    local room = i < #chars and gapMs[i + 1] - (nextShift and 22 or 6) or 85
    local hold = math.max(12, math.min(shift and rng:uniform(18, 28) or rng:uniform(30, 85), room))
    local typed = (c == "\n" or c == "\t") and "" or c
    local function key(kind, at, flags)
      local e = { t = r2(at), type = kind, key = code, flags = flags }
      if typed ~= "" then e.chars = typed end
      return e
    end
    if shift then
      local lead = rng:uniform(8, 14)
      events[#events + 1] = { t = r2(math.max(0, t - lead)), type = "flagsDown", key = 56, flags = P.FLAG.shift }
      events[#events + 1] = key("keyDown", t, P.FLAG.shift)
      events[#events + 1] = key("keyUp", t + hold, P.FLAG.shift)
      events[#events + 1] = { t = r2(t + hold + 3), type = "flagsUp", key = 56, flags = 0 }
    else
      events[#events + 1] = key("keyDown", t, 0)
      events[#events + 1] = key("keyUp", t + hold, 0)
    end
  end
  -- A stable sort by time (table.sort is not stable; plan.mjs's Array.sort is).
  for i, e in ipairs(events) do e._i = i end
  table.sort(events, function(a, b) return a.t < b.t or (a.t == b.t and a._i < b._i) end)
  for _, e in ipairs(events) do e._i = nil end
  return { events = events, paste = false, gaps = gaps, chars = #chars }
end

-- ---- scroll --------------------------------------------------------------------------------------

--- `dy` > 0 scrolls the page down (content moves up), in pixels, as a few wheel ticks that speed up
--- then slow down. Event dx/dy are wheel values (positive = up/left), summing exactly to -dx/-dy.
function P.planScroll(dx, dy, rng)
  dx, dy = tonumber(dx) or 0, tonumber(dy) or 0
  local total = math.max(math.abs(dx), math.abs(dy))
  if total < 1 then return {} end
  local n = clamp(round(total / 45), 1, 60)
  local w, sum = {}, 0
  for i = 0, n - 1 do w[i + 1] = math.sin((math.pi * (i + 0.5)) / n) * rng:uniform(0.8, 1.2) end
  for _, v in ipairs(w) do sum = sum + v end
  for i, v in ipairs(w) do w[i] = v / sum end
  local events = {}
  local t, sentX, sentY = 0, 0, 0
  for i, wi in ipairs(w) do
    local sx, sy = round(-dx * wi), round(-dy * wi)
    if i == n then sx, sy = -dx - sentX, -dy - sentY end -- land exactly on the total
    sentX, sentY = sentX + sx, sentY + sy
    events[#events + 1] = { t = r2(t), type = "scroll", dx = sx, dy = sy }
    t = t + rng:uniform(16, 40)
  end
  return events
end

-- ---- whole actions -------------------------------------------------------------------------------

--- Plans one hands action. opts: rng (P.Rng), from (the cursor position {x, y}), layout (P.keys(...),
--- default US). Returns {events = ..., ...info}; `rect`, when present, is what the focus guard
--- checks before posting.
function P.plan(kind, args, opts)
  args = args or {}
  local rng, from = opts.rng, opts.from or { x = 0, y = 0 }
  local layout = opts.layout or P.US
  if kind == "move" then
    local m = P.planMove(from, args.rect or args, rng)
    return { events = m.events, target = m.target, moveMs = m.moveMs, overshoot = m.overshoot,
      rect = args.rect and P.toRect(args.rect) or nil }
  elseif kind == "click" then
    local n = tonumber(args.clicks)
    if not n or n ~= n or n == 0 then n = 1 end
    local clicks = math.max(1, math.min(3, n))
    if args.rect or args.x ~= nil then
      local m = P.planMove(from, args.rect or args, rng)
      local events = m.events
      for _, e in ipairs(P.planClick(m["end"], clicks, rng, m.moveMs)) do events[#events + 1] = e end
      return { events = events, target = m.target, moveMs = m.moveMs, overshoot = m.overshoot,
        rect = args.rect and P.toRect(args.rect) or nil }
    end
    return { events = P.planClick(from, clicks, rng), target = { r2(from.x), r2(from.y) } }
  elseif kind == "type" then
    if type(args.text) ~= "string" then error("type needs text") end
    return P.planType(args.text, rng, layout)
  elseif kind == "key" then
    return { events = P.planCombo(layout:parseCombo(args.combo or args.arg or ""), rng) }
  elseif kind == "scroll" then
    return { events = P.planScroll(args.dx, args.dy, rng) }
  end
  error("unknown hands action " .. tostring(kind))
end

return P
