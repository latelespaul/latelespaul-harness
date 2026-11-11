-- Eyes & Hands guards: the person always wins (part 10 of docs/eyes-hands-design.md).
-- Pure Lua 5.4 with no hs.* calls: init.lua passes the Hammerspoon pieces in, the tests pass fakes.
--
-- Before a hands job starts, check(ctx) runs the guards in this order; the first failure refuses:
--   1. stop switch   the stop hotkey or menu item was used in the last stop_minutes
--   2. hold file     cfg.hold_file (off by default) holds a manual hold or a live driver
--   3. foreign hands job-hunt or another driver is armed or busy (read only; never stopped)
--   4. lease         one owner at a time holds the cursor            (ctx.lease hook, hands.lua)
--   5. session       unlocked, display awake, no screen saver, on the console
--   6. present rule  no human input for idle_buffer_s (default 20), or the person consented
--   7. takeover      no takeover waits for hands_resume             (ctx.takeover hook, hands.lua)
--   8. focus         the target is frontmost
-- A refusal is { ok=false, reason=, hint=, ... } with the reasons of the design's part 9.
-- During a job, hands.lua repeats checks 2 (G.holdCheck), 5 (G.sessionCheck) and 8 every 250 ms;
-- hands_resume needs check 6 (G.presentCheck). The eyes commands (init.lua) run check 2 too.
--
-- The hold file (part 10): a JSON driver lock shared with other tools (job-hunt's driver.lock). It
-- is held when:
--   - it holds a manual hold {pid: 0, who, since, manual: true, until} and now < until (no `until`,
--     or one that does not parse, counts as held: the safe side);
--   - it names a pid that is alive ({pid, who, since}, or a bare pid as the whole file);
--   - it is a borrowed hold {pid, who, since, borrowed: <a manual hold>} whose pid is gone, and the
--     borrowed manual hold is held by the first rule;
--   - it cannot be read, is not JSON, or has neither a pid nor manual: true (the safe side).
-- No file means free. `since` and `until` are epoch milliseconds (seconds below 1e11) or ISO 8601.
-- A live pid that is the caller's own armed pid, or the one in the entry this Spoon wrote, is not
-- held for that check (the caller holds the lock itself).
-- The hands lease takes the lock (G.holdTake): {pid: <the caller's armed pid>, who: "eyeshands-
-- <owner>", since: <epoch ms>}, written to a temp file and hard-linked into place (the link fails
-- when the file exists), only when there is no file or its holder is stale (moved aside first to
-- <file>.stale-<pid>-<n>). G.holdDrop removes the file only while it still holds that exact entry;
-- a manual, borrowed or foreign hold is never touched. A crash leaves a dead pid: stale.
--
-- Foreign hands, read only (part 11): never a call that changes another driver's state, and never
-- a write to its table:
--   - rawget(_G, "jobhunt") whose hands.status() says armed or busy;
--   - the harness port (harness.portInfo()) listing an armed owner with the hands capability;
--   - each global named in cfg.detectors, by the same hands.status() rule.
--
-- deps: now() -> seconds, idleTime() -> seconds since the last hardware input,
--       holdFile (path or nil = off), readHold(path) -> text, or nil and "missing" | "unreadable",
--       writeHold(path, text) -> bool, linkHold(from, to) -> bool (fails when `to` exists),
--       moveHold(from, to) -> bool, removeHold(path),
--       pidAlive(pid) -> whether a process with that pid exists,
--       session() -> { locked, on_console, display_asleep, screensaver },
--       global(name) -> rawget(_G, name), json (decode for a status() that returns JSON text),
--       idleBuffer, stopMinutes, consentMinutes, detectors (names),
--       ownTag, tagRegistered() -> whether the harness takes our tag for machine input
local JOBHUNT_TAG = 0x4A484844       -- "JHHD", job-hunt's event tag
local HARNESS_TAG = 0x484E           -- harness.EVENT_TAG when no harness is loaded to read it from
local FOREIGN_RETRY = 60
local HOLD_MAX = 65536               -- bytes; a bigger hold file is malformed
local PID_TTL = 1                    -- seconds a pid check stays good (one exec per second at most)

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

  -- ---- 2. hold file -----------------------------------------------------------------------------
  -- An epoch time in seconds from a number (milliseconds when 1e11 or more) or an ISO 8601 text
  -- ("2026-11-11T09:30:00Z", fraction and +hh:mm allowed); nil when it does not parse.
  local function days(y, m, d)   -- days from 1970-01-01 to y-m-d (proleptic Gregorian)
    y = m <= 2 and y - 1 or y
    local era = y // 400
    local yoe = y - era * 400
    local doy = (153 * (m + (m > 2 and -3 or 9)) + 2) // 5 + d - 1
    return era * 146097 + yoe * 365 + yoe // 4 - yoe // 100 + doy - 719468
  end
  local function epoch(v)
    if type(v) == "string" and v:match("^%s*%-?[%d.]+%s*$") then v = tonumber(v) end
    if type(v) == "number" then
      if v ~= v or v < 0 or v == math.huge then return nil end
      return v >= 1e11 and v / 1000 or v
    end
    if type(v) ~= "string" then return nil end
    local y, mo, d, h, mi, sec, rest = v:match("^(%d%d%d%d)%-(%d%d)%-(%d%d)[Tt ](%d%d):(%d%d):(%d%d)(.*)$")
    if not y then return nil end
    y, mo, d, h, mi, sec = tonumber(y), tonumber(mo), tonumber(d), tonumber(h), tonumber(mi), tonumber(sec)
    if mo < 1 or mo > 12 or d < 1 or d > 31 or h > 23 or mi > 59 or sec > 60 then return nil end
    local frac, zone = rest:match("^(%.%d+)(.*)$")
    if frac then rest = zone end
    local off = 0
    if rest == "Z" or rest == "z" then off = 0
    else
      local sign, oh, om = rest:match("^([+-])(%d%d):?(%d%d)$")
      if not sign then return nil end
      off = (tonumber(oh) * 3600 + tonumber(om) * 60) * (sign == "-" and -1 or 1)
    end
    return days(y, mo, d) * 86400 + h * 3600 + mi * 60 + sec + (frac and tonumber("0" .. frac) or 0) - off
  end
  local pidSeen = {}                 -- pid -> { alive, at }
  local function alive(pid)
    local c = pidSeen[pid]
    if c and now() - c.at < PID_TTL then return c.alive end
    local ok, res = pcall(deps.pidAlive, pid)
    local a = not ok or res == true  -- a check that fails counts as alive: the safe side
    pidSeen = { [pid] = { alive = a, at = now() } }
    return a
  end
  local function whoOf(v) return type(v) == "string" and (v:sub(1, 64):gsub("[%c]", "?")) or nil end
  local function pidOf(v)
    if v == nil then return nil, true end
    local n = math.tointeger(tonumber(v))
    if type(v) == "number" and n and n >= 0 then return n, true end
    return nil, false
  end
  -- The state of one decoded holder: { held, kind, who, since, untilAt, pid } (kind: manual, pid,
  -- borrowed, malformed, or free).
  local function holder(j, inner)
    if type(j) ~= "table" then return { held = true, kind = "malformed" } end
    local pid, okPid = pidOf(j.pid)
    if not okPid or (j.manual ~= nil and type(j.manual) ~= "boolean") then return { held = true, kind = "malformed" } end
    local info = { who = whoOf(j.who), since = epoch(j.since), pid = pid }
    if j.manual == true then
      info.untilAt = epoch(j["until"])
      if not info.untilAt or now() < info.untilAt then info.held, info.kind = true, "manual"; return info end
    end
    if pid and pid > 0 and alive(pid) then info.held, info.kind = true, "pid"; return info end
    if j.borrowed ~= nil then
      if inner or type(j.borrowed) ~= "table" or j.borrowed.manual ~= true then return { held = true, kind = "malformed" } end
      local b = holder(j.borrowed, true)
      if b.held then b.kind = b.kind == "manual" and "borrowed" or b.kind end
      return b
    end
    if pid == nil and j.manual ~= true then return { held = true, kind = "malformed" } end
    info.held, info.kind = false, "free"
    return info
  end
  -- The state of the hold file's text (nil and why when there is none).
  local function holdState(text, why)
    if text == nil then return why == "missing" and { held = false, kind = "missing" } or { held = true, kind = "unreadable" } end
    if #text > HOLD_MAX then return { held = true, kind = "malformed" } end
    if text:match("^%s*%d+%s*$") then return holder({ pid = math.tointeger(tonumber(text)) }) end
    local okJ, j = pcall(json.decode, text)
    return holder(okJ and j or nil)
  end
  local function readState(path)
    local ok, text, why = pcall(deps.readHold, path)
    if not ok then return { held = true, kind = "unreadable" } end
    return holdState(text, why)
  end
  local function report(h)
    local out = { configured = true, file = deps.holdFile, held = h.held == true, kind = h.kind, who = h.who, pid = h.pid,
      since = h.since and stamp(h.since) or nil, ["until"] = h.untilAt and stamp(h.untilAt) or nil }
    if out.held then
      out.retry_after_s = h.kind ~= "pid" and h.untilAt and math.max(1, ceil(h.untilAt - now())) or FOREIGN_RETRY
    end
    return out
  end
  local mine = nil                   -- { pid, who, since } the entry this Spoon wrote
  local function refusal(h)
    local hint = (h.kind == "unreadable" or h.kind == "malformed")
      and "the hold file cannot be read; it counts as held until it is fixed or removed; do offline work only"
      or h.kind == "pid" and "another driver holds the desktop lock; wait, never force"
      or "the person holds the desktop; do offline work only until the hold ends; never force"
    return { ok = false, reason = "held", kind = h.kind, who = h.who, pid = h.pid, since = h.since, ["until"] = h["until"],
      retry_after_s = h.retry_after_s, hint = hint }
  end
  local function exempt(h, selfPid)
    return h.kind == "pid" and h.pid ~= nil and (h.pid == selfPid or (mine ~= nil and h.pid == mine.pid))
  end
  -- What the hold file says now: { configured = false }, or { configured, file, held, kind, who,
  -- since, until, pid, retry_after_s } (kind: missing, manual, pid, borrowed, unreadable, malformed,
  -- free).
  function G.holdInfo()
    if not deps.holdFile then return { configured = false } end
    return report(readState(deps.holdFile))
  end
  -- nil when the hold file is off or free, or held by selfPid (the caller's armed pid), else the
  -- `held` refusal.
  function G.holdCheck(selfPid)
    local h = G.holdInfo()
    if not h.held or exempt(h, selfPid) then return nil end
    return refusal(h)
  end

  local function isMine(path, e)
    local ok, text = pcall(deps.readHold, path)
    if not ok or type(text) ~= "string" then return false end
    local okJ, j = pcall(json.decode, text)
    return okJ and type(j) == "table" and j.pid == e.pid and j.who == e.who and j.since == e.since
  end
  local function cannot(hint) return { ok = false, reason = "held", kind = "unwritable", retry_after_s = FOREIGN_RETRY, hint = hint } end
  -- Takes the driver lock for pid (the caller's armed pid) as `who`: nil when it is taken, is ours
  -- already, is held by pid itself, or no hold file is set; else the `held` refusal.
  function G.holdTake(pid, who)
    local file = deps.holdFile
    if not file then return nil end
    if mine and isMine(file, mine) then return nil end
    mine = nil
    pid = math.tointeger(tonumber(pid))
    if not pid or pid <= 0 then return cannot("arm with a pid (hsx arm passes the runner's) so the driver lock can name it") end
    local e = { pid = pid, who = tostring(who), since = math.floor(now() * 1000) }
    local body, tmp = json.encode(e), file .. ".take-" .. pid
    for i = 0, 2 do
      local okW, wrote = pcall(deps.writeHold, tmp, body)
      local okL, linked = false, false
      if okW and wrote then okL, linked = pcall(deps.linkHold, tmp, file) end
      pcall(deps.removeHold, tmp)
      if not (okW and wrote) then return cannot("the hold file cannot be written; fix its folder") end
      if okL and linked then
        if isMine(file, e) then mine = e; return nil end
        break
      end
      local h = readState(file)
      if h.held then
        if exempt(report(h), pid) then return nil end
        return refusal(report(h))
      end
      if h.kind ~= "missing" then
        local aside = file .. ".stale-" .. pid .. "-" .. i
        local okM, moved = pcall(deps.moveHold, file, aside)
        if okM and moved then
          local m = readState(aside)
          if m.held then
            pcall(deps.moveHold, aside, file)
            return refusal(report(m))
          end
          pcall(deps.removeHold, aside)
        end
      end
    end
    local h = report(readState(file))
    if not h.held then return cannot("could not take the driver lock; try again") end
    if exempt(h, pid) then return nil end
    return refusal(h)
  end
  -- Removes the driver lock while it still holds the entry this Spoon wrote; never another one.
  function G.holdDrop()
    local e = mine
    mine = nil
    if e and deps.holdFile and isMine(deps.holdFile, e) then pcall(deps.removeHold, deps.holdFile) end
  end

  -- ---- 3. foreign hands -------------------------------------------------------------------------
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

  -- ---- 5. session -------------------------------------------------------------------------------
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

  -- ---- 6. present rule --------------------------------------------------------------------------
  -- Known machine tags: ours, harness.EVENT_TAG, and job-hunt's; any other tag is a person.
  local function machineTag(tag)
    if tag == deps.ownTag or tag == JOBHUNT_TAG then return true end
    local h = deps.global("harness")
    local htag = type(h) == "table" and rawget(h, "EVENT_TAG") or HARNESS_TAG
    if tag == htag then return true end
    return false
  end
  -- While the takeover tap runs (hands.lua), it reports each event here. An event with no known
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

  -- Checks 5 and 6 alone: nil when they pass, else the refusal.
  G.sessionCheck, G.presentCheck = sessionRefusal, presentRefusal

  -- ---- the order --------------------------------------------------------------------------------
  -- ctx: { owner, pid (the caller's armed pid), targetPid, frontPid, lease = fn(owner) -> refusal|nil, takeover = fn() -> refusal|nil }
  -- Returns nil when hands may start, else the first refusal.
  function G.check(ctx)
    ctx = ctx or {}
    local st = G.stopInfo()
    if st.stopped then
      return { ok = false, reason = "stopped", by = st.by, ["until"] = st["until"], retry_after_s = st.retry_after_s,
        hint = "the person pressed the stop switch; stop and report" }
    end
    local held = G.holdCheck(ctx.pid)
    if held then return held end
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
