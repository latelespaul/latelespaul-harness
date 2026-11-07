#!/usr/bin/python3
"""Telegram channel watchdog. Run every minute by launchd (com.<prefix>.telegram-watchdog).

Checks that the Telegram Claude session is alive, single, polling and answering,
repairs it by restarting the com.<prefix>.telegram agent, and tells the user
on Telegram directly (Bot API, independent of Claude) whenever it acts.
Only the Mac named in $PROFILE_DIR/telegram/ACTIVE_HOST (on the profile's remote) runs
the bot; any other Mac stops its copy so two pollers never split the messages.
"""
import calendar
import fcntl
import hashlib
import json
import os
import re
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


ENV = harness_env("PROFILE_DIR", "LABEL_PREFIX", "TELEGRAM_WORKDIR", "BROWSER_PORT")
HOME = os.path.expanduser("~")
TG_DIR = os.path.join(HOME, ".claude/channels/telegram")
WD_DIR = os.path.join(TG_DIR, "watchdog")
STATE_FILE = os.path.join(WD_DIR, "state.json")
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

PENDING_GRACE = 180       # unread messages on Telegram for this long -> poller is deaf
NO_BOT_GRACE = 120        # no bot process for this long -> session failed to start
HANG_AFTER = 20 * 60      # mid-reply with no transcript activity for this long -> hung
PROMPT_HANG_AFTER = 60 * 60  # same, while a permission prompt is waiting for the user
FROZEN_AFTER = 10 * 60    # mid-reply with a screen that has not changed at all -> hung
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


def agent_pid():
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
        return calendar.timegm(time.strptime(s[:19], "%Y-%m-%dT%H:%M:%S"))
    except Exception:
        return 0


def transcript_status():
    """Return (busy, idle_seconds, last_api_error) for the newest Telegram session transcript."""
    try:
        files = [os.path.join(PROJECT_DIR, f) for f in os.listdir(PROJECT_DIR) if f.endswith(".jsonl")]
    except Exception:
        return False, 0, None
    if not files:
        return False, 0, None
    newest = max(files, key=os.path.getmtime)
    idle = time.time() - os.path.getmtime(newest)
    with open(newest, "rb") as f:
        f.seek(0, 2)
        f.seek(max(0, f.tell() - 1_500_000))
        lines = f.read().decode("utf-8", "replace").splitlines()[1:]
    last_in = last_end = 0
    last_err = None
    for line in lines:
        try:
            d = json.loads(line)
        except Exception:
            continue
        t, ts = d.get("type"), parse_ts(d.get("timestamp") or "")
        if t == "user" and "<channel source=\"telegram\"" in json.dumps(d.get("message", {}).get("content", ""))[:5000].replace('\\"', '"'):
            last_in = max(last_in, ts)
        elif t == "system" and d.get("subtype") == "turn_duration":
            last_end = max(last_end, ts)
        elif t == "assistant":
            if d.get("isApiErrorMessage"):
                text = " ".join(x.get("text", "") for x in d["message"].get("content", []) if isinstance(x, dict))
                last_err = {"ts": d.get("timestamp"), "text": text.strip()[:200]}
            else:
                last_err = None
    return last_in > last_end, idle, last_err


def restart(state, token, reason, fresh=False, tell=True):
    now = time.time()
    hist = [t for t in state.get("restarts", []) if now - t < STORM_WINDOW]
    if hist and now - hist[-1] < MIN_RESTART_GAP:
        log(f"restart wanted ({reason}) but last one was {int(now - hist[-1])}s ago; waiting")
        return
    if len(hist) >= STORM_MAX:
        if now - state.get("storm_alert", 0) > ALERT_GAP:
            notify(token, f"{len(hist)} restarts in 30 min and it is still unhealthy (last reason: {reason}). "
                          "Backing off to one try per 15 min. On the Mac, run: screen -r claude-tg")
            state["storm_alert"] = now
        if now - hist[-1] < 15 * 60:
            return
    if fresh:
        open(os.path.join(WD_DIR, "fresh-next"), "w").close()
    log(f"RESTART ({'fresh' if fresh else 'resume'}): {reason}")
    if agent_pid()[1]:
        subprocess.run(["launchctl", "kickstart", "-k", TARGET], capture_output=True)
    else:
        subprocess.run(["launchctl", "bootstrap", f"gui/{UID}", PLIST], capture_output=True)
    hist.append(now)
    state["restarts"] = hist
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


def this_host():
    return subprocess.run(["scutil", "--get", "LocalHostName"], capture_output=True, text=True).stdout.strip()


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


def check():
    os.makedirs(WD_DIR, exist_ok=True)
    state = load_state()
    now = time.time()
    token = read_env().get("TELEGRAM_BOT_TOKEN", "")
    state["last_run"] = now

    host, own = this_host(), owner(state, now)
    if own != host:
        if agent_pid()[1]:
            for label in (LABEL, AWAKE_LABEL):
                subprocess.run(["launchctl", "bootout", f"gui/{UID}/{label}"], capture_output=True)
            log(f"bot is owned by {own or 'no Mac'}; stopped the copy on {host}")
            notify(token, f"the bot now runs on {own or 'no Mac'}, so {host} stopped its copy.")
        save_state(state)
        return

    awake = f"gui/{UID}/{AWAKE_LABEL}"
    if subprocess.run(["launchctl", "print", awake], capture_output=True).returncode != 0:
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

    busy, idle, err = transcript_status()

    # Claude API errors (expired login, outages) never reach Telegram on their own.
    if err and err["ts"] != state.get("handled_error"):
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
    screen_busy = "esc to interrupt" in screen
    sig = hashlib.sha1(screen.encode()).hexdigest()
    if sig != state.get("screen_sig"):
        state["screen_sig"], state["screen_changed"] = sig, now
    frozen_for = now - state.get("screen_changed", now)

    # A usage limit leaves Claude on a menu that blocks every queued message, even after the
    # limit resets. Tell me once, and press Esc every 30 min so it resumes on its own.
    if "rate-limit-options" in screen and not screen_busy:
        if now - state.get("limit_alert", 0) > 6 * 3600:
            m = re.search(r"resets [^\n·]+", screen)
            notify(token, f"Claude hit its usage limit{' (' + m.group(0).strip() + ')' if m else ''}. "
                          "Your messages wait until then; I'll retry every 30 min.")
            state["limit_alert"] = now
        if now - state.get("limit_retry", 0) > 30 * 60:
            subprocess.run(["/usr/bin/screen", "-S", "claude-tg", "-p", "0", "-X", "stuff", "\x1b"],
                           capture_output=True)
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
