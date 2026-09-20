import ExpoModulesCore
import ARKit
import SceneKit

/// A surface painted with spray. One PaintNode = a 5 m × 5 m transparent quad glued to a custom
/// ARAnchor ("paint-<uuid>"), lying on a detected plane. Dabs are composited into its CGContext
/// texture, so cost is independent of how much paint is on it. Coordinates (u, v) are metres in
/// the anchor's plane (u = anchor +X, v = anchor −Z), which is what gets persisted and shared.
final class PaintNode {
  static let sizeM: CGFloat = 5.0
  /// 1024 over 5 m is ~5 mm per pixel, which is finer than the spray can resolve — and a quarter of
  /// the memory of 2048, which matters because every quad on a wall holds one of these plus the
  /// texture uploaded from it.
  static let px = 1024
  static var pxPerM: CGFloat { CGFloat(px) / sizeM }

  let id: String
  var transform: simd_float4x4
  let ctx: CGContext
  let node: SCNNode
  let material = SCNMaterial()
  var dirty = false
  var lastUpload: CFTimeInterval = 0
  var attached = false
  /// The ARPlaneAnchor this quad is snapped to (nil while it only rests on an estimated surface).
  var planeId: UUID?
  /// Identifier of the session ARAnchor currently carrying this quad (changes when we re-anchor).
  var anchorId: UUID?
  var lastSnap: CFTimeInterval = 0
  /// Placed by the geo/heading fallback (no world map): allow a wider snap radius onto real planes.
  var loose = false
  var center: simd_float3 { simd_float3(transform.columns.3.x, transform.columns.3.y, transform.columns.3.z) }

  init(id: String, transform: simd_float4x4) {
    self.id = id
    self.transform = transform
    let cs = CGColorSpaceCreateDeviceRGB()
    ctx = CGContext(data: nil, width: PaintNode.px, height: PaintNode.px, bitsPerComponent: 8, bytesPerRow: PaintNode.px * 4,
                    space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.clear(CGRect(x: 0, y: 0, width: PaintNode.px, height: PaintNode.px))
    let plane = SCNPlane(width: PaintNode.sizeM, height: PaintNode.sizeM)
    material.lightingModel = .constant
    material.isDoubleSided = true
    material.blendMode = .alpha
    material.writesToDepthBuffer = false
    material.transparencyMode = .aOne
    material.diffuse.contents = UIColor.clear
    plane.materials = [material]
    node = SCNNode(geometry: plane)
    node.eulerAngles.x = -.pi / 2 // lie in the anchor's XZ plane, facing +Y
    node.position.y = 0.004 // sit just above the surface, avoids z-fighting with plane visuals
    node.renderingOrder = 10
  }

  /// World point → (u, v, distanceFromPlane) in this node's anchor space.
  func local(_ world: simd_float3) -> (u: CGFloat, v: CGFloat, d: CGFloat) {
    let inv = simd_inverse(transform)
    let p = inv * simd_float4(world, 1)
    return (CGFloat(p.x), CGFloat(-p.z), CGFloat(abs(p.y)))
  }
  var normal: simd_float3 { simd_normalize(simd_float3(transform.columns.1.x, transform.columns.1.y, transform.columns.1.z)) }

  func contains(u: CGFloat, v: CGFloat) -> Bool {
    let h = PaintNode.sizeM / 2
    return abs(u) <= h && abs(v) <= h
  }

  func pixel(u: CGFloat, v: CGFloat) -> CGPoint {
    let h = PaintNode.sizeM / 2
    // CGContext origin is bottom-left; SceneKit texture v=0 is top. Flip so +v (anchor −Z, "up"
    // the wall for vertical planes) maps to the top of the image.
    return CGPoint(x: (u + h) * PaintNode.pxPerM, y: (v + h) * PaintNode.pxPerM)
  }

  /// Cheap spray that reads as paint rather than mist: a faint darker rim (edge darkening), a few
  /// soft blobs for buildup, then a hard, nearly opaque core. Overspray is kept light so a second
  /// pass covers the surface instead of hazing it.
  func dab(u: CGFloat, v: CGFloat, radiusM: CGFloat, alpha: CGFloat, color: UIColor, rng: inout SplitMix) {
    let c = pixel(u: u, v: v)
    let r = max(2, radiusM * PaintNode.pxPerM)
    var cr: CGFloat = 0, cg: CGFloat = 0, cb: CGFloat = 0, ca: CGFloat = 0
    color.getRed(&cr, green: &cg, blue: &cb, alpha: &ca)
    let dark = UIColor(red: cr * 0.72, green: cg * 0.72, blue: cb * 0.72, alpha: 1)

    softCircle(at: c, r: r * 0.98, color: dark, alpha: alpha * 0.10, hard: 0.35)
    for _ in 0..<4 {
      let a = rng.next() * 2 * .pi
      let d = rng.gauss() * r * 0.36
      softCircle(at: CGPoint(x: c.x + cos(a) * d, y: c.y + sin(a) * d), r: r * 0.55, color: color, alpha: alpha * (0.34 + 0.16 * rng.next()), hard: 0.4)
    }
    softCircle(at: c, r: r * 0.46, color: color, alpha: alpha * 0.9, hard: 0.8)
    for _ in 0..<2 {
      let a = rng.next() * 2 * .pi
      let d = r * (0.8 + rng.next() * 0.9)
      let sr = r * (0.06 + rng.next() * 0.05)
      ctx.setFillColor(color.withAlphaComponent(alpha * 0.45).cgColor)
      ctx.fillEllipse(in: CGRect(x: c.x + cos(a) * d - sr, y: c.y + sin(a) * d - sr, width: sr * 2, height: sr * 2))
    }
    dirty = true
  }

  /// Every stroke composited into this texture, kept so undo can rebuild the texture without one.
  struct Painted { let id: String; let colorHex: String; let points: [[Double]] }
  private(set) var history: [Painted] = []

  /// Records a stroke that is already on the texture (the one you just sprayed, dab by dab).
  func record(_ p: Painted) { history.append(p) }
  /// Records and paints a stroke that isn't on the texture yet (another phone's, or a past session's).
  func add(_ p: Painted) { history.append(p); replay(p) }

  /// Seeded per stroke id, so the speckle lands identically on every phone and on every repaint.
  private func replay(_ p: Painted) {
    var rng = SplitMix(seed: p.id)
    let color = UIColor(hex: p.colorHex)
    for pt in p.points where pt.count >= 4 {
      // kind 1 is a drip from an older build. Paint doesn't run any more, so it isn't drawn at all
      // (the rng still advances, so every phone skips it the same way).
      if pt.count > 4 && pt[4] == 1 { _ = rng.next(); continue }
      dab(u: CGFloat(pt[0]), v: CGFloat(pt[1]), radiusM: CGFloat(pt[2]), alpha: CGFloat(pt[3]), color: color, rng: &rng)
    }
  }

  /// Drops a stroke and rebuilds the texture from the ones that are left.
  func remove(strokeId: String) -> Bool {
    guard let i = history.lastIndex(where: { $0.id == strokeId }) else { return false }
    history.remove(at: i)
    ctx.clear(CGRect(x: 0, y: 0, width: PaintNode.px, height: PaintNode.px))
    for p in history { replay(p) }
    dirty = true
    return true
  }

  private func softCircle(at c: CGPoint, r: CGFloat, color: UIColor, alpha: CGFloat, hard: CGFloat = 0.0) {
    let cs = CGColorSpaceCreateDeviceRGB()
    let inner = color.withAlphaComponent(alpha).cgColor
    let outer = color.withAlphaComponent(0).cgColor
    guard let g = CGGradient(colorsSpace: cs, colors: [inner, inner, outer] as CFArray, locations: [0, hard, 1]) else { return }
    ctx.saveGState()
    ctx.addEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2))
    ctx.clip()
    ctx.drawRadialGradient(g, startCenter: c, startRadius: 0, endCenter: c, endRadius: r, options: [])
    ctx.restoreGState()
  }

  func uploadIfNeeded(now: CFTimeInterval, force: Bool = false) {
    guard dirty, force || now - lastUpload > 1.0 / 20.0 else { return }
    if let img = ctx.makeImage() {
      material.diffuse.contents = img
      lastUpload = now
      dirty = false
    }
  }
}

/// Deterministic PRNG so every phone renders the same speckle for the same stroke.
struct SplitMix {
  var state: UInt64
  init(seed: String) {
    var h: UInt64 = 0xcbf29ce484222325
    for b in seed.utf8 { h = (h ^ UInt64(b)) &* 0x100000001b3 }
    state = h
  }
  mutating func next() -> CGFloat {
    state &+= 0x9e3779b97f4a7c15
    var z = state
    z = (z ^ (z >> 30)) &* 0xbf58476d1ce4e5b9
    z = (z ^ (z >> 27)) &* 0x94d049bb133111eb
    z = z ^ (z >> 31)
    return CGFloat(Double(z >> 11) / Double(1 << 53))
  }
  mutating func gauss() -> CGFloat {
    let u = max(1e-9, next()), v = next()
    return max(-2.5, min(2.5, sqrt(-2 * log(u)) * cos(2 * .pi * v)))
  }
}

final class ArPaintView: ExpoView, ARSCNViewDelegate, ARSessionDelegate {
  let sceneView = ARSCNView()
  let onTracking = EventDispatcher()
  let onHit = EventDispatcher()
  let onStrokeEnd = EventDispatcher()
  let onSurface = EventDispatcher()

  // props
  var spraying = false { didSet { if spraying != oldValue { spraying ? beginStroke() : endStroke() } } }
  var paintColor: UIColor = UIColor(red: 1, green: 0.18, blue: 0.58, alpha: 1)
  var radius: CGFloat = 0.05
  var flow: CGFloat = 1
  var showPlanes = true { didSet { planeNodes.values.forEach { $0.isHidden = !showPlanes } } }

  private var paintNodes: [String: PaintNode] = [:]
  private var planeNodes: [UUID: SCNNode] = [:]
  private var planeAnchors: [UUID: ARPlaneAnchor] = [:]
  private var displayLink: CADisplayLink?
  private var reticle = SCNNode()
  private var reticleMaterial = SCNMaterial()
  private var lastHitEvent: CFTimeInterval = 0
  private var lastTrackingEvent: CFTimeInterval = 0
  private var lastTrackingKey = ""
  private var pendingWorldMap: ARWorldMap?
  private var started = false
  private var aimedPlane: UUID?
  private(set) var hasLidar = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
  private static let gridImage: UIImage = ArPaintView.makeGrid()

  // current stroke
  private struct StrokeRec { var id: String; var nodeId: String; var points: [[Double]]; var rng: SplitMix; var color: String; var viewer: [Double] }
  private var loadedMapAnchorNames = Set<String>()
  private var stroke: StrokeRec?
  /// Strokes you painted this session, newest last — what undo walks back through.
  private var myStrokes: [(nodeId: String, strokeId: String)] = []
  private var lastTick: CFTimeInterval = 0

  /// What the reticle is on. plane = detected plane geometry (locked), extended = the infinite
  /// extension of a detected plane, mesh = LiDAR mesh, estimated = feature-point estimate.
  private enum HitKind: String { case plane, extended, mesh, estimated }
  private struct Hit { let transform: simd_float4x4; let plane: ARPlaneAnchor?; let kind: HitKind; let vertical: Bool }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    sceneView.delegate = self
    sceneView.session.delegate = self
    sceneView.automaticallyUpdatesLighting = true
    sceneView.antialiasingMode = .multisampling2X
    sceneView.scene = SCNScene()
    addSubview(sceneView)
    buildReticle()
    sceneView.scene.rootNode.addChildNode(reticle)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    sceneView.frame = bounds
  }

  /// Leaving the window (other tab) pauses; coming back RESUMES the same session so every
  /// anchor keeps its place. Only a first start or a world-map load resets tracking.
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      if let map = pendingWorldMap { pendingWorldMap = nil; restartSession(worldMap: map) }
      else if !started { restartSession(worldMap: nil) }
      else { sceneView.session.run(makeConfig(worldMap: nil)) }
      if displayLink == nil {
        displayLink = CADisplayLink(target: self, selector: #selector(tick))
        displayLink?.preferredFramesPerSecond = 60
        displayLink?.add(to: .main, forMode: .common)
      }
    } else {
      sceneView.session.pause()
      displayLink?.invalidate(); displayLink = nil
    }
  }

  // MARK: session

  private func makeConfig(worldMap: ARWorldMap?) -> ARWorldTrackingConfiguration {
    let config = ARWorldTrackingConfiguration()
    // North-aligned metric frame (−Z = north, +X = east, +Y = up, origin = where the session started).
    // Anchor transforms are stored in this frame, so the web app can project AR strokes onto its
    // compass sphere and both clients agree on where paint is.
    config.worldAlignment = .gravityAndHeading
    config.planeDetection = [.horizontal, .vertical]
    config.environmentTexturing = .none
    config.isLightEstimationEnabled = true
    // LiDAR phones: the scene mesh makes blank walls hit-testable immediately (raycasts use it).
    if hasLidar { config.sceneReconstruction = .mesh }
    if let map = worldMap { config.initialWorldMap = map }
    return config
  }

  func restartSession(worldMap: ARWorldMap?) {
    guard ARWorldTrackingConfiguration.isSupported else { return }
    for p in paintNodes.values { p.node.removeFromParentNode(); p.attached = false }
    paintNodes.removeAll()
    planeNodes.values.forEach { $0.removeFromParentNode() }
    planeNodes.removeAll()
    planeAnchors.removeAll()
    aimedPlane = nil
    started = true
    sceneView.session.run(makeConfig(worldMap: worldMap), options: [.resetTracking, .removeExistingAnchors])
  }

  func setWorldMapPath(_ path: String?) {
    guard let path = path, !path.isEmpty else { return }
    DispatchQueue.global(qos: .userInitiated).async {
      guard let data = FileManager.default.contents(atPath: path),
            let map = try? NSKeyedUnarchiver.unarchivedObject(ofClass: ARWorldMap.self, from: data) else {
        DispatchQueue.main.async { self.onTracking(["state": "mapLoadFailed"]) }
        return
      }
      DispatchQueue.main.async {
        self.loadedMapAnchorNames = Set(map.anchors.compactMap { $0.name })
        if self.window != nil { self.restartSession(worldMap: map) } else { self.pendingWorldMap = map }
        self.onTracking(["state": "mapLoaded", "anchors": map.anchors.count])
      }
    }
  }

  func saveWorldMap(to path: String, completion: @escaping (Result<[String: Any], Error>) -> Void) {
    sceneView.session.getCurrentWorldMap { map, error in
      guard let map = map else { completion(.failure(error ?? NSError(domain: "ArPaint", code: 1))); return }
      DispatchQueue.global(qos: .utility).async {
        do {
          let data = try NSKeyedArchiver.archivedData(withRootObject: map, requiringSecureCoding: true)
          try data.write(to: URL(fileURLWithPath: path))
          completion(.success(["bytes": data.count, "anchors": map.anchors.count]))
        } catch { completion(.failure(error)) }
      }
    }
  }

  func clearAll() {
    for p in paintNodes.values { p.node.removeFromParentNode() }
    paintNodes.removeAll()
  }

  /// Takes back your most recent stroke in this session: its quad is repainted from the strokes
  /// that remain, so other people's paint over the top survives. Returns the stroke id for the app
  /// to drop from the shared wall, or nil when you have nothing left to undo here.
  func undoLast() -> [String: Any]? {
    while let last = myStrokes.popLast() {
      guard let node = paintNodes[last.nodeId], node.remove(strokeId: last.strokeId) else { continue }
      node.uploadIfNeeded(now: CACurrentMediaTime(), force: true)
      return ["id": last.strokeId, "anchorId": last.nodeId]
    }
    return nil
  }

  /// A photo of the wall as you're seeing it: the camera frame with the paint composited on top,
  /// written to `path` as JPEG. The reticle and the surface grids are hidden for the shot, so it
  /// looks like a picture of the piece rather than a screenshot of the app.
  func snapshot(to path: String) throws -> [String: Any] {
    let hidReticle = reticle.isHidden
    reticle.isHidden = true
    planeNodes.values.forEach { $0.isHidden = true }
    let image = sceneView.snapshot()
    reticle.isHidden = hidReticle
    planeNodes.values.forEach { $0.isHidden = !showPlanes }
    guard let data = image.jpegData(compressionQuality: 0.85) else {
      throw NSError(domain: "ArPaint", code: 2, userInfo: [NSLocalizedDescriptionKey: "could not encode the photo"])
    }
    try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    return ["width": Int(image.size.width), "height": Int(image.size.height), "bytes": data.count]
  }

  // MARK: reticle + plane visuals

  private func buildReticle() {
    let ring = SCNTube(innerRadius: 0.035, outerRadius: 0.045, height: 0.001)
    reticleMaterial.diffuse.contents = UIColor.white.withAlphaComponent(0.85)
    reticleMaterial.lightingModel = .constant
    reticleMaterial.writesToDepthBuffer = false
    ring.materials = [reticleMaterial]
    reticle = SCNNode(geometry: ring)
    reticle.renderingOrder = 20
    reticle.isHidden = true
    let dot = SCNNode(geometry: SCNSphere(radius: 0.004))
    dot.geometry?.firstMaterial?.diffuse.contents = UIColor.white
    dot.geometry?.firstMaterial?.lightingModel = .constant
    reticle.addChildNode(dot)
  }

  /// 1 m tile with 25 cm lines; ARSCNPlaneGeometry texture coordinates are in metres, so it tiles as a real grid.
  private static func makeGrid() -> UIImage {
    let px = 256
    let r = UIGraphicsImageRenderer(size: CGSize(width: px, height: px))
    return r.image { c in
      let ctx = c.cgContext
      ctx.clear(CGRect(x: 0, y: 0, width: px, height: px))
      ctx.setStrokeColor(UIColor.white.withAlphaComponent(0.9).cgColor)
      for i in 0...4 {
        let p = CGFloat(i) * CGFloat(px) / 4
        ctx.setLineWidth(i % 4 == 0 ? 3 : 1.2)
        ctx.move(to: CGPoint(x: p, y: 0)); ctx.addLine(to: CGPoint(x: p, y: CGFloat(px)))
        ctx.move(to: CGPoint(x: 0, y: p)); ctx.addLine(to: CGPoint(x: CGFloat(px), y: p))
        ctx.strokePath()
      }
    }
  }

  private func stylePlane(_ node: SCNNode, anchor: ARPlaneAnchor, aimed: Bool) {
    guard let m = node.geometry?.firstMaterial else { return }
    let vertical = anchor.alignment == .vertical
    let tint = vertical ? UIColor(red: 0.1, green: 0.9, blue: 1, alpha: 1) : UIColor(red: 0.49, green: 1, blue: 0.23, alpha: 1)
    m.multiply.contents = tint
    m.transparency = aimed ? 0.55 : 0.16
  }

  // MARK: raycast

  /// Locked plane geometry first, then the infinite extension of a known plane (so a whole wall is
  /// paintable once any patch of it is detected), then LiDAR mesh / feature-point estimates.
  private func raycastCenter() -> Hit? {
    let center = CGPoint(x: sceneView.bounds.midX, y: sceneView.bounds.midY)
    if let q = sceneView.raycastQuery(from: center, allowing: .existingPlaneGeometry, alignment: .any),
       let r = sceneView.session.raycast(q).first {
      let plane = r.anchor as? ARPlaneAnchor
      return Hit(transform: r.worldTransform, plane: plane, kind: .plane, vertical: plane?.alignment == .vertical || isVertical(r.worldTransform))
    }
    if let q = sceneView.raycastQuery(from: center, allowing: .existingPlaneInfinite, alignment: .any) {
      for r in sceneView.session.raycast(q) {
        guard let plane = r.anchor as? ARPlaneAnchor else { continue }
        // only trust the extension close to the part of the plane ARKit has actually seen
        let p = simd_float3(r.worldTransform.columns.3.x, r.worldTransform.columns.3.y, r.worldTransform.columns.3.z)
        let l = simd_inverse(plane.transform) * simd_float4(p, 1)
        let dx = max(0, abs(l.x - plane.center.x) - plane.planeExtent.width / 2)
        let dz = max(0, abs(l.z - plane.center.z) - plane.planeExtent.height / 2)
        if hypot(dx, dz) < 0.9 { return Hit(transform: r.worldTransform, plane: plane, kind: .extended, vertical: plane.alignment == .vertical) }
      }
    }
    if let q = sceneView.raycastQuery(from: center, allowing: .estimatedPlane, alignment: .any),
       let r = sceneView.session.raycast(q).first {
      return Hit(transform: r.worldTransform, plane: nil, kind: hasLidar ? .mesh : .estimated, vertical: isVertical(r.worldTransform))
    }
    return nil
  }

  private func isVertical(_ t: simd_float4x4) -> Bool { abs(t.columns.1.y) < 0.5 }

  // MARK: frames

  /// A right-handed quad frame: Y = surface normal, X horizontal along the surface, −Z "up the
  /// wall" (so drips run down) or north for floors. Plane anchors keep their own axes, flipped
  /// if needed so the up rule holds; estimated hits get a frame built from the normal alone.
  private func quadFrame(position p: simd_float3, normal nIn: simd_float3, plane: ARPlaneAnchor?) -> simd_float4x4 {
    var x: simd_float3, y: simd_float3, z: simd_float3
    if let plane = plane {
      x = simd_normalize(simd_float3(plane.transform.columns.0.x, plane.transform.columns.0.y, plane.transform.columns.0.z))
      y = simd_normalize(simd_float3(plane.transform.columns.1.x, plane.transform.columns.1.y, plane.transform.columns.1.z))
      z = simd_normalize(simd_float3(plane.transform.columns.2.x, plane.transform.columns.2.y, plane.transform.columns.2.z))
      if plane.alignment == .vertical && z.y > 0 { x = -x; z = -z } // make −Z point up
    } else {
      y = simd_normalize(nIn)
      let up = simd_float3(0, 1, 0)
      if abs(y.y) > 0.7 { // floor / table: X = east
        if y.y < 0 { y = -y }
        x = simd_normalize(simd_float3(1, 0, 0) - y * y.x)
        z = simd_cross(x, y)
      } else {
        x = simd_normalize(simd_cross(up, y))
        z = simd_cross(x, y) // points down for a wall normal → −Z is up
        if z.y > 0 { x = -x; z = -z }
      }
    }
    var m = matrix_identity_float4x4
    m.columns.0 = simd_float4(x, 0); m.columns.1 = simd_float4(y, 0); m.columns.2 = simd_float4(z, 0); m.columns.3 = simd_float4(p, 1)
    return m
  }

  private func planeCenterWorld(_ plane: ARPlaneAnchor) -> simd_float3 {
    let c = plane.transform * simd_float4(plane.center, 1)
    return simd_float3(c.x, c.y, c.z)
  }

  private func normal(of t: simd_float4x4) -> simd_float3 { simd_normalize(simd_float3(t.columns.1.x, t.columns.1.y, t.columns.1.z)) }

  // MARK: paint loop

  @objc private func tick(_ link: CADisplayLink) {
    let now = link.timestamp
    let hit = raycastCenter()
    if let h = hit {
      let t = h.transform
      reticle.simdTransform = t
      reticle.simdPosition += normal(of: t) * 0.006
      reticle.isHidden = false
      let locked = h.kind == .plane || h.kind == .extended || h.kind == .mesh
      reticleMaterial.diffuse.contents = locked ? UIColor.white.withAlphaComponent(0.9) : UIColor(red: 1, green: 0.9, blue: 0, alpha: 0.9)
      let cam = sceneView.pointOfView?.simdWorldPosition ?? .zero
      let dist = simd_distance(cam, simd_float3(t.columns.3.x, t.columns.3.y, t.columns.3.z))
      reticle.simdScale = simd_float3(repeating: max(0.5, min(3, dist / 0.8)))
      setAimed(h.plane?.identifier)
      if now - lastHitEvent > 0.1 {
        lastHitEvent = now
        onHit(["hit": true, "distance": Double(dist), "kind": h.kind.rawValue, "vertical": h.vertical, "locked": locked])
      }
    } else {
      reticle.isHidden = true
      setAimed(nil)
      if now - lastHitEvent > 0.1 { lastHitEvent = now; onHit(["hit": false, "distance": 0, "kind": "none", "locked": false]) }
    }

    if spraying, let h = hit, now - lastTick >= 1.0 / 30.0 {
      lastTick = now
      paintAt(h)
    }
    for p in paintNodes.values { p.uploadIfNeeded(now: now) }
  }

  private func setAimed(_ id: UUID?) {
    guard id != aimedPlane else { return }
    if let old = aimedPlane, let n = planeNodes[old], let a = planeAnchors[old] { stylePlane(n, anchor: a, aimed: false) }
    if let new = id, let n = planeNodes[new], let a = planeAnchors[new] { stylePlane(n, anchor: a, aimed: true) }
    aimedPlane = id
  }

  private func beginStroke() {
    lastTick = 0
    stroke = nil // created lazily on first hit so the anchor is the surface we actually hit
  }

  private func endStroke() {
    flushStroke()
  }

  private func flushStroke() {
    guard let s = stroke else { return }
    stroke = nil
    guard !s.points.isEmpty, let node = paintNodes[s.nodeId] else { return }
    node.record(PaintNode.Painted(id: s.id, colorHex: s.color, points: s.points))
    myStrokes.append((nodeId: s.nodeId, strokeId: s.id))
    node.uploadIfNeeded(now: CACurrentMediaTime(), force: true)
    onStrokeEnd([
      "id": s.id, "anchorId": s.nodeId, "transform": flatten(node.transform), "color": s.color, "points": s.points, "viewer": s.viewer,
    ])
  }

  /// Pick the paint node for a hit: a quad on the same detected plane that contains the point,
  /// else any coplanar quad that does, else a new one built in a wall-aligned frame.
  private func nodeFor(hit: Hit) -> PaintNode {
    let t = hit.transform
    let p = simd_float3(t.columns.3.x, t.columns.3.y, t.columns.3.z)
    let n = normal(of: t)
    if let plane = hit.plane {
      for node in paintNodes.values where node.planeId == plane.identifier {
        let l = node.local(p)
        if node.contains(u: l.u, v: l.v) { return node }
      }
    }
    for node in paintNodes.values {
      let l = node.local(p)
      if l.d < 0.08 && node.contains(u: l.u, v: l.v) && simd_dot(n, node.normal) > 0.95 {
        if node.planeId == nil, let plane = hit.plane { adopt(node, plane: plane) } // estimated quad meets its real wall
        return node
      }
    }
    let transform = quadFrame(position: p, normal: n, plane: hit.plane)
    let id = "paint-" + UUID().uuidString.lowercased()
    let node = PaintNode(id: id, transform: transform)
    node.planeId = hit.plane?.identifier
    paintNodes[id] = node
    addAnchor(for: node)
    onSurface(["id": id, "count": paintNodes.count, "kind": hit.kind.rawValue])
    return node
  }

  private func addAnchor(for node: PaintNode) {
    let a = ARAnchor(name: node.id, transform: node.transform)
    node.anchorId = a.identifier
    sceneView.session.add(anchor: a)
  }

  /// Bind an estimated quad to a real plane and pull it onto that plane.
  private func adopt(_ node: PaintNode, plane: ARPlaneAnchor) {
    node.planeId = plane.identifier
    node.loose = false
    snap(node, to: plane, force: true)
  }

  /// Move a quad onto its plane (position projected along the normal, orientation = plane's).
  /// Re-anchors the quad so ARKit keeps the corrected pose; debounced so refinement jitter is ignored.
  private func snap(_ node: PaintNode, to plane: ARPlaneAnchor, force: Bool = false) {
    let now = CACurrentMediaTime()
    guard force || now - node.lastSnap > 0.7 else { return }
    let pn = normal(of: plane.transform)
    let pc = planeCenterWorld(plane)
    let c = node.center
    let off = simd_dot(c - pc, pn)
    let angle = acos(max(-1, min(1, simd_dot(pn, node.normal))))
    guard force || abs(off) > 0.012 || angle > 2 * .pi / 180 else { return }
    let target = quadFrame(position: c - pn * off, normal: pn, plane: plane)
    node.lastSnap = now
    node.transform = target
    if let old = node.anchorId, let a = sceneView.session.currentFrame?.anchors.first(where: { $0.identifier == old }) {
      sceneView.session.remove(anchor: a)
    }
    node.node.removeFromParentNode(); node.attached = false
    addAnchor(for: node)
  }

  /// One spray tick. Dwelling on a spot used to start a drip; paint now stays where it was sprayed
  /// and only builds up, which is what you want when you're actually trying to draw something.
  private func paintAt(_ hit: Hit) {
    let node = nodeFor(hit: hit)
    if stroke == nil || stroke!.nodeId != node.id {
      flushStroke()
      let id = UUID().uuidString.lowercased()
      let cam = sceneView.pointOfView?.simdWorldPosition ?? .zero
      stroke = StrokeRec(id: id, nodeId: node.id, points: [], rng: SplitMix(seed: id), color: paintColor.hexString, viewer: [Double(cam.x), Double(cam.y), Double(cam.z)])
    }
    let t = hit.transform
    let p = simd_float3(t.columns.3.x, t.columns.3.y, t.columns.3.z)
    let l = node.local(p)
    let r = radius * (0.85 + 0.3 * flow)
    let a = 0.28 * flow
    node.dab(u: l.u, v: l.v, radiusM: r, alpha: a, color: paintColor, rng: &stroke!.rng)
    stroke!.points.append([Double(l.u), Double(l.v), Double(r), Double(a), 0])
  }

  /// Strokes from other phones / previous sessions: [{id, anchorId, transform:[16], color, points:[[u,v,r,a,kind]], viewer:[3]}]
  /// mode "absolute": transforms are in this session's frame (same world map). mode "relative":
  /// no shared map — place each quad at its offset from where the painter stood, relative to the
  /// camera now (frame is heading-aligned so the rotation is valid); real planes then pull it in.
  func addRemoteStrokes(_ strokes: [[String: Any]], mode: String) {
    let cam = sceneView.pointOfView?.simdWorldPosition ?? .zero
    for s in strokes {
      guard let id = s["id"] as? String, let anchorId = s["anchorId"] as? String,
            let tf = s["transform"] as? [Double], tf.count == 16,
            let colorHex = s["color"] as? String, let pts = s["points"] as? [[Double]] else { continue }
      let node: PaintNode
      if let existing = paintNodes[anchorId] { node = existing } else {
        var transform = unflatten(tf)
        if mode == "relative" {
          if let v = s["viewer"] as? [Double], v.count == 3 {
            let viewer = simd_float3(Float(v[0]), Float(v[1]), Float(v[2]))
            let anchorPos = simd_float3(transform.columns.3.x, transform.columns.3.y, transform.columns.3.z)
            transform.columns.3 = simd_float4(cam + (anchorPos - viewer), 1)
          } else { continue }
        }
        node = PaintNode(id: anchorId, transform: transform)
        node.loose = mode == "relative"
        paintNodes[anchorId] = node
        // If the loaded world map already contains this anchor, ARKit will call didAdd and we attach there;
        // otherwise add it ourselves.
        let inLoadedMap = mode == "absolute" && loadedMapAnchorNames.contains(anchorId)
        if let anchor = sceneView.session.currentFrame?.anchors.first(where: { $0.name == anchorId }) {
          node.anchorId = anchor.identifier
          node.transform = anchor.transform
          if let anchorNode = sceneView.node(for: anchor) { anchorNode.addChildNode(node.node); node.attached = true }
        } else if !inLoadedMap {
          addAnchor(for: node)
        }
        if node.loose { attachLooseNodeToNearbyPlane(node) }
      }
      node.add(PaintNode.Painted(id: id, colorHex: colorHex, points: pts))
      node.uploadIfNeeded(now: CACurrentMediaTime(), force: true)
    }
  }

  /// Quads without a real plane (estimated hits, or geo-fallback placement) adopt a newly seen
  /// plane that is close and parallel. Loose (fallback) quads accept a wider gap.
  private func attachLooseNodeToNearbyPlane(_ node: PaintNode) {
    for plane in planeAnchors.values { if tryAdopt(node, plane: plane) { return } }
  }
  @discardableResult private func tryAdopt(_ node: PaintNode, plane: ARPlaneAnchor) -> Bool {
    guard node.planeId == nil else { return false }
    let pn = normal(of: plane.transform)
    let dot = simd_dot(pn, node.normal)
    let maxAngle: Float = node.loose ? 0.94 : 0.97 // ~20° / ~14°
    guard dot > maxAngle else { return false }
    let pc = planeCenterWorld(plane)
    let off = abs(simd_dot(node.center - pc, pn))
    guard off < (node.loose ? 0.6 : 0.15) else { return false }
    // and the quad must overlap the plane's known extent (in-plane distance)
    let l = simd_inverse(plane.transform) * simd_float4(node.center, 1)
    let dx = max(0, abs(l.x - plane.center.x) - plane.planeExtent.width / 2)
    let dz = max(0, abs(l.z - plane.center.z) - plane.planeExtent.height / 2)
    guard hypot(dx, dz) < Float(PaintNode.sizeM) / 2 else { return false }
    adopt(node, plane: plane)
    return true
  }

  // MARK: ARSCNViewDelegate

  func renderer(_ renderer: SCNSceneRenderer, didAdd node: SCNNode, for anchor: ARAnchor) {
    if let plane = anchor as? ARPlaneAnchor {
      guard let geo = ARSCNPlaneGeometry(device: sceneView.device!) else { return }
      geo.update(from: plane.geometry)
      let m = SCNMaterial()
      m.diffuse.contents = ArPaintView.gridImage
      m.diffuse.wrapS = .repeat; m.diffuse.wrapT = .repeat
      m.lightingModel = .constant
      m.writesToDepthBuffer = false
      m.isDoubleSided = true
      geo.materials = [m]
      let pn = SCNNode(geometry: geo)
      pn.isHidden = !showPlanes
      pn.renderingOrder = 5
      pn.opacity = 0
      node.addChildNode(pn)
      pn.runAction(.fadeOpacity(to: 1, duration: 0.35))
      DispatchQueue.main.async {
        self.planeNodes[plane.identifier] = pn
        self.planeAnchors[plane.identifier] = plane
        self.stylePlane(pn, anchor: plane, aimed: plane.identifier == self.aimedPlane)
        for n in self.paintNodes.values { self.tryAdopt(n, plane: plane) }
      }
      return
    }
    if let name = anchor.name, name.hasPrefix("paint-") {
      DispatchQueue.main.async {
        let pnode: PaintNode
        if let existing = self.paintNodes[name] { pnode = existing } else {
          // restored from a saved world map: JS will replay its strokes via addStrokes
          pnode = PaintNode(id: name, transform: anchor.transform)
          self.paintNodes[name] = pnode
        }
        pnode.anchorId = anchor.identifier
        pnode.transform = anchor.transform
        if !pnode.attached { node.addChildNode(pnode.node); pnode.attached = true }
        self.onSurface(["id": name, "count": self.paintNodes.count, "restored": true])
      }
    }
  }

  func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
    let transform = anchor.transform
    if let plane = anchor as? ARPlaneAnchor {
      let geometry = plane.geometry
      DispatchQueue.main.async {
        if let geo = self.planeNodes[plane.identifier]?.geometry as? ARSCNPlaneGeometry { geo.update(from: geometry) }
        self.planeAnchors[plane.identifier] = plane
        // ARKit refines a plane's depth/tilt for a while after it appears: keep our quads on it
        for n in self.paintNodes.values {
          if n.planeId == plane.identifier { self.snap(n, to: plane) } else { self.tryAdopt(n, plane: plane) }
        }
      }
    } else if let name = anchor.name, name.hasPrefix("paint-") {
      DispatchQueue.main.async {
        if let n = self.paintNodes[name], n.anchorId == anchor.identifier { n.transform = transform }
      }
    }
  }

  func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool { true }

  func renderer(_ renderer: SCNSceneRenderer, didRemove node: SCNNode, for anchor: ARAnchor) {
    if let plane = anchor as? ARPlaneAnchor {
      DispatchQueue.main.async {
        self.planeNodes[plane.identifier] = nil
        self.planeAnchors[plane.identifier] = nil
        // merged into another plane: quads go back to "unbound" and re-adopt the survivor
        for n in self.paintNodes.values where n.planeId == plane.identifier { n.planeId = nil; self.attachLooseNodeToNearbyPlane(n) }
      }
    } else if let name = anchor.name, name.hasPrefix("paint-") {
      // our own re-anchoring removes the old anchor; a stale one must not detach the quad's new node
      DispatchQueue.main.async {
        if let n = self.paintNodes[name], n.anchorId == anchor.identifier { n.node.removeFromParentNode(); n.attached = false }
      }
    }
  }

  // MARK: ARSessionDelegate

  func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
    emitTracking(camera: camera, frame: session.currentFrame)
  }

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    let now = CACurrentMediaTime()
    if now - lastTrackingEvent > 0.5 { emitTracking(camera: frame.camera, frame: frame) }
  }

  private func emitTracking(camera: ARCamera, frame: ARFrame?) {
    var state = "normal", reason = ""
    switch camera.trackingState {
    case .notAvailable: state = "notAvailable"
    case .limited(let r):
      state = "limited"
      switch r {
      case .initializing: reason = "initializing"
      case .relocalizing: reason = "relocalizing"
      case .excessiveMotion: reason = "excessiveMotion"
      case .insufficientFeatures: reason = "insufficientFeatures"
      @unknown default: reason = "unknown"
      }
    case .normal: state = "normal"
    }
    var mapping = ""
    if let f = frame {
      switch f.worldMappingStatus {
      case .notAvailable: mapping = "notAvailable"
      case .limited: mapping = "limited"
      case .extending: mapping = "extending"
      case .mapped: mapping = "mapped"
      @unknown default: mapping = "unknown"
      }
    }
    let key = state + reason + mapping
    let now = CACurrentMediaTime()
    if key == lastTrackingKey && now - lastTrackingEvent < 2 { return }
    lastTrackingKey = key; lastTrackingEvent = now
    onTracking(["state": state, "reason": reason, "mapping": mapping, "planes": planeNodes.count, "surfaces": paintNodes.count, "lidar": hasLidar])
  }
}

private func flatten(_ m: simd_float4x4) -> [Double] {
  var out: [Double] = []
  for c in 0..<4 { for r in 0..<4 { out.append(Double(m[c][r])) } }
  return out
}
private func unflatten(_ a: [Double]) -> simd_float4x4 {
  var m = matrix_identity_float4x4
  for c in 0..<4 { for r in 0..<4 { m[c][r] = Float(a[c * 4 + r]) } }
  return m
}

extension UIColor {
  var hexString: String {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    getRed(&r, green: &g, blue: &b, alpha: &a)
    return String(format: "#%02x%02x%02x", Int(r * 255), Int(g * 255), Int(b * 255))
  }
}
