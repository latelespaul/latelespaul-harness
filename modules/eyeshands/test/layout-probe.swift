// swift modules/eyeshands/test/layout-probe.swift   (reads layout data only; posts nothing)
// Lists the installed keyboard layouts whose Shift layer on the US symbol keys gives exactly the US
// shifted symbols (Shift+2 = @, Shift+- = _, ...), as the Lua lines for planner.lua's
// P.US_SHIFT_LAYOUTS. It asks macOS itself (UCKeyTranslate on each layout's data), so the list is
// proof, not a guess. A shifted dead key does not count. The unshifted characters may differ (ABC -
// India has the rupee sign on the ` key): the planner takes those from hs.keycodes.map.
// Keyboard types: a layout can map one key code differently on ANSI, ISO and JIS hardware. The probe
// checks every keyboard type ID (0-255) that KBGetLayoutType classes as ANSI, ISO or JIS, whatever
// keyboard this Mac has. A layout is listed when it matches on every ANSI and ISO type, the bar the
// U.S. layout itself meets. JIS is checked and its mismatches go to stderr, but it does not decide:
// on a JIS keyboard even U.S. and ABC have the JIS Shift layer (Shift+2 = "), so the US shifted
// symbols the planner uses are wrong there for U.S., ABC and every listed layout alike. The planner
// is not told the keyboard type; that limit is known and not handled.
import Carbon
import Foundation

// US key code -> its shifted symbol (the same pairs as planner.lua's P.US_SHIFTED and P.US_MAP).
let usShift: [Int: String] = [18: "!", 19: "@", 20: "#", 21: "$", 23: "%", 22: "^", 26: "&", 28: "*", 25: "(",
  29: ")", 27: "_", 24: "+", 33: "{", 30: "}", 42: "|", 41: ":", 39: "\"", 43: "<", 47: ">", 44: "?", 50: "~"]

let classes: [(name: String, type: PhysicalKeyboardLayoutType)] =
  [("ANSI", PhysicalKeyboardLayoutType(kKeyboardANSI)), ("ISO", PhysicalKeyboardLayoutType(kKeyboardISO)),
   ("JIS", PhysicalKeyboardLayoutType(kKeyboardJIS))]
var kbdTypes: [(cls: String, id: UInt32)] = []
for t in 0..<256 {
  let kind = KBGetLayoutType(Int16(t))
  if let c = classes.first(where: { $0.type == kind }) { kbdTypes.append((c.name, UInt32(t))) }
}
for c in classes where !kbdTypes.contains(where: { $0.cls == c.name }) {
  FileHandle.standardError.write("cannot probe \(c.name): no keyboard type ID of that class\n".data(using: .utf8)!)
  exit(1)
}

func shifted(_ layout: UnsafePointer<UCKeyboardLayout>, _ code: Int, _ kbdType: UInt32) -> String? {
  var dead: UInt32 = 0
  var len = 0
  var chars = [UniChar](repeating: 0, count: 8)
  let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), UInt32((shiftKey >> 8) & 0xFF),
    kbdType, OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, 8, &len, &chars)
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
var partial: [String] = []
var jis: [String] = []
for s in sources {
  guard let id = prop(s, kTISPropertyInputSourceID) as? String,
    let data = prop(s, kTISPropertyUnicodeKeyLayoutData) as! CFData? else { continue }
  let name = prop(s, kTISPropertyLocalizedName) as? String ?? "?"
  let failed = CFDataGetBytePtr(data)!.withMemoryRebound(to: UCKeyboardLayout.self, capacity: 1) { layout in
    Set(kbdTypes.filter { t in !usShift.allSatisfy { shifted(layout, $0.key, t.id) == $0.value } }.map { $0.cls })
  }
  if !failed.contains("ANSI") && !failed.contains("ISO") {
    lines.append("  [\"\(id)\"] = true, -- \(name)")
    if failed.contains("JIS") { jis.append("\(id) (\(name))") }
  } else if failed.count < classes.count {
    partial.append("\(id) (\(name)): not on \(failed.sorted().joined(separator: ", "))")
  }
}
for l in lines.sorted() { print(l) }
let counts = classes.map { c in "\(c.name) \(kbdTypes.filter { $0.cls == c.name }.count)" }.joined(separator: ", ")
FileHandle.standardError.write("keyboard type IDs checked: \(counts)\n".data(using: .utf8)!)
for j in jis.sorted() { FileHandle.standardError.write("listed, but not on JIS: \(j)\n".data(using: .utf8)!) }
for p in partial.sorted() { FileHandle.standardError.write("not listed, matches on some types only: \(p)\n".data(using: .utf8)!) }
