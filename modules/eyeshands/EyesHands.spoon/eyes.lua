-- Eyes & Hands eyes: read the target's Accessibility (AX) tree and its window pixels (part 8 of
-- docs/eyes-hands-design.md). Pure Lua 5.4 with no hs.* calls: init.lua passes the Hammerspoon
-- pieces in, the tests pass fakes.
--
-- Eyes only read. They never post input and never move the cursor, so they work while a person is
-- present. init.lua registers each command on the port (eh.eyes.<name>); every one needs the `eyes`
-- capability and, except frontmost, a target in the owner's `apps`. pixels and shot also need `shot`.
--   fields    {target, match?, limits?}  url, title, window, viewport, fields[], nodes, truncated
--   value     {target, id | dom}         one field record, read live (a stale id falls back to dom)
--   text      {target, limits?}          lines[], frames[], url, title, nodes, truncated
--   focused   {target}                   focused (a field record or false) and its id
--   dialog    {target}                   open, dialogs[] (dialog windows and sheets)
--   tree      {target, depth?, max_nodes?}  a pruned AX tree of the front window
--   frontmost {}                         the front app's pid, name, bundle and the targets it matches
--   pixels    {target, points[] | rect}  colours as "#rrggbb"; `checked` for a control-sized rect
--   shot      {target, max_px?}          path of a PNG of the target's front window, bounds
-- A refusal is { ok=false, reason=, hint=, ... }, as in targets.lua and guards.lua.
--
-- Field records have the shape of job-hunt's jobhunt.lua, plus `onscreen`:
--   { id, role, label, labelSource, value, placeholder, required, focused, enabled, dom, rect,
--     onscreen [, checked, checkedSource] [, shown] [, expanded] [, subrole, roleDescription] }
--   rect      [x, y, w, h] in global screen points (origin top left of the main display), as AX
--             reports them and as mouse events use them;
--   id        valid until this owner's next fields call on any target; a stale id falls back to
--             dom (the HTML id) in value;
--   checked   for checkboxes and radio buttons, with checkedSource "ax", "pixels" or "unknown":
--             Chrome leaves AXValue empty for both states, so the pixels of the control decide,
--             only for owners that hold `shot`;
--   onscreen  the rect's centre lies inside the viewport (the web area, or the window for an app
--             without one).
-- Walk limits: max_depth 80, max_nodes 8000, time_ms 4000 (a caller may only lower them). A walk
-- that stops sets truncated to "depth", "nodes" or "time". Each walk has a time limit because the
-- Hammerspoon main thread also runs the takeover tap.
--
-- AX elements are used only through their hs.axuielement methods: attributeValue(name),
-- setAttributeValue(name, v), setTimeout(s) and isValid(). The tests pass tables with them.
-- deps: axTrusted() -> bool, appElement(pid) -> AX element or nil, resolve(name) -> targets.resolve
--       result, targetsList() -> targets.list() result, front() -> {pid, name, bundle} or nil,
--       nowMs() -> monotonic milliseconds, sleepMs(ms), hasCap(owner, cap) -> bool,
--       windowImage(pid) -> { frame = {x, y, w, h}, w, h, color = fn(px, py) -> r, g, b (0-1) }
--         or nil, reason (the target's front window, its own pixels: no other window shows in it),
--       windowShot(pid, maxPx) -> { path, bounds, size, bytes } or nil, reason
local LIMITS = { max_depth = 80, max_nodes = 8000, time_ms = 4000 }
local TREE = { depth = 12, max_nodes = 1000 }
local MAX_POINTS = 64
local MAX_LINE = 4000

local function set(list)
  local out = {}
  for _, v in ipairs(list) do out[v] = true end
  return out
end
local CONTROL_ROLES = set({ "AXTextField", "AXTextArea", "AXPopUpButton", "AXComboBox", "AXCheckBox", "AXRadioButton",
  "AXButton", "AXLink", "AXMenuButton", "AXSearchField", "AXSlider", "AXIncrementor", "AXDateField" })
-- Controls whose children are only their own text: fields does not descend into them.
local LEAF_CONTROLS = set({ "AXTextField", "AXTextArea", "AXPopUpButton", "AXComboBox", "AXCheckBox", "AXRadioButton",
  "AXButton", "AXMenuButton", "AXSearchField", "AXLink" })
-- Chromium browsers build their web tree only after AXManualAccessibility, and asynchronously.
local CHROMIUM = set({ "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
  "org.chromium.Chromium", "com.brave.Browser", "com.microsoft.edgemac", "com.vivaldi.Vivaldi" })
-- Layers that tree collapses when they carry no text and hold one child.
local WRAPPERS = set({ "AXGroup", "AXUnknown" })

local function round(v) return math.floor(v * 100 + 0.5) / 100 end
local function clean(s) return (tostring(s or ""):gsub("%s+", " "):gsub("^ ", ""):gsub(" $", "")) end

-- One attribute, or nil when the element cannot give it.
local function A(el, name)
  local ok, v = pcall(el.attributeValue, el, name)
  if ok then return v end
  return nil
end
local function isEl(v)
  if type(v) ~= "userdata" and type(v) ~= "table" then return false end
  local ok, f = pcall(function() return v.attributeValue end)
  return ok and type(f) == "function"
end
local function children(el)
  local c = A(el, "AXChildren")
  return type(c) == "table" and c or {}
end
local function str(v)
  if type(v) == "string" then return v end
  if type(v) == "table" and type(v.url) == "string" then return v.url end
  return nil
end
local function jsonValue(v)
  if type(v) == "string" or type(v) == "number" or type(v) == "boolean" then return v end
  return str(v)
end
local function rectOf(el)
  local p, s = A(el, "AXPosition"), A(el, "AXSize")
  if type(p) ~= "table" or type(s) ~= "table" or not tonumber(p.x) or not tonumber(p.y) or not tonumber(s.w) or not tonumber(s.h) then
    return nil
  end
  return { round(p.x), round(p.y), round(s.w), round(s.h) }
end
local function inside(r, f)
  return f ~= nil and r[1] >= f[1] and r[2] >= f[2] and r[1] + r[3] <= f[1] + f[3] and r[2] + r[4] <= f[2] + f[4]
end
local function centreIn(r, f)
  if not r or not f or r[3] <= 0 or r[4] <= 0 then return false end
  local cx, cy = r[1] + r[3] / 2, r[2] + r[4] / 2
  return cx >= f[1] and cy >= f[2] and cx < f[1] + f[3] and cy < f[2] + f[4]
end
local function refuse(reason, hint, extra)
  local out = extra or {}
  out.ok, out.reason, out.hint = false, reason, hint
  return out
end

-- Whether a native checkbox or radio button looks ticked, from samples of its pixels. A ticked
-- native control is filled with the accent colour; an empty one shows the colour of its own corner
-- (the page behind it). sample(fx, fy) -> r, g, b (0-1) or nil, at fractions of the control's rect.
-- Returns true, false, or nil when too few samples could be read.
local GRID = { 0.2, 0.35, 0.5, 0.65, 0.8 }
local function tickState(sample)
  local br, bg, bb = sample(0, 0)
  if not br then return nil end
  local differ, n = 0, 0
  for _, fy in ipairs(GRID) do
    for _, fx in ipairs(GRID) do
      local r, g, b = sample(fx, fy)
      if r then
        n = n + 1
        if math.sqrt((r - br) ^ 2 + (g - bg) ^ 2 + (b - bb) ^ 2) > 0.35 then differ = differ + 1 end
      end
    end
  end
  if n < 10 then return nil end
  return differ / n >= 0.3
end
-- A rect that a native tick box can have: 8-40 points, square within 3 points (a box clipped at
-- the viewport edge is not square).
local function tickSized(r)
  return r ~= nil and r[3] >= 8 and r[4] >= 8 and r[3] <= 40 and r[4] <= 40 and math.abs(r[3] - r[4]) <= 3
end

-- The colour at a global point in a window image, or nil outside it.
local function colorAt(img, gx, gy)
  local f = img.frame
  if not f or f[3] <= 0 or f[4] <= 0 then return nil end
  local px, py = math.floor((gx - f[1]) * img.w / f[3]), math.floor((gy - f[2]) * img.h / f[4])
  if px < 0 or py < 0 or px >= img.w or py >= img.h then return nil end
  local ok, r, g, b = pcall(img.color, px, py)
  if not ok or type(r) ~= "number" or type(g) ~= "number" or type(b) ~= "number" then return nil end
  return r, g, b
end
local function hex(r, g, b)
  if not r then return false end
  local function c(v) return math.max(0, math.min(255, math.floor(v * 255 + 0.5))) end
  return string.format("#%02x%02x%02x", c(r), c(g), c(b))
end

return function(deps)
  local M = { tickState = tickState }
  local registry = {}                   -- owner -> { target, pid, ids = { f1 = { el, dom } } }

  -- ---- walks ------------------------------------------------------------------------------------
  -- limits: { max_depth, max_nodes, time_ms }, each 1 up to its default. Returns a walk or nil, why.
  local function newWalk(limits, defaults)
    defaults = defaults or LIMITS
    if limits ~= nil and type(limits) ~= "table" then return nil, "limits must be an object" end
    local w = { nodes = 0 }
    for k, cap in pairs(LIMITS) do
      local v = limits and limits[k]
      if v ~= nil and (math.type(v) ~= "integer" or v < 1 or v > cap) then
        return nil, string.format("limits.%s must be a whole number 1-%d", k, cap)
      end
      w[k] = v or defaults[k] or cap
    end
    for k in pairs(limits or {}) do
      if not LIMITS[k] then return nil, "unknown limit " .. tostring(k) end
    end
    w.deadline = deps.nowMs() + w.time_ms
    return w
  end
  -- Whether the walk may visit one more node. Too deep skips only that subtree; too many nodes or
  -- no time left stops the whole walk (w.stop), and that reason wins over "depth".
  local function budget(w, depth)
    if w.stop then return false end
    if depth > w.max_depth then w.deep, w.truncated = true, w.truncated or "depth"; return false end
    if w.nodes >= w.max_nodes then w.truncated, w.stop = "nodes", true; return false end
    if deps.nowMs() > w.deadline then w.truncated, w.stop = "time", true; return false end
    w.nodes = w.nodes + 1
    return true
  end
  -- Depth first, in page order. visit(el, role, depth) returns false to skip the children.
  local function walk(el, w, depth, visit)
    if not budget(w, depth) then return end
    local role = A(el, "AXRole") or ""
    if visit(el, role, depth) == false then return end
    for _, c in ipairs(children(el)) do
      walk(c, w, depth + 1, visit)
      if w.stop then return end
    end
  end

  -- ---- the target -------------------------------------------------------------------------------
  -- The target's app element. Returns ctx { name, pid, bundle, browser, app, shot } or nil, refusal.
  local function openApp(a, owner)
    if not deps.axTrusted() then
      return nil, refuse("no_accessibility", "grant Hammerspoon Accessibility in System Settings")
    end
    local t = deps.resolve(a.target)
    if not t.ok then return nil, t end
    local app = deps.appElement(t.pid)
    if not isEl(app) then return nil, refuse("no_ax_element", "the target has no accessibility element", { pid = t.pid }) end
    pcall(app.setTimeout, app, 2)
    -- What screen readers do: Chromium and Electron apps build their web tree only after this.
    pcall(app.setAttributeValue, app, "AXManualAccessibility", true)
    local c = { name = t.name, pid = t.pid, bundle = t.bundle, app = app,
      browser = t.profile ~= nil or CHROMIUM[t.bundle] == true, shot = deps.hasCap(owner, "shot") == true }
    -- The target's window image, read at most once per command and only for an owner with shot.
    function c.image()
      if c.img == nil then c.img = c.shot and deps.windowImage(c.pid) or false end
      return c.img or nil
    end
    return c
  end

  -- pixels and shot read no AX tree: the running target is enough.
  local function openTarget(a)
    local t = deps.resolve(a.target)
    if not t.ok then return nil, t end
    return t
  end

  local function frontWindow(app)
    for _, k in ipairs({ "AXFocusedWindow", "AXMainWindow" }) do
      local w = A(app, k)
      if isEl(w) then return w end
    end
    local list = A(app, "AXWindows")
    local w = type(list) == "table" and list[1]
    return isEl(w) and w or nil
  end
  -- The first AXWebArea under the window (the active tab), breadth first.
  local function findWebArea(win)
    local w = newWalk(nil)
    local queue, i = { { win, 0 } }, 1
    while i <= #queue do
      local el, depth = queue[i][1], queue[i][2]
      i = i + 1
      if not budget(w, depth) then
        if w.stop then return nil end
      elseif A(el, "AXRole") == "AXWebArea" then return el
      else
        for _, c in ipairs(children(el)) do queue[#queue + 1] = { c, depth + 1 } end
      end
    end
    return nil
  end
  -- Adds the walk root to ctx: the web area when there is one (a browser waits briefly for it,
  -- because Chrome fills its tree after the first request), else the front window.
  local function openRoot(c)
    local tries = c.browser and 8 or 1
    for attempt = 1, tries do
      c.win = frontWindow(c.app)
      c.web = c.win and findWebArea(c.win) or nil
      if c.web and #children(c.web) > 0 then break end
      if attempt < tries then deps.sleepMs(150) end
    end
    if not c.win then return refuse("no_window", "the target has no window") end
    if c.browser and not (c.web and #children(c.web) > 0) then
      return refuse("no_web_content", "no web content in the target's front window")
    end
    c.root = c.web or c.win
    c.viewport = rectOf(c.root)
  end
  local function open(a, owner)
    local c, bad = openApp(a, owner)
    if not c then return nil, bad end
    bad = openRoot(c)
    if bad then return nil, bad end
    return c
  end
  local function pageInfo(c, out)
    out.ok, out.target = true, c.name
    out.window, out.viewport = rectOf(c.win), c.viewport
    out.url = c.web and str(A(c.web, "AXURL")) or nil
    out.title = str(A(c.win, "AXTitle"))
    return out
  end

  -- ---- field records ----------------------------------------------------------------------------
  -- Text of a label element (a <label> exposed as AXTitleUIElement).
  local function elementText(el, depth)
    for _, k in ipairs({ "AXValue", "AXTitle", "AXDescription" }) do
      local s = str(A(el, k))
      if s and s ~= "" then return s end
    end
    if depth > 3 then return "" end
    local parts = {}
    for _, c in ipairs(children(el)) do
      local t = elementText(c, depth + 1)
      if t ~= "" then parts[#parts + 1] = t end
    end
    return table.concat(parts, " ")
  end

  -- Whether r lies inside every AXWebArea above el (iframes and the page), with at least one.
  local function insideWebAreas(el, r)
    local p, seen = A(el, "AXParent"), 0
    for _ = 1, LIMITS.max_depth do
      if not isEl(p) then return seen > 0 end
      local role = A(p, "AXRole")
      if role == "AXWindow" or role == "AXApplication" then return seen > 0 end
      if role == "AXWebArea" then
        if not inside(r, rectOf(p)) then return false end
        seen = seen + 1
      end
      p = A(p, "AXParent")
    end
    return false
  end

  -- A web checkbox or radio button's state from its pixels: only for owners with shot, for a
  -- tick-sized rect wholly inside its web areas and the target's window. Otherwise nil.
  local function pixelChecked(el, r, c)
    if not c.shot or not tickSized(r) or not insideWebAreas(el, r) then return nil end
    local img = c.image()
    if not img or not inside(r, img.frame) then return nil end
    return tickState(function(fx, fy) return colorAt(img, r[1] + r[3] * fx, r[2] + r[4] * fy) end)
  end

  -- What a combobox shows when its own value is empty: some custom selects draw the chosen option
  -- as text beside their input, so AXValue stays "". The first real text in the input's parent,
  -- then grandparent (never the input itself, its label or its placeholder).
  local function shownText(el, label, placeholder)
    local skip = { [clean(label)] = true, [clean(placeholder)] = true }
    local node = el
    for _ = 1, 2 do
      node = A(node, "AXParent")
      if not isEl(node) then return nil end
      local prole = A(node, "AXRole")
      if prole == "AXWebArea" or prole == "AXForm" then return nil end
      local queue, i = { { node, 0 } }, 1
      while i <= #queue and i <= 40 do
        local cur, d = queue[i][1], queue[i][2]
        i = i + 1
        if cur ~= el then
          if A(cur, "AXRole") == "AXStaticText" then
            local v = clean(str(A(cur, "AXValue")))
            if #v > 1 and v:match("%w") and not skip[v] then return v end
          end
          if d < 3 then for _, ch in ipairs(children(cur)) do queue[#queue + 1] = { ch, d + 1 } end end
        end
      end
    end
    return nil
  end

  -- One control as fields, value and focused report it.
  local function describe(el, role, c)
    role = role or A(el, "AXRole") or ""
    local label, source = "", nil
    local title, desc = str(A(el, "AXTitle")), str(A(el, "AXDescription"))
    if title and clean(title) ~= "" then label, source = clean(title), "title"
    elseif desc and clean(desc) ~= "" then label, source = clean(desc), "description"
    else
      local te = A(el, "AXTitleUIElement")
      if isEl(te) then
        label = clean(elementText(te, 0))
        if label ~= "" then source = "titleElement" end
      end
    end
    local value = jsonValue(A(el, "AXValue"))
    local out = {
      role = role, label = label, labelSource = source, value = value == nil and "" or value,
      placeholder = str(A(el, "AXPlaceholderValue")) or "",
      required = A(el, "AXRequired") == true,
      focused = A(el, "AXFocused") == true,
      enabled = A(el, "AXEnabled") ~= false,
      dom = str(A(el, "AXDOMIdentifier")) or "",
      rect = rectOf(el),
    }
    out.onscreen = centreIn(out.rect, c.viewport)
    if role == "AXCheckBox" or role == "AXRadioButton" then
      if type(value) == "number" or type(value) == "boolean" or value == "1" or value == "0" then
        out.checked, out.checkedSource = value == 1 or value == true or value == "1", "ax"
      else
        out.checked = pixelChecked(el, out.rect, c)   -- nil (absent) when it cannot tell
        out.checkedSource = out.checked == nil and "unknown" or "pixels"
      end
    end
    if role == "AXComboBox" then
      if out.value == "" then out.shown = shownText(el, label, out.placeholder) end
      local ex = A(el, "AXExpanded")
      if type(ex) == "boolean" then out.expanded = ex end   -- its option list is open
    end
    local sub, rd = str(A(el, "AXSubrole")), str(A(el, "AXRoleDescription"))
    if sub and sub ~= "" then out.subrole = sub end
    if rd and rd ~= "" then out.roleDescription = rd end
    return out
  end

  local function stillValid(el)
    local ok, v = pcall(el.isValid, el)
    return ok and v ~= false and A(el, "AXRole") ~= nil
  end

  -- match: { role = exact, label = case-insensitive part, dom = exact }. Returns a test or nil, why.
  local function matcher(m)
    if m == nil then return function() return true end end
    if type(m) ~= "table" then return nil, "match must be an object" end
    for k, v in pairs(m) do
      if k ~= "role" and k ~= "label" and k ~= "dom" then return nil, "unknown match key " .. tostring(k) end
      if type(v) ~= "string" then return nil, "match." .. k .. " must be text" end
    end
    local label = m.label and m.label:lower()
    return function(d)
      return (not m.role or d.role == m.role) and (not m.dom or d.dom == m.dom)
        and (not label or d.label:lower():find(label, 1, true) ~= nil)
    end
  end

  -- ---- commands ---------------------------------------------------------------------------------
  function M.fields(a, owner)
    local test, why = matcher(a.match)
    if not test then return refuse("bad_args", why) end
    local w, err = newWalk(a.limits)
    if not w then return refuse("bad_args", err) end
    local c, bad = open(a, owner)
    if not c then return bad end
    w.deadline = deps.nowMs() + w.time_ms   -- the wait for a browser's web tree does not count
    local list, ids, n = {}, {}, 0
    walk(c.root, w, 0, function(el, role, depth)
      if depth == 0 or not CONTROL_ROLES[role] then return true end
      n = n + 1
      local d = describe(el, role, c)
      d.id = "f" .. n
      ids[d.id] = { el = el, dom = d.dom }
      if test(d) then list[#list + 1] = d end
      return not LEAF_CONTROLS[role]
    end)
    -- Ids number every control, so a match keeps the ids a full call gives.
    registry[owner] = { target = c.name, pid = c.pid, ids = ids }
    return pageInfo(c, { fields = list, nodes = w.nodes, truncated = w.truncated })
  end

  function M.value(a, owner)
    local id, dom = a.id, a.dom
    if (id ~= nil and type(id) ~= "string") or (dom ~= nil and type(dom) ~= "string") or (id == nil and dom == nil) then
      return refuse("bad_args", "value needs id (from eyes_fields) or dom (the HTML id)")
    end
    local c, bad = open(a, owner)
    if not c then return bad end
    local reg = registry[owner]
    local hit = id and reg and reg.target == c.name and reg.pid == c.pid and reg.ids[id] or nil
    local function reply(d, via)
      d.ok, d.target, d.id, d.via = true, c.name, id, via
      return d
    end
    if hit and stillValid(hit.el) then return reply(describe(hit.el, nil, c), "id") end
    -- A stale or unknown id: find the control again by its HTML id.
    local want = dom or (hit and hit.dom) or ""
    if want == "" then return refuse("unknown_id", "call eyes_fields again, or pass dom", { id = id }) end
    local found, foundEl
    walk(c.root, newWalk(nil), 0, function(el, role)
      if found then return false end
      if CONTROL_ROLES[role] and str(A(el, "AXDOMIdentifier")) == want then
        found, foundEl = describe(el, role, c), el
        return false
      end
      return true
    end)
    if not found then return refuse("not_found", "no control with that HTML id now", { dom = want }) end
    if hit and want == hit.dom then hit.el = foundEl end
    return reply(found, "dom")
  end

  function M.text(a, owner)
    local w, err = newWalk(a.limits)
    if not w then return refuse("bad_args", err) end
    local c, bad = open(a, owner)
    if not c then return bad end
    w.deadline = deps.nowMs() + w.time_ms
    local lines, frames = {}, {}
    local function add(v)
      v = clean(v)
      if v ~= "" then lines[#lines + 1] = #v > MAX_LINE and v:sub(1, MAX_LINE) or v end
    end
    walk(c.root, w, 0, function(el, role, depth)
      if role == "AXStaticText" then add(str(A(el, "AXValue")))
      elseif role == "AXWebArea" and depth > 0 then
        local t = clean(str(A(el, "AXTitle")) or str(A(el, "AXDescription")))
        frames[#frames + 1] = t ~= "" and t or (str(A(el, "AXURL")) or "")
      elseif not c.web and (role == "AXTextArea" or role == "AXTextField") then
        add(str(A(el, "AXValue")))   -- a native app's document text
        return false
      end
      return true
    end)
    return pageInfo(c, { lines = lines, frames = frames, nodes = w.nodes, truncated = w.truncated })
  end

  function M.focused(a, owner)
    local c, bad = open(a, owner)
    if not c then return bad end
    local el = A(c.app, "AXFocusedUIElement")
    if not isEl(el) then return { ok = true, target = c.name, focused = false } end
    local reg, id = registry[owner], nil
    if reg and reg.target == c.name and reg.pid == c.pid then
      for k, v in pairs(reg.ids) do if v.el == el then id = k; break end end
    end
    local d = describe(el, nil, c)
    d.id = id
    return { ok = true, target = c.name, focused = d, id = id }
  end

  function M.dialog(a, owner)
    local c, bad = openApp(a, owner)
    if not c then return bad end
    local found = {}
    local wins = A(c.app, "AXWindows")
    for _, win in ipairs(type(wins) == "table" and wins or {}) do
      if isEl(win) then
        local sub = str(A(win, "AXSubrole"))
        if sub == "AXDialog" or sub == "AXSystemDialog" then
          found[#found + 1] = { role = "AXWindow", subrole = sub, title = str(A(win, "AXTitle")) or "", rect = rectOf(win) }
        end
        -- Sheets hang off their window; a sheet can hang off another sheet (a file panel's
        -- "Go to folder").
        local stack = {}
        for _, ch in ipairs(children(win)) do stack[#stack + 1] = { ch, 1 } end
        while #stack > 0 do
          local el, d = table.unpack(table.remove(stack))
          if A(el, "AXRole") == "AXSheet" then
            found[#found + 1] = { role = "AXSheet", title = str(A(el, "AXTitle")) or str(A(el, "AXDescription")) or "",
              depth = d, rect = rectOf(el) }
            if d < 3 then for _, ch in ipairs(children(el)) do stack[#stack + 1] = { ch, d + 1 } end end
          end
        end
      end
    end
    return { ok = true, target = c.name, open = #found > 0, dialogs = found }
  end

  function M.tree(a, owner)
    local depth, maxNodes = a.depth, a.max_nodes
    if depth ~= nil and (math.type(depth) ~= "integer" or depth < 1 or depth > LIMITS.max_depth) then
      return refuse("bad_args", "depth must be a whole number 1-" .. LIMITS.max_depth)
    end
    if maxNodes ~= nil and (math.type(maxNodes) ~= "integer" or maxNodes < 1 or maxNodes > LIMITS.max_nodes) then
      return refuse("bad_args", "max_nodes must be a whole number 1-" .. LIMITS.max_nodes)
    end
    local w = newWalk({ max_depth = depth or TREE.depth, max_nodes = maxNodes or TREE.max_nodes })
    local c, bad = openApp(a, owner)
    if not c then return bad end
    local win = frontWindow(c.app)
    if not win then return refuse("no_window", "the target has no window") end
    local function build(el, d)
      if not budget(w, d) then return nil end
      local role = A(el, "AXRole") or ""
      local n = { role = role }
      local title, desc = clean(str(A(el, "AXTitle"))), clean(str(A(el, "AXDescription")))
      local value = jsonValue(A(el, "AXValue"))
      if type(value) == "string" then value = clean(value); if #value > 200 then value = value:sub(1, 200) end end
      if title ~= "" then n.title = title end
      if desc ~= "" then n.desc = desc end
      if value ~= nil and value ~= "" then n.value = value end
      local sub, dom = str(A(el, "AXSubrole")), str(A(el, "AXDOMIdentifier"))
      if sub and sub ~= "" then n.subrole = sub end
      if dom and dom ~= "" then n.dom = dom end
      n.rect = rectOf(el)
      local kids = {}
      for _, ch in ipairs(children(el)) do
        local k = build(ch, d + 1)
        if k then kids[#kids + 1] = k end
        if w.stop then break end
      end
      if #kids > 0 then n.children = kids end
      -- Prune: a wrapper with no text of its own and one child is that child.
      if d > 0 and WRAPPERS[role] and not n.title and not n.desc and n.value == nil and #kids == 1 then return kids[1] end
      return n
    end
    local root = build(win, 0)
    -- Reaching the asked depth is the point of depth, so only nodes and time count as truncated.
    local truncated = w.truncated ~= "depth" and w.truncated or nil
    return { ok = true, target = c.name, tree = root, nodes = w.nodes, truncated = truncated,
      depth_limited = w.deep }
  end

  function M.frontmost()
    local f = deps.front()
    if not f then return { ok = true, pid = nil, targets = {} } end
    local names = {}
    local okL, list = pcall(deps.targetsList)
    for _, row in ipairs(okL and type(list) == "table" and list.targets or {}) do
      if row.running and row.pid == f.pid then names[#names + 1] = row.name end
    end
    return { ok = true, pid = f.pid, name = f.name, bundle = f.bundle, target = names[1], targets = names }
  end

  -- points: up to 64 [x, y] in global points; rect: [x, y, w, h]. Both must lie on the target's
  -- front window, whose own pixels are read, so no other app's pixels can come back.
  function M.pixels(a)
    local points, rect = a.points, a.rect
    local function isPoint(p, n)
      if type(p) ~= "table" or #p ~= n then return false end
      for i = 1, n do if type(p[i]) ~= "number" then return false end end
      return true
    end
    if (points == nil) == (rect == nil) then return refuse("bad_args", "pixels needs points or rect, not both") end
    if points ~= nil then
      if type(points) ~= "table" or #points == 0 or #points > MAX_POINTS then
        return refuse("bad_args", "points must be a list of 1-" .. MAX_POINTS .. " [x, y]")
      end
      for _, p in ipairs(points) do
        if not isPoint(p, 2) then return refuse("bad_args", "each point is [x, y] in screen points") end
      end
    elseif not isPoint(rect, 4) or rect[3] <= 0 or rect[4] <= 0 then
      return refuse("bad_args", "rect is [x, y, w, h] in screen points")
    end
    local c, bad = openTarget(a)
    if not c then return bad end
    local img, why = deps.windowImage(c.pid)
    if not img then return refuse(why or "shot_failed", "could not read the target's window pixels (Screen Recording?)") end
    local f = img.frame
    if points then
      local colors = {}
      for i, p in ipairs(points) do
        if not (p[1] >= f[1] and p[2] >= f[2] and p[1] < f[1] + f[3] and p[2] < f[2] + f[4]) then
          return refuse("not_on_target", "a point is outside the target's window", { index = i, window = f })
        end
        colors[i] = hex(colorAt(img, p[1], p[2]))
      end
      return { ok = true, target = c.name, window = f, colors = colors }
    end
    if not inside(rect, f) then return refuse("not_on_target", "the rect is outside the target's window", { window = f }) end
    local function at(fx, fy) return colorAt(img, rect[1] + rect[3] * fx, rect[2] + rect[4] * fy) end
    local grid = {}
    for row, fy in ipairs({ 0.1, 0.3, 0.5, 0.7, 0.9 }) do
      grid[row] = {}
      for col, fx in ipairs({ 0.1, 0.3, 0.5, 0.7, 0.9 }) do grid[row][col] = hex(at(fx, fy)) end
    end
    local out = { ok = true, target = c.name, window = f, rect = rect, corner = hex(at(0, 0)), center = hex(at(0.5, 0.5)), grid = grid }
    if tickSized(rect) then out.checked = tickState(at) end
    return out
  end

  function M.shot(a)
    local maxPx = a.max_px
    if maxPx ~= nil and (math.type(maxPx) ~= "integer" or maxPx < 64 or maxPx > 8192) then
      return refuse("bad_args", "max_px must be a whole number 64-8192")
    end
    local c, bad = openTarget(a)
    if not c then return bad end
    local res, why = deps.windowShot(c.pid, maxPx)
    if not res then return refuse(why or "shot_failed", "could not take the window shot (Screen Recording?)") end
    res.ok, res.target = true, c.name
    return res
  end

  -- Forget an owner's field ids (on disarm), so no AX element outlives its owner's session.
  function M.forget(owner) registry[owner] = nil end

  return M
end
