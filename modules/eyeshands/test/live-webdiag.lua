-- The live fixture test's no_web_content diagnostic: what the throwaway Chrome shows to
-- Accessibility when the eyes find no web content in its front window. The live test runs
--   hs -c 'return hs.json.encode(dofile("<this file>")({ pid = <chrome pid>, test = "__eyeshands_test", target = "chrome-test" }))'
-- and records the JSON object in its report. It only reads: it sets no attribute (not even
-- AXManualAccessibility), posts no input, writes no global and no file. Every walk is bounded by a
-- node count and one shared deadline, so it cannot hang Hammerspoon.
--   opts.pid       the throwaway Chrome's main process (found by its profile path)
--   opts.test      the test Spoon's global (its targets.resolve is the eyes' view of the target)
--   opts.target    the target name to resolve
--   opts.depth     front_tree depth (default 5), opts.tree_nodes its node cap (default 400)
--   opts.max_nodes the node cap of the eyes_bfs and web_areas walks (default 20000 each)
--   opts.time_ms   the deadline shared by every walk (default 8000)
-- Returns:
--   pid, resolved   { ok, pid, reason }: the test Spoon's targets.resolve(opts.target)
--   app             { title, frontmost, focused_title, main_title, manual_accessibility, enhanced_ui,
--                   windows (AXWindows count) }
--   front_app       hs.application.frontmostApplication(): { pid, name, bundle }
--   windows         AXWindows: [{ index, title, role, subrole, focused, main, minimized, rect, children }]
--   hs_windows      hs.application allWindows(): [{ title, standard, visible, frame }]
--   front           the window the eyes' frontWindow picks: { by = AXFocusedWindow | AXMainWindow
--                   | AXWindows[1], index (in windows, or nil when it is not among them), title, role, subrole }
--   front_tree      that window's AX tree to opts.depth: { role, subrole, title, desc, dom, n (child
--                   count), children }; tree_nodes, tree_truncated
--   eyes_bfs        the eyes' findWebArea (breadth first from the front window) without their budget:
--                   { found, nodes (visited up to the first AXWebArea), ms, depth, children, url, title,
--                   stopped (nodes | time) } and eyes_budget { max_nodes, time_ms, max_depth } to compare
--   web_areas       every AXWebArea under every AXWindows window (depth first, at most 20): [{ window,
--                   depth, children, url, title }]; walk { nodes, ms, stopped }
return function(opts)
  opts = opts or {}
  local DEPTH, TREE_NODES = opts.depth or 5, opts.tree_nodes or 400
  local MAX_NODES, TIME_MS = opts.max_nodes or 20000, opts.time_ms or 8000
  local out = { pid = opts.pid }
  local nowMs = function() return hs.timer.absoluteTime() / 1e6 end
  local deadline = nowMs() + TIME_MS
  local function try(f, ...)
    local ok, v = pcall(f, ...)
    if ok then return v end
    return nil
  end
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
  local function kids(el)
    local c = A(el, "AXChildren")
    return type(c) == "table" and c or {}
  end
  local function text(v, max)
    if type(v) == "table" and type(v.url) == "string" then v = v.url end
    if type(v) ~= "string" or v == "" then return nil end
    v = v:gsub("%s+", " ")
    if #v > (max or 80) then v = v:sub(1, max or 80) end
    return v
  end
  local function same(a, b) return a ~= nil and b ~= nil and try(function() return a == b end) == true end
  local function rect(el)
    local p, s = A(el, "AXPosition"), A(el, "AXSize")
    if type(p) ~= "table" or type(s) ~= "table" then return nil end
    return { tonumber(p.x), tonumber(p.y), tonumber(s.w), tonumber(s.h) }
  end

  -- The eyes' view of the target: which pid the test Spoon resolves it to.
  local t = rawget(_G, opts.test or "__eyeshands_test")
  local r = try(function() return t._s.targets.resolve(opts.target) end)
  out.resolved = type(r) == "table" and { ok = r.ok, pid = r.pid, reason = r.reason } or { ok = false, reason = "no test Spoon" }

  local f = try(hs.application.frontmostApplication)
  if f then out.front_app = { pid = try(f.pid, f), name = try(f.name, f), bundle = try(f.bundleID, f) } end

  local app = opts.pid and try(hs.axuielement.applicationElementForPID, opts.pid)
  if not isEl(app) then out.error = "no AX application element for the pid"; return out end
  pcall(app.setTimeout, app, 1)   -- bounds each read of a stalled Chrome; changes nothing in Chrome
  local list = A(app, "AXWindows")
  list = type(list) == "table" and list or {}
  local focused, main = A(app, "AXFocusedWindow"), A(app, "AXMainWindow")
  out.app = { title = text(A(app, "AXTitle")), frontmost = A(app, "AXFrontmost"), windows = #list,
    focused_title = isEl(focused) and text(A(focused, "AXTitle")) or nil, main_title = isEl(main) and text(A(main, "AXTitle")) or nil,
    manual_accessibility = A(app, "AXManualAccessibility"), enhanced_ui = A(app, "AXEnhancedUserInterface") }

  out.windows = {}
  for i, w in ipairs(list) do
    out.windows[i] = { index = i, title = text(A(w, "AXTitle")), role = A(w, "AXRole"), subrole = A(w, "AXSubrole"),
      focused = same(w, focused), main = same(w, main), minimized = A(w, "AXMinimized"), rect = rect(w), children = #kids(w) }
  end
  local happ = try(hs.application.applicationForPID, opts.pid)
  if happ then
    out.hs_windows = {}
    for i, w in ipairs(try(happ.allWindows, happ) or {}) do
      local fr = try(w.frame, w)
      out.hs_windows[i] = { title = text(try(w.title, w)), standard = try(w.isStandard, w), visible = try(w.isVisible, w),
        frame = fr and { fr.x, fr.y, fr.w, fr.h } or nil }
    end
  end

  -- The eyes' frontWindow, the same order: focused, else main, else the first of AXWindows.
  local win, by
  if isEl(focused) then win, by = focused, "AXFocusedWindow"
  elseif isEl(main) then win, by = main, "AXMainWindow"
  elseif isEl(list[1]) then win, by = list[1], "AXWindows[1]" end
  if not win then out.front = { by = "none" }; return out end
  out.front = { by = by, title = text(A(win, "AXTitle")), role = A(win, "AXRole"), subrole = A(win, "AXSubrole") }
  for i, w in ipairs(list) do if same(w, win) then out.front.index = i; break end end

  -- The front window's tree, shallow, with each node's child count (n).
  local tn = 0
  local function build(el, d)
    if tn >= TREE_NODES or nowMs() > deadline then out.tree_truncated = true; return nil end
    tn = tn + 1
    local c = kids(el)
    local n = { role = A(el, "AXRole"), subrole = A(el, "AXSubrole"), title = text(A(el, "AXTitle")),
      desc = text(A(el, "AXDescription")), dom = text(A(el, "AXDOMIdentifier")), n = #c }
    if d < DEPTH and #c > 0 then
      n.children = {}
      for _, ch in ipairs(c) do
        local k = build(ch, d + 1)
        if k then n.children[#n.children + 1] = k end
        if out.tree_truncated then break end
      end
    end
    return n
  end
  out.front_tree = build(win, 0)
  out.tree_nodes = tn

  -- The eyes' findWebArea replayed with a far larger budget: breadth first from the front window.
  out.eyes_budget = { max_nodes = 8000, time_ms = 4000, max_depth = 80 }
  local b = { found = false, nodes = 0 }
  local t0 = nowMs()
  local queue, i = { { win, 0 } }, 1
  while i <= #queue do
    if b.nodes >= MAX_NODES then b.stopped = "nodes"; break end
    if nowMs() > deadline then b.stopped = "time"; break end
    local el, d = queue[i][1], queue[i][2]
    queue[i], i = false, i + 1
    b.nodes = b.nodes + 1
    if A(el, "AXRole") == "AXWebArea" then
      b.found, b.depth, b.children = true, d, #kids(el)
      b.url, b.title = text(A(el, "AXURL"), 200), text(A(el, "AXTitle"))
      break
    end
    for _, c in ipairs(kids(el)) do queue[#queue + 1] = { c, d + 1 } end
  end
  b.ms = math.floor(nowMs() - t0)
  out.eyes_bfs = b

  -- Every web area in every window: is there one at all, and where.
  out.web_areas = {}
  local walk = { nodes = 0 }
  local t1 = nowMs()
  local function dfs(el, wi, d)
    if walk.stopped then return end
    if walk.nodes >= MAX_NODES then walk.stopped = "nodes"; return end
    if nowMs() > deadline then walk.stopped = "time"; return end
    walk.nodes = walk.nodes + 1
    if A(el, "AXRole") == "AXWebArea" and #out.web_areas < 20 then
      out.web_areas[#out.web_areas + 1] = { window = wi, depth = d, children = #kids(el),
        url = text(A(el, "AXURL"), 200), title = text(A(el, "AXTitle")) }
    end
    for _, c in ipairs(kids(el)) do dfs(c, wi, d + 1) end
  end
  for wi, w in ipairs(list) do dfs(w, wi, 0) end
  walk.ms = math.floor(nowMs() - t1)
  out.walk = walk
  return out
end
