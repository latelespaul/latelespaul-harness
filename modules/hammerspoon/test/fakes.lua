-- Pure-Lua stand-ins for hs.hash.hmacSHA256 and hs.json, shared by the test drivers.
local M32 = 0xffffffff

local K = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}
local function rr(x, n) return ((x >> n) | (x << (32 - n))) & M32 end
local function sha256(msg)
  local H = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 }
  local bits = #msg * 8
  msg = msg .. "\128" .. string.rep("\0", (55 - #msg) % 64) .. string.pack(">I8", bits)
  for i = 1, #msg, 64 do
    local w = {}
    for j = 1, 16 do w[j] = string.unpack(">I4", msg, i + (j - 1) * 4) end
    for j = 17, 64 do
      local x, y = w[j - 15], w[j - 2]
      w[j] = (w[j - 16] + (rr(x, 7) ~ rr(x, 18) ~ (x >> 3)) + w[j - 7] + (rr(y, 17) ~ rr(y, 19) ~ (y >> 10))) & M32
    end
    local a, b, c, d, e, f, g, h = table.unpack(H)
    for j = 1, 64 do
      local t1 = (h + (rr(e, 6) ~ rr(e, 11) ~ rr(e, 25)) + ((e & f) ~ (~e & g)) + K[j] + w[j]) & M32
      local t2 = ((rr(a, 2) ~ rr(a, 13) ~ rr(a, 22)) + ((a & b) ~ (a & c) ~ (b & c))) & M32
      h, g, f, e, d, c, b, a = g, f, e, (d + t1) & M32, c, b, a, (t1 + t2) & M32
    end
    for j, v in ipairs({ a, b, c, d, e, f, g, h }) do H[j] = (H[j] + v) & M32 end
  end
  return string.pack(">I4I4I4I4I4I4I4I4", table.unpack(H))
end
local function hmacSHA256(key, data)
  if #key > 64 then key = sha256(key) end
  key = key .. string.rep("\0", 64 - #key)
  local function x(p) return (key:gsub(".", function(ch) return string.char(ch:byte() ~ p) end)) end
  return (sha256(x(0x5c) .. sha256(x(0x36) .. data)):gsub(".", function(ch) return string.format("%02x", ch:byte()) end))
end

-- Minimal JSON, enough for the port's messages.
local json = {}
function json.decode(s)
  local i = 1
  local function ws() i = s:find("[^ \t\r\n]", i) or #s + 1 end
  local val
  local function str()
    local out = {}
    i = i + 1
    while true do
      local ch = s:sub(i, i)
      if ch == "" then error("unterminated string") end
      if ch == '"' then i = i + 1; return table.concat(out) end
      if ch == "\\" then
        local e = s:sub(i + 1, i + 1)
        local map = { n = "\n", t = "\t", r = "\r", b = "\b", f = "\f", ['"'] = '"', ["\\"] = "\\", ["/"] = "/" }
        if e == "u" then out[#out + 1] = utf8.char(tonumber(s:sub(i + 2, i + 5), 16)); i = i + 6
        else out[#out + 1] = assert(map[e], "bad escape"); i = i + 2 end
      else out[#out + 1] = ch; i = i + 1 end
    end
  end
  function val()
    ws()
    local ch = s:sub(i, i)
    if ch == "{" then
      local t = {}; i = i + 1; ws()
      if s:sub(i, i) == "}" then i = i + 1; return t end
      while true do
        ws(); assert(s:sub(i, i) == '"', "key expected"); local k = str(); ws()
        assert(s:sub(i, i) == ":", ": expected"); i = i + 1
        t[k] = val(); ws()
        local d = s:sub(i, i); i = i + 1
        if d == "}" then return t end
        assert(d == ",", ", expected")
      end
    elseif ch == "[" then
      local t = {}; i = i + 1; ws()
      if s:sub(i, i) == "]" then i = i + 1; return t end
      while true do
        t[#t + 1] = val(); ws()
        local d = s:sub(i, i); i = i + 1
        if d == "]" then return t end
        assert(d == ",", ", expected")
      end
    elseif ch == '"' then return str()
    elseif s:sub(i, i + 3) == "true" then i = i + 4; return true
    elseif s:sub(i, i + 4) == "false" then i = i + 5; return false
    elseif s:sub(i, i + 3) == "null" then i = i + 4; return nil
    else
      local num = s:match("^-?%d+%.?%d*[eE]?[-+]?%d*", i)
      assert(num and #num > 0, "bad value at " .. i)
      i = i + #num
      return math.tointeger(tonumber(num)) or tonumber(num)
    end
  end
  local v = val(); ws()
  assert(i > #s, "trailing data")
  return v
end
function json.encode(v)
  local t = type(v)
  if t == "table" then
    if next(v) == nil then return "{}" end
    if #v > 0 then
      local out = {}
      for _, x in ipairs(v) do out[#out + 1] = json.encode(x) end
      return "[" .. table.concat(out, ",") .. "]"
    end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    local out = {}
    for _, k in ipairs(keys) do out[#out + 1] = json.encode(k) .. ":" .. json.encode(v[k]) end
    return "{" .. table.concat(out, ",") .. "}"
  elseif t == "string" then
    return '"' .. v:gsub('[%c"\\]', function(c) return string.format("\\u%04x", c:byte()) end) .. '"'
  elseif t == "number" then return math.type(v) == "integer" and string.format("%d", v) or string.format("%.14g", v)
  elseif t == "boolean" then return tostring(v)
  else return "null" end
end

return { hmacSHA256 = hmacSHA256, json = json }
