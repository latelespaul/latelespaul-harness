#!/usr/bin/env python3
# Send-only Telegram ping for hcron: tg-notify.py "message". Uses the telegram module's bot token
# (~/.claude/channels/telegram/.env) and its allowed chats (access.json). It only calls sendMessage,
# never getUpdates, so it cannot steal messages from the running Telegram session.
import json, os, sys, urllib.parse, urllib.request

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


def main():
    text = " ".join(sys.argv[1:]).strip()
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
