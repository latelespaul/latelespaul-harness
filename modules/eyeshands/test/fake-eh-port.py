"""Fake Eyes & Hands port for cli.test.mjs: a real CFMessagePort with the port.lua rules that the CLI
depends on (arm, first arm wins, HMAC-SHA256 over seq|cmd|args, seq strictly rising, disarm) and
canned eyes and hands replies. Never touches Hammerspoon.
  python3 fake-eh-port.py <port name> <config.json> <log.jsonl>   prints "ready" once listening
Every envelope it receives goes to the log as one JSON line, plus {"event": ...} lines for jobs.
config.json: {"owners": {name: {"enabled": true}}, "status": {...}, "targets": {...},
  "lines": [...], "frames": [...], "job_polls": 2, "refuse": {cmd: result},
  "ax_flag": path (accessibility reads true once this file exists)}"""
import copy, ctypes, hashlib, hmac, json, os, sys

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


def handle(env):
    cmd, args = env.get("cmd"), env.get("args") or ""
    a = json.loads(args) if args else {}
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
        return ok({"ok": True, "target": a.get("target"), "lines": CONF.get("lines", []), "frames": CONF.get("frames", [])})
    if cmd.startswith("eh.eyes."):
        return ok({"ok": True, "cmd": cmd, "args": a})
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
                j["state"] = "done"
                log({"event": "job-done", "job": (a or {}).get("id")})
        return ok({"ok": j["state"] in ("done", "running"), "job": a["id"], "state": j["state"], "posted": 3, "total": 3})
    if cmd == "eh.hands.abort":
        for jid, j in jobs.items():
            if j["owner"] == owner and j["state"] == "running":
                j["state"] = "aborted"
                log({"event": "job-aborted", "job": jid, "why": "abort"})
                return ok({"ok": False, "job": jid, "state": "aborted"})
        return ok({"ok": True, "aborted": False})
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
