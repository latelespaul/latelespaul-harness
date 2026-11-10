"""Fake Hammerspoon for port.test.mjs: registers a real CFMessagePort and hands each message to
test/driver.lua (the real port.lua with fake hs pieces), so hsx is tested end to end without
touching Hammerspoon.  python3 fake-port.py <port name> <lua binary>; prints "ready" once listening."""
import ctypes, os, subprocess, sys

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

lua = subprocess.Popen([sys.argv[2], os.path.join(os.path.dirname(os.path.abspath(__file__)), "driver.lua")],
                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
assert lua.stdin and lua.stdout


@CALLBACK
def on_message(_port, _msgid, data, _info):
    msg = ctypes.string_at(CF.CFDataGetBytePtr(data), CF.CFDataGetLength(data)).decode()
    lua.stdin.write(msg.replace("\n", " ") + "\n")
    lua.stdin.flush()
    out = lua.stdout.readline().rstrip("\n").encode()
    return CF.CFDataCreate(None, out, len(out))


name = CF.CFStringCreateWithCString(None, sys.argv[1].encode(), 0x08000100)
port = CF.CFMessagePortCreateLocal(None, name, on_message, ctypes.byref(Context()), ctypes.byref(ctypes.c_bool()))
if not port:
    sys.exit("could not register the port")
CF.CFRunLoopAddSource(CF.CFRunLoopGetCurrent(), CF.CFMessagePortCreateRunLoopSource(None, port, 0),
                      vp.in_dll(CF, "kCFRunLoopDefaultMode"))
print("ready", flush=True)
CF.CFRunLoopRun()
