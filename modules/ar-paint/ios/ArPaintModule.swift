import ExpoModulesCore
import ARKit

public class ArPaintModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArPaint")

    Constants([
      "isSupported": ARWorldTrackingConfiguration.isSupported,
      "hasLidar": ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh),
      "hasSnapshot": true,
      "hasUndo": true
    ])

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
