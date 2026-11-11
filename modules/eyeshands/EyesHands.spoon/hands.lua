-- Eyes & Hands hands: real mouse and keyboard input with human timing (parts 9, 10 and 13 of
-- docs/eyes-hands-design.md). Lua 5.4; every Hammerspoon piece comes in through deps (init.lua
-- passes hs.eventtap and friends, the tests pass fakes), so this file calls no hs.* itself.
--
-- init.lua registers each command on the port (eh.hands.<name>), all with the `hands` capability;
-- the ones with a target also need it in the owner's apps:
--   focus  {target}                          brings the target to the front (no posted input)
--   move   {target, to}                      a planned cursor path
--   click  {target, to?, clicks 1-3, button left|right}   move, settle, press, hold, release
--   type   {target, text, paste?}            per-character keys; over 300 characters a paste
--   key    {target, combo}                   "cmd+shift+g": modifiers down, the key, modifiers up
--   scroll {target, dy, dx?, at?}            wheel ticks (dy > 0 scrolls the page down)
--   drag   {target, from, to}                press at from, a dragged path, release at to
--   play   {target, events[], rect?}         a pre-planned event list (the jobhunt.lua format)
--   job    {id}                              one job's report
--   status {}                                lease, busy, interrupted, interrupts, pos, watch
--   resume {}                                clears a takeover, only when the present rule passes
--   abort  {}                                stops the caller's running job
-- `to`, `from` and `at` are {field = "f3"} (an id from eyes_fields, read again just before the
-- plan), {rect = {x, y, w, h}} or {x =, y =}, in global screen points.
--
-- Jobs. A command that posts input plans it (planner.lua), starts a job and returns at once with
-- {ok, job, state = "running", planned_ms}. A 4 ms timer posts the due events, so the main thread
-- never blocks. Final states: done, interrupted (takeover), focus (the target lost the front),
-- locked, failed, aborted. Every 250 ms during a job the session (guard 4) and the front app
-- (guard 7) are checked again; the takeover tap ends the job at its next tick.
--
-- Every posted event carries EVENT_TAG in eventSourceUserData; nothing is posted any other way.
-- A job that ends early (any state) releases a held mouse button and every held key or modifier,
-- and puts the clipboard back, so a cut-off cmd+v never leaves cmd down.
--
-- Lease. One owner at a time holds the cursor. An owner takes the lease with its first hands job
-- (or focus) that passes the guards; it ends on hands_release (disarm), on any disarm, on unload,
-- or after 2 minutes with no hands call and no job. While a lease exists:
--   - the takeover tap runs: it only reads (it never changes, delays or drops an event); any event
--     without EVENT_TAG ends the job and refuses hands until resume; each event also feeds the
--     present rule's clock (guards.noteEvent), where known machine tags are not a person;
--   - an awake hold keeps the screen awake: harness.awake(true, {owner = "eyeshands-<owner>",
--     minutes, pid = <the caller's pid>}), released with lock = true when the lease ends (awake mode
--     locks only in away mode, never on a person). Without the harness: hs.caffeinate displayIdle.
-- Typed text is never logged and never part of a reply or an error.
--
-- deps: tag, planner (planner.lua), guards (guards.lua instance), now() -> seconds,
--       nowMs() -> monotonic ms, seed() -> integer, layout() -> planner layout,
--       resolve(name) -> targets.resolve result, frontPid() -> pid or nil,
--       windows(pid) -> { {x, y, w, h}, ... } the target's visible windows,
--       field(args, owner) -> eyes.value result, activate(pid) -> bool,
--       event = hs.eventtap.event (newMouseEvent, newKeyEvent, newScrollEvent, types, properties),
--       newTap(types, fn) -> tap (start, stop, isEnabled), every(secs, fn) -> started timer (stop),
--       pasteboard = hs.pasteboard (readAllData, writeAllData, setContents, clearContents,
--       changeCount), mousePos() -> {x, y}, global(name) -> rawget(_G, name),
--       caffeinate(on) (standalone awake), log(line)
local LEASE_IDLE_S = 120
local AWAKE_MINUTES, AWAKE_RENEW_S = 10, 300
local CHECK_MS = 250
local MAX_EVENTS = 40000
local MAX_TEXT = 100000             -- characters; over PASTE_LIMIT only as a paste
local KEYED_TEXT = 5000             -- the most characters `paste: false` types key by key
local KEEP_JOBS = 20
local NO_KEY = 0x7F                 -- a virtual key code no Apple keyboard has, for Unicode-only keys
local COORD = 100000

local function round(v) return math.floor(v * 10 + 0.5) / 10 end
local function int(v) return math.floor((tonumber(v) or 0) + 0.5) end
local function stamp(t) return os.date("!%Y-%m-%dT%H:%M:%SZ", math.floor(t)) end
local function clean(s) return (tostring(s or "-"):sub(1, 64):gsub("[^%w._:-]", "?")) end
local function refuse(reason, hint, extra)
  local out = extra or {}
  out.ok, out.reason, out.hint = false, reason, hint
  return out
end
local function num(v) return type(v) == "number" and v == v and math.abs(v) <= COORD end

return function(deps)
  local P, G, TAG = deps.planner, deps.guards, deps.tag
  local E = deps.event
  local T, PR = E.types, E.properties
  local H = {}
  local lease = nil      -- { owner, pid, lastUse, since, awake = "harness"|"caffeinate"|nil, renewed }
  local takeover = nil   -- { by, x, y, at }
  local interrupts = 0
  local job = nil        -- the running job
  local jobs, nextId = {}, 0
  local tap = nil
  local button = nil     -- "left" | "right" while a button is held
  local held = {}        -- key code -> "key" | "flag"
  local saved = nil      -- { data, change } the clipboard before a paste
  local last = { x = -1e9, y = -1e9, at = -1e9 }

  local function log(line) if deps.log then pcall(deps.log, stamp(deps.now()) .. " " .. line) end end
  local function harnessFn(name)
    local h = deps.global("harness")
    local f = type(h) == "table" and rawget(h, name)
    return type(f) == "function" and f or nil
  end

  -- ---- posting ----------------------------------------------------------------------------------
  local function flagsTable(f)
    f = math.tointeger(f) or 0
    local t = {}
    if f & P.FLAG.shift ~= 0 then t.shift = true end
    if f & P.FLAG.ctrl ~= 0 then t.ctrl = true end
    if f & P.FLAG.alt ~= 0 then t.alt = true end
    if f & P.FLAG.cmd ~= 0 then t.cmd = true end
    return t
  end
  local function send(ev)
    ev:setProperty(PR.eventSourceUserData, TAG)
    ev:post()
  end
  local function mouse(kind, e)
    local right = (e.button or button) == "right"
    local types = {
      move = (button == "right" and T.rightMouseDragged) or (button and T.leftMouseDragged) or T.mouseMoved,
      down = right and T.rightMouseDown or T.leftMouseDown,
      up = right and T.rightMouseUp or T.leftMouseUp,
    }
    local ev = E.newMouseEvent(types[kind], { x = e.x, y = e.y })
    if kind == "move" then
      ev:setProperty(PR.mouseEventDeltaX, int(e.dx))
      ev:setProperty(PR.mouseEventDeltaY, int(e.dy))
    else
      ev:setProperty(PR.mouseEventClickState, int(e.clicks or 1))
    end
    last = { x = e.x, y = e.y, at = deps.nowMs() }
    return ev
  end
  local function keyEvent(e, down)
    local code = e.key ~= nil and int(e.key) or NO_KEY
    local ev = E.newKeyEvent({}, code, down)
    if e.chars and e.chars ~= "" then ev:setUnicodeString(e.chars) end
    ev:setFlags(flagsTable(e.flags))
    return ev, code
  end
  local function restoreClipboard()
    local s = saved
    if not s then return end
    saved = nil
    local pb = deps.pasteboard
    if pb.changeCount() ~= s.change then return end   -- something else wrote to it meanwhile
    pb.clearContents()
    if next(s.data) then pb.writeAllData(s.data) end
  end
  local POST = {
    move = function(e) send(mouse("move", e)) end,
    down = function(e)
      local ev = mouse("down", e)
      button = e.button == "right" and "right" or "left"
      send(ev)
    end,
    up = function(e)
      local ev = mouse("up", e)
      button = nil
      send(ev)
    end,
    keyDown = function(e) local ev, code = keyEvent(e, true); held[code] = "key"; send(ev) end,
    keyUp = function(e) local ev, code = keyEvent(e, false); held[code] = nil; send(ev) end,
    -- A modifier's key code gives a flagsChanged event.
    flagsDown = function(e) local ev, code = keyEvent(e, true); held[code] = "flag"; send(ev) end,
    flagsUp = function(e) local ev, code = keyEvent(e, false); held[code] = nil; send(ev) end,
    scroll = function(e) send(E.newScrollEvent({ int(e.dx), int(e.dy) }, {}, "pixel")) end,
    paste = function(e)
      local pb = deps.pasteboard
      saved = saved or { data = pb.readAllData() or {} }
      pb.setContents(e.text or "")
      saved.change = pb.changeCount()
    end,
    restore = restoreClipboard,
  }
  -- Never leave a button or a key held, or the clipboard swapped.
  local function letGo()
    if button then pcall(POST.up, { x = last.x, y = last.y, button = button }) end
    button = nil
    for code, kind in pairs(held) do
      pcall(kind == "flag" and POST.flagsUp or POST.keyUp, { key = code, flags = 0 })
    end
    held = {}
    pcall(restoreClipboard)
  end

  -- ---- jobs -------------------------------------------------------------------------------------
  local function report(j)
    local out = { ok = j.state == "done" or j.state == "running", job = j.id, kind = j.kind, state = j.state,
      posted = j.i - 1, total = j.total, elapsed_ms = math.floor((j.endedMs or deps.nowMs()) - j.t0 + 0.5),
      planned_ms = j.planned }
    if j.at then out.at = { round(j.at.x), round(j.at.y) } end
    if not out.ok then out.reason = j.state end
    for k, v in pairs(j.extra or {}) do out[k] = v end
    return out
  end
  local function finish(j, state, extra)
    if j.timer then pcall(function() j.timer:stop() end); j.timer = nil end
    if state ~= "done" then letGo() else pcall(restoreClipboard) end
    j.state, j.extra, j.endedMs = state, extra, deps.nowMs()
    if job == j then job = nil end
    if lease then lease.lastUse = deps.now() end
    jobs[j.id] = j
    jobs[j.id - KEEP_JOBS] = nil
    log(string.format("job owner=%s id=%d kind=%s state=%s posted=%d/%d", clean(j.owner), j.id, j.kind, state, j.i - 1, j.total))
  end
  local function frontOk(j)
    local ok, front = pcall(deps.frontPid)
    return ok and front == j.pid
  end
  local function tick()
    local j = job
    if not j then return end
    if takeover then return finish(j, "interrupted", { by = takeover.by }) end
    local t = deps.nowMs() - j.t0
    if t - j.lastCheck >= CHECK_MS then
      j.lastCheck = t
      local r = G.sessionCheck()
      if r then return finish(j, "locked", { why = r.why or r.reason }) end
      if not frontOk(j) then return finish(j, "focus", { hint = "call hands_focus" }) end
    end
    while j.i <= j.total and j.events[j.i].t <= t do
      local e = j.events[j.i]
      local ok, err = pcall(POST[e.type], e)
      if not ok then return finish(j, "failed", { error = tostring(err):sub(1, 120) }) end
      if e.x then j.at = { x = e.x, y = e.y } end
      j.i = j.i + 1
    end
    if j.i > j.total then finish(j, "done") end
  end

  -- ---- lease, tap and awake hold ----------------------------------------------------------------
  local WATCH = { T.mouseMoved, T.leftMouseDown, T.leftMouseUp, T.rightMouseDown, T.rightMouseUp, T.otherMouseDown,
    T.otherMouseUp, T.leftMouseDragged, T.rightMouseDragged, T.otherMouseDragged, T.scrollWheel, T.keyDown, T.keyUp,
    T.flagsChanged }
  local NAMES = {
    [T.mouseMoved] = "mouseMoved", [T.leftMouseDown] = "mouseDown", [T.rightMouseDown] = "mouseDown",
    [T.otherMouseDown] = "mouseDown", [T.leftMouseUp] = "mouseUp", [T.rightMouseUp] = "mouseUp",
    [T.otherMouseUp] = "mouseUp", [T.leftMouseDragged] = "mouseDragged", [T.rightMouseDragged] = "mouseDragged",
    [T.otherMouseDragged] = "mouseDragged", [T.scrollWheel] = "scroll", [T.keyDown] = "keyDown", [T.keyUp] = "keyUp",
    [T.flagsChanged] = "flagsChanged",
  }
  -- The tap only reads: it returns false for every event, so each one goes on unchanged.
  local function onEvent(ev)
    local ok = pcall(function()
      local tag = ev:getProperty(PR.eventSourceUserData)
      if tag == TAG then return end
      local t = ev:getType()
      local loc = ev:location() or { x = 0, y = 0 }
      if t == T.mouseMoved or t == T.leftMouseDragged or t == T.rightMouseDragged then
        -- No movement, or the window server echoing the move we just posted.
        if ev:getProperty(PR.mouseEventDeltaX) == 0 and ev:getProperty(PR.mouseEventDeltaY) == 0 then return end
        if deps.nowMs() - last.at < 300 and math.abs(loc.x - last.x) < 2 and math.abs(loc.y - last.y) < 2 then return end
      end
      G.noteEvent(tag)
      if not takeover then
        takeover = { by = NAMES[t] or ("event" .. tostring(t)), x = round(loc.x), y = round(loc.y), at = stamp(deps.now()) }
        interrupts = interrupts + 1
      end
    end)
    if not ok then takeover = takeover or { by = "unknown", at = stamp(deps.now()) } end
    return false
  end
  local function tapState()
    if not tap then return "off" end
    local ok, on = pcall(tap.isEnabled, tap)
    return (ok and on) and "tap" or "disabled"
  end

  local function awakeTake(l)
    local awake = harnessFn("awake")
    l.renewed = deps.now()
    if awake then
      local ok, res = pcall(awake, true, { owner = "eyeshands-" .. l.owner, minutes = AWAKE_MINUTES, pid = l.pid })
      l.awake = "harness"
      if not ok then log("awake owner=" .. clean(l.owner) .. " hold failed") end
      return res
    end
    pcall(deps.caffeinate, true)
    l.awake = "caffeinate"
  end
  local function awakeRelease(l)
    if l.awake == "harness" then
      local awake = harnessFn("awake")
      if awake then pcall(awake, false, { owner = "eyeshands-" .. l.owner, lock = true, reason = "eyeshands lease ended" }) end
    elseif l.awake == "caffeinate" then
      pcall(deps.caffeinate, false)
    end
    l.awake = nil
  end

  local function endLease(reason)
    local l = lease
    if not l then return false end
    if job then finish(job, "aborted", { why = reason }) end
    lease = nil
    if tap then pcall(function() tap:stop() end); tap = nil end
    G.tap(false)
    takeover, interrupts = nil, 0
    awakeRelease(l)
    log(string.format("lease-end owner=%s reason=%s", clean(l.owner), clean(reason)))
    return true
  end
  local function takeLease(caller)
    if lease then lease.lastUse = deps.now(); return end
    lease = { owner = caller.owner, pid = caller.pid, lastUse = deps.now(), since = deps.now() }
    G.tap(true)
    local ok, t = pcall(deps.newTap, WATCH, onEvent)
    if ok and t then
      tap = t
      pcall(function() tap:start() end)
    end
    awakeTake(lease)
    log(string.format("lease owner=%s pid=%s", clean(caller.owner), caller.pid and tostring(math.floor(caller.pid)) or "-"))
  end

  -- Every few seconds (init.lua): the 2-minute idle end, a tap that macOS turned off, the awake
  -- hold's renewal while the lease lasts.
  function H.sweep()
    local l = lease
    if not l then return end
    if not job and deps.now() - l.lastUse >= LEASE_IDLE_S then return endLease("idle") end
    if tap and tapState() == "disabled" then pcall(function() tap:start() end) end
    if l.awake == "harness" and deps.now() - (l.renewed or 0) >= AWAKE_RENEW_S then awakeTake(l) end
  end

  -- ---- the guards -------------------------------------------------------------------------------
  local function leaseCheck(owner)
    if lease and lease.owner ~= owner then
      return refuse("lease_held", "another Eyes & Hands owner holds the cursor; wait for its release",
        { by = lease.owner, retry_after_s = math.max(1, math.ceil(LEASE_IDLE_S - (deps.now() - lease.lastUse))) })
    end
    if job then
      return refuse("busy", "a job is running; poll eh.hands.job or call hands_abort", { busy = job.id })
    end
  end
  local function takeoverCheck()
    if not takeover then return nil end
    return refuse("interrupted", "the person took over; wait until they leave, then hands_resume",
      { by = takeover.by, since = takeover.at, interrupts = interrupts })
  end
  -- Guards 1-7 for the target: the target's pid, or nil and the refusal.
  local function guard(a, caller)
    local t = deps.resolve(a.target)
    if not t.ok then return nil, t end
    local okF, front = pcall(deps.frontPid)
    local r = G.check({ owner = caller.owner, targetPid = t.pid, frontPid = okF and front or nil,
      lease = leaseCheck, takeover = takeoverCheck })
    if r then return nil, r end
    return t
  end

  -- ---- where to: {field}, {rect} or {x, y} -------------------------------------------------------
  local function onWindow(pid, x, y)
    local ok, wins = pcall(deps.windows, pid)
    for _, f in ipairs(ok and type(wins) == "table" and wins or {}) do
      if x >= f[1] and y >= f[2] and x < f[1] + f[3] and y < f[2] + f[4] then return true end
    end
    return false
  end
  -- Returns a planner rect argument ({rect = {...}} or {x, y}), or nil and a refusal.
  local function where(spec, name, a, caller, t)
    if type(spec) ~= "table" then return nil, refuse("bad_args", name .. " must be {field}, {rect} or {x, y}") end
    local arg, cx, cy
    if spec.field ~= nil then
      if type(spec.field) ~= "string" then return nil, refuse("bad_args", name .. ".field must be an id from eyes_fields") end
      local d = deps.field({ target = a.target, id = spec.field }, caller.owner)
      if type(d) ~= "table" or not d.ok then return nil, d end
      local r = d.rect
      if type(r) ~= "table" or not (r[3] and r[3] > 0 and r[4] > 0) then
        return nil, refuse("offscreen", "the field has no size on the screen", { field = spec.field })
      end
      cx, cy = r[1] + r[3] / 2, r[2] + r[4] / 2
      if d.onscreen == false then
        local v = d.viewport
        local dy = v and math.floor(cy - (v[2] + v[4] / 2) + 0.5) or nil
        return nil, refuse("offscreen", "the field is outside the viewport; hands_scroll by dy, then try again",
          { field = spec.field, dy = dy })
      end
      arg = { rect = { r[1], r[2], r[3], r[4] } }
    elseif spec.rect ~= nil then
      local r = spec.rect
      if type(r) ~= "table" or #r ~= 4 or not (num(r[1]) and num(r[2]) and num(r[3]) and num(r[4])) or r[3] <= 0 or r[4] <= 0 then
        return nil, refuse("bad_args", name .. ".rect must be [x, y, w, h] with w and h above 0")
      end
      cx, cy = r[1] + r[3] / 2, r[2] + r[4] / 2
      arg = { rect = { r[1], r[2], r[3], r[4] } }
    elseif spec.x ~= nil or spec.y ~= nil then
      if not (num(spec.x) and num(spec.y)) then return nil, refuse("bad_args", name .. " needs numbers x and y") end
      cx, cy = spec.x, spec.y
      arg = { x = spec.x, y = spec.y }
    else
      return nil, refuse("bad_args", name .. " must be {field}, {rect} or {x, y}")
    end
    if not onWindow(t.pid, cx, cy) then
      return nil, refuse("focus", "the point is not on a target window", { [name] = { round(cx), round(cy) } })
    end
    return arg
  end

  -- ---- plans ------------------------------------------------------------------------------------
  local function rng() return P.Rng(deps.seed()) end
  local function from()
    local ok, p = pcall(deps.mousePos)
    if ok and type(p) == "table" and num(p.x) and num(p.y) then return { x = p.x, y = p.y } end
    return { x = 0, y = 0 }
  end
  local function layout()
    local ok, l = pcall(deps.layout)
    return ok and l or P.US
  end
  -- Shift every event by dt ms and append it to list.
  local function append(list, events, dt)
    for _, e in ipairs(events) do
      e.t = P.r2(e.t + (dt or 0))
      list[#list + 1] = e
    end
    return list
  end
  local function lastT(list) return #list > 0 and list[#list].t or 0 end

  local PLAN = {}
  function PLAN.move(a, caller, t)
    if a.to == nil then return nil, refuse("bad_args", "move needs to") end
    local to, bad = where(a.to, "to", a, caller, t)
    if not to then return nil, bad end
    return P.plan("move", to, { rng = rng(), from = from() }).events
  end
  function PLAN.click(a, caller, t)
    local clicks = a.clicks == nil and 1 or a.clicks
    if math.type(clicks) ~= "integer" or clicks < 1 or clicks > 3 then return nil, refuse("bad_args", "clicks must be 1-3") end
    local btn = a.button == nil and "left" or a.button
    if btn ~= "left" and btn ~= "right" then return nil, refuse("bad_args", "button must be left or right") end
    local args = { clicks = clicks }
    if a.to ~= nil then
      local to, bad = where(a.to, "to", a, caller, t)
      if not to then return nil, bad end
      args.rect, args.x, args.y = to.rect, to.x, to.y
    else
      local p = from()
      if not onWindow(t.pid, p.x, p.y) then
        return nil, refuse("focus", "the cursor is not on a target window; pass to", { at = { round(p.x), round(p.y) } })
      end
    end
    local events = P.plan("click", args, { rng = rng(), from = from() }).events
    for _, e in ipairs(events) do if e.type == "down" or e.type == "up" then e.button = btn end end
    return events
  end
  function PLAN.type(a)
    if type(a.text) ~= "string" or a.text == "" then return nil, refuse("bad_args", "type needs text") end
    local n = utf8.len(a.text)
    if not n then return nil, refuse("bad_args", "type needs UTF-8 text") end
    if n > MAX_TEXT then return nil, refuse("bad_args", "text is longer than " .. MAX_TEXT .. " characters") end
    if a.paste ~= nil and type(a.paste) ~= "boolean" then return nil, refuse("bad_args", "paste must be true or false") end
    if a.paste == false and n > KEYED_TEXT then
      return nil, refuse("bad_args", "paste=false types at most " .. KEYED_TEXT .. " characters")
    end
    -- paste=true pastes even short text; paste=false types even long text key by key.
    local keep = P.PASTE_THRESHOLD
    if a.paste == true then P.PASTE_THRESHOLD = 0 elseif a.paste == false then P.PASTE_THRESHOLD = math.huge end
    local ok, plan = pcall(P.plan, "type", { text = a.text }, { rng = rng(), layout = layout() })
    P.PASTE_THRESHOLD = keep
    if not ok then return nil, refuse("bad_args", "type could not plan the text") end
    return plan.events
  end
  function PLAN.key(a)
    if type(a.combo) ~= "string" or a.combo == "" or #a.combo > 64 then return nil, refuse("bad_args", "key needs combo, such as cmd+shift+g") end
    local ok, plan = pcall(P.plan, "key", { combo = a.combo }, { rng = rng(), layout = layout() })
    if not ok then return nil, refuse("bad_args", (tostring(plan):match('(unknown [%w ]+ "[^"]*")') or "bad key combo")) end
    return plan.events
  end
  function PLAN.scroll(a, caller, t)
    local dx, dy = a.dx == nil and 0 or a.dx, a.dy == nil and 0 or a.dy
    if not (num(dx) and num(dy)) or (dx == 0 and dy == 0) then return nil, refuse("bad_args", "scroll needs dy (or dx) in pixels") end
    local r = rng()
    local events = {}
    if a.at ~= nil then
      local at, bad = where(a.at, "at", a, caller, t)
      if not at then return nil, bad end
      append(events, P.plan("move", at, { rng = r, from = from() }).events)
    else
      local p = from()
      if not onWindow(t.pid, p.x, p.y) then
        return nil, refuse("focus", "the cursor is not on a target window; pass at", { at = { round(p.x), round(p.y) } })
      end
    end
    local start = #events > 0 and lastT(events) + r:uniform(60, 120) or 0
    return append(events, P.planScroll(dx, dy, r), start)
  end
  function PLAN.drag(a, caller, t)
    if a.from == nil or a.to == nil then return nil, refuse("bad_args", "drag needs from and to") end
    local f, bad = where(a.from, "from", a, caller, t)
    if not f then return nil, bad end
    local to
    to, bad = where(a.to, "to", a, caller, t)
    if not to then return nil, bad end
    local r = rng()
    local m1 = P.planMove(from(), f.rect or f, r)
    local events = append({}, m1.events)
    local tDown = m1.moveMs + r:uniform(40, 120)
    local p = m1["end"]
    events[#events + 1] = { t = P.r2(tDown), type = "down", x = P.r2(p.x), y = P.r2(p.y), clicks = 1 }
    local m2 = P.planMove(p, to.rect or to, r, tDown + r:uniform(80, 160))
    append(events, m2.events)
    local q = m2["end"]
    events[#events + 1] = { t = P.r2(math.max(lastT(events), tDown) + r:uniform(60, 120)), type = "up", x = P.r2(q.x), y = P.r2(q.y), clicks = 1 }
    return events
  end
  -- A pre-planned list (the jobhunt.lua format): checked, never trusted.
  function PLAN.play(a, caller, t)
    local events = a.events
    if type(events) ~= "table" or #events == 0 then return nil, refuse("bad_args", "play needs events") end
    if #events > MAX_EVENTS then return nil, refuse("bad_args", "at most " .. MAX_EVENTS .. " events") end
    local out = {}
    for i, e in ipairs(events) do
      if type(e) ~= "table" or not POST[e.type] or not num(e.t) or e.t < 0 then return nil, refuse("bad_args", "bad event " .. i) end
      if i > 1 and e.t < events[i - 1].t then return nil, refuse("bad_args", "events out of order at " .. i) end
      local m = e.type == "move" or e.type == "down" or e.type == "up"
      if m and not (num(e.x) and num(e.y)) then return nil, refuse("bad_args", "event " .. i .. " needs x and y") end
      if e.type == "paste" and type(e.text) ~= "string" then return nil, refuse("bad_args", "event " .. i .. " needs text") end
      local k = e.type:match("^key") or e.type:match("^flags")
      if k and e.key ~= nil and (math.type(e.key) ~= "integer" or e.key < 0 or e.key > 0xFFFF) then
        return nil, refuse("bad_args", "event " .. i .. " has a bad key")
      end
      out[i] = { t = e.t, type = e.type, x = e.x, y = e.y, dx = e.dx, dy = e.dy, clicks = e.clicks, key = e.key,
        flags = e.flags, chars = type(e.chars) == "string" and e.chars or nil, text = e.text,
        button = e.button == "right" and "right" or nil }
    end
    if a.rect ~= nil then
      local _, bad = where({ rect = a.rect }, "rect", a, caller, t)
      if bad then return nil, bad end
    end
    return out
  end

  -- Guards, the plan, the lease, then the job (it posts nothing before its first tick).
  local function start(kind, a, caller)
    a = type(a) == "table" and a or {}
    local t, bad = guard(a, caller)
    if not t then return bad end
    local ok, events, why = pcall(PLAN[kind], a, caller, t)
    if not ok then return refuse("failed", "could not plan the " .. kind) end
    if not events then return why end
    takeLease(caller)
    nextId = nextId + 1
    local j = { id = nextId, kind = kind, owner = caller.owner, pid = t.pid, events = events, i = 1, total = #events,
      t0 = deps.nowMs(), lastCheck = 0, state = "running", planned = math.floor(lastT(events) + 0.5) }
    job = j
    if j.total == 0 then finish(j, "done"); return report(j) end
    j.timer = deps.every(0.004, tick)
    tick()
    return report(j)
  end

  -- ---- commands ---------------------------------------------------------------------------------
  for _, kind in ipairs({ "move", "click", "type", "key", "scroll", "drag", "play" }) do
    H[kind] = function(a, caller) return start(kind, a, caller) end
  end

  function H.focus(a, caller)
    a = type(a) == "table" and a or {}
    local t = deps.resolve(a.target)
    if not t.ok then return t end
    -- Guards 1-6: focus is what fixes guard 7.
    local r = G.check({ owner = caller.owner, lease = leaseCheck, takeover = takeoverCheck })
    if r then return r end
    takeLease(caller)
    local ok, res = pcall(deps.activate, t.pid)
    if not ok or res == false then return refuse("failed", "could not bring the target to the front", { pid = t.pid }) end
    return { ok = true, focused = true, target = t.name, pid = t.pid }
  end

  function H.job(a, caller)
    local id = type(a) == "table" and math.tointeger(a.id) or nil
    local j = id and ((job and job.id == id and job) or jobs[id]) or nil
    if not j or j.owner ~= caller.owner then return refuse("unknown_job", "no such job of this owner", { id = id }) end
    if lease and lease.owner == caller.owner then lease.lastUse = deps.now() end
    return report(j)
  end

  function H.status(_, caller)
    local mine = lease and caller and lease.owner == caller.owner
    if mine then lease.lastUse = deps.now() end
    local p = from()
    return { ok = true, lease = lease and lease.owner or false, mine = mine == true,
      busy = job and job.id or false, interrupted = takeover or false, interrupts = mine and interrupts or 0,
      pos = { round(p.x), round(p.y) }, watch = tapState(), awake = lease and lease.awake or false }
  end

  function H.resume(_, caller)
    if lease and lease.owner ~= caller.owner then
      return refuse("lease_held", "another Eyes & Hands owner holds the cursor", { by = lease.owner })
    end
    if takeover then
      local r = G.presentCheck()
      if r then return r end
      takeover = nil
    end
    if lease then lease.lastUse = deps.now() end
    return H.status(nil, caller)
  end

  function H.abort(_, caller)
    if job and job.owner == caller.owner then
      local j = job
      finish(j, "aborted")
      return report(j)
    end
    return { ok = true, aborted = false }
  end

  -- For init.lua: the port's disarm hook (hands_release, the sweep, a policy change, the stop
  -- switch), unload, and status.
  function H.release(owner, reason)
    if lease and lease.owner == owner then return endLease(reason or "released") end
    return false
  end
  function H.abortAll(reason)
    if job then finish(job, "aborted", { why = reason }) end
  end
  function H.unload()
    endLease("unloaded")
    letGo()
  end
  function H.info()
    return { lease = lease and lease.owner or false, busy = job and job.id or false, interrupted = takeover ~= nil,
      watch = tapState(), awake = lease and lease.awake or false }
  end

  return H
end
