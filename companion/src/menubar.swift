import Cocoa

/// Menu bar status item for the Quacksteps companion.
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

    let titleItem = NSMenuItem(title: "Quacksteps", action: nil, keyEquivalent: "")
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
      let image = MenuBarController.logoImage()
      image.isTemplate = true
      button.image = image
      button.imagePosition = .imageOnly
      button.toolTip = "Connected"
      button.setAccessibilityLabel("Quacksteps")
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

  /// The logo mark, traced from the 36×24 brand artwork: braces around a duck footprint.
  /// Template images follow the menu bar's light and dark appearance.
  private static func logoImage() -> NSImage {
    let size = NSSize(width: 27, height: 18)
    let image = NSImage(size: size, flipped: true) { rect in
      let scale = min(rect.width / 36, rect.height / 24)
      let transform = AffineTransform(scale: scale)
      NSColor.black.set()

      func paint(_ path: NSBezierPath, stroke: Bool) {
        path.transform(using: transform)
        if stroke {
          path.lineWidth = 2.4 * scale
          path.lineCapStyle = .round
          path.lineJoinStyle = .round
          path.stroke()
        } else {
          path.fill()
        }
      }

      // Quadratic segment as a cubic, since NSBezierPath's quadratic API needs macOS 14.
      func quad(_ path: NSBezierPath, to end: NSPoint, control c: NSPoint) {
        let start = path.currentPoint
        path.curve(
          to: end,
          controlPoint1: NSPoint(x: start.x + 2 / 3 * (c.x - start.x), y: start.y + 2 / 3 * (c.y - start.y)),
          controlPoint2: NSPoint(x: end.x + 2 / 3 * (c.x - end.x), y: end.y + 2 / 3 * (c.y - end.y)))
      }

      // The footprint is filled solid (no webbing), tilted 12° counterclockwise about the centre.
      let foot = NSBezierPath()
      foot.move(to: NSPoint(x: 18, y: 21.4))
      quad(foot, to: NSPoint(x: 16, y: 20), control: NSPoint(x: 16.6, y: 21.4))
      foot.line(to: NSPoint(x: 10.6, y: 8.8))
      quad(foot, to: NSPoint(x: 12, y: 6.8), control: NSPoint(x: 9.9, y: 6.6))
      quad(foot, to: NSPoint(x: 16.8, y: 4.2), control: NSPoint(x: 15.3, y: 10.6))
      quad(foot, to: NSPoint(x: 19.2, y: 4.2), control: NSPoint(x: 18, y: 1.8))
      quad(foot, to: NSPoint(x: 24, y: 6.8), control: NSPoint(x: 20.7, y: 10.6))
      quad(foot, to: NSPoint(x: 25.4, y: 8.8), control: NSPoint(x: 26.1, y: 6.6))
      foot.line(to: NSPoint(x: 20, y: 20))
      quad(foot, to: NSPoint(x: 18, y: 21.4), control: NSPoint(x: 19.4, y: 21.4))
      foot.close()
      var tilt = AffineTransform(translationByX: 18, byY: 12)
      tilt.rotate(byDegrees: -12)
      tilt.translate(x: -18, y: -12)
      foot.transform(using: tilt)
      paint(foot, stroke: false)

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
