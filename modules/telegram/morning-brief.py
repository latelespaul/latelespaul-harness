#!/usr/bin/python3 -I
"""Writes a daily morning brief with headless Claude and sends it from the Telegram bot.

Runs from launchd (com.<prefix>.morning-brief) at TELEGRAM_BRIEF_TIME every day. The prompt is
$PROFILE_DIR/telegram/morning-brief.md; names in watchlist.txt next to it replace {{WATCHLIST}} in
the prompt (or are appended). Only the Mac named in ACTIVE_HOST sends, so one brief a day.
`morning-brief.py --now` skips the owner check (for a manual test).
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request



def harness_setting(name, default=""):
    """A harness.env value, loaded the same way the zsh scripts load it (lib/env.sh)."""
    lib = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "lib", "env.sh")
    r = subprocess.run(["/bin/zsh", "-c", 'source "$1"; print -r -- "${(P)2}"', "zsh", lib, name],
                       capture_output=True, text=True)
    return r.stdout.strip() or default


def profile_dir():
    return harness_setting("PROFILE_DIR")


HERE = os.path.join(profile_dir(), "telegram")
TG_DIR = os.path.expanduser("~/.claude/channels/telegram")
WORK_DIR = os.path.join(TG_DIR, "morning")
LOG = os.path.join(TG_DIR, "logs", "morning-brief.log")
LIMIT = 4000  # Telegram caps a message at 4096 characters


def log(msg):
    with open(LOG, "a") as f:
        f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")


def token():
    for line in open(os.path.join(TG_DIR, ".env")):
        if line.startswith("TELEGRAM_BOT_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("no TELEGRAM_BOT_TOKEN")


def chat_ids():
    return [str(x) for x in json.load(open(os.path.join(TG_DIR, "access.json"))).get("allowFrom", [])]


def send(text):
    for cid in chat_ids():
        data = urllib.parse.urlencode({"chat_id": cid, "text": text, "disable_web_page_preview": "true"}).encode()
        req = urllib.request.Request(f"https://api.telegram.org/bot{token()}/sendMessage", data=data)
        with urllib.request.urlopen(req, timeout=20) as r:
            json.load(r)


def chunks(text):
    """Split on paragraph breaks, then lines, so no message passes Telegram's limit."""
    out, cur = [], ""
    for para in text.split("\n\n"):
        piece = para if not cur else "\n\n" + para
        if len(cur) + len(piece) <= LIMIT:
            cur += piece
            continue
        if cur:
            out.append(cur)
        cur = ""
        for line in para.split("\n"):
            while len(line) > LIMIT:
                out.append(line[:LIMIT])
                line = line[LIMIT:]
            piece = line if not cur else "\n" + line
            if len(cur) + len(piece) > LIMIT:
                out.append(cur)
                cur = line
            else:
                cur += piece
    if cur:
        out.append(cur)
    return out


def main():
    os.makedirs(WORK_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    if "--now" not in sys.argv:
        owner = open(os.path.join(HERE, "ACTIVE_HOST")).read().strip()
        me = subprocess.run(["/usr/sbin/scutil", "--get", "LocalHostName"], capture_output=True, text=True).stdout.strip()
        if owner != me:
            log(f"skipped: bot owner is {owner or 'nobody'}, this Mac is {me or socket.gethostname()}")
            return
    prompt = open(os.path.join(HERE, "morning-brief.md")).read()
    prompt = time.strftime("Today is %A, %d %B %Y (%Z).\n\n") + prompt
    # Names the user follows, one per line in watchlist.txt (# comments allowed).
    try:
        names = [l.split("#")[0].strip() for l in open(os.path.join(HERE, "watchlist.txt"))]
        names = [n for n in names if n]
    except FileNotFoundError:
        names = []
    if "{{WATCHLIST}}" in prompt:
        prompt = prompt.replace("{{WATCHLIST}}", ", ".join(names) or "(none)")
    elif names:
        prompt += "\nMY WATCHLIST: " + ", ".join(names) + "\n"
    claude = os.path.expanduser("~/.local/bin/claude")
    if not os.path.exists(claude):
        claude = shutil.which("claude") or "/opt/homebrew/bin/claude"
    # CLAUDE_P_IGNORE_API_KEY=1 (harness.env): use the claude.ai subscription login, not an API key.
    env = dict(os.environ)
    if harness_setting("CLAUDE_P_IGNORE_API_KEY", "0") == "1":
        env.pop("ANTHROPIC_API_KEY", None)
        env.pop("ANTHROPIC_AUTH_TOKEN", None)
    last = ""
    for attempt in (1, 2):
        try:
            r = subprocess.run(
                [claude, "-p", prompt, "--allowedTools", "WebSearch", "WebFetch", "--output-format", "text"],
                cwd=WORK_DIR, env=env, capture_output=True, text=True, timeout=25 * 60,
            )
            brief = r.stdout.strip()
            if r.returncode == 0 and len(brief) > 200:
                for part in chunks(brief):
                    send(part)
                log(f"sent brief ({len(brief)} chars, attempt {attempt})")
                # Keep each sent brief so its quality can be reviewed and the prompt tuned.
                try:
                    with open(os.path.join(WORK_DIR, time.strftime("%Y-%m-%d") + ".txt"), "w") as f:
                        f.write(brief + "\n")
                except OSError as e:
                    log(f"could not save brief: {e!r}")
                return
            last = f"exit {r.returncode}: {(r.stderr or brief)[-300:]}"
        except Exception as e:
            last = repr(e)[-300:]
        log(f"attempt {attempt} failed: {last}")
    send("☀️ Morning brief failed today. " + last + f"\nLog: {LOG}")


if __name__ == "__main__":
    main()
