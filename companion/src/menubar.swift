import Cocoa

/// Menu bar status item for the Quack companion.
///
/// Stdin is newline-delimited JSON: `{"title":"Connected"}` or
/// `{"title":"acme/widgets#41","subtitle":"Fetching PR","count":"2 requests"}`.
/// The process exits on stdin EOF or when its parent exits, so the icon cannot
/// outlive the companion. The log path, when present, is argv[1] and is opened
/// with NSWorkspace — never a shell.
final class MenuBarController: NSObject, NSApplicationDelegate {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let countItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let statusLine = NSMenuItem(title: "Connected", action: nil, keyEquivalent: "")
  private let subtitleItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let logPath: String?
  private var buffer = Data()
  private var stdinSource: DispatchSourceRead?
  private var parentSource: DispatchSourceProcess?
  private var finishing = false

  override init() {
    let arg = CommandLine.arguments.dropFirst().first
    logPath = (arg?.isEmpty == false) ? arg : nil
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let menu = NSMenu()
    menu.autoenablesItems = false

    let titleItem = NSMenuItem(title: "Quack", action: nil, keyEquivalent: "")
    titleItem.isEnabled = false
    countItem.isEnabled = false
    countItem.isHidden = true
    statusLine.isEnabled = false
    subtitleItem.isEnabled = false
    subtitleItem.isHidden = true

    let openItem = NSMenuItem(title: "Open Log", action: #selector(openLog(_:)), keyEquivalent: "")
    openItem.target = self

    menu.addItem(titleItem)
    menu.addItem(countItem)
    menu.addItem(statusLine)
    menu.addItem(subtitleItem)
    menu.addItem(.separator())
    menu.addItem(openItem)
    statusItem.menu = menu

    if let button = statusItem.button {
      let image = MenuBarController.duckImage()
      image.isTemplate = true
      button.image = image
      button.imagePosition = .imageOnly
      button.toolTip = "Connected"
      button.setAccessibilityLabel("Quack")
    }

    watchParent()
    watchStdin()
  }

  @objc func openLog(_ sender: Any?) {
    guard let logPath else { return }
    NSWorkspace.shared.open(URL(fileURLWithPath: logPath))
  }

  private func watchParent() {
    let parent = getppid()
    guard parent > 1 else { return }
    let source = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .main)
    source.setEventHandler { [weak self] in
      self?.finish()
    }
    source.resume()
    parentSource = source
  }

  private func watchStdin() {
    let fd = FileHandle.standardInput.fileDescriptor
    let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
    source.setEventHandler { [weak self] in
      guard let self else { return }
      let expected = Int(source.data)
      if expected == 0 {
        self.finish()
        return
      }
      var chunk = [UInt8](repeating: 0, count: expected)
      let got = Darwin.read(fd, &chunk, expected)
      if got <= 0 {
        self.finish()
        return
      }
      self.buffer.append(contentsOf: chunk.prefix(got))
      self.drainLines()
    }
    source.resume()
    stdinSource = source
  }

  private func drainLines() {
    while let newline = buffer.firstIndex(of: 0x0A) {
      let line = buffer.subdata(in: 0..<newline)
      buffer.removeSubrange(0...newline)
      guard let text = String(data: line, encoding: .utf8) else { continue }
      apply(text)
    }
  }

  private struct Update: Decodable {
    var title: String
    var subtitle: String?
    var count: String?
  }

  private func apply(_ line: String) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.count <= 4096, let data = trimmed.data(using: .utf8) else { return }
    guard let update = try? JSONDecoder().decode(Update.self, from: data) else { return }
    guard !update.title.isEmpty, update.title.count <= 200 else { return }

    statusLine.title = update.title
    if let count = update.count, !count.isEmpty, count.count <= 40 {
      countItem.title = count
      countItem.isHidden = false
    } else {
      countItem.isHidden = true
    }
    if let subtitle = update.subtitle, !subtitle.isEmpty, subtitle.count <= 80 {
      subtitleItem.title = subtitle
      subtitleItem.isHidden = false
    } else {
      subtitleItem.isHidden = true
    }

    var parts: [String] = []
    if !countItem.isHidden { parts.append(countItem.title) }
    parts.append(update.title)
    if !subtitleItem.isHidden { parts.append(subtitleItem.title) }
    statusItem.button?.toolTip = parts.joined(separator: " — ")
  }

  private func finish() {
    if finishing { return }
    finishing = true
    NSApp.terminate(nil)
  }

  /// The logo mark, traced from the 36×24 brand artwork: brackets around the duck.
  /// Template images follow the menu bar's light and dark appearance.
  private static func duckImage() -> NSImage {
    let size = NSSize(width: 27, height: 18)
    let image = NSImage(size: size, flipped: true) { rect in
      let scale = min(rect.width / 36, rect.height / 24)
      let transform = AffineTransform(scale: scale)
      NSColor.black.set()

      func paint(_ path: NSBezierPath, stroke: Bool) {
        path.transform(using: transform)
        if stroke {
          path.lineWidth = 2.2 * scale
          path.lineCapStyle = .round
          path.lineJoinStyle = .round
          path.stroke()
        } else {
          path.fill()
        }
      }

      let body = NSBezierPath()
      body.move(to: NSPoint(x: 10.8, y: 13.2))
      body.curve(to: NSPoint(x: 18.1, y: 20.2), controlPoint1: NSPoint(x: 10.4, y: 17.7), controlPoint2: NSPoint(x: 13.3, y: 20.2))
      body.curve(to: NSPoint(x: 26.9, y: 12.6), controlPoint1: NSPoint(x: 23.3, y: 20.2), controlPoint2: NSPoint(x: 26.5, y: 17.5))
      body.curve(to: NSPoint(x: 25.1, y: 11.4), controlPoint1: NSPoint(x: 27, y: 11.1), controlPoint2: NSPoint(x: 26.2, y: 10.5))
      body.curve(to: NSPoint(x: 19.4, y: 12.6), controlPoint1: NSPoint(x: 23.5, y: 12.8), controlPoint2: NSPoint(x: 21.5, y: 13.2))
      body.curve(to: NSPoint(x: 17.9, y: 11.6), controlPoint1: NSPoint(x: 18.7, y: 12.4), controlPoint2: NSPoint(x: 18.2, y: 12.1))
      body.line(to: NSPoint(x: 14, y: 11.8))
      body.curve(to: NSPoint(x: 10.8, y: 13.2), controlPoint1: NSPoint(x: 12.4, y: 12), controlPoint2: NSPoint(x: 11.2, y: 12.4))
      body.close()
      paint(body, stroke: false)

      paint(NSBezierPath(ovalIn: NSRect(x: 11.3, y: 3.9, width: 8.6, height: 8.6)), stroke: false)

      let beak = NSBezierPath()
      beak.move(to: NSPoint(x: 12.4, y: 7.4))
      beak.curve(to: NSPoint(x: 8.6, y: 9.1), controlPoint1: NSPoint(x: 10.9, y: 7.2), controlPoint2: NSPoint(x: 9.3, y: 7.8))
      beak.curve(to: NSPoint(x: 12.9, y: 10.6), controlPoint1: NSPoint(x: 9.4, y: 10.4), controlPoint2: NSPoint(x: 11.3, y: 10.9))
      beak.close()
      paint(beak, stroke: false)

      if let context = NSGraphicsContext.current {
        context.compositingOperation = .destinationOut
        paint(NSBezierPath(ovalIn: NSRect(x: 15.7, y: 6.2, width: 2, height: 2)), stroke: false)
        context.compositingOperation = .sourceOver
      }

      let left = NSBezierPath()
      left.move(to: NSPoint(x: 7, y: 3))
      left.curve(to: NSPoint(x: 4.4, y: 7), controlPoint1: NSPoint(x: 4.6, y: 3), controlPoint2: NSPoint(x: 4.4, y: 4.8))
      left.line(to: NSPoint(x: 4.4, y: 9.6))
      left.curve(to: NSPoint(x: 2, y: 12), controlPoint1: NSPoint(x: 4.4, y: 11), controlPoint2: NSPoint(x: 3.6, y: 12))
      left.curve(to: NSPoint(x: 4.4, y: 14.4), controlPoint1: NSPoint(x: 3.6, y: 12), controlPoint2: NSPoint(x: 4.4, y: 13))
      left.line(to: NSPoint(x: 4.4, y: 17))
      left.curve(to: NSPoint(x: 7, y: 21), controlPoint1: NSPoint(x: 4.4, y: 19.2), controlPoint2: NSPoint(x: 4.6, y: 21))
      paint(left, stroke: true)

      let right = NSBezierPath()
      right.move(to: NSPoint(x: 29, y: 3))
      right.curve(to: NSPoint(x: 31.6, y: 7), controlPoint1: NSPoint(x: 31.4, y: 3), controlPoint2: NSPoint(x: 31.6, y: 4.8))
      right.line(to: NSPoint(x: 31.6, y: 9.6))
      right.curve(to: NSPoint(x: 34, y: 12), controlPoint1: NSPoint(x: 31.6, y: 11), controlPoint2: NSPoint(x: 32.4, y: 12))
      right.curve(to: NSPoint(x: 31.6, y: 14.4), controlPoint1: NSPoint(x: 32.4, y: 12), controlPoint2: NSPoint(x: 31.6, y: 13))
      right.line(to: NSPoint(x: 31.6, y: 17))
      right.curve(to: NSPoint(x: 29, y: 21), controlPoint1: NSPoint(x: 31.6, y: 19.2), controlPoint2: NSPoint(x: 31.4, y: 21))
      paint(right, stroke: true)
      return true
    }
    image.isTemplate = true
    return image
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = MenuBarController()
app.delegate = controller
app.run()
