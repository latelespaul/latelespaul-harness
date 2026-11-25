#!/usr/bin/env python3
# Send-only Telegram ping for hcron: tg-notify.py "message". Uses the telegram module's bot token
# (~/.claude/channels/telegram/.env) and its allowed chats (access.json). It only calls sendMessage,
# never getUpdates, so it cannot steal messages from the running Telegram session.
#
# Alerts to the master session (opt-in): when <profile>/telegram/ALERTS_TO_MASTER exists and the
# master session is up, the alert is appended to <profile>/logs/master-alerts.log instead of being
# sent. The master session watches that file and fixes what it can (docs/master-session.md). It counts
# as up when its session "claude-tg" runs here (screen on macOS, tmux on Linux), or when a master
# session on a VM pulled this Mac's alerts over mac-node in the last 10 minutes
# ($MACNODE_DIR/alerts-pulled; the VM's heartbeat pulls every minute while its master runs). If the
# master session is down, the alert is still logged there, and Telegram gets one note per outage
# ("master session down since HH:MM; N alerts queued") plus at most one reminder every 6 h, instead
# of every alert (~/.claude/channels/telegram/master-down.json keeps the outage's count; it is cleared
# once the master is back). TG_NOTIFY_DIRECT=1 always sends the alert itself.
import json, os, re, subprocess, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone

TG_DIR = os.path.join(os.path.expanduser("~"), ".claude/channels/telegram")


def env():
    out = {}
    try:
        for line in open(os.path.join(TG_DIR, ".env")):
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.strip().split("=", 1)
                out[k] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return out


def harness_value(key, default=""):
    """key from the environment, else from harness.env ($HARNESS_ENV or the harness's own), else default."""
    if os.environ.get(key):
        return os.environ[key]
    harness_env = os.environ.get("HARNESS_ENV") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "harness.env")
    try:
        for line in open(harness_env):
            m = re.match(r"""\s*""" + key + r"""=['"]?([^'"\n]*)""", line)
            if m:
                return os.path.expanduser(os.path.expandvars(m.group(1)))
    except OSError:
        pass
    return default


def profile_dir():
    return harness_value("PROFILE_DIR")


REMOTE_FRESH = 10 * 60  # a VM pull this recent means a master session on the VM is up


def local_master_up():
    cmd = ["screen", "-ls"] if sys.platform == "darwin" else ["tmux", "has-session", "-t", "=claude-tg"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return False
    return ".claude-tg" in r.stdout if sys.platform == "darwin" else r.returncode == 0


def remote_master_up():
    mn = harness_value("MACNODE_DIR", os.path.join(os.path.expanduser("~"), ".local/state/mac-node"))
    try:
        return time.time() - os.path.getmtime(os.path.join(mn, "alerts-pulled")) < REMOTE_FRESH
    except OSError:
        return False


def master_up():
    return local_master_up() or remote_master_up()


DOWN_FILE = os.path.join(TG_DIR, "master-down.json")
REMIND_EVERY = 6 * 3600


def alerts_to_master():
    prof = profile_dir()
    return bool(prof) and os.path.exists(os.path.join(prof, "telegram", "ALERTS_TO_MASTER")) and os.environ.get("TG_NOTIFY_DIRECT") != "1"


def log_alert(text):
    """Append the alert to the master session's log; True when written."""
    prof = profile_dir()
    try:
        os.makedirs(os.path.join(prof, "logs"), exist_ok=True)
        with open(os.path.join(prof, "logs", "master-alerts.log"), "a") as f:
            f.write(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") + " " + text.replace("\n", " ") + "\n")
        return True
    except OSError:
        return False


def outage_note(now=None):
    """The master is down: count this alert in the outage, and return the one note for Telegram when
    it is due (the first alert of the outage, then every REMIND_EVERY), else None."""
    now = now or time.time()
    try:
        st = json.load(open(DOWN_FILE))
    except (OSError, ValueError):
        st = {}
    first = "since" not in st
    st.setdefault("since", now)
    st["count"] = st.get("count", 0) + 1
    due = first or now - st.get("sent", 0) >= REMIND_EVERY
    if due:
        st["sent"] = now
    try:
        os.makedirs(TG_DIR, exist_ok=True)
        with open(DOWN_FILE + ".tmp", "w") as f:
            json.dump(st, f)
        os.replace(DOWN_FILE + ".tmp", DOWN_FILE)
    except OSError:
        pass
    if not due:
        return None
    n = st["count"]
    return (f"master session {'down' if first else 'still down'} since {time.strftime('%H:%M', time.localtime(st['since']))}; "
            f"{n} alert{'s' if n != 1 else ''} queued in logs/master-alerts.log")


USAGE = 'usage: tg-notify.py "message"   (sends a send-only Telegram alert, or queues it for the master session)'


def main():
    args = sys.argv[1:]
    text = " ".join(args).strip()
    if not text or "-h" in args or "--help" in args:
        print(USAGE, file=sys.stderr)
        return 2
    if alerts_to_master():
        if master_up():
            try:
                os.remove(DOWN_FILE)  # the outage, if any, is over
            except OSError:
                pass
            if log_alert(text):
                return 0
        elif log_alert(text):
            text = outage_note()
            if text is None:
                return 0
    token = env().get("TELEGRAM_BOT_TOKEN", "")
    if not text or not token:
        return 1
    try:
        chats = json.load(open(os.path.join(TG_DIR, "access.json"))).get("allowFrom", [])
    except (OSError, ValueError):
        return 1
    for cid in chats:
        data = urllib.parse.urlencode({"chat_id": cid, "text": "⏰ " + text[:3500]}).encode()
        try:
            urllib.request.urlopen(urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=data), timeout=15).read()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
