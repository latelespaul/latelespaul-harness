-- Loads the real init.lua under plain Lua with a stub `hs` (used by port.test.mjs), then drives the
-- harness port it opened.  lua init-smoke.lua <configdir>   (configdir/init.lua links to init.lua)
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
local R = { ports = {}, alerts = {}, tasks = {} }
local function timer() return { stop = function() end } end

hs = stub()
hs.configdir = arg[1]
hs.processInfo = { version = "test" }
hs.accessibilityState = function() return true end
hs.screenRecordingState = function() return true end
hs.caffeinate.sessionProperties = function() return {} end
hs.caffeinate.watcher = { new = function() return { start = function() end } end, screensDidLock = 1 }
hs.application.frontmostApplication = function() return nil end
hs.settings = { get = function() return nil end, set = function() end, clear = function() end }
hs.host.idleTime = function() return 0 end
hs.json, hs.hash = json, { hmacSHA256 = fakes.hmacSHA256 }
hs.execute = sh
hs.timer = { doEvery = timer, doAfter = function(_, fn) fn(); return timer() end, secondsSinceEpoch = os.time }
hs.alert = { show = function(text) R.alerts[#R.alerts + 1] = text end }
hs.task = { new = function(cmd, _, args) return { start = function() R.tasks[#R.tasks + 1] = { cmd, table.unpack(args) } end } end }
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

local port = R.ports.harness
local function call(t) return json.decode(port(nil, 0, json.encode(t))) end
local function signed(key, owner, cmd, args, seq)
  return call({ cmd = cmd, owner = owner, args = args, seq = seq, mac = fakes.hmacSHA256(key, seq .. "|" .. cmd .. "|" .. args) })
end
local key = string.rep("ab", 32)
local out = { genericClosed = R.genericClosed == true, opened = port ~= nil, watched = R.watched }
out.status = call({ cmd = "status" })
out.arm = call({ cmd = "arm", args = json.encode({ owner = "runner", secret = key }) })
out.click = signed(key, "runner", "smoke.click", '{"x":2}', 1)
-- Revoke in the file, then let the folder watcher fire: the next call must be refused.
local f = io.open(os.getenv("ACCESS_FILE"), "w"); f:write('{"owners":{"runner":{"enabled":false}}}'); f:close()
R.watch({ os.getenv("ACCESS_FILE") })
out.afterRevoke = signed(key, "runner", "smoke.click", '{"x":3}', 2)
out.alerts, out.tasks = R.alerts, R.tasks
io.write(json.encode(out), "\n")
