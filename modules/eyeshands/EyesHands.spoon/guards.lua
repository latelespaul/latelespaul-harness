-- Eyes & Hands guards: the person always wins (part 10 of docs/eyes-hands-design.md).
-- Pure Lua 5.4 with no hs.* calls: init.lua passes the Hammerspoon pieces in, the tests pass fakes.
--
-- Before a hands job starts, check(ctx) runs the guards in this order; the first failure refuses:
--   1. stop switch   the stop hotkey or menu item was used in the last stop_minutes
--   2. foreign hands job-hunt or another driver is armed or busy (read only; never stopped)
--   3. lease         one owner at a time holds the cursor            (ctx.lease hook, hands PR)
--   4. session       unlocked, display awake, no screen saver, on the console
--   5. present rule  no human input for idle_buffer_s (default 20), or the person consented
--   6. takeover      no takeover waits for hands_resume             (ctx.takeover hook, hands PR)
--   7. focus         the target is frontmost
-- A refusal is { ok=false, reason=, hint=, ... } with the reasons of the design's part 9.
-- Eyes never come here: they post no input, so they work while a person is present.
--
-- Foreign hands, read only (part 11): never a call that changes another driver's state, and never
-- a write to its table:
--   - rawget(_G, "jobhunt") whose hands.status() says armed or busy;
--   - the harness port (harness.portInfo()) listing an armed owner with the hands capability;
--   - each global named in cfg.detectors, by the same hands.status() rule.
--
-- deps: now() -> seconds, idleTime() -> seconds since the last hardware input,
--       session() -> { locked, on_console, display_asleep, screensaver },
--       global(name) -> rawget(_G, name), json (decode for a status() that returns JSON text),
--       idleBuffer, stopMinutes, consentMinutes, detectors (names),
--       ownTag, tagRegistered() -> whether the harness takes our tag for machine input
local JOBHUNT_TAG = 0x4A484844       -- "JHHD", job-hunt's event tag
local HARNESS_TAG = 0x484E           -- harness.EVENT_TAG when no harness is loaded to read it from
local FOREIGN_RETRY = 60

return function(deps)
  local now, json = deps.now, deps.json
  local G = {}
  local stop = nil                   -- { untilAt, by }
  local consentUntil = nil
  local tapOn, lastHuman = false, nil

  local function ceil(x) return math.tointeger(math.ceil(x)) or math.ceil(x) end
  local function stamp(t) return os.date("!%Y-%m-%dT%H:%M:%SZ", math.floor(t)) end

  -- ---- 1. stop switch ---------------------------------------------------------------------------
  -- stopFor(by): new hands are refused for stopMinutes (the hotkey and the menu item). The CLI stop
  -- only disarms (init.lua), so it does not come here.
  function G.stopFor(by, minutes)
    stop = { untilAt = now() + (minutes or deps.stopMinutes) * 60, by = tostring(by or "stop switch") }
    return stop.untilAt
  end
  function G.clearStop() stop = nil end
  function G.stopInfo()
    if stop and now() >= stop.untilAt then stop = nil end
    if not stop then return { stopped = false } end
    return { stopped = true, by = stop.by, ["until"] = stamp(stop.untilAt), retry_after_s = ceil(stop.untilAt - now()) }
  end

  -- ---- 2. foreign hands -------------------------------------------------------------------------
  -- A global table's hands.status() (a table or JSON text) says armed=true or a busy job. rawget at
  -- every level, so no metatable (hs's lazy loader, say) runs.
  local function handsBusy(mod)
    local hands = type(mod) == "table" and rawget(mod, "hands")
    local status = type(hands) == "table" and rawget(hands, "status")
    if type(status) ~= "function" then return false end
    local ok, st = pcall(status)
    if ok and type(st) == "string" then ok, st = pcall(json.decode, st) end
    return ok and type(st) == "table" and (st.armed == true or (st.busy ~= nil and st.busy ~= false)) or false
  end
  -- The drivers that hold hands now, as names ("jobhunt", "harness:<owner>", a detector name).
  function G.foreign()
    local out = {}
    if handsBusy(deps.global("jobhunt")) then out[#out + 1] = "jobhunt" end
    local h = deps.global("harness")
    local portInfo = type(h) == "table" and rawget(h, "portInfo")
    if type(portInfo) == "function" then
      local ok, info = pcall(portInfo)
      local owners = ok and type(info) == "table" and type(info.owners) == "table" and info.owners or {}
      local names = {}
      for name, o in pairs(owners) do
        local hands = false
        for _, c in ipairs(type(o) == "table" and type(o.capabilities) == "table" and o.capabilities or {}) do
          if c == "hands" then hands = true end
        end
        if hands and o.armed == true then names[#names + 1] = "harness:" .. tostring(name) end
      end
      table.sort(names)
      for _, n in ipairs(names) do out[#out + 1] = n end
    end
    for _, name in ipairs(deps.detectors or {}) do
      if name ~= "jobhunt" and handsBusy(deps.global(name)) then out[#out + 1] = name end
    end
    return out
  end

  -- ---- 4. session -------------------------------------------------------------------------------
  local function sessionRefusal()
    local ok, s = pcall(deps.session)
    s = ok and type(s) == "table" and s or { locked = true }   -- unknown counts as locked: fail closed
    local why = s.locked and "screen locked" or s.on_console == false and "session not on the console"
      or s.display_asleep and "display asleep" or s.screensaver and "screen saver running" or nil
    if why then return { ok = false, reason = "locked", why = why, hint = "stop and report; never retry in a loop" } end
    -- A harness that cannot take our tag for machine input locks the screen on our first event in
    -- its away mode (design part 11), so hands wait while it is away.
    if not deps.tagRegistered() then
      local h = deps.global("harness")
      local awakeInfo = type(h) == "table" and rawget(h, "awakeInfo")
      if type(awakeInfo) == "function" then
        local okA, info = pcall(awakeInfo)
        if okA and type(info) == "table" and info.mode == "away" then
          return { ok = false, reason = "awake_away", retry_after_s = FOREIGN_RETRY,
            hint = "harness awake mode is away and cannot tell Eyes & Hands input from a person; update the harness" }
        end
      end
    end
  end

  -- ---- 5. present rule --------------------------------------------------------------------------
  -- Known machine tags: ours, harness.EVENT_TAG, and job-hunt's; any other tag is a person.
  local function machineTag(tag)
    if tag == deps.ownTag or tag == JOBHUNT_TAG then return true end
    local h = deps.global("harness")
    local htag = type(h) == "table" and rawget(h, "EVENT_TAG") or HARNESS_TAG
    if tag == htag then return true end
    return false
  end
  -- While the takeover tap runs (hands PR), it reports each event here. An event with no known
  -- machine tag is a person; one with a known tag is not (a job-hunt event is not a person).
  function G.noteEvent(tag)
    if not machineTag(tag) then lastHuman = now(); return true end
    return false
  end
  -- The tap started or stopped. While it runs, the last human event it saw is the clock; it starts
  -- from the hardware idle time, so a person who just left still counts.
  function G.tap(on)
    if on and not tapOn then lastHuman = now() - (tonumber(deps.idleTime()) or 0) end
    tapOn = on == true
  end
  -- Seconds since the last human input: the tap's clock while it runs, else the hardware idle time.
  local function humanIdle()
    if tapOn and lastHuman then return math.max(0, now() - lastHuman), "tap" end
    local ok, v = pcall(deps.idleTime)
    return (ok and tonumber(v)) or 0, "idle_time"
  end
  -- The person at the Mac lets agents drive now (the menu bar item). A CLI cannot give consent.
  function G.consent(minutes)
    consentUntil = now() + (minutes or deps.consentMinutes) * 60
    return consentUntil
  end
  function G.clearConsent() consentUntil = nil end
  function G.presentInfo()
    local idle, source = humanIdle()
    local consent = consentUntil and now() < consentUntil
    return { present = idle < deps.idleBuffer, human_idle_s = math.floor(idle), idle_buffer_s = deps.idleBuffer,
      source = source, consent_until = consent and stamp(consentUntil) or nil }
  end
  local function presentRefusal()
    if consentUntil and now() < consentUntil then return nil end
    local idle = humanIdle()
    if idle >= deps.idleBuffer then return nil end
    return { ok = false, reason = "present", human_idle_s = math.floor(idle), idle_buffer_s = deps.idleBuffer,
      retry_after_s = math.max(1, ceil(deps.idleBuffer - idle)), hint = "ask the person, or wait" }
  end

  -- ---- the order --------------------------------------------------------------------------------
  -- ctx: { owner, targetPid, frontPid, lease = fn(owner) -> refusal|nil, takeover = fn() -> refusal|nil }
  -- Returns nil when hands may start, else the first refusal.
  function G.check(ctx)
    ctx = ctx or {}
    local st = G.stopInfo()
    if st.stopped then
      return { ok = false, reason = "stopped", by = st.by, ["until"] = st["until"], retry_after_s = st.retry_after_s,
        hint = "the person pressed the stop switch; stop and report" }
    end
    local by = G.foreign()
    if #by > 0 then
      return { ok = false, reason = "foreign_hands", by = by, retry_after_s = FOREIGN_RETRY, hint = "wait; never force" }
    end
    if ctx.lease then
      local r = ctx.lease(ctx.owner)
      if r then return r end
    end
    local r = sessionRefusal()
    if r then return r end
    r = presentRefusal()
    if r then return r end
    if ctx.takeover then
      r = ctx.takeover()
      if r then return r end
    end
    if ctx.targetPid ~= nil and ctx.frontPid ~= ctx.targetPid then
      return { ok = false, reason = "focus", hint = "call hands_focus" }
    end
    return nil
  end

  return G
end
