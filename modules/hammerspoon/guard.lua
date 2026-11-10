-- The awake guard (loaded by init.lua; see SETUP.md, "Awake guard"). Rule: nothing uses eyes or
-- hands without an awake hold, because the idle lock stops a run halfway and nothing can type into
-- a locked screen. Pure logic with no hs.* calls: init.lua passes the Hammerspoon pieces in, the
-- tests pass fakes.
--
-- Three kinds of screen driver are covered, each by a hold of its own named "guard.<name>":
--   port    an owner armed on the harness port (hsx): held from arm to disarm (or arm expiry, or
--           its pid exiting), and checked again before every authenticated call
--   driver  a Hammerspoon module whose public <name>.hands.status() says it is armed or busy
--           (init.lua probes them every 30 s): held while it stays so
--   input   events posted with harness.EVENT_TAG: held until 30 minutes after the last one
-- When the guard has to take a hold because nothing else held awake mode, it sends ONE alert per
-- owner per arm (or busy period), and at most one every 10 minutes, so one gap is one message.
-- An authenticated call is refused only when no hold can be taken (the screen is locked, or
-- Hammerspoon refused); every other call goes on as before.
--
-- deps: awake(on, opts) -> info table, awakeInfo() -> info table (init.lua's awake mode),
--       now() -> seconds, log(line), alert(text)
local DRIVER_MINUTES = 10      -- a driver's hold; renewed every tick while it stays armed or busy
local INPUT_MINUTES = 30       -- tagged input: released after this long without any
local PING_GAP = 600           -- at most one "took a hold" alert per 10 minutes

return function(deps)
  local now = deps.now
  local G = {}
  local eps = {}                -- hold name -> { name, source, pid, untilAt, renewAt, lastInput, held, reported, failed, lastErr }
  local lastPing

  local function stamp() return os.date("!%Y-%m-%dT%H:%M:%SZ", math.floor(now())) end
  local function clean(s) return (tostring(s or "-"):sub(1, 64):gsub("[^%w._:-]", "?")) end
  local function log(what, hold, extra) deps.log(string.format("%s guard %s owner=%s%s", stamp(), what, clean(hold), extra or "")) end
  local function holds(info, owner)
    for _, o in ipairs((info or {}).owners or {}) do if o == owner then return true end end
    return false
  end
  local function othersHold(info)   -- a hold the guard did not take
    for _, o in ipairs((info or {}).owners or {}) do if not o:match("^guard%.") then return true end end
    return false
  end

  -- Make sure "guard.<name>" holds awake mode. Returns true, or false and why not.
  local function cover(name, source, o)
    o = o or {}
    local hold = "guard." .. name
    local ep = eps[hold]
    if not ep then ep = { name = name, source = source }; eps[hold] = ep end
    if o.pid ~= nil then ep.pid = o.pid end
    if o.untilAt ~= nil then ep.untilAt = o.untilAt end
    local info = deps.awakeInfo() or {}
    local had = holds(info, hold)
    if had and not (ep.renewAt and now() >= ep.renewAt) then ep.held = true; return true end
    local minutes = o.minutes or (ep.untilAt and math.max(1, math.ceil((ep.untilAt - now()) / 60))) or 600
    local res = deps.awake(true, { owner = hold, pid = ep.pid, minutes = minutes, dim = true }) or {}
    if holds(res, hold) then
      ep.renewAt = o.minutes and now() + o.minutes * 30 or nil   -- renew a timed hold at half time
      ep.held, ep.failed, ep.lastErr = true, false, nil
      if not had then
        local gap = not othersHold(info)
        log("hold", hold, " source=" .. source .. (gap and " gap=yes" or " gap=no"))
        if gap and not ep.reported then
          ep.reported = true
          if not lastPing or now() - lastPing >= PING_GAP then
            lastPing = now()
            deps.alert(string.format("awake guard: %s used eyes/hands without an awake hold; harness took one", clean(name)))
          end
        end
      end
      return true
    end
    local why = type(res.reason) == "string" and res.reason or "awake mode refused"
    if ep.lastErr ~= why then log("refused", hold, " reason=" .. clean(why)); ep.lastErr = why end
    -- A hold that ended after the guard had one (a person at the Mac, a lock) is a stop on
    -- purpose: only a driver that never got a hold this time is an alert.
    if not ep.held and not ep.failed then
      ep.failed = true
      deps.alert(string.format("awake guard: %s is using eyes/hands with no awake hold, and none could be taken (%s)",
        clean(name), why))
    end
    return false, "no awake hold (" .. why .. ")"
  end

  local function release(hold, reason)
    local ep = eps[hold]
    if not ep then return end
    eps[hold] = nil
    if holds(deps.awakeInfo(), hold) then
      deps.awake(false, { owner = hold, lock = true, reason = reason })
      log("release", hold, " reason=" .. clean(reason))
    end
  end

  -- port.lua hooks: an arm starts the owner's hold, a disarm ends it, and every authenticated call
  -- checks it first (returns nil to go on, or why the call is refused).
  function G.armed(owner, pid, untilAt)
    eps["guard." .. owner] = nil   -- a new arm is a new episode (and may alert again); the hold stays
    cover(owner, "port", { pid = pid, untilAt = untilAt })
  end
  function G.disarmed(owner, reason) release("guard." .. owner, owner .. " disarmed (" .. tostring(reason) .. ")") end
  function G.beforeCall(owner, pid, untilAt)
    local ok, why = cover(owner, "port", { pid = pid, untilAt = untilAt })
    if not ok then return why end
  end

  -- A tagged event was posted (init.lua's tap calls this at most every 30 s).
  function G.input()
    local hold = "guard.input"
    cover("input", "input", { minutes = INPUT_MINUTES })
    if eps[hold] then eps[hold].lastInput = now() end
  end

  -- Every 30 s. drivers: { name = true (armed or busy) | false } from the module probe.
  function G.tick(drivers)
    drivers = drivers or {}
    for name, active in pairs(drivers) do
      if active then cover(name, "driver", { minutes = DRIVER_MINUTES }) end
    end
    local gone = {}
    for hold, ep in pairs(eps) do
      if ep.source == "driver" and not drivers[ep.name] then gone[hold] = ep.name .. " no longer armed or busy"
      elseif ep.source == "input" and now() - (ep.lastInput or 0) >= INPUT_MINUTES * 60 then gone[hold] = "no tagged input for " .. INPUT_MINUTES .. " minutes"
      end
    end
    for hold, why in pairs(gone) do release(hold, why) end
    for _, ep in pairs(eps) do
      if ep.source == "port" then cover(ep.name, "port")    -- a hold lost on the way is taken again
      elseif ep.source == "input" then cover("input", "input", { minutes = INPUT_MINUTES }) end
    end
  end

  -- For harness.status(): which screen drivers the guard covers.
  function G.info()
    local out = {}
    for hold, ep in pairs(eps) do out[hold] = { source = ep.source, held = holds(deps.awakeInfo(), hold) } end
    return out
  end

  return G
end
