#!/usr/bin/python3
"""Telegram channel watchdog. Run every minute by launchd (com.<prefix>.telegram-watchdog) on
macOS, or by a crontab line on Linux (no launchd), where the session is the tmux session claude-tg.

Checks that the Telegram Claude session is alive, single, polling and answering,
repairs it by restarting the com.<prefix>.telegram agent (or the tmux session), and tells the user
on Telegram directly (Bot API, independent of Claude) whenever it acts.
Only the machine named in $PROFILE_DIR/telegram/ACTIVE_HOST (on the profile's remote) runs
the bot; any other machine stops its copy so two pollers never split the messages.
With TELEGRAM_POLLING=0 it only keeps the session running: it never calls Telegram, ignores
ACTIVE_HOST, and stops any poller that starts under the session.
"""
import calendar
import datetime
import fcntl
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request



def harness_env(*keys):
    """Per-user values, loaded the same way the zsh scripts load them (lib/env.sh)."""
    lib = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "lib", "env.sh")
    script = 'source "$1"; shift; for k in "$@"; do print -r -- "$k=${(P)k}"; done'
    out = subprocess.run(["/bin/zsh", "-c", script, "zsh", lib, *keys], capture_output=True, text=True).stdout
    return dict(line.split("=", 1) for line in out.splitlines() if "=" in line)


ENV = harness_env("PROFILE_DIR", "LABEL_PREFIX", "TELEGRAM_WORKDIR", "BROWSER_PORT", "TELEGRAM_POLLING")
HOME = os.path.expanduser("~")
TG_DIR = os.path.join(HOME, ".claude/channels/telegram")
WD_DIR = os.path.join(TG_DIR, "watchdog")
STATE_FILE = os.path.join(WD_DIR, "state.json")
UNINSTALLED = os.path.join(WD_DIR, "uninstalled")  # install.sh --uninstall on Linux; install removes it
LOG_FILE = os.path.join(TG_DIR, "logs/watchdog.log")
PROFILE = ENV.get("PROFILE_DIR", "")
WORK_DIR = ENV.get("TELEGRAM_WORKDIR") or os.path.join(HOME, "Projects/claude-telegram")
PROJECT_DIR = os.path.join(HOME, ".claude/projects", re.sub(r"[^A-Za-z0-9]", "-", WORK_DIR))
PREFIX = ENV.get("LABEL_PREFIX", "")
LABEL = f"com.{PREFIX}.telegram"
AWAKE_LABEL = f"com.{PREFIX}.keep-awake"
BROWSER_LABEL = f"com.{PREFIX}.chrome-claude"
BROWSER_PORT = ENV.get("BROWSER_PORT") or "9222"
PLIST = os.path.join(HOME, f"Library/LaunchAgents/{LABEL}.plist")
UID = os.getuid()
TARGET = f"gui/{UID}/{LABEL}"
OWNER_CHECK_EVERY = 10 * 60
POLLING = ENV.get("TELEGRAM_POLLING", "1") != "0"
# No launchd (Linux): the session is a tmux session that runs run.sh.
LAUNCHD = sys.platform == "darwin"
SESSION = "claude-tg"
RUN_SH = os.path.join(os.path.dirname(os.path.realpath(__file__)), "run.sh")
TMUX = shutil.which("tmux") or "tmux"

PENDING_GRACE = 180       # unread messages on Telegram for this long -> poller is deaf
NO_BOT_GRACE = 120        # no bot process for this long -> session failed to start
HANG_AFTER = 20 * 60      # mid-reply with no transcript activity for this long -> hung
PROMPT_HANG_AFTER = 60 * 60  # same, while a permission prompt is waiting for the user
CHANNEL_TAG = re.compile(r'<channel source="(?:plugin:telegram:)?telegram"')
FROZEN_AFTER = 10 * 60    # mid-reply with a screen that has not changed at all -> hung
STALLED_AFTER = 5 * 60    # a message queued in Claude this long with no reply started -> it stopped taking turns
RESET_GRACE = 60          # after a usage limit resets, wait this long before restarting
MIN_RESTART_GAP = 180
STORM_WINDOW, STORM_MAX = 30 * 60, 5
ALERT_GAP = 60 * 60


def log(msg):
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 1_000_000:
        os.replace(LOG_FILE, LOG_FILE + ".1")
    with open(LOG_FILE, "a") as f:
        f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(s):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f, indent=1)
    os.replace(tmp, STATE_FILE)


def read_env():
    env = {}
    try:
        for line in open(os.path.join(TG_DIR, ".env")):
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.strip().split("=", 1)
                env[k] = v.strip().strip('"').strip("'")
    except Exception:
        pass
    return env


def chat_ids():
    try:
        return [str(x) for x in json.load(open(os.path.join(TG_DIR, "access.json"))).get("allowFrom", [])]
    except Exception:
        return []


def tg(token, method, params=None, timeout=15):
    data = urllib.parse.urlencode(params).encode() if params else None
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=data)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def notify(token, text):
    if not POLLING:  # polling off: this machine never talks to the bot
        return
    for cid in chat_ids():
        try:
            tg(token, "sendMessage", {"chat_id": cid, "text": "🛠 Telegram watchdog: " + text})
        except Exception as e:
            log(f"notify failed: {e}")


def processes():
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,command="], capture_output=True, text=True).stdout
    procs = {}
    for line in out.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            procs[int(parts[0])] = (int(parts[1]), parts[2])
    return procs


def descendants(procs, root):
    found, frontier = set(), {root}
    while frontier:
        nxt = {p for p, (pp, _) in procs.items() if pp in frontier and p not in found}
        found |= nxt
        frontier = nxt
    return found


def tmux(*args):
    return subprocess.run([TMUX, *args], capture_output=True, text=True)


def agent_pid():
    """(pid of the session's root process, whether the session exists)."""
    if not LAUNCHD:
        r = tmux("list-panes", "-t", f"={SESSION}", "-F", "#{pane_pid}")
        if r.returncode != 0:
            return None, False
        first = (r.stdout.split() or [""])[0]
        return (int(first) if first.isdigit() else None), True
    r = subprocess.run(["launchctl", "print", TARGET], capture_output=True, text=True)
    if r.returncode != 0:
        return None, False
    m = re.search(r"^\s*pid = (\d+)", r.stdout, re.M)
    return (int(m.group(1)) if m else None), True


def is_ours(cmd):
    """A bot-session process: run.sh, a claude started with the bot settings, or the plugin's server.

    Matches on the program actually running, not on text anywhere in the command line: a shell
    or editor whose arguments merely mention these paths (an agent inspecting the setup) is not
    the bot and must not be killed.
    """
    words = cmd.split()
    if not words:
        return False
    prog = os.path.basename(words[0])
    if words[0].endswith("/telegram/run.sh"):
        return True
    # "/bin/zsh -il .../telegram/run.sh" (its shebang) or the screen/login that started it.
    # "zsh -c '...run.sh...'" (also -lc, -ic) is someone's command, and for a shell run.sh must be
    # the script it runs, not an argument to another script.
    if prog in ("zsh", "bash", "sh", "screen", "SCREEN", "login"):
        for w in words[1:]:
            if w.endswith("/telegram/run.sh"):
                return True
            if w.startswith("-") and not w.startswith("--") and "c" in w:
                return False
            if prog in ("zsh", "bash", "sh") and not w.startswith("-"):
                return False
    if prog in ("claude", "node") and "telegram-settings.json" in cmd:
        return True
    return prog == "bun" and "plugins/cache/claude-plugins-official/telegram" in cmd


def kill_strays(procs, tree):
    """Kill Telegram-session processes that are not under the current agent (orphans, manual copies)."""
    killed = []
    # firstmate runs its own bot (separate TELEGRAM_STATE_DIR) under run-firstmate.sh; leave it alone.
    for root, (_, cmd) in procs.items():
        if "run-firstmate.sh" in cmd:
            tree = tree | {root} | descendants(procs, root)
    for pid, (_, cmd) in procs.items():
        if pid not in tree and pid != os.getpid() and is_ours(cmd) and "watchdog" not in cmd:
            try:
                os.kill(pid, 15)
                killed.append(pid)
            except ProcessLookupError:
                pass
    # A poller recorded in bot.pid that is not ours (another session with the plugin enabled).
    try:
        bp = int(open(os.path.join(TG_DIR, "bot.pid")).read().strip())
        if bp in procs and bp not in tree and "server.ts" in procs[bp][1]:
            os.kill(bp, 15)
            killed.append(bp)
    except Exception:
        pass
    return killed


def screen_text():
    if not LAUNCHD:
        r = tmux("capture-pane", "-p", "-t", f"={SESSION}")
        return r.stdout if r.returncode == 0 else ""
    path = os.path.join(WD_DIR, "screen.txt")
    try:
        subprocess.run(["/usr/bin/screen", "-S", "claude-tg", "-p", "0", "-X", "hardcopy", path],
                       capture_output=True, timeout=10)
        time.sleep(0.5)
        return open(path, "rb").read().decode("utf-8", "replace")
    except Exception:
        return ""


def parse_ts(s):
    try:
        t = calendar.timegm(time.strptime(s[:19], "%Y-%m-%dT%H:%M:%S"))
    except Exception:
        return 0
    m = re.match(r"\.(\d+)", s[19:])
    return t + (float("0." + m.group(1)) if m else 0)


def reset_from_text(text, since):
    """Epoch seconds a usage limit resets at, from "resets Nov 20 at 11:30pm (Asia/Calcutta)" or
    "resets 3pm (Europe/London)" in an error written at `since`. Unreadable: an hour after the error."""
    m = re.search(r"resets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)"
                  r"(?:\s*\(([^)]+)\))?", text, re.I)
    if not m:
        return since + 3600
    mon, day, hour, minute, ampm, zone = m.groups()
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(zone) if zone else None
    except Exception:
        tz = None  # unknown zone: local time
    base = datetime.datetime.fromtimestamp(since, tz)
    hm = {"hour": int(hour) % 12 + (12 if ampm.lower() == "pm" else 0), "minute": int(minute or 0),
          "second": 0, "microsecond": 0}
    try:
        if mon:
            t = base.replace(month=time.strptime(mon.title(), "%b").tm_mon, day=int(day), **hm)
            if t.timestamp() < since - 86400:  # "Jan 2" written on Dec 30
                t = t.replace(year=t.year + 1)
        else:
            t = base.replace(**hm)
            if t.timestamp() <= since:
                t += datetime.timedelta(days=1)
    except ValueError:
        return since + 3600
    return t.timestamp()


def limit_reset(d, text):
    """For a usage-limit error entry, when the limit resets (epoch seconds); None for any other error."""
    if d.get("apiError") != "usage_limit_reached" and not re.search(r"hit your .*limit", text, re.I):
        return None
    at = ((d.get("apiErrorParams") or {}).get("rate_limit_info") or {}).get("resetsAt")
    if isinstance(at, (int, float)) and at > 0:
        return float(at)
    return reset_from_text(text, parse_ts(d.get("timestamp") or "") or time.time())


def transcript_status():
    """Return (busy, idle_seconds, last_api_error, queued, turn_open) for the newest Telegram session transcript.

    queued is (enqueued, limit_reset) when messages wait in Claude's queue with no reply started,
    else None (also while a tool call is running): enqueued lists when each message newer than the
    newest assistant entry was queued; limit_reset is when the usage limit resets if the last reply
    was a usage-limit error. turn_open is False once the last turn has ended (its turn_duration
    entry is the newest turn entry), so a stale "esc to interrupt" left on screen is not a live turn.
    """
    try:
        files = [os.path.join(PROJECT_DIR, f) for f in os.listdir(PROJECT_DIR) if f.endswith(".jsonl")]
    except Exception:
        return False, 0, None, None, False
    if not files:
        return False, 0, None, None, False
    newest = max(files, key=os.path.getmtime)
    idle = time.time() - os.path.getmtime(newest)
    with open(newest, "rb") as f:
        f.seek(0, 2)
        f.seek(max(0, f.tell() - 1_500_000))
        lines = f.read().decode("utf-8", "replace").splitlines()[1:]
    last_in = last_end = last_out = 0
    enqueued = []
    last_err = None
    in_tool = False  # the last turn entry is a tool call whose result has not come back
    turn_open = False  # a user or assistant entry came after the last turn_duration
    for line in lines:
        try:
            d = json.loads(line)
        except Exception:
            continue
        t, ts = d.get("type"), parse_ts(d.get("timestamp") or "")
        if t == "queue-operation":
            # Slash commands (e.g. /rate-limit-options) are queued too but run without a reply.
            c = d.get("content")
            if d.get("operation") == "enqueue" and not (isinstance(c, str) and c.lstrip().startswith("/")):
                enqueued.append(ts)
            continue
        if t in ("user", "assistant") or (t == "system" and d.get("subtype") == "turn_duration"):
            content = d.get("message", {}).get("content") if t == "assistant" else None
            in_tool = isinstance(content, list) and any(isinstance(x, dict) and x.get("type") == "tool_use" for x in content)
            turn_open = t != "system"
        # The plugin tags messages <channel source="plugin:telegram:telegram" ...>; older builds used "telegram".
        if t == "user" and CHANNEL_TAG.search(json.dumps(d.get("message", {}).get("content", ""))[:5000].replace('\\"', '"')):
            last_in = max(last_in, ts)
        elif t == "system" and d.get("subtype") == "turn_duration":
            last_end = max(last_end, ts)
        elif t == "assistant":
            last_out = max(last_out, ts)
            if d.get("isApiErrorMessage"):
                text = " ".join(x.get("text", "") for x in d["message"].get("content", []) if isinstance(x, dict))
                last_err = {"ts": d.get("timestamp"), "text": text.strip()[:200], "reset": limit_reset(d, text)}
            else:
                last_err = None
    waiting = [t for t in enqueued if t > last_out]
    queued = (waiting, last_err["reset"] if last_err else None) if waiting and not in_tool else None
    return last_in > last_end, idle, last_err, queued, turn_open


def restart(state, token, reason, fresh=False, tell=True):
    now = time.time()
    hist = [t for t in state.get("restarts", []) if now - t < STORM_WINDOW]
    if hist and now - hist[-1] < MIN_RESTART_GAP:
        log(f"restart wanted ({reason}) but last one was {int(now - hist[-1])}s ago; waiting")
        return False
    if len(hist) >= STORM_MAX:
        if now - state.get("storm_alert", 0) > ALERT_GAP:
            notify(token, f"{len(hist)} restarts in 30 min and it is still unhealthy (last reason: {reason}). "
                          "Backing off to one try per 15 min. On the Mac, run: screen -r claude-tg")
            state["storm_alert"] = now
        if now - hist[-1] < 15 * 60:
            return False
    if fresh:
        open(os.path.join(WD_DIR, "fresh-next"), "w").close()
    log(f"RESTART ({'fresh' if fresh else 'resume'}): {reason}")
    if not LAUNCHD:
        if agent_pid()[1]:
            tmux("kill-session", "-t", f"={SESSION}")
        tmux("new", "-d", "-s", SESSION, RUN_SH)
    elif agent_pid()[1]:
        subprocess.run(["launchctl", "kickstart", "-k", TARGET], capture_output=True)
    else:
        subprocess.run(["launchctl", "bootstrap", f"gui/{UID}", PLIST], capture_output=True)
    hist.append(now)
    state["restarts"] = hist
    state["last_restart_at"] = now
    state["last_restart_reason"] = reason
    for k in ("pending_since", "no_bot_since"):
        state.pop(k, None)
    time.sleep(3)
    procs = processes()
    pid, _ = agent_pid()
    kill_strays(procs, descendants(procs, pid) | {pid} if pid else set())
    if tell:
        notify(token, f"restarted Claude ({reason}). "
                      + ("Started a fresh conversation. " if fresh else "Your conversation was kept. ")
                      + "If your last message wasn't answered, send it again.")
    return True


def check_queue(state, token, now, queued):
    """Alive and polling, but no turn runs: messages pile up in Claude's queue unanswered (seen after a
    usage limit reset). Waits out a usage limit, then restarts when the oldest waiting message has
    waited STALLED_AFTER. A restart resumes the conversation but loses the messages queued in the old
    process (restart says so), so only messages queued after the last restart count: one restart per
    stuck batch, never a loop. Returns True when it restarted."""
    enqueued, reset = queued
    if reset and now < reset + RESET_GRACE:
        return False  # restarting now only hits the limit again
    waiting = [t for t in enqueued if t > state.get("last_restart_at", 0)]
    if not waiting or now - min(waiting) <= STALLED_AFTER:
        return False
    why = f"{len(waiting)} message(s) waited {int((now - min(waiting)) // 60)} min with no reply"
    return restart(state, token, why + (" after the usage limit reset" if reset else ""))


def this_host():
    """The same name install.sh writes to ACTIVE_HOST: scutil on macOS, else hostname -s."""
    if LAUNCHD:
        return subprocess.run(["scutil", "--get", "LocalHostName"], capture_output=True, text=True).stdout.strip()
    return socket.gethostname().split(".")[0]


def owner(state, now):
    """The Mac that should run the bot, per telegram/ACTIVE_HOST in the profile's upstream (re-fetched every 10 min)."""
    git = ["git", "-C", PROFILE]
    if now - state.get("owner_checked", 0) > OWNER_CHECK_EVERY:
        state["owner_checked"] = now
        subprocess.run(git + ["fetch", "-q"], capture_output=True, timeout=60,
                       env={**os.environ, "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"})
    r = subprocess.run(git + ["show", "@{u}:telegram/ACTIVE_HOST"], capture_output=True, text=True)
    if r.returncode == 0:
        return r.stdout.strip()
    try:
        return open(os.path.join(PROFILE, "telegram/ACTIVE_HOST")).read().strip()
    except Exception:
        return ""


def check_browser(state, token, now):
    """Keep Claude Chrome (browser module) answering on its debug port, if it is installed here."""
    label = BROWSER_LABEL
    plist = os.path.join(HOME, f"Library/LaunchAgents/{label}.plist")
    if not os.path.exists(plist):
        return
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{BROWSER_PORT}/json/version", timeout=5) as r:
            r.read()
        state.pop("browser_down_since", None)
        return
    except Exception:
        pass
    state.setdefault("browser_down_since", now)
    if now - state["browser_down_since"] < 180 or now - state.get("browser_restart", 0) < 600:
        return
    state["browser_restart"] = now
    target = f"gui/{UID}/{label}"
    if subprocess.run(["launchctl", "print", target], capture_output=True).returncode == 0:
        subprocess.run(["launchctl", "kickstart", "-k", target], capture_output=True)
    else:
        subprocess.run(["launchctl", "bootstrap", f"gui/{UID}", plist], capture_output=True)
    log("RESTART Claude Chrome: debug port not answering")
    notify(token, "Claude Chrome stopped responding, so I restarted it. Your logins are kept.")


def check_no_poll(state, token, now):
    """Polling off: keep the session running, and stop any poller under it. No Telegram calls."""
    pid, loaded = agent_pid()
    if not loaded or pid is None:
        restart(state, token, "the Telegram session (polling off) was not running", tell=False)
        return
    procs = processes()
    tree = descendants(procs, pid) | {pid}
    killed = kill_strays(procs, tree)
    if killed:
        log(f"killed stray Telegram processes: {killed}")
    for p in tree:
        if p in procs and "server.ts" in procs[p][1]:
            try:
                os.kill(p, 15)
                log(f"polling is off, but a Telegram poller ({p}) ran under the session; stopped it")
            except ProcessLookupError:
                pass


def check():
    os.makedirs(WD_DIR, exist_ok=True)
    if os.path.exists(UNINSTALLED):
        return
    state = load_state()
    now = time.time()
    token = read_env().get("TELEGRAM_BOT_TOKEN", "")
    state["last_run"] = now

    if not POLLING:
        check_no_poll(state, token, now)
        save_state(state)
        return

    host, own = this_host(), owner(state, now)
    if own != host:
        if agent_pid()[1]:
            if LAUNCHD:
                for label in (LABEL, AWAKE_LABEL):
                    subprocess.run(["launchctl", "bootout", f"gui/{UID}/{label}"], capture_output=True)
            else:
                tmux("kill-session", "-t", f"={SESSION}")
            log(f"bot is owned by {own or 'no machine'}; stopped the copy on {host}")
            notify(token, f"the bot now runs on {own or 'no machine'}, so {host} stopped its copy.")
        save_state(state)
        return

    awake = f"gui/{UID}/{AWAKE_LABEL}"
    if LAUNCHD and subprocess.run(["launchctl", "print", awake], capture_output=True).returncode != 0:
        subprocess.run(["launchctl", "bootstrap", f"gui/{UID}",
                        os.path.join(HOME, f"Library/LaunchAgents/{AWAKE_LABEL}.plist")], capture_output=True)

    pid, loaded = agent_pid()
    if not loaded or pid is None:
        restart(state, token, "the Telegram session was not running")
        save_state(state)
        return

    procs = processes()
    tree = descendants(procs, pid) | {pid}
    killed = kill_strays(procs, tree)
    if killed:
        log(f"killed stray Telegram processes: {killed}")

    bot_alive = any("server.ts" in procs[p][1] for p in tree if p in procs)
    if bot_alive:
        state.pop("no_bot_since", None)
    else:
        state.setdefault("no_bot_since", now)
        if now - state["no_bot_since"] > NO_BOT_GRACE:
            screen = screen_text()
            if "trust" in screen and "Enter to confirm" in screen:
                if now - state.get("prompt_alert", 0) > ALERT_GAP:
                    notify(token, "Claude is waiting on the 'trust this folder' prompt. On the Mac, run "
                                  "screen -r claude-tg and choose Yes.")
                    state["prompt_alert"] = now
            else:
                restart(state, token, "the bot process was not running")
            save_state(state)
            return

    # Messages stuck on Telegram's side mean nothing is polling.
    if token:
        try:
            pending = tg(token, "getWebhookInfo")["result"].get("pending_update_count", 0)
            if pending:
                state.setdefault("pending_since", now)
                if now - state["pending_since"] > PENDING_GRACE:
                    restart(state, token, f"{pending} message(s) were not being picked up")
                    save_state(state)
                    return
            else:
                state.pop("pending_since", None)
        except Exception as e:
            log(f"Telegram API unreachable ({e}); skipping poll check")

    check_browser(state, token, now)

    busy, idle, err, queued, turn_open = transcript_status()
    # A restarted session writes no transcript until its first message, so the newest file can be
    # the old one with its unanswered message: not a live turn, or every restart looks stuck again.
    if now - idle < state.get("last_restart_at", 0):
        busy = turn_open = False

    # A usage limit: a restart cannot help before it resets, so only say when. check_queue restarts
    # once after the reset if messages are still waiting.
    if err and err["reset"] and err["ts"] != state.get("handled_error"):
        state["handled_error"] = err["ts"]
        when = time.strftime("%b %d %H:%M", time.localtime(err["reset"]))
        log(f"usage limit until {when}; not restarting before then")
        if state.get("limit_noticed") != err["reset"]:  # once per limit, however often it is hit again
            notify(token, f"Claude hit its usage limit (resets {when}). Your messages wait until then; "
                          "if they are still unanswered after the reset, I'll restart it.")
            state["limit_noticed"] = err["reset"]

    # Claude API errors (expired login, outages) never reach Telegram on their own.
    if err and not err["reset"] and err["ts"] != state.get("handled_error"):
        state["handled_error"] = err["ts"]
        auth = re.search(r"login|auth|401|token|credential", err["text"], re.I)
        recent = [t for t in state.get("auth_errors", []) if now - t < 3600]
        if auth:
            recent.append(now)
            state["auth_errors"] = recent
        if auth and len(recent) >= 2:
            notify(token, f"Claude says: \"{err['text']}\". A restart didn't fix it, so the Mac needs a new "
                          "sign-in: open Terminal and run claude, then /login. I'll keep checking.")
        else:
            restart(state, token, f"Claude returned an error: {err['text']}")
        save_state(state)
        return

    # A turn in progress is not in the transcript until it ends, so also watch the screen:
    # a live turn shows "esc to interrupt" with a ticking timer; a frozen one never changes.
    screen = screen_text()
    # The screen hardcopy can keep "esc to interrupt" after a turn ends; trust it only while the
    # transcript shows the turn still open, or an idle session looks frozen and gets restarted.
    screen_busy = "esc to interrupt" in screen and turn_open
    sig = hashlib.sha1(screen.encode()).hexdigest()
    if sig != state.get("screen_sig"):
        state["screen_sig"], state["screen_changed"] = sig, now
    frozen_for = now - state.get("screen_changed", now)

    if queued and not (busy or screen_busy) and check_queue(state, token, now, queued):
        save_state(state)
        return

    # A usage limit leaves Claude on a menu that blocks every queued message, even after the
    # limit resets. Tell me once, and press Esc every 30 min so it resumes on its own.
    if "rate-limit-options" in screen and not screen_busy:
        if now - state.get("limit_alert", 0) > 6 * 3600:
            m = re.search(r"resets [^\n·]+", screen)
            notify(token, f"Claude hit its usage limit{' (' + m.group(0).strip() + ')' if m else ''}. "
                          "Your messages wait until then; I'll retry every 30 min.")
            state["limit_alert"] = now
        if now - state.get("limit_retry", 0) > 30 * 60:
            if LAUNCHD:
                subprocess.run(["/usr/bin/screen", "-S", "claude-tg", "-p", "0", "-X", "stuff", "\x1b"],
                               capture_output=True)
            else:
                tmux("send-keys", "-t", f"={SESSION}", "Escape")
            state["limit_retry"] = now
            log("usage-limit menu on screen; pressed Esc to retry")
        save_state(state)
        return
    state.pop("limit_alert", None)

    if busy or screen_busy:
        waiting_on_user = bool(re.search(r"Do you want to|Allow .*\?|Yes, and don't ask", screen))
        stuck = []
        if busy and idle > (PROMPT_HANG_AFTER if waiting_on_user else HANG_AFTER):
            stuck.append(idle)
        if screen_busy and frozen_for > (PROMPT_HANG_AFTER if waiting_on_user else FROZEN_AFTER):
            stuck.append(frozen_for)
        if stuck:
            recent_hang = now - state.get("last_hang", 0) < 2 * 3600
            state["last_hang"] = now
            restart(state, token, f"it was stuck on a reply for {int(max(stuck) // 60)} min", fresh=recent_hang)

    save_state(state)


def main():
    os.makedirs(WD_DIR, exist_ok=True)
    lock = open(os.path.join(WD_DIR, "lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return
    try:
        check()
    except Exception as e:
        log(f"watchdog error: {e!r}")
        sys.exit(1)


if __name__ == "__main__":
    main()
