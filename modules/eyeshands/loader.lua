-- Eyes & Hands loader for the harness (linked to ~/.hammerspoon/local/eyeshands.lua by
-- modules/eyeshands/install.sh). The harness Hammerspoon config (modules/hammerspoon/init.lua)
-- loads every file in ~/.hammerspoon/local/ last, so this file starts the Spoon after the harness
-- table exists and the Spoon can register its event tag with harness.addEventTag.
--
-- It starts spoon.EyesHands with the harness's files:
--   access_file   HS_ACCESS_FILE from harness.env: the one access policy file the harness port
--                 reads too (design decision 9; default deny)
--   targets_file  EYESHANDS_TARGETS_FILE from harness.env (default <PROFILE_DIR>/eyeshands/targets.json)
--   alert         one Telegram line through the cron module's send-only notifier (tg-notify.py,
--                 never getUpdates), plus the console; a notification when the notifier is missing
-- Every other key keeps the Spoon default (config.lua). It writes no global besides what
-- hs.loadSpoon itself sets (spoon.EyesHands).

-- This file is a symlink into the harness; its real folder is modules/eyeshands.
local here = (debug.getinfo(1, "S").source or ""):match("^@(.*)$") or ""
local moduleDir = (hs.fs.pathToAbsolute(here) or here):match("^(.*)/[^/]*$") or "."
local harnessDir = moduleDir:match("^(.*)/modules/eyeshands$")

local function shq(s) return "'" .. tostring(s):gsub("'", "'\\''") .. "'" end

-- harness.env values (with the harness defaults), read the way every harness script reads them.
local env = {}
if harnessDir then
  local out = hs.execute(string.format(
    [[/bin/zsh -c 'source "$1/lib/env.sh"; print -r -- "$HS_ACCESS_FILE"; print -r -- "$EYESHANDS_TARGETS_FILE"' eh %s]],
    shq(harnessDir)))
  env.access, env.targets = (out or ""):match("^([^\n]*)\n([^\n]*)")
end

-- Alerts: the console always; Telegram through tg-notify.py when the cron module's notifier and
-- python3 exist. The hs.task objects stay referenced until they exit.
local tasks = {}
local notify = harnessDir and harnessDir .. "/modules/cron/tg-notify.py"
local python
for _, p in ipairs({ "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3" }) do
  if hs.fs.attributes(p) then python = p; break end
end
local function alert(text)
  if not (python and notify and hs.fs.attributes(notify)) then
    pcall(function() hs.notify.new({ title = "Eyes & Hands", informativeText = text }):send() end)
    return
  end
  local task
  task = hs.task.new(python, function(code)
    tasks[task] = nil
    if code ~= 0 then print("eyeshands loader: alert not sent (tg-notify exit " .. tostring(code) .. ")") end
  end, { notify, "Eyes & Hands: " .. text })
  if task and task:start() then tasks[task] = true
  else print("eyeshands loader: alert not sent (task did not start)") end
end

local cfg = { alert = alert }
if env.access and env.access ~= "" then cfg.access_file = env.access end
if env.targets and env.targets ~= "" then cfg.targets_file = env.targets end

local ok, err = pcall(function()
  local eh = hs.loadSpoon("EyesHands")
  if not eh then error("hs.loadSpoon found no EyesHands.spoon in ~/.hammerspoon/Spoons") end
  eh:start(cfg)
end)
if ok then
  print("eyeshands loader: started (access " .. tostring(cfg.access_file or "default") .. ")")
else
  print("eyeshands loader: failed to start the Spoon: " .. tostring(err))
end
