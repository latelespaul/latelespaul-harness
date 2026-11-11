"""Fake Eyes & Hands port for cli.test.mjs and mcp.test.mjs: a real CFMessagePort with the port.lua rules that the CLI
depends on (arm, first arm wins, HMAC-SHA256 over seq|cmd|args, seq strictly rising, disarm) and
canned eyes and hands replies. Never touches Hammerspoon.
  python3 fake-eh-port.py <port name> <config.json> <log.jsonl>   prints "ready" once listening
Every envelope it receives goes to the log as one JSON line, plus {"event": ...} lines for jobs.
config.json: {"owners": {name: {"enabled": true}}, "status": {...}, "targets": {...},
  "lines": [...], "frames": [...], "job_polls": 2, "refuse": {cmd: result},
  "ax_flag": path (accessibility reads true once this file exists),
  "url": url in every eyes reply, "text_seq": [{lines, frames, url}] one per eh.eyes.text (the last repeats),
  "restart_flag": path (when it exists, every arm is dropped as by a Hammerspoon restart, once),
  "forget_arms": true (every signed call finds no arm), "job_end": final job state (default done),
  "hands_status_seq": [interrupts] one per eh.hands.status (the last repeats),
  "shot": {"dir": private folder, "w": px, "h": px, "honor_max_px": bool} (writes a grey PNG)}"""
import copy, ctypes, hashlib, hmac, json, os, struct, sys, time, zlib

CF = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
vp = ctypes.c_void_p
CALLBACK = ctypes.CFUNCTYPE(vp, vp, ctypes.c_int32, vp, vp)


class Context(ctypes.Structure):
    _fields_ = [("version", ctypes.c_long), ("info", vp), ("retain", vp), ("release", vp), ("copyDescription", vp)]


CF.CFStringCreateWithCString.restype, CF.CFStringCreateWithCString.argtypes = vp, [vp, ctypes.c_char_p, ctypes.c_uint32]
CF.CFMessagePortCreateLocal.restype = vp
CF.CFMessagePortCreateLocal.argtypes = [vp, vp, CALLBACK, ctypes.POINTER(Context), ctypes.POINTER(ctypes.c_bool)]
CF.CFMessagePortCreateRunLoopSource.restype, CF.CFMessagePortCreateRunLoopSource.argtypes = vp, [vp, vp, ctypes.c_long]
CF.CFRunLoopGetCurrent.restype = vp
CF.CFRunLoopAddSource.argtypes = [vp, vp, vp]
CF.CFDataCreate.restype, CF.CFDataCreate.argtypes = vp, [vp, ctypes.c_char_p, ctypes.c_long]
CF.CFDataGetLength.restype, CF.CFDataGetLength.argtypes = ctypes.c_long, [vp]
CF.CFDataGetBytePtr.restype, CF.CFDataGetBytePtr.argtypes = vp, [vp]

with open(sys.argv[2]) as f:
    CONF = json.load(f)
LOG = open(sys.argv[3], "a", buffering=1)
armed = {}   # owner -> {secret, seq, pid}
jobs = {}    # id -> {owner, polls, state}
next_job = [0]
calls = {}   # cmd -> how many times it ran (for the *_seq configs)
JOB_CMDS = {"eh.hands." + c for c in ("focus", "move", "click", "type", "key", "scroll", "drag", "play")}


def log(obj):
    LOG.write(json.dumps(obj) + "\n")


def ok(v):
    return {"ok": True, "result": v}


def err(e):
    return {"ok": False, "error": e}


def disarm(owner, why):
    if armed.pop(owner, None) is not None:
        for jid, j in jobs.items():
            if j["owner"] == owner and j["state"] == "running":
                j["state"] = "aborted"
                log({"event": "job-aborted", "job": jid, "why": why})


def status():
    st = copy.deepcopy(CONF.get("status", {"name": "EyesHands", "version": "0.1.0", "running": True}))
    owners = st.setdefault("access", {"policy": "ok", "owners": {}}).setdefault("owners", {})
    for name in CONF.get("owners", {}):
        owners.setdefault(name, {"enabled": True})["armed"] = owners.get(name, {}).get("armed") or name in armed
    if CONF.get("ax_flag"):
        st.setdefault("grants", {})["accessibility"] = os.path.exists(CONF["ax_flag"])
    return st


def seq_item(key, cmd):
    items = CONF.get(key) or [None]
    n = calls[cmd] = calls.get(cmd, 0) + 1
    return items[min(n, len(items)) - 1]


def png(w, h):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + b"\x80" * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def shot(a):
    c = CONF["shot"]
    w, h = c.get("w", 2400), c.get("h", 1200)
    m = a.get("max_px")
    if c.get("honor_max_px") and m and max(w, h) > m:
        k = m / max(w, h)
        w, h = round(w * k), round(h * k)
    path = os.path.join(c["dir"], "shot-%d-%04x.png" % (int(time.time() * 1000), next_job[0] & 0xFFFF))
    data = png(w, h)
    with open(path, "wb") as f:
        f.write(data)
    return {"ok": True, "target": a.get("target"), "path": path, "bounds": [0, 25, w, h], "size": [w, h], "bytes": len(data)}


def handle(env):
    cmd, args = env.get("cmd"), env.get("args") or ""
    a = json.loads(args) if args else {}
    flag = CONF.get("restart_flag")
    if flag and os.path.exists(flag):
        os.unlink(flag)
        armed.clear()
        log({"event": "restart"})
    if CONF.get("forget_arms") and env.get("mac"):
        armed.clear()
    if cmd == "status":
        return ok(status())
    if cmd == "eh.targets":
        return ok(CONF.get("targets", {"file": "/tmp/targets.json", "state": "ok", "targets": []}))
    if cmd == "stop":
        names = sorted(armed)
        for n in names:
            disarm(n, "stop switch")
        return ok({"stopped": True, "disarmed": names})
    if cmd == "arm":
        owner = a.get("owner")
        if owner not in CONF.get("owners", {}):
            return err("owner not in the access policy")
        if owner in armed or status()["access"]["owners"].get(owner, {}).get("armed"):
            log({"event": "alert", "text": f"{owner}: arm refused (already armed)"})
            return err("already armed")
        armed[owner] = {"secret": a["secret"], "seq": 0, "pid": a.get("pid")}
        return ok({"owner": owner, "until": "2026-11-11T01:10:00Z"})
    owner = env.get("owner")
    s = armed.get(owner)
    if not s:
        return err("not armed")
    seq = env.get("seq")
    want = hmac.new(s["secret"].encode(), f"{seq}|{cmd}|{args}".encode(), hashlib.sha256).hexdigest()
    if not isinstance(seq, int) or not isinstance(env.get("mac"), str):
        disarm(owner, "unsigned call")
        return err("unsigned call")
    if not hmac.compare_digest(want, env["mac"].lower()):
        disarm(owner, "bad mac")
        return err("bad mac")
    if seq <= s["seq"]:
        disarm(owner, "replay")
        return err("replay")
    s["seq"] = seq
    if cmd == "disarm":
        disarm(owner, "released")
        return ok(True)
    if cmd in CONF.get("refuse", {}):
        return ok(CONF["refuse"][cmd])
    if cmd == "eh.eyes.text":
        page = seq_item("text_seq", cmd) or {}
        out = {"ok": True, "target": a.get("target"), "lines": page.get("lines", CONF.get("lines", [])),
               "frames": page.get("frames", CONF.get("frames", []))}
        if page.get("url") or CONF.get("url"):
            out["url"] = page.get("url") or CONF.get("url")
        return ok(out)
    if cmd == "eh.eyes.shot":
        return ok(shot(a))
    if cmd.startswith("eh.eyes."):
        out = {"ok": True, "cmd": cmd, "args": a}
        if CONF.get("url"):
            out["url"] = CONF["url"]
        return ok(out)
    if cmd in JOB_CMDS:
        next_job[0] += 1
        jid = next_job[0]
        jobs[jid] = {"owner": owner, "polls": CONF.get("job_polls", 2), "state": "running"}
        return ok({"ok": True, "job": jid, "state": "running", "planned_ms": 100})
    if cmd == "eh.hands.job":
        j = jobs.get((a or {}).get("id"))
        if not j or j["owner"] != owner:
            return ok({"ok": False, "reason": "unknown_job"})
        if j["state"] == "running":
            j["polls"] -= 1
            if j["polls"] <= 0:
                j["state"] = CONF.get("job_end", "done")
                log({"event": "job-" + j["state"], "job": (a or {}).get("id")})
        out = {"ok": j["state"] in ("done", "running"), "job": a["id"], "state": j["state"], "posted": 3, "total": 3}
        if not out["ok"]:
            out["reason"] = j["state"]
        return ok(out)
    if cmd == "eh.hands.abort":
        for jid, j in jobs.items():
            if j["owner"] == owner and j["state"] == "running":
                j["state"] = "aborted"
                log({"event": "job-aborted", "job": jid, "why": "abort"})
                return ok({"ok": False, "job": jid, "state": "aborted"})
        return ok({"ok": True, "aborted": False})
    if cmd == "eh.hands.status" and CONF.get("hands_status_seq"):
        return ok({"ok": True, "lease": owner, "mine": True, "busy": False, "interrupts": seq_item("hands_status_seq", cmd)})
    if cmd.startswith("eh.hands."):
        return ok({"ok": True, "cmd": cmd, "lease": False, "interrupts": 0})
    return err("unknown command")


@CALLBACK
def on_message(_port, _msgid, data, _info):
    msg = ctypes.string_at(CF.CFDataGetBytePtr(data), CF.CFDataGetLength(data)).decode()
    try:
        env = json.loads(msg)
        log(env)
        rep = handle(env)
    except Exception as e:   # a test fake: report, never die
        rep = err(f"fake failed: {e}")
    out = json.dumps(rep).encode()
    return CF.CFDataCreate(None, out, len(out))


name = CF.CFStringCreateWithCString(None, sys.argv[1].encode(), 0x08000100)
port = CF.CFMessagePortCreateLocal(None, name, on_message, ctypes.byref(Context()), ctypes.byref(ctypes.c_bool()))
if not port:
    sys.exit("could not register the port")
CF.CFRunLoopAddSource(CF.CFRunLoopGetCurrent(), CF.CFMessagePortCreateRunLoopSource(None, port, 0),
                      vp.in_dll(CF, "kCFRunLoopDefaultMode"))
print("ready", flush=True)
CF.CFRunLoopRun()
