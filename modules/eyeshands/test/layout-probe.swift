// swift modules/eyeshands/test/layout-probe.swift   (reads layout data only; posts nothing)
// Lists the installed keyboard layouts whose Shift layer on the US symbol keys gives exactly the US
// shifted symbols (Shift+2 = @, Shift+- = _, ...), as the Lua lines for planner.lua's
// P.US_SHIFT_LAYOUTS. It asks macOS itself (UCKeyTranslate on each layout's data), so the list is
// proof, not a guess. A shifted dead key does not count. The unshifted characters may differ (ABC -
// India has the rupee sign on the ` key): the planner takes those from hs.keycodes.map.
import Carbon
import Foundation

// US key code -> its shifted symbol (the same pairs as planner.lua's P.US_SHIFTED and P.US_MAP).
let usShift: [Int: String] = [18: "!", 19: "@", 20: "#", 21: "$", 23: "%", 22: "^", 26: "&", 28: "*", 25: "(",
  29: ")", 27: "_", 24: "+", 33: "{", 30: "}", 42: "|", 41: ":", 39: "\"", 43: "<", 47: ">", 44: "?", 50: "~"]

func shifted(_ layout: UnsafePointer<UCKeyboardLayout>, _ code: Int) -> String? {
  var dead: UInt32 = 0
  var len = 0
  var chars = [UniChar](repeating: 0, count: 8)
  let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), UInt32((shiftKey >> 8) & 0xFF),
    UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, 8, &len, &chars)
  if status != noErr || dead != 0 { return nil }
  return String(utf16CodeUnits: chars, count: len)
}

func prop(_ s: TISInputSource, _ k: CFString) -> AnyObject? {
  guard let p = TISGetInputSourceProperty(s, k) else { return nil }
  return Unmanaged<AnyObject>.fromOpaque(p).takeUnretainedValue()
}

let filter = [kTISPropertyInputSourceType as String: kTISTypeKeyboardLayout as String] as CFDictionary
let sources = TISCreateInputSourceList(filter, true).takeRetainedValue() as! [TISInputSource]
var lines: [String] = []
for s in sources {
  guard let id = prop(s, kTISPropertyInputSourceID) as? String,
    let data = prop(s, kTISPropertyUnicodeKeyLayoutData) as! CFData? else { continue }
  let name = prop(s, kTISPropertyLocalizedName) as? String ?? "?"
  let same = CFDataGetBytePtr(data)!.withMemoryRebound(to: UCKeyboardLayout.self, capacity: 1) { layout in
    usShift.allSatisfy { shifted(layout, $0.key) == $0.value }
  }
  if same { lines.append("  [\"\(id)\"] = true, -- \(name)") }
}
for l in lines.sorted() { print(l) }
