-- Eyes & Hands targets: what a call reads or drives (part 7 of docs/eyes-hands-design.md).
-- Pure Lua 5.4 with no hs.* calls: init.lua passes the Hammerspoon pieces in, the tests pass fakes.
--
-- A call names a target by an alias from the targets file or by a bundle id. The targets file:
--   { "targets": { "textedit":     { "bundle": "com.apple.TextEdit" },
--                  "chrome-agent": { "bundle": "com.google.Chrome", "profile": "~/.chrome-agent" },
--                  "chrome-test":  { "bundle": "com.google.Chrome", "profile": "/tmp/eh-test-profile",
--                                    "refuse_debug_port": true } } }
-- Rules:
--   1. a bundle target resolves to the frontmost running instance with that bundle id (else the
--      lowest pid);
--   2. a profile target resolves to the Chromium main process (no --type=) whose --user-data-dir
--      equals the profile path, read from `ps -axww -o pid=,command=`; the process must also be a
--      running app with the target's bundle id, so a shell or `open` line that only mentions the
--      path never matches;
--   3. refuse_debug_port refuses such a process when it runs with --remote-debugging-port;
--   4. nothing matches: {ok=false, reason="target_not_running"}.
-- Who may use a target is the access policy's business (its `apps`), not this module's.
--
-- deps: readFile(path) -> text or nil (missing), ps() -> text, apps(bundle) -> { {pid=, name=}, ... },
--       frontPid() -> pid or nil, home (for "~/" in profile paths), targetsFile (path, for status)
local NAME = "^[%w._-]+$"
local TARGET_KEYS = { bundle = 1, profile = 1, refuse_debug_port = 1, mode_id = 1 }

-- Expands ~ and drops trailing slashes. Returns the path, or nil when it is not absolute.
local function normPath(p, home)
  if p == "~" or p:sub(1, 2) == "~/" then
    if not home or home == "" then return nil end
    p = home .. p:sub(2)
  end
  if p:sub(1, 1) ~= "/" then return nil end
  p = p:gsub("/+$", "")
  return p ~= "" and p or "/"
end

-- Parses and checks the targets file text. Returns { name -> spec } or nil, reason. Unknown keys
-- are errors, so a typo ("refuse_debug_prot") fails closed.
local function parse(json, text, home)
  local ok, doc = pcall(json.decode, text)
  if not ok or type(doc) ~= "table" then return nil, "not a JSON object" end
  for k in pairs(doc) do
    if k ~= "targets" and not tostring(k):match("^_") then return nil, "unknown top-level key " .. tostring(k) end
  end
  if doc.targets ~= nil and type(doc.targets) ~= "table" then return nil, "targets must be an object" end
  local out = {}
  for name, t in pairs(doc.targets or {}) do
    if type(name) ~= "string" or #name > 64 or not name:match(NAME) then return nil, "bad target name " .. tostring(name) end
    if type(t) ~= "table" then return nil, name .. ": must be an object" end
    for k in pairs(t) do
      if not TARGET_KEYS[k] and not tostring(k):match("^_") then return nil, name .. ": unknown key " .. tostring(k) end
    end
    if type(t.bundle) ~= "string" or not t.bundle:match(NAME) then return nil, name .. ": bundle must be a bundle id" end
    local spec = { name = name, bundle = t.bundle }
    if t.profile ~= nil then
      if type(t.profile) ~= "string" or t.profile == "" then return nil, name .. ": profile must be a path" end
      spec.profile = normPath(t.profile, home)
      if not spec.profile then return nil, name .. ": profile must be an absolute path (or start with ~/)" end
    end
    if t.refuse_debug_port ~= nil then
      if type(t.refuse_debug_port) ~= "boolean" then return nil, name .. ": refuse_debug_port must be true or false" end
      if not spec.profile then return nil, name .. ": refuse_debug_port needs a profile" end
      spec.refuse_debug_port = t.refuse_debug_port
    end
    if t.mode_id ~= nil then
      if type(t.mode_id) ~= "string" or not t.mode_id:match(NAME) then return nil, name .. ": mode_id must be a name" end
      spec.mode_id = t.mode_id
    end
    out[name] = spec
  end
  return out
end

-- Whether `cmd` carries --user-data-dir=<profile> as a whole argument: after a space (or at the
-- start), and ending at a space or the end of the line (trailing slashes allowed).
local function hasProfile(cmd, profile)
  local flag = "--user-data-dir=" .. profile
  local from = 1
  while true do
    local s, e = cmd:find(flag, from, true)
    if not s then return false end
    local rest = cmd:sub(e + 1)
    if (s == 1 or cmd:sub(s - 1, s - 1) == " ") and (rest:match("^/*$") or rest:match("^/* ")) then return true end
    from = e + 1
  end
end

-- The ps lines of main processes (no --type=, which Chromium helpers carry) for the profile.
local function profileProcs(psText, profile)
  local out = {}
  for line in (psText or ""):gmatch("[^\n]+") do
    local pid, cmd = line:match("^%s*(%d+)%s+(.*)$")
    if pid and not cmd:find(" --type=", 1, true) and hasProfile(cmd, profile) then
      out[#out + 1] = { pid = math.tointeger(tonumber(pid)), cmd = cmd }
    end
  end
  return out
end

return function(deps)
  local json = deps.json
  local M = {}

  -- The targets file now: aliases, or nil and why (file invalid). A missing file means no aliases.
  local function load()
    local text = deps.readFile(deps.targetsFile)
    if text == nil then return {}, nil, "missing" end
    local t, err = parse(json, text, deps.home)
    if not t then return nil, "invalid targets file: " .. err end
    return t, nil, "ok"
  end

  local function appPids(bundle)
    local ok, list = pcall(deps.apps, bundle)
    local out = {}
    for _, a in ipairs(ok and type(list) == "table" and list or {}) do
      local pid = type(a) == "table" and math.tointeger(a.pid)
      if pid then out[#out + 1] = pid end
    end
    table.sort(out)
    return out
  end

  -- One spec -> {ok=true, pid=} or {ok=false, reason=}.
  local function resolveSpec(spec)
    local pids = appPids(spec.bundle)
    if not spec.profile then
      if #pids == 0 then return { ok = false, reason = "target_not_running" } end
      local front = deps.frontPid()
      for _, pid in ipairs(pids) do if pid == front then return { ok = true, pid = pid } end end
      return { ok = true, pid = pids[1] }
    end
    local isApp = {}
    for _, pid in ipairs(pids) do isApp[pid] = true end
    local okPs, psText = pcall(deps.ps)
    for _, p in ipairs(profileProcs(okPs and psText or "", spec.profile)) do
      if isApp[p.pid] then
        if spec.refuse_debug_port and p.cmd:find("--remote-debugging-port", 1, true) then
          return { ok = false, reason = "debug_port", pid = p.pid,
            hint = "this profile runs with a debugging port; refuse_debug_port is set" }
        end
        return { ok = true, pid = p.pid }
      end
    end
    return { ok = false, reason = "target_not_running" }
  end

  -- resolve("chrome-agent") or resolve("com.apple.TextEdit"): an alias first, else a bundle id.
  -- Returns { ok=true, name, bundle, profile, pid } or { ok=false, reason, ... }.
  function M.resolve(name)
    if type(name) ~= "string" or #name > 64 or not name:match(NAME) then
      return { ok = false, reason = "bad_target", hint = "a target is an alias or a bundle id (letters, digits, . _ -)" }
    end
    local aliases, err = load()
    if not aliases then return { ok = false, reason = "targets_invalid", error = err } end
    local spec = aliases[name] or { name = name, bundle = name }
    local r = resolveSpec(spec)
    r.name, r.bundle, r.profile = name, spec.bundle, spec.profile
    return r
  end

  -- The eh.targets rows: each alias with name, bundle, profile, running and pid, sorted by name.
  -- Never anything secret: the file holds none.
  function M.list()
    local aliases, err, state = load()
    if not aliases then return { file = deps.targetsFile, error = err, targets = {} } end
    local names = {}
    for n in pairs(aliases) do names[#names + 1] = n end
    table.sort(names)
    local rows = {}
    for i, n in ipairs(names) do
      local spec = aliases[n]
      local r = resolveSpec(spec)
      rows[i] = { name = n, bundle = spec.bundle, profile = spec.profile, refuse_debug_port = spec.refuse_debug_port,
        mode_id = spec.mode_id, running = r.ok, pid = r.pid, reason = (not r.ok and r.reason ~= "target_not_running") and r.reason or nil }
    end
    return { file = deps.targetsFile, state = state, targets = rows }
  end

  -- For status: whether the file is there and valid, never its content.
  function M.fileState()
    local aliases, err, state = load()
    if not aliases then return { file = deps.targetsFile, error = err } end
    local n = 0
    for _ in pairs(aliases) do n = n + 1 end
    return { file = deps.targetsFile, state = state, count = n }
  end

  return M
end
