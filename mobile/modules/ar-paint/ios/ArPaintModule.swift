import ExpoModulesCore
import ARKit
import MapKit

public class ArPaintModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArPaint")

    Constants([
      "isSupported": ARWorldTrackingConfiguration.isSupported,
      "hasLidar": ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh),
      "hasSnapshot": true,
      "hasUndo": true,
      // expo-live-activity reads images by file name from this App Group container; JS writes the locator bar there
      "liveActivityGroupPath": FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.expoLiveActivity.sharedData")?.path as Any,
      "appGroupPath": FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.com.hamzakhan.tagged")?.path as Any
    ])

    /// Renders an Apple Maps snapshot for the home-screen widget (dark, no labels/POIs, centred on the user)
    /// into the App Group as `<name>.png`, and projects the given spots into it. The widget extension
    /// can't reliably snapshot itself (no time, no network), so the app does it while it's open.
    AsyncFunction("mapSnapshot") { (opts: [String: Any], promise: Promise) in
      guard let lat = opts["lat"] as? Double, let lng = opts["lng"] as? Double,
            let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.com.hamzakhan.tagged") else {
        promise.reject("E_ARGS", "lat/lng or app group missing"); return
      }
      let name = opts["name"] as? String ?? "widgetmap"
      let width = opts["width"] as? Double ?? 400, height = opts["height"] as? Double ?? 400
      let spanM = opts["spanM"] as? Double ?? 300
      let spots = opts["spots"] as? [[String: Any]] ?? []
      let o = MKMapSnapshotter.Options()
      o.region = MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: lat, longitude: lng), latitudinalMeters: spanM, longitudinalMeters: spanM * (width / height))
      o.size = CGSize(width: width, height: height)
      o.scale = 2
      o.mapType = .mutedStandard
      o.pointOfInterestFilter = .excludingAll
      o.showsBuildings = false
      o.traitCollection = UITraitCollection(userInterfaceStyle: .dark)
      MKMapSnapshotter(options: o).start { snap, err in
        guard let snap = snap else { promise.reject("E_SNAP", err?.localizedDescription ?? "snapshot failed"); return }
        let url = container.appendingPathComponent("\(name).png")
        guard let data = snap.image.pngData() else { promise.reject("E_PNG", "encode failed"); return }
        do { try data.write(to: url, options: .atomic) } catch { promise.reject("E_WRITE", error.localizedDescription); return }
        let pts: [[String: Any]] = spots.compactMap { s in
          guard let id = s["id"] as? String, let sl = s["lat"] as? Double, let sg = s["lng"] as? Double else { return nil }
          let p = snap.point(for: CLLocationCoordinate2D(latitude: sl, longitude: sg))
          return ["id": id, "x": p.x, "y": p.y, "w": s["w"] as? Double ?? 0.5]
        }
        promise.resolve(["path": url.path, "width": width, "height": height, "pts": pts])
      }
    }

    View(ArPaintView.self) {
      Events("onTracking", "onHit", "onStrokeEnd", "onSurface")

      Prop("spraying") { (view: ArPaintView, value: Bool) in view.spraying = value }
      Prop("paintColor") { (view: ArPaintView, value: String) in view.paintColor = UIColor(hex: value) }
      Prop("radius") { (view: ArPaintView, value: Double) in view.radius = CGFloat(value) }
      Prop("flow") { (view: ArPaintView, value: Double) in view.flow = CGFloat(value) }
      Prop("showPlanes") { (view: ArPaintView, value: Bool) in view.showPlanes = value }
      Prop("worldMapPath") { (view: ArPaintView, value: String?) in view.setWorldMapPath(value) }

      AsyncFunction("saveWorldMap") { (view: ArPaintView, path: String, promise: Promise) in
        view.saveWorldMap(to: path) { result in
          switch result {
          case .success(let info): promise.resolve(info)
          case .failure(let err): promise.reject("E_WORLDMAP", err.localizedDescription)
          }
        }
      }
      AsyncFunction("addStrokes") { (view: ArPaintView, strokes: [[String: Any]], mode: String?) in
        view.addRemoteStrokes(strokes, mode: mode ?? "absolute")
      }
      AsyncFunction("snapshot") { (view: ArPaintView, path: String, promise: Promise) in
        DispatchQueue.main.async {
          do { promise.resolve(try view.snapshot(to: path)) }
          catch { promise.reject("E_SNAPSHOT", error.localizedDescription) }
        }
      }
      AsyncFunction("undoLast") { (view: ArPaintView, promise: Promise) in
        DispatchQueue.main.async { promise.resolve(view.undoLast()) }
      }
      AsyncFunction("clearAll") { (view: ArPaintView) in view.clearAll() }
      AsyncFunction("resetSession") { (view: ArPaintView) in view.restartSession(worldMap: nil) }
    }
  }
}

extension UIColor {
  convenience init(hex: String) {
    var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix("#") { s.removeFirst() }
    var n: UInt64 = 0
    Scanner(string: s).scanHexInt64(&n)
    let r, g, b: CGFloat
    if s.count == 6 {
      r = CGFloat((n >> 16) & 0xff) / 255; g = CGFloat((n >> 8) & 0xff) / 255; b = CGFloat(n & 0xff) / 255
    } else { r = 1; g = 0; b = 1 }
    self.init(red: r, green: g, blue: b, alpha: 1)
  }
}
