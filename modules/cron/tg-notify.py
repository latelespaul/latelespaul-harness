#!/usr/bin/env python3
# Send-only Telegram ping for hcron: tg-notify.py "message". Uses the telegram module's bot token
# (~/.claude/channels/telegram/.env) and its allowed chats (access.json). It only calls sendMessage,
# never getUpdates, so it cannot steal messages from the running Telegram session.
#
# Alerts to the master session (opt-in): when <profile>/telegram/ALERTS_TO_MASTER exists and the
# master session's screen ("claude-tg") is running, the alert is appended to
# <profile>/logs/master-alerts.log instead of being sent. The master session watches that file and
# fixes what it can (docs/master-session.md). If the master session is down, the alert goes to
# Telegram as before, marked "(master session down)". TG_NOTIFY_DIRECT=1 always sends.
import json, os, re, subprocess, sys, urllib.parse, urllib.request
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


def profile_dir():
    if os.environ.get("PROFILE_DIR"):
        return os.environ["PROFILE_DIR"]
    harness_env = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "harness.env")
    try:
        for line in open(harness_env):
            m = re.match(r"""\s*PROFILE_DIR=['"]?([^'"\n]*)""", line)
            if m:
                return os.path.expanduser(m.group(1))
    except OSError:
        pass
    return ""


def master_up():
    try:
        out = subprocess.run(["screen", "-ls"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return ".claude-tg" in out


def to_master(text):
    """Queue the alert for the master session; True when queued."""
    if os.environ.get("TG_NOTIFY_DIRECT") == "1":
        return False
    prof = profile_dir()
    if not prof or not os.path.exists(os.path.join(prof, "telegram", "ALERTS_TO_MASTER")) or not master_up():
        return False
    try:
        os.makedirs(os.path.join(prof, "logs"), exist_ok=True)
        with open(os.path.join(prof, "logs", "master-alerts.log"), "a") as f:
            f.write(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") + " " + text.replace("\n", " ") + "\n")
        return True
    except OSError:
        return False


def main():
    text = " ".join(sys.argv[1:]).strip()
    if not text:
        return 1
    if to_master(text):
        return 0
    prof = profile_dir()
    if prof and os.path.exists(os.path.join(prof, "telegram", "ALERTS_TO_MASTER")) and os.environ.get("TG_NOTIFY_DIRECT") != "1":
        text += " (master session down)"
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
