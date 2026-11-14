-- The live fixture test's read-only probe (design part 18, preconditions 1-4). The live test runs
--   hs -c 'return hs.json.encode(dofile("<this file>")({ spoon = "<EyesHands.spoon>", hold_file = "<path>" }))'
-- and reads one JSON object back. It only reads: it calls no function that changes another
-- driver's state, writes no global and no file. The hold file and the foreign drivers are judged by
-- the Spoon's own guards.lua, so the test and the Spoon use one set of rules.
--   opts.spoon       the EyesHands.spoon folder (guards.lua comes from it)
--   opts.hold_file   the driver lock to judge (nil: not judged)
--   opts.test        the test Spoon's global name (default "__eyeshands_test"), to see a leftover
-- Returns:
--   grants          { accessibility, screen_recording }
--   session         { locked, on_console }
--   idle_s          hs.host.idleTime(): seconds since the last hardware input
--   awake           harness.awakeInfo() ({ on, mode, owners }) or nil without a harness
--   add_event_tag   whether harness.addEventTag exists (design part 19, PR 2)
--   foreign         guards.foreign(): "jobhunt", "harness:<owner>" for armed hands owners
--   jobhunt         { loaded, info } (info: jobhunt.info() as JSON text, read before and after)
--   production      the running spoon.EyesHands: { running, port, lease, busy, armed (owners with
--                   hands), hold_file, tag_registered }, or { running = false }
--   hold            guards.holdInfo() for opts.hold_file, or nil
--   test_loaded     whether the test Spoon's global exists (a leftover from an earlier run)
return function(opts)
  opts = opts or {}
  local out = {}
  local function try(f, ...)
    local ok, v = pcall(f, ...)
    if ok then return v end
    return nil
  end

  out.grants = { accessibility = try(hs.accessibilityState, false) == true }
  if hs.screenRecordingState then out.grants.screen_recording = try(hs.screenRecordingState, false) == true end
  local p = try(hs.caffeinate.sessionProperties) or {}
  out.session = { locked = p.CGSSessionScreenIsLocked == true, on_console = p.kCGSSessionOnConsoleKey ~= false }
  out.idle_s = try(hs.host.idleTime)

  local h = rawget(_G, "harness")
  if type(h) == "table" then
    local awakeInfo = rawget(h, "awakeInfo")
    if type(awakeInfo) == "function" then
      local a = try(awakeInfo)
      if type(a) == "table" then out.awake = { on = a.on == true, mode = a.mode, owners = a.owners } end
    end
    out.add_event_tag = type(rawget(h, "addEventTag")) == "function"
  else
    out.add_event_tag = false
  end

  -- The hold file is read the way init.lua reads it.
  local function readHold(path)
    local f, _, code = io.open(path, "r")
    if not f then return nil, code == 2 and "missing" or "unreadable" end
    local ok, text, err = pcall(f.read, f, 65537)
    f:close()
    if not ok or (text == nil and err ~= nil) then return nil, "unreadable" end
    return text or ""
  end
  local function pidExists(pid) return os.execute("/bin/ps -p " .. math.floor(pid) .. " >/dev/null 2>&1") == true end
  local G = dofile(opts.spoon .. "/guards.lua")({
    now = hs.timer.secondsSinceEpoch, json = hs.json,
    global = function(name) return rawget(_G, name) end, detectors = {},
    holdFile = opts.hold_file, readHold = readHold, pidAlive = pidExists,
  })
  out.foreign = try(G.foreign) or { "unknown" }
  if opts.hold_file then out.hold = try(G.holdInfo) or { configured = true, held = true, kind = "unreadable" } end

  local jh = rawget(_G, "jobhunt")
  out.jobhunt = { loaded = type(jh) == "table" }
  local info = type(jh) == "table" and rawget(jh, "info")
  if type(info) == "function" then
    local v = try(info)
    if type(v) == "table" then v = try(hs.json.encode, v) end
    out.jobhunt.info = type(v) == "string" and v or nil
  end

  local sp = rawget(_G, "spoon")
  local eh = type(sp) == "table" and rawget(sp, "EyesHands") or nil
  local st = type(eh) == "table" and rawget(eh, "_s") and try(eh.status, eh) or nil
  if type(st) == "table" and st.running then
    local armed = {}
    for name, o in pairs(type(st.access) == "table" and st.access.owners or {}) do
      local hands = false
      for _, c in ipairs(type(o) == "table" and o.capabilities or {}) do if c == "hands" then hands = true end end
      if hands and o.armed == true then armed[#armed + 1] = tostring(name) end
    end
    table.sort(armed)
    local hs_ = type(st.hands) == "table" and st.hands or {}
    out.production = { running = true, port = st.port, lease = hs_.lease or nil, busy = hs_.busy or nil, armed = armed,
      hold_file = type(st.hold) == "table" and st.hold.file or nil, tag_registered = st.tag_registered == true }
  else
    out.production = { running = false }
  end

  out.test_loaded = rawget(_G, opts.test or "__eyeshands_test") ~= nil
  return out
end
