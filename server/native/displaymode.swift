// Display mode helper (macOS). Lists / reads / sets the main display's mode via CoreGraphics. Prints JSON on stdout.
//   displaymode info                     current main display: id, name-ish info, current mode
//   displaymode list                     all modes incl. duplicate low-res ones
//   displaymode set <w> <h>              switch to the non-HiDPI mode with that pixel size (permanent=false: until logout/restart of the session)
//   displaymode restore W H HIDPI       switch back to the mode with that pixel size (HIDPI 1|0). Mode ids are NOT stable: the virtual
//                                        display is re-created on a switch (new display id, new mode numbers), so match by size.
import CoreGraphics
import Foundation

func modes(_ d: CGDirectDisplayID) -> [CGDisplayMode] {
  let opts = [kCGDisplayShowDuplicateLowResolutionModes as String: true] as CFDictionary
  return (CGDisplayCopyAllDisplayModes(d, opts) as? [CGDisplayMode]) ?? []
}
func desc(_ m: CGDisplayMode) -> [String: Any] {
  ["id": Int(m.ioDisplayModeID), "width": m.width, "height": m.height, "pixelWidth": m.pixelWidth, "pixelHeight": m.pixelHeight,
   "hidpi": m.pixelWidth > m.width, "hz": m.refreshRate, "usable": m.isUsableForDesktopGUI()]
}
func out(_ o: Any) { let d = try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]); print(String(data: d, encoding: .utf8)!) }
func fail(_ s: String) -> Never { out(["ok": false, "error": s]); exit(1) }

func apply(_ d: CGDirectDisplayID, _ m: CGDisplayMode) {
  var cfg: CGDisplayConfigRef?
  guard CGBeginDisplayConfiguration(&cfg) == .success, let c = cfg else { fail("begin configuration failed") }
  guard CGConfigureDisplayWithDisplayMode(c, d, m, nil) == .success else { CGCancelDisplayConfiguration(c); fail("configure failed") }
  guard CGCompleteDisplayConfiguration(c, .forSession) == .success else { fail("complete failed") }
}

let a = CommandLine.arguments
guard a.count >= 2 else { fail("usage: info|list|set W H|restore ID") }
let d = CGMainDisplayID()
guard let cur = CGDisplayCopyDisplayMode(d) else { fail("no current mode") }
switch a[1] {
case "info":
  // Virtual = not built in AND (a known virtual vendor/model OR no physical identity at all: no serial and 0 mm size, which
  // a real monitor always reports). The display NAME is deliberately not used: it changes ("Screen Sharing Virtual Display" -> "Display").
  let vendor = CGDisplayVendorNumber(d), model = CGDisplayModelNumber(d), serial = CGDisplaySerialNumber(d), mm = CGDisplayScreenSize(d)
  let known = (vendor == 0x6161706C && model == 0x1234) || (vendor == 0x756E6B6E && model == 0x76697274)
  let noBody = serial == 0 && mm.width == 0 && mm.height == 0
  let builtin = CGDisplayIsBuiltin(d) != 0
  out(["ok": true, "display": Int(d), "builtin": builtin, "virtual": !builtin && (known || noBody), "knownVirtualId": known, "noPhysicalIdentity": noBody,
       "vendor": Int(vendor), "model": Int(model), "serial": Int(serial), "mmWidth": Int(mm.width), "mmHeight": Int(mm.height), "current": desc(cur)])
case "list":
  out(["ok": true, "display": Int(d), "current": desc(cur), "modes": modes(d).map(desc)])
case "set":
  guard a.count == 4, let w = Int(a[2]), let h = Int(a[3]) else { fail("usage: set W H") }
  let c = modes(d).filter { $0.pixelWidth == w && $0.pixelHeight == h && $0.width == w && $0.isUsableForDesktopGUI() }
  guard let m = c.sorted(by: { $0.refreshRate > $1.refreshRate }).first else { fail("no non-HiDPI \(w)x\(h) mode") }
  if m.ioDisplayModeID != cur.ioDisplayModeID { apply(d, m) }
  out(["ok": true, "from": desc(cur), "to": desc(CGDisplayCopyDisplayMode(d) ?? m)])
case "restore":
  guard a.count == 5, let w = Int(a[2]), let h = Int(a[3]), let hi = Int(a[4]) else { fail("usage: restore W H HIDPI") }
  let c = modes(d).filter { $0.pixelWidth == w && $0.pixelHeight == h && ($0.pixelWidth > $0.width) == (hi == 1) && $0.isUsableForDesktopGUI() }
  guard let m = c.sorted(by: { $0.refreshRate > $1.refreshRate }).first else { fail("mode \(w)x\(h) hidpi=\(hi) not found") }
  if m.ioDisplayModeID != cur.ioDisplayModeID { apply(d, m) }
  out(["ok": true, "to": desc(CGDisplayCopyDisplayMode(d) ?? m)])
default: fail("unknown command")
}
