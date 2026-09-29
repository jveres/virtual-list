import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import ImageIO

func fail(_ message: String) -> Never {
    fputs(message + "\n", stderr)
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("Expected displays, place, focus, scroll, or quit") }

switch args[1] {
case "session":
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    let state: [String: Bool] = [
        "locked": session == nil || (session?["CGSSessionScreenIsLocked"] as? Bool ?? false),
        "onConsole": session?["kCGSSessionOnConsoleKey"] as? Bool ?? false,
    ]
    let data = try JSONSerialization.data(withJSONObject: state)
    print(String(data: data, encoding: .utf8)!)
case "image-metrics":
    guard args.count == 7, let x = Double(args[3]), let y = Double(args[4]),
          let width = Double(args[5]), let height = Double(args[6]),
          x >= 0, y >= 0, width > 0, height > 0, x + width <= 1.001, y + height <= 1.001,
          let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
          let cropped = image.cropping(to: CGRect(x: x * Double(image.width), y: y * Double(image.height),
              width: width * Double(image.width), height: height * Double(image.height))) else {
        fail("Expected PNG and normalized crop x/y/width/height")
    }
    let w = min(512, cropped.width)
    let h = max(1, Int(Double(cropped.height) * Double(w) / Double(cropped.width)))
    var pixels = [UInt8](repeating: 0, count: w * h * 4)
    let drawn = pixels.withUnsafeMutableBytes { bytes -> Bool in
        guard let context = CGContext(data: bytes.baseAddress, width: w, height: h, bitsPerComponent: 8,
            bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
        context.draw(cropped, in: CGRect(x: 0, y: 0, width: w, height: h))
        return true
    }
    guard drawn else { fail("Cannot decode screenshot pixels") }
    var colors: [Int: Int] = [:]
    var edges = 0
    for row in 0..<h {
        var previous: Int? = nil
        for column in 0..<w {
            let at = (row * w + column) * 4
            let r = Int(pixels[at]), g = Int(pixels[at + 1]), b = Int(pixels[at + 2])
            colors[(r >> 4) << 8 | (g >> 4) << 4 | (b >> 4), default: 0] += 1
            let light = (r + g + b) / 3
            if let before = previous, abs(light - before) > 24 { edges += 1 }
            previous = light
        }
    }
    let result: [String: Any] = ["width": w, "height": h,
        "dominantFraction": Double(colors.values.max() ?? 0) / Double(w * h),
        "edgeFraction": Double(edges) / Double(w * h)]
    let data = try JSONSerialization.data(withJSONObject: result)
    print(String(data: data, encoding: .utf8)!)
case "displays":
    let top = NSScreen.screens[0].frame.maxY
    let screens: [[String: Any]] = NSScreen.screens.enumerated().map { index, screen in
        let rect = screen.visibleFrame
        let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as! NSNumber
        return ["index": index, "name": screen.localizedName,
                "builtin": CGDisplayIsBuiltin(number.uint32Value) != 0,
                "x": rect.minX, "y": top - rect.maxY,
                "width": rect.width, "height": rect.height,
                "scale": screen.backingScaleFactor,
                "maximumFramesPerSecond": screen.maximumFramesPerSecond]
    }
    let data = try JSONSerialization.data(withJSONObject: screens)
    print(String(data: data, encoding: .utf8)!)
case "quit":
    guard args.count == 3, let pid = Int32(args[2]) else { fail("Expected PID") }
    if let app = NSRunningApplication(processIdentifier: pid), !app.terminate() {
        fail("Could not terminate the isolated Firefox instance")
    }
case "place":
    guard args.count == 7, let pid = Int32(args[2]),
          let x = Double(args[3]), let y = Double(args[4]),
          let width = Double(args[5]), let height = Double(args[6]),
          width > 0, height > 0,
          let app = NSRunningApplication(processIdentifier: pid) else {
        fail("Expected PID, x, y, width, and height")
    }
    guard AXIsProcessTrusted() else { fail("Window placement requires Accessibility permission") }
    let application = AXUIElementCreateApplication(pid)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &value) == .success,
          let windows = value as? [AXUIElement], windows.count == 1 else {
        fail("Expected exactly one owned automation window")
    }
    var point = CGPoint(x: x, y: y)
    var size = CGSize(width: width, height: height)
    guard let position = AXValueCreate(.cgPoint, &point),
          AXUIElementSetAttributeValue(windows[0], kAXPositionAttribute as CFString, position) == .success else {
        fail("Could not move the owned automation window")
    }
    // AppKit updates the window's display asynchronously. Resizing immediately
    // can clamp its height to the previous (smaller) display's usable area.
    usleep(200000)
    guard let dimensions = AXValueCreate(.cgSize, &size),
          AXUIElementSetAttributeValue(windows[0], kAXSizeAttribute as CFString, dimensions) == .success else {
        fail("Could not place the owned automation window")
    }
    app.activate(options: [])
    AXUIElementPerformAction(windows[0], kAXRaiseAction as CFString)
case "focus":
    guard args.count == 5, let pid = Int32(args[2]),
          let x = Double(args[3]), let y = Double(args[4]),
          let app = NSRunningApplication(processIdentifier: pid) else {
        fail("Expected PID, x, and y")
    }
    guard CGPreflightPostEventAccess() else {
        fail("macOS event posting is not permitted; enable Accessibility for the invoking app")
    }
    app.activate(options: [])
    for _ in 0..<100 {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { break }
        // NSWorkspace's activation state updates when the run loop runs.
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.01))
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
        fail("Could not activate the test browser for document focus")
    }
    let point = CGPoint(x: x, y: y)
    let original = CGEvent(source: nil)?.location
    let source = CGEventSource(stateID: .combinedSessionState)
    CGWarpMouseCursorPosition(point)
    for kind in [CGEventType.leftMouseDown, CGEventType.leftMouseUp] {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
              let event = CGEvent(mouseEventSource: source, mouseType: kind,
                                  mouseCursorPosition: point, mouseButton: .left) else {
            fail("Test browser lost foreground during document focus")
        }
        event.post(tap: .cghidEventTap)
        usleep(50000)
    }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
       let original = original { CGWarpMouseCursorPosition(original) }
case "scroll":
    guard args.count == 8, let pid = Int32(args[2]),
          let x = Double(args[3]), let y = Double(args[4]),
          let delta = Int32(args[5]), let count = Int(args[6]),
          let delay = UInt32(args[7]), count > 0 else {
        fail("Expected PID, x, y, delta, count, and interval in microseconds")
    }
    guard CGPreflightPostEventAccess() else {
        fail("macOS event posting is not permitted; enable Accessibility for the invoking app")
    }
    func checkForeground() {
        let front = NSWorkspace.shared.frontmostApplication
        guard front?.processIdentifier == pid else {
            fail("Test Firefox lost foreground; stopped native input (frontmost: \(front?.localizedName ?? "unknown"), PID \(front?.processIdentifier ?? -1))")
        }
    }
    checkForeground()
    let point = CGPoint(x: x, y: y)
    let original = CGEvent(source: nil)?.location
    CGWarpMouseCursorPosition(point)
    defer {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
           let original = original {
            CGWarpMouseCursorPosition(original)
        }
    }
    let source = CGEventSource(stateID: .combinedSessionState)
    func send(_ amount: Int32, phase: Int64) {
        checkForeground()
        guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel,
                                  wheelCount: 1, wheel1: amount, wheel2: 0, wheel3: 0) else {
            fail("Could not create a native scroll event")
        }
        event.location = point
        event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        event.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
        event.setIntegerValueField(.scrollWheelEventMomentumPhase, value: 0)
        event.post(tap: .cghidEventTap)
    }
    for index in 0..<count {
        send(delta, phase: index == 0 ? 1 : 2)
        usleep(delay)
    }
    send(0, phase: 4)
default:
    fail("Unknown native profiling action")
}
