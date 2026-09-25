package expo.modules.arpaint

import android.Manifest
import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.opengl.Matrix
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Surface
import android.view.View
import com.google.ar.core.Anchor
import com.google.ar.core.ArCoreApk
import com.google.ar.core.Camera
import com.google.ar.core.Config
import com.google.ar.core.Coordinates2d
import com.google.ar.core.DepthPoint
import com.google.ar.core.Earth
import com.google.ar.core.Frame
import com.google.ar.core.Plane
import com.google.ar.core.ResolveCloudAnchorFuture
import com.google.ar.core.Session
import com.google.ar.core.TrackingFailureReason
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.CameraNotAvailableException
import com.google.ar.core.exceptions.UnavailableUserDeclinedInstallationException
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * ARCore twin of ArPaintView.swift — same props, events and functions, so the JS screen is shared.
 *
 * DETECTION: horizontal + vertical plane finding, plus ARCore's Depth API (depth-from-motion on
 * phones without a depth sensor, e.g. Galaxy S25), which lets planes form on walls too blank to
 * give up feature points. The reticle takes the nearest usable plane — its polygon, or its
 * extension within an overhang that scales per axis with that plane's own extents, so a wall stays
 * paintable past the patch ARCore has found while a chair seat stays chair-sized. Nothing else:
 * ceilings, and the depth/feature points ARCore also offers, are rejected. Upward-facing surfaces
 * are all paintable, so that includes tables and seats as well as the floor. Where ARCore has no
 * plane at all — a wall in one flat colour can defeat it for a long time — a depth hit is taken as
 * a last resort, but only one oriented like a wall or a floor. See [raycastCenter].
 *
 * ANCHORING: every quad rides an ARCore anchor (attached to its plane when it has one), is snapped
 * onto a real plane when one appears (< 15 cm, < 14°) and re-snapped as ARCore refines it.
 *
 * OCCLUSION: with the Depth API on, the paint shader compares each fragment's distance against
 * ARCore's depth map and fades out wherever something real is clearly in front of it: a person
 * walking past, a pole, the near edge of a pillar. See [DepthTexture]. Settings can turn it off.
 *
 * MOVED SURFACES: ARCore assumes nothing in the world moves, so paint on a chair that gets pushed
 * away is left hanging in the air. [verifySurfaces] samples the depth map where each piece on a
 * piece of furniture sits — see [isFurniture], which means raised, upward-facing and small enough
 * to carry, never a wall or a floor — and hides the ones the camera can now see straight through.
 * Hidden, not deleted, and the verdict is dropped the moment a quad stops being eligible: bring
 * the chair back and the paint comes back on it.
 *
 * GEOSPATIAL: with cloud auth configured and the location permission granted, the session also runs
 * ARCore's Geospatial API (Google's VPS, from Street View imagery: sub-metre outdoors where there is
 * coverage). Each stroke carries its quad's WGS84 pose when the fix is good. A piece that has no
 * usable map is placed from memory as before, then moved onto its recorded geo pose as soon as this
 * phone's own fix is good enough, and snapped to the real wall from there. See [updateGeo].
 *
 * FRAME: ARCore's yaw is arbitrary; [HeadingEstimator] recovers the north-aligned frame the iPhone
 * uses, and everything crossing to JS (stroke transforms, viewer positions) is expressed in it.
 *
 * PERSISTENCE: ARCore has no exportable world map. saveWorldMap hosts each quad as a Cloud Anchor
 * (needs keyless auth — 365-day anchors — or an API key — 1-day anchors; see app.plugin.js) and
 * writes their ids to a small JSON "map"; loading resolves them, and
 * the first one to resolve aligns every other quad. Without a key, JS falls back to the
 * placed-from-memory path, exactly as the iPhone does when relocalisation fails.
 */
class ArPaintView(context: Context, appContext: AppContext) : ExpoView(context, appContext), GLSurfaceView.Renderer {
  private companion object {
    const val TAG = "ArPaint"
    const val SAVE_TIMEOUT_MS = 30_000L

    // ---- Geospatial (see updateGeo) ----
    /** Record a stroke's geo pose only when VPS has this phone at least this well. */
    const val GEO_RECORD_MAX_H_M = 5f
    const val GEO_RECORD_MAX_YAW_DEG = 10f
    /** Move a piece placed from memory onto its geo pose once our own fix is at least this good. */
    const val GEO_PLACE_MAX_H_M = 3f
    const val GEO_PLACE_MAX_YAW_DEG = 8f

    // ---- surface verification (see verifySurfaces) ----
    /** Anything whose smaller side is under this can be picked up and carried off: a chair, a box,
     *  a laptop. A wall or a floor cannot, and is never subjected to the check. */
    const val FURNITURE_MAX_M = 1.6f
    /** A surface must stand this clear of the floor before it counts as something you could move. */
    const val FURNITURE_MIN_RISE_M = 0.15f
    const val VERIFY_INTERVAL_MS = 200L
    /** Measured depth must be this far behind the paint before it counts as seeing through it. */
    const val DEPTH_CLEAR_MARGIN_M = 0.25f
    /** Consecutive contradicting samples needed to hide a piece: ~1.2 s at 5 Hz. */
    const val MISS_TO_HIDE = 6f
    /** Depth-from-motion is only trustworthy in this band. */
    const val DEPTH_NEAR_M = 0.4f
    const val DEPTH_FAR_M = 4f
    /**
     * How far past a plane's edge still counts as "on it" rather than a guess. This is the width
     * of ARCore's polygon noise, not a design choice: inside it the near surface keeps the
     * reticle, outside it a real surface behind is allowed to take over, which is what makes a
     * line drawn off a table edge drop onto the floor promptly instead of hanging in the air.
     */
    const val EDGE_SLOP_M = 0.05f
    /**
     * How far behind a guessed extension a real polygon hit may be and still take over. Under it,
     * the real surface is the one you are pointing at — the next face of a pillar, the floor below
     * a table edge. Over it, the polygon is merely somewhere further along the same ray, like the
     * floor several metres past a wall, and the nearer surface keeps the reticle.
     */
    const val HANDOVER_M = 1.2f
    /**
     * How square-on the ray must meet a plane for its extension to count: below this it is being
     * seen edge-on, where the hit position swings wildly for a millimetre of plane error. 0.2 is
     * about 78 degrees off the normal, so ordinary steep painting is unaffected.
     */
    const val EXTENSION_MIN_INCIDENCE = 0.2f
    /** Normals this far from parallel mean two different surfaces meeting — a corner, not a gap. */
    const val PERPENDICULAR_DOT = 0.5f // 60 degrees apart
    // ---- steadying a depth-derived reticle (no plane behind it, so no steadiness of its own) ----
    const val MESH_SMOOTH_K = 0.25f
    const val MESH_DEADBAND_M = 0.012f
    const val MESH_DEADBAND_RAD = 0.035f // ~2 degrees
    const val MESH_JUMP_M = 0.4f
    val CROSS_X = intArrayOf(0, -1, 1, 0, 0)
    val CROSS_Y = intArrayOf(0, 0, 0, -1, 1)

    // ---- how closely painted geometry follows its anchor (see M.settle) ----
    /** Below this, a correction is noise and the paint does not move at all. */
    const val POSE_DEADBAND_M = 0.004f
    const val POSE_DEADBAND_RAD = 0.006f // ~0.35 degrees
    /** Above this it isn't a correction, it's a relocalisation: go there at once. */
    const val POSE_JUMP_M = 0.35f
    /** Ease time constant, seconds: a real refinement lands in about a fifth of a second. */
    const val POSE_EASE_TAU = 0.07f
  }

  private val onTracking by EventDispatcher()
  private val onHit by EventDispatcher()
  private val onStrokeEnd by EventDispatcher()
  private val onSurface by EventDispatcher()

  override val shouldUseAndroidLayout = true

  private val main = Handler(Looper.getMainLooper())
  private val glView = GLSurfaceView(context)
  private val heading = HeadingEstimator(context)

  // ---- props (written on the main thread) ------------------------------------------------
  @Volatile var radius = 0.05f
  @Volatile var flow = 1f
  @Volatile var showPlanes = true
  /** Hide paint behind real things in front of it, using the depth map. */
  @Volatile var occlusion = true
  @Volatile private var colorInt = Color.rgb(255, 46, 148)
  @Volatile private var colorHex = "#ff2e94"

  // ---- session lifecycle (main thread) ---------------------------------------------------
  @Volatile private var session: Session? = null
  @Volatile private var running = false
  private var installRequested = false
  private var activityResumed = true
  private var destroyed = false
  private var retryPosted = false
  @Volatile private var cloudEnabled = false
  /** Cloud Anchor lifetime for this build's auth: 365 days keyless, 1 day with an API key. */
  private var hostTtlDays = 1
  @Volatile private var geoEnabled = false
  /** This phone's current geospatial accuracy (horizontal metres, yaw degrees); NaN while not tracking. */
  @Volatile private var geoH = Float.NaN
  @Volatile private var geoYaw = Float.NaN
  private var geoStateLogged: Earth.EarthState? = null
  @Volatile private var depthEnabled = false
  @Volatile private var displayRotation = Surface.ROTATION_0

  // ---- work queued for the GL thread -----------------------------------------------------
  /** Returns true when done; false to retry next frame. Stale ops (from before a reset) are dropped. */
  private class Op(val gen: Int, val needsTracking: Boolean, val block: () -> Boolean, val onDropped: (() -> Unit)? = null)
  private val ops = ConcurrentLinkedQueue<Op>()
  private val pendingSaves = ConcurrentLinkedQueue<Promise>() // settled even if the view goes away first
  private val generation = AtomicInteger(0)
  private var activeGeneration = 0

  // ---- GL thread state -------------------------------------------------------------------
  private val background = CameraBackground()
  private val planeRenderer = PlaneRenderer()
  private val quadRenderer = QuadRenderer()
  private val depthTexture = DepthTexture()
  private var viewportW = 0
  private var viewportH = 0
  private var displayChanged = true
  private var cameraTextureSet = false
  private val viewM = FloatArray(16)
  private val projM = FloatArray(16)
  private val viewProj = FloatArray(16)

  private val quads = LinkedHashMap<String, PaintQuad>()
  private val planes = LinkedHashMap<Plane, Long>() // plane → first seen (fade-in)
  private var aimedPlane: Plane? = null
  private var cameraPos = V3.ZERO
  private var tracking = false
  private var lastHitEvent = 0L
  private var lastTrackingEvent = 0L
  private var lastTrackingKey = ""

  private enum class HitKind(val js: String) { PLANE("plane"), EXTENDED("extended"), MESH("mesh"), ESTIMATED("estimated") }
  private class Hit(val transform: M4, val plane: Plane?, val kind: HitKind, val vertical: Boolean)

  // current stroke
  private class StrokeRec(val id: String, val quadId: String, val points: MutableList<List<Double>>, val rng: SplitMix, val color: String, val viewer: List<Double>)
  private var spraying = false
  private var stroke: StrokeRec? = null
  /** Strokes you painted this session, newest last - what undo walks back through. */
  private val myStrokes = mutableListOf<Pair<String, String>>() // quad id, stroke id
  private var lastTick = 0L
  @Volatile private var snapshotJob: SnapshotJob? = null // set from JS, consumed on the GL thread

  private class SnapshotJob(val path: String, val promise: Promise)

  // loaded Cloud-Anchor map
  private enum class MapState { NONE, RESOLVING, RESOLVED, FAILED }
  private var mapState = MapState.NONE
  private var mapAlignment: M4? = null // saving session's north frame → this session's ARCore world
  private var pendingResolves = 0
  private val resolveFutures = mutableListOf<ResolveCloudAnchorFuture>()

  // ---- setup -----------------------------------------------------------------------------

  init {
    glView.preserveEGLContextOnPause = true
    glView.setEGLContextClientVersion(2)
    glView.setEGLConfigChooser(8, 8, 8, 8, 16, 0)
    glView.setRenderer(this)
    glView.renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
    addView(glView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  private val lifecycle = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityResumed(a: Activity) { if (a === appContext.currentActivity) { activityResumed = true; updateRunning() } }
    override fun onActivityPaused(a: Activity) { if (a === appContext.currentActivity) { activityResumed = false; updateRunning() } }
    override fun onActivityCreated(a: Activity, b: Bundle?) {}
    override fun onActivityStarted(a: Activity) {}
    override fun onActivityStopped(a: Activity) {}
    override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}
    override fun onActivityDestroyed(a: Activity) {}
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    appContext.currentActivity?.application?.registerActivityLifecycleCallbacks(lifecycle)
    updateRunning()
  }

  override fun onDetachedFromWindow() {
    appContext.currentActivity?.application?.unregisterActivityLifecycleCallbacks(lifecycle)
    // isAttachedToWindow / windowVisibility are still stale here, so stop outright rather than re-deriving
    stop()
    super.onDetachedFromWindow()
  }

  // React Native sizes this view but never measures native children: fill it with the GL surface.
  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    glView.measure(MeasureSpec.makeMeasureSpec(r - l, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(b - t, MeasureSpec.EXACTLY))
    glView.layout(0, 0, r - l, b - t)
  }

  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    if (visibility != View.VISIBLE) stop() else updateRunning()
  }

  override fun onVisibilityChanged(changedView: View, visibility: Int) {
    super.onVisibilityChanged(changedView, visibility)
    if (visibility != View.VISIBLE) stop() else updateRunning()
  }
  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    displayRotation = display?.rotation ?: Surface.ROTATION_0
    displayChanged = true
    updateRunning()
  }

  /**
   * Leaving the Create tab (hidden / zero size / detached) or backgrounding the app pauses the
   * session; coming back RESUMES the same session, so every anchor keeps its place.
   */
  private fun updateRunning() {
    if (destroyed) return
    val want = isAttachedToWindow && windowVisibility == View.VISIBLE && isShown && width > 0 && height > 0 && activityResumed
    if (want) start() else stop()
  }

  private fun start() {
    if (running) return
    val activity = appContext.currentActivity ?: return retryLater()
    if (context.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      emitTracking(mapOf("state" to "notAvailable", "reason" to "cameraPermission"))
      return retryLater()
    }
    if (session == null) {
      try {
        if (ArCoreApk.getInstance().requestInstall(activity, !installRequested) == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
          installRequested = true // Play Services for AR is installing; we resume via onActivityResumed
          return
        }
        session = Session(activity).also { configure(it) }
      } catch (e: UnavailableUserDeclinedInstallationException) {
        emitTracking(mapOf("state" to "notAvailable", "reason" to "arcoreDeclined"))
        return
      } catch (e: Exception) {
        Log.w(TAG, "ARCore session failed", e)
        emitTracking(mapOf("state" to "notAvailable", "reason" to (e.javaClass.simpleName ?: "error")))
        return
      }
    }
    try {
      session!!.resume()
    } catch (e: CameraNotAvailableException) {
      emitTracking(mapOf("state" to "notAvailable", "reason" to "cameraUnavailable"))
      return retryLater()
    } catch (e: Exception) {
      Log.w(TAG, "resume failed", e)
      return retryLater()
    }
    glView.onResume()
    heading.start()
    running = true
  }

  private fun stop() {
    if (!running) return
    running = false
    glView.queueEvent { if (spraying) { spraying = false; flushStroke() } }
    glView.onPause()
    session?.pause()
    heading.stop()
  }

  private fun retryLater() {
    if (retryPosted || destroyed) return
    retryPosted = true
    main.postDelayed({ retryPosted = false; updateRunning() }, 1000)
  }

  private fun configure(s: Session) {
    val cfg = Config(s)
    cfg.planeFindingMode = Config.PlaneFindingMode.HORIZONTAL_AND_VERTICAL
    cfg.focusMode = Config.FocusMode.AUTO
    cfg.lightEstimationMode = Config.LightEstimationMode.DISABLED
    cfg.updateMode = Config.UpdateMode.LATEST_CAMERA_IMAGE
    cfg.instantPlacementMode = Config.InstantPlacementMode.DISABLED
    // Depth-from-motion (or a ToF sensor where present) makes untextured walls hit-testable.
    depthEnabled = s.isDepthModeSupported(Config.DepthMode.AUTOMATIC)
    cfg.depthMode = if (depthEnabled) Config.DepthMode.AUTOMATIC else Config.DepthMode.DISABLED
    cloudEnabled = ArSupport.hasCloudAuth(context)
    hostTtlDays = ArSupport.hostTtlDays(context)
    cfg.cloudAnchorMode = if (cloudEnabled) Config.CloudAnchorMode.ENABLED else Config.CloudAnchorMode.DISABLED
    // Geospatial rides on the same auth, and ARCore refuses to configure it without fine location.
    geoEnabled = cloudEnabled &&
      context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED &&
      try { s.isGeospatialModeSupported(Config.GeospatialMode.ENABLED) } catch (_: Exception) { false }
    cfg.geospatialMode = if (geoEnabled) Config.GeospatialMode.ENABLED else Config.GeospatialMode.DISABLED
    try {
      s.configure(cfg)
    } catch (e: Exception) {
      if (!geoEnabled) throw e
      // never lose AR over Geospatial: run without it
      Log.w(TAG, "Geospatial configure failed, continuing without it", e)
      geoEnabled = false
      cfg.geospatialMode = Config.GeospatialMode.DISABLED
      s.configure(cfg)
    }
  }

  fun destroy() {
    destroyed = true
    main.removeCallbacksAndMessages(null)
    ops.clear()
    while (true) failSave(pendingSaves.poll() ?: break, "AR view closed before the map was saved")
    // Free textures and detach anchors on the GL thread *before* the session closes under them.
    // If the GL thread is already gone the latch times out and Session.close() frees them anyway.
    val released = CountDownLatch(1)
    glView.queueEvent {
      try { for (q in quads.values) q.release(); quads.clear() } finally { released.countDown() }
    }
    try { released.await(500, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) {}
    stop()
    session?.close()
    session = null
  }

  private fun failSave(promise: Promise?, message: String) {
    if (promise == null) return
    pendingSaves.remove(promise)
    promise.reject("E_WORLDMAP", message, null)
  }

  // ---- props / functions from JS ----------------------------------------------------------

  fun setSpraying(value: Boolean) {
    glView.queueEvent {
      if (value == spraying) return@queueEvent
      spraying = value
      if (value) beginStroke() else flushStroke()
    }
  }

  fun setPaintColor(hex: String) {
    val clean = hex.trim().removePrefix("#")
    val parsed = colorOrNull(clean)
    colorInt = parsed ?: Color.rgb(255, 0, 255)
    colorHex = "#" + (if (parsed != null) clean.lowercase() else "ff00ff")
  }

  private fun colorOrNull(hex: String): Int? = hex.takeIf { it.length == 6 }?.toLongOrNull(16)
    ?.let { Color.rgb(((it shr 16) and 0xff).toInt(), ((it shr 8) and 0xff).toInt(), (it and 0xff).toInt()) }

  private fun colorOf(hex: String): Int = colorOrNull(hex.trim().removePrefix("#")) ?: Color.rgb(255, 0, 255)

  private fun enqueue(needsTracking: Boolean = true, gen: Int = generation.get(), onDropped: (() -> Unit)? = null, block: () -> Boolean) {
    ops.add(Op(gen, needsTracking, block, onDropped))
  }

  fun clearAll() {
    enqueue(needsTracking = false) { for (q in quads.values) q.release(); quads.clear(); stroke = null; true }
  }

  /** A fresh start for placed-from-memory: drop all paint and any loaded map. Keeps ARCore's planes and the heading lock. */
  fun resetSession() {
    val g = generation.incrementAndGet()
    enqueue(needsTracking = false, gen = g) { resetState(); activeGeneration = g; true }
  }

  private fun resetState() {
    stroke = null
    myStrokes.clear()
    for (f in resolveFutures) f.cancel()
    resolveFutures.clear()
    for (q in quads.values) q.release()
    quads.clear()
    mapState = MapState.NONE
    mapAlignment = null
    pendingResolves = 0
    aimedPlane = null
  }

  fun setWorldMapPath(path: String?) {
    if (path.isNullOrEmpty()) return
    Thread {
      val entries = WorldMapFile.read(path)
      if (entries == null) { emitTracking(mapOf("state" to "mapLoadFailed")); return@Thread }
      val g = generation.incrementAndGet()
      enqueue(needsTracking = true, gen = g) { loadMap(entries, g); activeGeneration = g; true }
    }.start()
  }

  fun saveWorldMap(path: String, promise: Promise) {
    if (session == null) return promise.reject("E_WORLDMAP", "AR session not running", null)
    if (!cloudEnabled) return promise.reject("E_WORLDMAP", "Cloud Anchors not configured (no ARCORE_AUTH=keyless or ARCORE_API_KEY at build time)", null)
    val deadline = SystemClock.elapsedRealtime() + SAVE_TIMEOUT_MS
    var started = false
    pendingSaves.add(promise)
    enqueue(needsTracking = false, onDropped = { failSave(promise, "AR session reset before the map was saved") }) {
      val now = SystemClock.elapsedRealtime()
      if (!started) {
        if (!tracking && now < deadline) return@enqueue false
        started = true
        if (tracking) hostUnhostedQuads()
      }
      if (quads.values.any { it.hosting != null } && now < deadline) return@enqueue false
      pendingSaves.remove(promise)
      finishSave(path, promise)
      true
    }
  }

  /**
   * Takes back your most recent stroke in this session: its quad is repainted from the strokes that
   * remain, so other people's paint over the top survives. Resolves the stroke id for the app to
   * drop from the shared wall, or null when you have nothing left to undo here.
   */
  fun undoLast(promise: Promise) {
    enqueue(needsTracking = false, onDropped = { promise.resolve(null) }) {
      var result: Map<String, Any>? = null
      while (result == null && myStrokes.isNotEmpty()) {
        val (quadId, strokeId) = myStrokes.removeAt(myStrokes.size - 1)
        val q = quads[quadId] ?: continue
        if (!q.remove(strokeId)) continue
        q.upload(SystemClock.elapsedRealtime(), force = true)
        result = mapOf("id" to strokeId, "anchorId" to quadId)
      }
      promise.resolve(result)
      true
    }
  }

  /**
   * A photo of the wall as you're seeing it: the camera frame with the paint composited on top,
   * written to [path] as JPEG. The reticle and the surface grids are left out of that frame, so it
   * looks like a picture of the piece rather than a screenshot of the app.
   */
  fun snapshot(path: String, promise: Promise) {
    if (!running) return promise.reject("E_SNAPSHOT", "AR session not running", null)
    if (snapshotJob != null) return promise.reject("E_SNAPSHOT", "a photo is already being taken", null)
    snapshotJob = SnapshotJob(path, promise) // the next drawn frame takes it
  }

  /** Reads the frame just drawn (GL origin is bottom-left, so it comes back flipped) and writes a JPEG. */
  private fun takeSnapshot(job: SnapshotJob) {
    val w = viewportW
    val h = viewportH
    if (w <= 0 || h <= 0) return job.promise.reject("E_SNAPSHOT", "nothing drawn yet", null)
    val buf = ByteBuffer.allocateDirect(w * h * 4).order(ByteOrder.nativeOrder())
    GLES20.glReadPixels(0, 0, w, h, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, buf)
    buf.rewind()
    val raw = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    raw.copyPixelsFromBuffer(buf)
    val flip = android.graphics.Matrix().apply { postScale(1f, -1f, w / 2f, h / 2f) } // android.opengl.Matrix is the other one
    val image = Bitmap.createBitmap(raw, 0, 0, w, h, flip, true)
    raw.recycle()
    Thread {
      try {
        val file = File(job.path)
        file.parentFile?.mkdirs()
        FileOutputStream(file).use { out ->
          image.compress(Bitmap.CompressFormat.JPEG, 85, out)
          out.flush()
        }
        val bytes = file.length().toInt()
        image.recycle()
        job.promise.resolve(mapOf("width" to w, "height" to h, "bytes" to bytes))
      } catch (e: Exception) {
        job.promise.reject("E_SNAPSHOT", e.message ?: "could not write the photo", e)
      }
    }.start()
  }

  /** Strokes from other phones / previous sessions: [{id, anchorId, transform:[16], color, points:[[u,v,r,a,kind]], viewer:[3]}]. */
  fun addRemoteStrokes(raw: List<Map<String, Any?>>, mode: String) {
    val strokes = raw.mapNotNull { parseStroke(it) }
    if (strokes.isEmpty()) return
    val enqueuedAt = SystemClock.elapsedRealtime()
    enqueue(needsTracking = true) {
      // relative placement is only meaningful in the north-aligned frame: give the compass a moment
      if (mode == "relative" && !heading.locked && SystemClock.elapsedRealtime() - enqueuedAt < 5000) return@enqueue false
      placeRemote(strokes, mode)
      true
    }
  }

  // ---- GLSurfaceView.Renderer --------------------------------------------------------------

  override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
    GLES20.glClearColor(0f, 0f, 0f, 1f)
    background.create()
    planeRenderer.create()
    quadRenderer.create()
    depthTexture.create()
    cameraTextureSet = false
    for (q in quads.values) q.onContextLost()
  }

  override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
    GLES20.glViewport(0, 0, width, height)
    viewportW = width
    viewportH = height
    displayChanged = true
  }

  override fun onDrawFrame(gl: GL10?) {
    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
    val s = session ?: return
    if (!running) return
    if (displayChanged && viewportW > 0) { s.setDisplayGeometry(displayRotation, viewportW, viewportH); displayChanged = false }
    if (!cameraTextureSet) { s.setCameraTextureName(background.textureId); cameraTextureSet = true }
    val frame = try { s.update() } catch (e: Exception) { return }
    background.draw(frame)

    val camera = frame.camera
    val now = SystemClock.elapsedRealtime()
    tracking = camera.trackingState == TrackingState.TRACKING
    cameraPos = M.pos(M.fromPose(camera.pose))
    drainOps()

    if (!tracking) {
      if (now - lastHitEvent > 100) { lastHitEvent = now; emitHit(mapOf("hit" to false, "distance" to 0.0, "kind" to "none", "locked" to false)) }
      emitTrackingIfDue(camera, now)
      return
    }

    camera.getViewMatrix(viewM, 0)
    camera.getProjectionMatrix(projM, 0, 0.05f, 100f)
    Matrix.multiplyMM(viewProj, 0, projM, 0, viewM, 0)
    heading.addFrame(-M.col(M.fromPose(camera.displayOrientedPose), 2))

    updatePlanes(frame, now)
    updateGeo()
    updateQuadPoses(now)
    verifySurfaces(frame, now)

    val hit = raycastCenter(frame)
    if (hit != null) {
      val locked = hit.kind != HitKind.ESTIMATED
      val dist = cameraPos.distance(M.pos(hit.transform))
      aimedPlane = hit.plane
      if (now - lastHitEvent > 100) {
        lastHitEvent = now
        emitHit(mapOf("hit" to true, "distance" to dist.toDouble(), "kind" to hit.kind.js, "vertical" to hit.vertical, "locked" to locked))
      }
      if (spraying && now - lastTick >= 33) { lastTick = now; paintAt(hit, now) }
    } else {
      aimedPlane = null
      if (now - lastHitEvent > 100) { lastHitEvent = now; emitHit(mapOf("hit" to false, "distance" to 0.0, "kind" to "none", "locked" to false)) }
    }

    for (q in quads.values) q.upload(now)
    if (depthEnabled && occlusion) depthTexture.update(frame, now)
    val job = snapshotJob
    if (job != null) snapshotJob = null
    drawScene(hit, now, overlays = job == null)
    if (job != null) takeSnapshot(job)
    emitTrackingIfDue(camera, now)
  }

  private fun drainOps() {
    repeat(ops.size) {
      val op = ops.poll() ?: return
      if (op.gen < activeGeneration) { op.onDropped?.invoke(); return@repeat }
      if (op.needsTracking && !tracking) { ops.add(op); return@repeat }
      val done = try { op.block() } catch (e: Exception) { Log.w(TAG, "op failed", e); true }
      if (!done) ops.add(op)
    }
  }

  private fun drawScene(hit: Hit?, now: Long, overlays: Boolean = true) {
    if (showPlanes && overlays) {
      planeRenderer.begin()
      for ((p, seen) in planes) {
        if (p.trackingState != TrackingState.TRACKING || p.subsumedBy != null) continue
        // don't draw a grid on something the reticle refuses to paint — a ceiling reads as a target
        if (p.type == Plane.Type.HORIZONTAL_DOWNWARD_FACING) continue
        // Nor on a surface you are behind. Nothing here writes depth, so a grid cannot be occluded
        // by the thing in front of it: the far face of a pillar would draw straight over the near
        // one, reading as a grid hovering off the surface rather than lying on it. The hit test
        // has always rejected these planes; the overlay was still drawing them.
        if (((cameraPos - planeCenter(p)) dot planeNormal(p)) <= 0f) continue
        val fade = min(1f, (now - seen) / 350f)
        val opacity = (if (p == aimedPlane) 0.55f else 0.16f) * fade
        planeRenderer.draw(viewProj, M.fromPose(p.centerPose), p.polygon, p.type == Plane.Type.VERTICAL, opacity)
      }
    }
    quadRenderer.beginPaint(if (depthEnabled && occlusion) depthTexture else null, viewportW, viewportH)
    // q.missing: the surface this was painted on has been carried off, so the paint goes with it
    for (q in quads.values) if (q.placed && !q.missing) quadRenderer.drawPaint(viewProj, viewM, q)
    if (hit != null && overlays) {
      val t = hit.transform
      val n = M.col(t, 1).normalized()
      // Scale with distance so the reticle keeps one apparent size on screen. This used to be
      // capped at 3, i.e. 2.4 m, past which the world size froze and the thing shrank away with
      // range — at eight metres it was a third of the size it should be, which is exactly when
      // you most need to see where you are pointing. The remaining limits only stop it swelling
      // absurdly when pressed against a wall or aimed across a car park.
      val scale = max(0.45f, min(14f, cameraPos.distance(M.pos(t)) / 0.8f))
      val m = M.withPos(t, M.pos(t) + n * 0.006f)
      for (i in 0..10) if (i % 4 != 3) m[i] *= scale
      quadRenderer.drawReticle(viewProj, m, hit.kind != HitKind.ESTIMATED)
    }
  }

  // ---- planes + anchors --------------------------------------------------------------------

  private fun planeNormal(p: Plane) = M.col(M.fromPose(p.centerPose), 1).normalized()
  private fun planeCenter(p: Plane) = M.pos(M.fromPose(p.centerPose))

  private fun updatePlanes(frame: Frame, now: Long) {
    for (p in frame.getUpdatedTrackables(Plane::class.java)) {
      if (p.subsumedBy != null || p.trackingState == TrackingState.STOPPED) {
        // merged into another plane: quads go back to "unbound" and re-adopt the survivor
        if (planes.remove(p) != null) {
          if (aimedPlane == p) aimedPlane = null
          for (q in quads.values) if (q.plane == p) { q.plane = null; attachLooseToNearbyPlane(q) }
        }
        continue
      }
      if (p.trackingState != TrackingState.TRACKING) continue
      // the lowest upward-facing plane is the floor; everything raised above it might be furniture
      if (p.type == Plane.Type.HORIZONTAL_UPWARD_FACING) {
        val y = planeCenter(p).y
        if (floorY.isNaN() || y < floorY) floorY = y
      }
      val isNew = !planes.containsKey(p)
      if (isNew) planes[p] = now
      // ARCore refines a plane's depth/tilt for a while after it appears: keep our quads on it
      for (q in quads.values) {
        if (!q.placed) continue
        if (q.plane == p) { if (!isNew) snap(q, p, now) } else tryAdopt(q, p, now)
      }
    }
  }

  private var lastPoseUpdate = 0L

  /**
   * Follow the anchors, but not slavishly. See [M.settle] for why: paint bolted to a floor should
   * not shimmer because ARCore is still making up its mind about where the floor is.
   *
   * A STOPPED anchor used to leave the quad holding its last transform forever. That transform is
   * expressed in a world frame ARCore has since abandoned, so the piece would sit at coordinates
   * that no longer mean anything — which is how paint ends up somewhere else after you leave the
   * tab and come back. Re-anchoring at the same apparent place puts it back in the live frame,
   * and clearing the plane lets it re-adopt whatever surface is really there now.
   */
  private fun updateQuadPoses(now: Long) {
    val dt = (now - lastPoseUpdate).coerceIn(0, 100) / 1000f
    lastPoseUpdate = now
    // exponential ease, frame-rate independent
    val k = if (dt <= 0f) 1f else 1f - kotlin.math.exp(-dt / POSE_EASE_TAU)
    for (q in quads.values) {
      val a = q.anchor ?: continue
      when (a.trackingState) {
        TrackingState.TRACKING -> {
          val m = M.fromPose(a.pose)
          val target = q.anchorOffset?.let { M.mul(m, it) } ?: m
          q.transform = M.settle(q.transform, target, k, POSE_DEADBAND_M, POSE_DEADBAND_RAD, POSE_JUMP_M)
        }
        TrackingState.STOPPED -> {
          q.anchor = null
          if (q.placed) {
            q.plane = null
            anchorQuad(q)              // same place, but expressed in the frame ARCore is using now
            attachLooseToNearbyPlane(q) // and back onto a real surface if one is there
          }
        }
        else -> {} // PAUSED: hold the last good pose rather than guess
      }
    }
  }

  /** (Re)anchor a quad at its current transform, on its plane when it has one. */
  private fun anchorQuad(q: PaintQuad) {
    val s = session ?: return
    val pose = M.toPose(q.transform)
    val old = q.anchor
    q.anchor = try {
      q.plane?.takeIf { it.trackingState == TrackingState.TRACKING }?.createAnchor(pose) ?: s.createAnchor(pose)
    } catch (e: Exception) {
      Log.w(TAG, "createAnchor failed", e); null
    }
    q.anchorOffset = null
    if (old != null && old !== q.hostAnchor) old.detach()
  }

  /**
   * A right-handed quad frame: Y = surface normal, X horizontal along the surface, −Z "up the wall"
   * (so drips run down) or north for floors. Built from the normal alone, so a quad keeps its
   * orientation when it snaps onto a plane (ARCore's in-plane plane axes are arbitrary).
   */
  private fun quadFrame(p: V3, normalIn: V3): M4 {
    var y = normalIn.normalized()
    var x: V3
    var z: V3
    if (abs(y.y) > 0.7f) { // floor / table: X = east
      if (y.y < 0) y = -y
      val east = heading.east()
      x = (east - y * (y dot east)).normalized()
      z = x cross y
    } else {
      x = (V3.UP cross y).normalized()
      z = x cross y // points down for a wall normal → −Z is up
      if (z.y > 0) { x = -x; z = -z }
    }
    return M.fromAxes(x, y, z, p)
  }

  /** Bind an estimated quad to a real plane and pull it onto that plane. */
  /** Lowest upward-facing plane seen this session — the floor, as far as we can tell. */
  private var floorY = Float.NaN

  /**
   * Small enough to be picked up and carried off, which is the only thing that justifies hiding
   * its paint when depth disagrees.
   *
   * The old test was `min(extentX, extentZ) <= 2 m`, which called most real walls furniture: a
   * vertical plane's two extents are BOTH in-plane (width along the wall, height up it), so a wall
   * panned at chest height — 4 m by 1.1 m — was "furniture-sized" and its paint became eligible to
   * vanish on a noisy depth vote. Three corrections: only upward-facing planes qualify, since a
   * wall cannot be carried off; the larger extent is tested, so a long thin strip is not furniture;
   * and it must stand clear of the floor, because the floor itself is upward-facing and starts out
   * small.
   */
  private fun isFurniture(p: Plane?): Boolean {
    if (p == null || p.type != Plane.Type.HORIZONTAL_UPWARD_FACING) return false
    if (max(p.extentX, p.extentZ) > FURNITURE_MAX_M) return false
    if (floorY.isNaN()) return false
    return planeCenter(p).y - floorY > FURNITURE_MIN_RISE_M
  }

  private fun adopt(q: PaintQuad, plane: Plane, now: Long) {
    q.plane = plane
    q.loose = false
    q.onFurniture = isFurniture(plane)
    snap(q, plane, now, force = true)
  }

  /** Move a quad onto its plane (position projected along the normal, orientation from the plane's normal). Debounced. */
  private fun snap(q: PaintQuad, plane: Plane, now: Long, force: Boolean = false) {
    // ARCore grows a plane as it sees more of it, and a wall's first patch looks like a tabletop,
    // so the furniture verdict is re-taken every time rather than latched at first contact.
    q.onFurniture = isFurniture(plane)
    if (!force && now - q.lastSnap < 700) return
    val pn = planeNormal(plane)
    val pc = planeCenter(plane)
    val c = q.center
    val off = (c - pc) dot pn
    val angle = acos((pn dot q.normal).coerceIn(-1f, 1f))
    if (!force && abs(off) <= 0.012f && angle <= Math.toRadians(2.0).toFloat()) return
    q.lastSnap = now
    // Re-project the quad's OWN in-plane axis rather than rebuilding the frame from scratch.
    // quadFrame derives a horizontal surface's X from heading.east(), and the heading is
    // provisional for the first 1.5-8 s; rebuilding here meant a tag sprayed on the floor in the
    // first seconds visibly swung about its own centre the moment the compass settled, carrying
    // every mark on the quad with it. Correcting height and tilt must not re-decide which way is
    // along the surface.
    val prevX = M.col(q.transform, 0)
    val projected = prevX - pn * (prevX dot pn)
    val x = if (projected.length > 1e-3f) projected.normalized() else M.col(quadFrame(c, pn), 0)
    q.transform = M.fromAxes(x, pn, x cross pn, c - pn * off)
    anchorQuad(q)
  }

  /** Quads without a real plane (estimated hits, or placed from memory) adopt a close, parallel plane. Loose quads accept a wider gap. */
  private fun tryAdopt(q: PaintQuad, plane: Plane, now: Long): Boolean {
    if (q.plane != null || !q.placed) return false
    // a piece placed from memory must not get pulled onto a ceiling, the one plane we never paint
    if (plane.type == Plane.Type.HORIZONTAL_DOWNWARD_FACING) return false
    val pn = planeNormal(plane)
    if ((pn dot q.normal) <= (if (q.loose) 0.94f else 0.97f)) return false // ~20° / ~14°
    val pc = planeCenter(plane)
    if (abs((q.center - pc) dot pn) >= (if (q.loose) 0.6f else 0.15f)) return false
    // and the quad must overlap the plane's known extent (in-plane distance). The allowance scales
    // with the plane for the same reason the hit-test's does: a chair seat must not reach out and
    // adopt paint that was put on the floor beside it.
    val l = M.transformPoint(M.invert(M.fromPose(plane.centerPose)), q.center)
    val dx = max(0f, abs(l.x) - plane.extentX / 2)
    val dz = max(0f, abs(l.z) - plane.extentZ / 2)
    if (hypot(dx, dz) >= min(PaintQuad.SIZE_M / 2, max(0.3f, min(plane.extentX, plane.extentZ)))) return false
    adopt(q, plane, now)
    return true
  }

  /**
   * Put a loose quad back on a surface — the nearest one that will have it.
   *
   * This used to take the first plane in `planes`, which is a LinkedHashMap, so the winner was
   * whichever ARCore happened to notice first. With a bookcase standing half a metre in front of a
   * wall, or a rug on a floor, that is a coin toss, and `adopt` force-snaps, so the piece teleports
   * up to 60 cm onto the wrong one of two parallel surfaces. It runs on plane subsumption and on
   * anchor loss, not just on load, so the coin was being tossed during ordinary tracking.
   */
  private fun attachLooseToNearbyPlane(q: PaintQuad) {
    val now = SystemClock.elapsedRealtime()
    val candidates = planes.keys
      .filter { it.trackingState == TrackingState.TRACKING && it.subsumedBy == null }
      .sortedBy { abs((q.center - planeCenter(it)) dot planeNormal(it)) }
    for (p in candidates) if (tryAdopt(q, p, now)) return
  }

  // ---- surface verification --------------------------------------------------------------

  /** The plane the reticle was on last frame; it gets a wider margin, see raycastCenter. */
  private var stickyPlane: Plane? = null
  /** Last depth-derived reticle pose, and when — depth hits are eased rather than followed raw. */
  private var meshPose: M4? = null
  private var meshAt = 0L

  private var lastVerify = 0L
  /** Pieces eligible for the check, and how many are currently hidden — reported to the debug HUD. */
  @Volatile private var watchedCount = 0
  @Volatile private var movedCount = 0
  private val viewIn = FloatArray(2)
  private val texOut = FloatArray(2)
  private val depthSamples = FloatArray(5)

  /**
   * Notice when the thing you painted has been carried off, and take the paint with it.
   *
   * ARCore assumes the world holds still. Spray a chair, push the chair away, and the anchor stays
   * where the chair was — the piece hangs in mid-air, which is the single most obviously fake
   * thing the app can do. There is no callback for it: a plane that moved is not subsumed and not
   * stopped, it simply stops describing reality, and ARCore goes on reporting it.
   *
   * The depth map is the one thing that can tell. Where the paint claims to sit, ARCore measures
   * the distance to whatever is actually in front of the camera. If that measurement comes back
   * well *behind* the paint, we are looking through the space the surface used to occupy. Hold
   * that reading and the piece is hidden — hidden, not deleted, so wheeling the chair back brings
   * the paint back with it, which is also what makes a false positive survivable.
   *
   * Deliberately timid, because depth-from-motion on a phone with no ToF sensor is noisy, and
   * paint vanishing while you are painting it would be far worse than paint floating:
   *  - only pieces on furniture-sized planes are eligible, so a wall or floor piece can never go;
   *  - evidence accrues at 5 Hz and needs ~1.2 s of agreement, while confirming evidence counts
   *    double against it, so returning is twice as easy as leaving;
   *  - the sample must sit well inside the frame and inside depth's useful range;
   *  - a five-texel median, so one dead pixel decides nothing.
   */
  private fun verifySurfaces(frame: Frame, now: Long) {
    if (!depthEnabled || now - lastVerify < VERIFY_INTERVAL_MS) return
    lastVerify = now
    watchedCount = quads.values.count { it.placed && it.onFurniture }
    movedCount = quads.values.count { it.missing }
    if (watchedCount == 0) return
    val img = try { frame.acquireDepthImage16Bits() } catch (e: Exception) { return } // usually NotYetAvailable
    try {
      val plane = img.planes[0]
      val buf = plane.buffer.order(ByteOrder.nativeOrder()).asShortBuffer()
      val stride = plane.rowStride / 2
      for (q in quads.values) {
        if (!q.placed || !q.onFurniture) {
          // No longer eligible — a wall that grew, or a quad that lost its plane. Its last verdict
          // must not stick: otherwise a piece hidden while it was briefly furniture-shaped stays
          // invisible for the rest of the session, with nothing left to ever re-examine it.
          q.missing = false
          q.missScore = 0f
          continue
        }
        val delta = depthDelta(frame, q.center, img.width, img.height, buf, stride) ?: continue
        q.missScore = (q.missScore + if (delta > DEPTH_CLEAR_MARGIN_M) 1f else -2f).coerceIn(0f, MISS_TO_HIDE)
        val missing = q.missScore >= MISS_TO_HIDE
        if (missing != q.missing) {
          q.missing = missing
          Log.i(TAG, "surface ${if (missing) "gone" else "back"}: ${q.id}")
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "depth verify failed", e)
    } finally {
      img.close()
    }
  }

  /**
   * How far the measured surface is behind this point, in metres, or null if the sample can't be
   * trusted. Positive means free space where the paint is.
   */
  private fun depthDelta(frame: Frame, p: V3, dw: Int, dh: Int, buf: java.nio.ShortBuffer, stride: Int): Float? {
    val m = viewProj
    val cw = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15]
    if (cw <= 0f) return null // behind the camera
    val ndcX = (m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12]) / cw
    val ndcY = (m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13]) / cw
    if (abs(ndcX) > 0.7f || abs(ndcY) > 0.7f) return null // edges are where depth is worst

    // The depth map measures along the camera axis, not along the ray, so compare like with like.
    val paintZ = -(viewM[2] * p.x + viewM[6] * p.y + viewM[10] * p.z + viewM[14])
    if (paintZ < DEPTH_NEAR_M || paintZ > DEPTH_FAR_M) return null

    viewIn[0] = (ndcX * 0.5f + 0.5f) * viewportW
    viewIn[1] = (0.5f - ndcY * 0.5f) * viewportH // GL is y-up, the view is y-down
    try {
      frame.transformCoordinates2d(Coordinates2d.VIEW, viewIn, Coordinates2d.TEXTURE_NORMALIZED, texOut)
    } catch (e: Exception) { return null }
    val tx = (texOut[0] * dw).toInt()
    val ty = (texOut[1] * dh).toInt()
    if (tx < 1 || ty < 1 || tx >= dw - 1 || ty >= dh - 1) return null

    var n = 0
    for (i in 0 until 5) {
      val raw = buf.get((ty + CROSS_Y[i]) * stride + (tx + CROSS_X[i])).toInt() and 0xFFFF
      // Low 13 bits are millimetres. There was a confidence test on the top 3 bits here and it was
      // wrong whichever way DEPTH16 is read: under Android's convention 0 means *full* confidence,
      // so it threw away the best texels and took the median of the worst; and if ARCore leaves
      // those bits clear, it rejected every sample and the whole check silently never ran.
      val mm = raw and 0x1FFF
      if (mm == 0) continue
      depthSamples[n++] = mm / 1000f
    }
    if (n < 3) return null
    java.util.Arrays.sort(depthSamples, 0, n)
    return depthSamples[n / 2] - paintZ
  }

  // ---- hit testing -----------------------------------------------------------------------

  /**
   * Real planes only, and only the two kinds you can paint: floors and walls. A detected polygon
   * first, then the extension of a known plane, so a whole wall is paintable once any patch of it
   * is found.
   *
   * There used to be a third pass taking ARCore's DepthPoint and feature-point hits. On a phone
   * with no time-of-flight sensor the depth map is inferred from motion, so those hits land on
   * people, glass, the back of a chair — anything with parallax — and `locked` counted them as a
   * surface. That is how the reticle came to read "0.5 M FROM THE SURFACE" while aimed down a
   * corridor, and why paint went onto things that are not walls. A point is not a plane: if ARCore
   * hasn't resolved actual geometry we now report no hit, and the HUD says "aim at a wall or
   * floor" instead of lying. The iPhone keeps its equivalent fallback because on a LiDAR device
   * that mesh is measured rather than guessed.
   *
   * Depth stays enabled in the session config — ARCore uses it to find planes on surfaces too
   * blank to yield feature points, which is exactly the wall this is meant to work on.
   */
  private fun raycastCenter(frame: Frame): Hit? {
    if (viewportW == 0) return null
    val hits = try { frame.hitTest(viewportW / 2f, viewportH / 2f) } catch (e: Exception) { return null }
    // A ceiling is a plane you can neither reach nor meant to paint; ARCore calls it downward-facing.
    fun paintable(p: Plane) = p.type == Plane.Type.VERTICAL || p.type == Plane.Type.HORIZONTAL_UPWARD_FACING
    /**
     * How far past its seen edge a plane may still be painted, along one of its own axes. Per
     * axis, not one radius, because a plane's two extents mean different things: ARCore usually
     * finds a wall as a wide, short strip, and an isotropic margin derived from the short side
     * then refuses the rest of the wall you can plainly see gridded in front of you. Scaling each
     * axis by its own extent keeps a chair seat chair-sized while letting a wall extend along
     * itself.
     *
     * `sticky` widens it for the plane the reticle was already on. Extents and centre are
     * re-estimated every frame, so a fixed boundary makes the reticle blink on and off at the
     * edge and chops a stroke into dashes; the surface you are already painting gets the benefit
     * of the doubt.
     */
    fun allowance(extent: Float, sticky: Boolean) =
      min(0.9f, max(0.06f, 0.3f * extent)) * (if (sticky) 1.6f else 1f)
    // Not `> 0f`: hitPos is on the plane, so this is the camera's signed distance to it, and
    // leaning in to 5 cm on a blank wall lets ARCore's own depth error push it negative — the
    // reticle would die while the plane grid was still being drawn under it.
    fun usable(p: Plane, hitPos: V3) =
      p.trackingState == TrackingState.TRACKING && p.subsumedBy == null && paintable(p) &&
        ((cameraPos - hitPos) dot planeNormal(p)) > -0.03f

    // One pass, in ARCore's order, which is nearest first — two passes (every polygon hit, then
    // every extension) meant a far plane always beat a near one, so aiming at a chair seat whose
    // ragged polygon just missed sent the reticle to the floor two metres behind it.
    //
    // But "nearest wins" alone is too greedy in the other direction: draw a line off a table edge
    // and down onto the floor, and the table's extension — which is nearer than the floor — keeps
    // winning for as long as it is in range, so the line hangs at table height before dropping.
    //
    // So the extension is split in two. A few centimetres past the edge is polygon raggedness, and
    // that beats anything behind it. Further out is a guess, held only as a fallback: if some
    // farther plane reports a real polygon hit, that is a surface actually there and it wins.
    //
    // "Close behind" is the whole rule, and it is a distance rather than a kind of surface: the
    // floor metres past a wall does not take over, so a wall stays paintable from one patch, while
    // the next face of a pillar or the floor under a table edge does, because it is right there.
    // Two things can be held while scanning on: `edge`, a hit just past a ragged polygon but still
    // inside the surface's real extent, and `guess`, a hit genuinely out beyond it.
    var edge: Hit? = null
    var edgeDist = 0f
    var guess: Hit? = null
    var guessDist = 0f
    for (h in hits) {
      val p = h.trackable as? Plane ?: continue
      val t = M.fromPose(h.hitPose)
      val pos = M.pos(t)
      if (!usable(p, pos)) continue
      val sticky = p === stickyPlane
      val dist = cameraPos.distance(pos)

      if (p.isPoseInPolygon(h.hitPose)) {
        // Real geometry, so it outranks a held extension — but not unconditionally.
        val held = edge ?: guess
        val takesOver = when {
          held == null -> true
          // Still inside the near surface, just outside its ragged outline. Only a surface facing
          // a different way takes over, because that is a corner. A parallel one close behind is
          // the floor showing through a gap in a chair seat's polygon, and following it there is
          // what used to throw the reticle to the floor mid-stroke.
          edge != null -> dist - edgeDist <= HANDOVER_M &&
            (held.plane?.let { abs(planeNormal(p) dot planeNormal(it)) < PERPENDICULAR_DOT } ?: true)
          // Genuinely past the edge, so any real surface close behind wins, parallel or not: the
          // floor under a table edge, or the next face of a pillar.
          else -> dist - guessDist <= HANDOVER_M
        }
        if (!takesOver) break
        stickyPlane = p
        return Hit(t, p, HitKind.PLANE, p.type == Plane.Type.VERTICAL || M.isVertical(t))
      }

      // Grazing extensions are the pillar problem. Sweeping round a corner, the face you have
      // just left is seen edge-on, and its invisible continuation lies right across the face you
      // are now aiming at. Anything met this obliquely is not what the reticle is pointed at, and
      // its hit position is wildly sensitive to a millimetre of plane error, which is what makes
      // the paint stutter at a corner instead of turning it.
      if (abs(((pos - cameraPos).normalized()) dot planeNormal(p)) < EXTENSION_MIN_INCIDENCE) continue

      val l = M.transformPoint(M.invert(M.fromPose(p.centerPose)), pos)
      val dx = max(0f, abs(l.x) - p.extentX / 2)
      val dz = max(0f, abs(l.z) - p.extentZ / 2)
      // within a few centimetres of the edge this is polygon raggedness, not a real overshoot.
      // Held rather than returned: at a pillar corner the next face is a real surface a few
      // centimetres behind this one, and returning here handed it seven centimetres of every
      // corner, four times around.
      if (hypot(dx, dz) < EDGE_SLOP_M * (if (sticky) 1.5f else 1f)) {
        if (edge == null) {
          edge = Hit(t, p, HitKind.EXTENDED, p.type == Plane.Type.VERTICAL || M.isVertical(t))
          edgeDist = dist
        }
      } else if (guess == null && (dx / allowance(p.extentX, sticky)).let { it * it } +
          (dz / allowance(p.extentZ, sticky)).let { it * it } < 1f) {
        guess = Hit(t, p, HitKind.EXTENDED, p.type == Plane.Type.VERTICAL || M.isVertical(t))
        guessDist = dist
      }
    }
    val best = edge ?: guess
    if (best != null) {
      stickyPlane = best.plane
      return best
    }

    // Nothing here has a plane. A wall in one flat colour gives ARCore almost no features to fit
    // one to, and depth-from-motion is itself a stereo match, so it can go a long time with no
    // plane at all — and refusing everything else meant the commonest surface in the building was
    // simply ignored. The depth map still has the wall, so take a depth hit as a last resort.
    //
    // Gated to keep the failure that got this removed in the first place away: back then any
    // depth point counted, so paint landed on people, glass and chair backs, and `locked` called
    // them surfaces. Now it must be oriented like a wall or a floor — anything tilted between the
    // two is something else in the room — and lie in the range depth is worth trusting. It is
    // also last, so a real plane always wins, and paint put down this way is not stranded:
    // tryAdopt binds it to a plane the moment ARCore finds one.
    for (h in hits) {
      if (h.trackable !is DepthPoint) continue
      val raw = M.fromPose(h.hitPose)
      val d = cameraPos.distance(M.pos(raw))
      if (d < DEPTH_NEAR_M || d > DEPTH_FAR_M) continue
      val vertical = M.isVertical(raw)
      val n0 = M.col(raw, 1).normalized()
      if (!vertical && n0.y < 0.75f) continue

      // A depth point has none of a plane's steadiness: on a blank wall the map is reconstructed
      // from frame to frame, so its normal and its distance both wobble, and the reticle chases
      // the wobble. Two corrections make it sit still.
      //
      // First, take the world's word over the measurement's: walls are plumb and floors are
      // level, so a wall's normal is forced horizontal and a floor's straight up. Most of the
      // visible jitter is orientation, and this removes it outright.
      val n = if (vertical) V3(n0.x, 0f, n0.z).normalized() else V3(0f, 1f, 0f)
      var t = quadFrame(M.pos(raw), n)

      // Second, ease position frame to frame, with the same dead-band-and-jump rule that stops
      // painted quads shimmering. A genuinely new aim point is a jump and arrives at once; noise
      // around a still one is ignored. Dropped if the surface has been lost for a moment, so it
      // never eases across the room from somewhere stale.
      val nowMs = SystemClock.elapsedRealtime()
      val prev = meshPose
      if (prev != null && nowMs - meshAt < 300) {
        t = M.settle(prev, t, MESH_SMOOTH_K, MESH_DEADBAND_M, MESH_DEADBAND_RAD, MESH_JUMP_M)
      }
      meshPose = t
      meshAt = nowMs

      stickyPlane = null
      return Hit(t, null, HitKind.MESH, vertical)
    }
    stickyPlane = null
    return null
  }

  // ---- Geospatial --------------------------------------------------------------------------

  private fun earth(): Earth? = if (geoEnabled) session?.earth else null

  /**
   * Keep this phone's geospatial accuracy current, and move pieces placed from memory onto the geo
   * pose their painter recorded as soon as our own fix is good enough (GEO_PLACE_*). Placed from
   * memory is metres out (GPS + compass); a VPS fix is typically well under a metre. The quad stays
   * `loose`, so it then snaps onto the real wall within 0.6 m exactly like any other.
   */
  private fun updateGeo() {
    val e = earth()
    if (e == null) { geoH = Float.NaN; geoYaw = Float.NaN; return }
    if (e.earthState != Earth.EarthState.ENABLED && geoStateLogged != e.earthState) {
      geoStateLogged = e.earthState
      Log.w(TAG, "Geospatial unavailable: ${e.earthState}") // e.g. ERROR_NOT_AUTHORIZED: see goal2.md section 2
    }
    if (e.trackingState != TrackingState.TRACKING) { geoH = Float.NaN; geoYaw = Float.NaN; return }
    val cam = e.cameraGeospatialPose
    geoH = cam.horizontalAccuracy.toFloat()
    geoYaw = cam.orientationYawAccuracy.toFloat()
    if (!(geoH <= GEO_PLACE_MAX_H_M && geoYaw <= GEO_PLACE_MAX_YAW_DEG)) return
    for (q in quads.values) {
      val g = q.geo ?: continue
      if (q.geoPlaced || !q.placed || q.cloudId != null) continue
      val a = try { e.createAnchor(g.lat, g.lng, g.alt, g.q[0], g.q[1], g.q[2], g.q[3]) } catch (ex: Exception) {
        Log.w(TAG, "geo anchor failed for ${q.id}", ex); q.geoPlaced = true; continue
      }
      if (a.trackingState != TrackingState.TRACKING) { a.detach(); continue } // try again next frame
      q.geoPlaced = true
      if (q.anchor != null && q.anchor !== q.hostAnchor) q.anchor?.detach()
      q.anchor = a
      q.anchorOffset = null
      q.transform = M.fromPose(a.pose)
      q.plane = null
      q.loose = true
      attachLooseToNearbyPlane(q)
      emitSurface(mapOf("id" to q.id, "count" to quads.size, "restored" to true))
    }
  }

  /** The quad's pose on Earth, for sharing with a stroke, only when this phone's fix is good enough to be worth keeping. */
  private fun geoOf(q: PaintQuad): Map<String, Any>? {
    val e = earth() ?: return null
    if (e.trackingState != TrackingState.TRACKING) return null
    if (!(geoH <= GEO_RECORD_MAX_H_M && geoYaw <= GEO_RECORD_MAX_YAW_DEG)) return null
    val g = try { e.getGeospatialPose(M.toPose(q.transform)) } catch (ex: Exception) { return null }
    return mapOf(
      "lat" to g.latitude, "lng" to g.longitude, "alt" to g.altitude,
      "q" to g.eastUpSouthQuaternion.map { it.toDouble() },
      "hAcc" to geoH.toDouble(), "yawAcc" to geoYaw.toDouble(),
    )
  }

  private fun geoLabel(): String = when {
    !geoEnabled -> "off"
    geoH.isNaN() -> "searching"
    else -> "±%.1fm ±%.0f°".format(geoH, geoYaw)
  }

  // ---- paint loop --------------------------------------------------------------------------

  private fun beginStroke() {
    lastTick = 0
    stroke = null // created lazily on first hit so the anchor is the surface we actually hit
  }

  private fun flushStroke() {
    val s = stroke ?: return
    stroke = null
    val q = quads[s.quadId] ?: return
    if (s.points.isEmpty()) return
    q.record(PaintQuad.Painted(s.id, colorOf(s.color), s.points.map { p -> FloatArray(p.size) { i -> p[i].toFloat() } }))
    myStrokes.add(q.id to s.id)
    q.upload(SystemClock.elapsedRealtime(), force = true)
    val body = mapOf(
      "id" to s.id,
      "anchorId" to q.id,
      "transform" to M.flatten(M.mul(heading.toNorth(), q.transform)),
      "color" to s.color,
      "points" to s.points.toList(),
      "viewer" to s.viewer,
    )
    val geo = geoOf(q)
    emitStrokeEnd(if (geo != null) body + ("geo" to geo) else body)
  }

  /** Pick the quad for a hit: one on the same plane containing the point, else any coplanar one, else a new one. */
  private fun quadFor(hit: Hit, now: Long): PaintQuad {
    val p = M.pos(hit.transform)
    val n = M.col(hit.transform, 1).normalized()
    // `missing` quads are excluded throughout: they are not drawn, so painting into one means
    // spraying at a surface, seeing nothing appear, and shipping the stroke to everyone else
    // anyway. Better to start a fresh quad on the surface that is actually there.
    hit.plane?.let { plane ->
      for (q in quads.values) {
        if (!q.placed || q.missing || q.plane != plane) continue
        val l = q.local(p)
        if (l.d < 0.08f && q.contains(l.u, l.v)) return q
      }
    }
    for (q in quads.values) {
      if (!q.placed || q.missing) continue
      // A quad is 5 m across, so proximity alone joins things that are not the same surface: two
      // chairs of the same height side by side, a counter and its island, a doorsill and the
      // floor. If both this hit and this quad know which plane they are on and they disagree,
      // they are different surfaces however close they look.
      if (hit.plane != null && q.plane != null && q.plane !== hit.plane) continue
      val l = q.local(p)
      if (l.d < 0.08f && q.contains(l.u, l.v) && (n dot q.normal) > 0.95f) {
        if (q.plane == null && hit.plane != null) adopt(q, hit.plane, now) // estimated quad meets its real wall
        return q
      }
    }
    // "paint-a-" marks quads made on Android, so each platform knows whose saved map a stroke belongs to
    val id = "paint-a-" + UUID.randomUUID().toString().lowercase()
    val q = PaintQuad(id, quadFrame(p, hit.plane?.let { planeNormal(it) } ?: n))
    q.plane = hit.plane
    q.onFurniture = isFurniture(hit.plane)
    quads[id] = q
    anchorQuad(q)
    emitSurface(mapOf("id" to id, "count" to quads.size, "kind" to hit.kind.js))
    return q
  }

  /**
   * One spray tick. Dwelling on a spot used to start a drip; paint now stays where it was sprayed
   * and only builds up, which is what you want when you're actually trying to draw something.
   */
  private fun paintAt(hit: Hit, now: Long) {
    val q = quadFor(hit, now)
    var s = stroke
    if (s == null || s.quadId != q.id) {
      flushStroke()
      val id = UUID.randomUUID().toString().lowercase()
      val viewer = M.transformPoint(heading.toNorth(), cameraPos)
      s = StrokeRec(id, q.id, mutableListOf(), SplitMix(id), colorHex, viewer.toList())
      stroke = s
    }
    val l = q.local(M.pos(hit.transform))
    val f = flow
    val r = radius * (0.85f + 0.3f * f)
    val a = 0.28f * f
    q.dab(l.u, l.v, r, a, colorInt, s.rng)
    s.points.add(listOf(l.u.toDouble(), l.v.toDouble(), r.toDouble(), a.toDouble(), 0.0))
  }

  // ---- remote strokes ----------------------------------------------------------------------

  private class RemoteStroke(val id: String, val anchorId: String, val transform: M4, val color: Int, val points: List<FloatArray>, val viewer: V3?, val geo: GeoPose?)

  private fun parseStroke(m: Map<String, Any?>): RemoteStroke? {
    val id = m["id"] as? String ?: return null
    val anchorId = m["anchorId"] as? String ?: return null
    val tf = M.unflatten(m["transform"]) ?: return null
    val hex = (m["color"] as? String)?.trim()?.removePrefix("#") ?: return null
    val color = colorOf(hex)
    val pts = (m["points"] as? List<*>)?.mapNotNull { p -> (p as? List<*>)?.mapNotNull { (it as? Number)?.toFloat() }?.toFloatArray()?.takeIf { it.size >= 4 } } ?: return null
    val viewer = (m["viewer"] as? List<*>)?.mapNotNull { (it as? Number)?.toFloat() }?.takeIf { it.size == 3 }?.let { V3(it[0], it[1], it[2]) }
    return RemoteStroke(id, anchorId, tf, color, pts, viewer, parseGeo(m["geo"]))
  }

  private fun parseGeo(raw: Any?): GeoPose? {
    val g = raw as? Map<*, *> ?: return null
    val lat = (g["lat"] as? Number)?.toDouble() ?: return null
    val lng = (g["lng"] as? Number)?.toDouble() ?: return null
    val alt = (g["alt"] as? Number)?.toDouble() ?: return null
    val q = (g["q"] as? List<*>)?.mapNotNull { (it as? Number)?.toFloat() }?.takeIf { it.size == 4 } ?: return null
    if (!lat.isFinite() || !lng.isFinite() || !alt.isFinite()) return null
    return GeoPose(lat, lng, alt, q.toFloatArray())
  }

  /**
   * mode "absolute": transforms are in the frame of the loaded map (aligned once one of its anchors
   * resolves) or, with no map, this session's own north frame. mode "relative": no shared map —
   * place each quad at its offset from where the painter stood, relative to the camera now (valid
   * because both frames are north-aligned); real planes then pull it in.
   */
  private fun placeRemote(strokes: List<RemoteStroke>, mode: String) {
    val now = SystemClock.elapsedRealtime()
    val fromNorth = heading.fromNorth()
    val camNorth = M.transformPoint(heading.toNorth(), cameraPos)
    for (s in strokes) {
      var q = quads[s.anchorId]
      if (q == null) {
        when {
          mode == "relative" -> {
            val viewer = s.viewer ?: continue
            val placedNorth = M.withPos(s.transform, camNorth + (M.pos(s.transform) - viewer))
            q = PaintQuad(s.anchorId, M.mul(fromNorth, placedNorth)).also { it.loose = true }
          }
          mapState == MapState.RESOLVING && mapAlignment == null -> {
            // part of the piece being resolved, but not in the saved map: place it when the map aligns
            q = PaintQuad(s.anchorId, M.identity()).also { it.placed = false; it.savedNorth = s.transform }
          }
          mapAlignment != null -> q = PaintQuad(s.anchorId, M.mul(mapAlignment!!, s.transform)).also { it.loose = true }
          else -> q = PaintQuad(s.anchorId, M.mul(fromNorth, s.transform))
        }
        // only a piece placed from memory is waiting for a better position; one resolved from a
        // saved map already has it
        if (mode == "relative") q.geo = s.geo
        quads[s.anchorId] = q
        if (q.placed) { anchorQuad(q); if (q.loose) attachLooseToNearbyPlane(q) }
      }
      q.add(PaintQuad.Painted(s.id, s.color, s.points))
      q.upload(now, force = true)
    }
  }

  // ---- Cloud Anchor "world map" ------------------------------------------------------------

  private fun loadMap(entries: List<WorldMapFile.Entry>, g: Int) {
    resetState()
    val s = session ?: return
    for (e in entries) {
      val q = PaintQuad(e.id, M.identity())
      q.placed = false
      q.savedNorth = e.north
      q.savedOffset = e.offset
      q.cloudId = e.cloudId
      quads[e.id] = q
      val cloudId = e.cloudId ?: continue
      if (!cloudEnabled) continue
      try {
        pendingResolves++
        resolveFutures.add(s.resolveCloudAnchorAsync(cloudId) { anchor, state ->
          enqueue(needsTracking = false, gen = g) { onResolved(e.id, anchor, state == Anchor.CloudAnchorState.SUCCESS); true }
        })
      } catch (ex: Exception) {
        pendingResolves--
        Log.w(TAG, "resolve failed to start", ex)
      }
    }
    if (pendingResolves == 0) {
      mapState = MapState.FAILED
      emitTracking(mapOf("state" to "mapLoadFailed"))
      return
    }
    mapState = MapState.RESOLVING
    emitTracking(mapOf("state" to "mapLoaded", "anchors" to entries.size))
  }

  private fun onResolved(id: String, anchor: Anchor?, ok: Boolean) {
    pendingResolves--
    val q = quads[id]
    if (ok && anchor != null && q != null) {
      if (q.anchor != null && q.anchor !== q.hostAnchor) q.anchor?.detach() // provisional placement
      q.hostAnchor = anchor
      q.anchor = anchor
      q.anchorOffset = q.savedOffset ?: M.identity()
      q.transform = M.mul(M.fromPose(anchor.pose), q.anchorOffset!!)
      q.loose = false
      q.placed = true
      val saved = q.savedNorth
      if (mapAlignment == null && saved != null) {
        mapAlignment = M.mul(q.transform, M.invert(saved))
        placePendingWithAlignment()
      }
      mapState = MapState.RESOLVED
      attachLooseToNearbyPlane(q)
      emitSurface(mapOf("id" to id, "count" to quads.size, "restored" to true))
    } else {
      anchor?.detach()
    }
    if (pendingResolves <= 0 && mapState == MapState.RESOLVING) {
      mapState = MapState.FAILED
      emitTracking(mapOf("state" to "mapLoadFailed"))
    }
  }

  /** The first resolved anchor tells us how the saved frame sits in ours: place everything still waiting. */
  private fun placePendingWithAlignment() {
    val align = mapAlignment ?: return
    for (q in quads.values) {
      val saved = q.savedNorth ?: continue
      if (q.placed) continue
      q.transform = M.mul(align, saved)
      q.placed = true
      q.loose = true
      anchorQuad(q)
      attachLooseToNearbyPlane(q)
    }
  }

  private fun hostUnhostedQuads() {
    val s = session ?: return
    val g = generation.get()
    for (q in quads.values) {
      if (!q.placed || q.cloudId != null || q.hosting != null) continue
      try {
        val host = s.createAnchor(M.toPose(q.transform))
        if (q.hostAnchor != null && q.hostAnchor !== q.anchor) q.hostAnchor?.detach()
        q.hostAnchor = host
        q.hosting = s.hostCloudAnchorAsync(host, hostTtlDays) { cloudId, state ->
          enqueue(needsTracking = false, gen = g) {
            q.hosting = null
            if (state == Anchor.CloudAnchorState.SUCCESS && cloudId != null) q.cloudId = cloudId
            else { Log.w(TAG, "hosting ${q.id} failed: $state"); if (q.hostAnchor !== q.anchor) q.hostAnchor?.detach(); q.hostAnchor = null }
            true
          }
        }
      } catch (e: Exception) {
        Log.w(TAG, "hosting ${q.id} failed to start", e)
      }
    }
  }

  private fun finishSave(path: String, promise: Promise) {
    val toNorth = heading.toNorth()
    val entries = quads.values.filter { it.placed }.map { q ->
      val host = q.hostAnchor
      val offset = if (q.cloudId != null && host != null && host.trackingState == TrackingState.TRACKING) {
        M.mul(M.invert(M.fromPose(host.pose)), q.transform)
      } else if (q.cloudId != null) q.anchorOffset ?: q.savedOffset else null
      WorldMapFile.Entry(q.id, if (offset != null) q.cloudId else null, offset, M.mul(toNorth, q.transform))
    }
    val hosted = entries.count { it.cloudId != null }
    if (hosted == 0) return promise.reject("E_WORLDMAP", "No Cloud Anchors could be hosted (scan the wall a little longer)", null)
    Thread {
      try {
        val bytes = WorldMapFile.write(path, entries)
        promise.resolve(mapOf("bytes" to bytes, "anchors" to hosted))
      } catch (e: Exception) {
        promise.reject("E_WORLDMAP", e.message ?: "write failed", e)
      }
    }.start()
  }

  // ---- events ------------------------------------------------------------------------------

  private fun emitTrackingIfDue(camera: Camera, now: Long) {
    if (now - lastTrackingEvent < 500) return
    var state = "normal"
    var reason = ""
    when (camera.trackingState) {
      TrackingState.STOPPED -> state = "notAvailable"
      TrackingState.PAUSED -> {
        state = "limited"
        reason = when (camera.trackingFailureReason) {
          TrackingFailureReason.NONE -> "initializing"
          TrackingFailureReason.EXCESSIVE_MOTION -> "excessiveMotion"
          TrackingFailureReason.INSUFFICIENT_FEATURES -> "insufficientFeatures"
          TrackingFailureReason.INSUFFICIENT_LIGHT -> "insufficientLight"
          TrackingFailureReason.CAMERA_UNAVAILABLE -> "cameraUnavailable"
          else -> "unknown"
        }
      }
      else -> if (mapState == MapState.RESOLVING) { state = "limited"; reason = "relocalizing" }
    }
    var mapping = ""
    if (cloudEnabled && camera.trackingState == TrackingState.TRACKING) {
      mapping = try {
        when (session?.estimateFeatureMapQualityForHosting(camera.pose)) {
          Session.FeatureMapQuality.GOOD -> "mapped"
          Session.FeatureMapQuality.SUFFICIENT -> "extending"
          Session.FeatureMapQuality.INSUFFICIENT -> "limited"
          else -> "unknown"
        }
      } catch (_: Exception) { "" }
    }
    val key = state + reason + mapping + geoLabel()
    if (key == lastTrackingKey && now - lastTrackingEvent < 2000) return
    lastTrackingKey = key
    lastTrackingEvent = now
    val planeCount = planes.keys.count { it.trackingState == TrackingState.TRACKING && it.subsumedBy == null }
    emitTracking(mapOf(
      "state" to state, "reason" to reason, "mapping" to mapping, "planes" to planeCount, "surfaces" to quads.size,
      "lidar" to false, "depth" to depthEnabled, "heading" to if (heading.locked) "ready" else "calibrating",
      "geo" to geoLabel(),
    ))
  }

  private fun emitTracking(body: Map<String, Any>) = main.post { if (!destroyed) onTracking(body) }
  /** Every hit event also carries how the moved-surface check is doing, for the debug HUD. */
  private fun emitHit(body: Map<String, Any>) =
    main.post { if (!destroyed) onHit(body + mapOf("watched" to watchedCount, "moved" to movedCount)) }
  private fun emitStrokeEnd(body: Map<String, Any>) = main.post { if (!destroyed) onStrokeEnd(body) }
  private fun emitSurface(body: Map<String, Any>) = main.post { if (!destroyed) onSurface(body) }
}
