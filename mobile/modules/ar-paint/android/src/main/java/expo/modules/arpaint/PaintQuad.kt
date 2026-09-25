package expo.modules.arpaint

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.opengl.GLES20
import android.opengl.GLUtils
import com.google.ar.core.Anchor
import com.google.ar.core.HostCloudAnchorFuture
import com.google.ar.core.Plane
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * A surface painted with spray — the Android twin of PaintNode in ArPaintView.swift. One quad =
 * a 5 m × 5 m transparent square glued to an ARCore anchor, lying on a detected (or estimated)
 * surface. Dabs are composited into a 2048² bitmap, so cost is independent of how much paint is on
 * it. Coordinates (u, v) are metres in the quad's plane (u = +X, v = −Z, "up the wall"), exactly
 * what the iPhone persists, so strokes replay identically on both platforms.
 *
 * All methods run on the GL thread.
 */
/** A WGS84 pose: latitude/longitude (degrees), altitude (m, WGS84), east-up-south quaternion (x, y, z, w). */
class GeoPose(val lat: Double, val lng: Double, val alt: Double, val q: FloatArray)

class PaintQuad(val id: String, var transform: M4) {
  companion object {
    const val SIZE_M = 5f
    const val PX = 2048
    const val PX_PER_M = PX / SIZE_M
    private const val H = SIZE_M / 2
    private const val UPLOAD_INTERVAL_MS = 50L // 20 Hz, like the iPhone
  }

  data class Local(val u: Float, val v: Float, val d: Float)

  private var bitmap: Bitmap? = Bitmap.createBitmap(PX, PX, Bitmap.Config.ARGB_8888)
  private val canvas = Canvas(bitmap!!)
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }

  // GL texture mirror of the bitmap
  var texture = 0; private set
  private var dirty = true
  private var fullDirty = true
  private var dl = 0f; private var dt = 0f; private var dr = PX.toFloat(); private var db = PX.toFloat()
  private var lastUpload = 0L

  // ARCore binding
  /** Plane this quad is snapped to (null while it only rests on an estimated surface). */
  var plane: Plane? = null
  /** Anchor carrying the quad; its pose (× [anchorOffset]) is the quad's transform. */
  var anchor: Anchor? = null
  var anchorOffset: M4? = null
  /** Anchor that was hosted as a Cloud Anchor for this quad (kept even when [anchor] is re-created by snapping). */
  var hostAnchor: Anchor? = null
  var cloudId: String? = null
  var hosting: HostCloudAnchorFuture? = null
  var lastSnap = 0L
  /** Placed from memory (no shared map): allow a wider snap radius onto real planes. */
  var loose = false

  /**
   * This piece is on something that can be carried off — a chair, a box — rather than on a wall or
   * a floor. Set when the quad binds to a plane and refreshed as ARCore grows it, because a wall
   * starts out looking small. Only these are depth-checked for having moved.
   */
  var onFurniture = false
  /** Depth says there is nothing where this paint sits: the surface it was on has gone. Hidden, not deleted. */
  var missing = false
  /** Evidence for [missing], with hysteresis, so one noisy depth frame can't flick paint in and out. */
  var missScore = 0f
  /** False while waiting for a saved map to resolve: painted into, but not drawn or hit-tested. */
  var placed = true
  /** Pose in the saving session's north-aligned frame, used to place it once a saved map aligns. */
  var savedNorth: M4? = null
  /** Quad pose relative to its hosted cloud anchor, from the saved map. */
  var savedOffset: M4? = null
  /**
   * Where the painter's phone said this quad was on Earth (Geospatial API), if it knew well enough.
   * A quad placed from memory is moved here once this phone's own geospatial fix is good enough.
   */
  var geo: GeoPose? = null
  var geoPlaced = false

  val center: V3 get() = M.pos(transform)
  val normal: V3 get() = M.col(transform, 1).normalized()

  /** World point → (u, v, distance from plane) in this quad's frame. */
  fun local(world: V3): Local {
    val p = M.transformPoint(M.invert(transform), world)
    return Local(p.x, -p.z, abs(p.y))
  }

  fun contains(u: Float, v: Float) = abs(u) <= H && abs(v) <= H

  // ---- painting --------------------------------------------------------------------------
  // The spray model is written in the iPhone's CoreGraphics coordinates (origin bottom-left,
  // y up: +v is up) and converted only when drawing, so the same stroke + seed produces the same
  // speckle on both platforms.

  /**
   * Cheap spray that reads as paint rather than mist: a faint darker rim (edge darkening), a few
   * soft blobs for buildup, then a hard, nearly opaque core. Overspray is kept light so a second
   * pass covers the surface instead of hazing it.
   */
  fun dab(u: Float, v: Float, radiusM: Float, alpha: Float, color: Int, rng: SplitMix) {
    val cx = (u + H) * PX_PER_M
    val cy = (v + H) * PX_PER_M
    val r = max(2f, radiusM * PX_PER_M)
    val dark = Color.rgb((Color.red(color) * 0.72f).toInt(), (Color.green(color) * 0.72f).toInt(), (Color.blue(color) * 0.72f).toInt())

    softCircle(cx, cy, r * 0.98f, dark, alpha * 0.10f, hard = 0.35f)
    repeat(4) {
      val a = rng.next() * 2 * PI
      val d = rng.gauss() * r * 0.36
      softCircle((cx + cos(a) * d).toFloat(), (cy + sin(a) * d).toFloat(), r * 0.55f, color, alpha * (0.34f + 0.16f * rng.next().toFloat()), hard = 0.4f)
    }
    softCircle(cx, cy, r * 0.46f, color, alpha * 0.9f, hard = 0.8f)
    repeat(2) {
      val a = rng.next() * 2 * PI
      val d = r * (0.8 + rng.next() * 0.9)
      val sr = (r * (0.06 + rng.next() * 0.05)).toFloat()
      fillCircle((cx + cos(a) * d).toFloat(), (cy + sin(a) * d).toFloat(), sr, color, alpha * 0.45f)
    }
  }

  /** Every stroke composited into this texture, kept so undo can rebuild the texture without one. */
  class Painted(val id: String, val color: Int, val points: List<FloatArray>)

  private val history = mutableListOf<Painted>()

  /** Records a stroke that is already on the texture (the one you just sprayed, dab by dab). */
  fun record(p: Painted) { history.add(p) }

  /** Records and paints a stroke that isn't on the texture yet (another phone's, or a past session's). */
  fun add(p: Painted) { history.add(p); replay(p) }

  /** Seeded per stroke id, so the speckle lands identically on every phone and on every repaint. */
  private fun replay(p: Painted) {
    val rng = SplitMix(p.id)
    for (pt in p.points) {
      if (pt.size < 4) continue
      // kind 1 is a drip from an older build. Paint doesn't run any more, so it isn't drawn at all
      // (the rng still advances, so every phone skips it the same way).
      if (pt.size > 4 && pt[4] == 1f) { rng.next(); continue }
      dab(pt[0], pt[1], pt[2], pt[3], p.color, rng)
    }
  }

  /** Drops a stroke and rebuilds the texture from the ones that are left. */
  fun remove(strokeId: String): Boolean {
    val i = history.indexOfLast { it.id == strokeId }
    if (i < 0) return false
    history.removeAt(i)
    val bmp = bitmap ?: return false
    bmp.eraseColor(Color.TRANSPARENT)
    dirty = true; fullDirty = true
    dl = 0f; dt = 0f; dr = PX.toFloat(); db = PX.toFloat()
    for (p in history) replay(p)
    return true
  }

  private fun withAlpha(color: Int, a: Float) =
    Color.argb((a.coerceIn(0f, 1f) * 255f).roundToInt(), Color.red(color), Color.green(color), Color.blue(color))

  private fun softCircle(xCg: Float, yCg: Float, rIn: Float, color: Int, alpha: Float, hard: Float = 0f) {
    val c = canvas.takeIf { bitmap != null } ?: return
    val r = max(0.1f, rIn)
    val x = xCg
    val y = PX - yCg
    val inner = withAlpha(color, alpha)
    val outer = withAlpha(color, 0f)
    paint.shader = if (hard <= 0f) {
      RadialGradient(x, y, r, inner, outer, Shader.TileMode.CLAMP)
    } else {
      RadialGradient(x, y, r, intArrayOf(inner, inner, outer), floatArrayOf(0f, hard, 1f), Shader.TileMode.CLAMP)
    }
    paint.alpha = 255 // Skia multiplies shader output by the paint's alpha; fillCircle leaves a low one behind
    c.drawCircle(x, y, r, paint)
    paint.shader = null
    markDirty(x, y, r)
  }

  private fun fillCircle(xCg: Float, yCg: Float, rIn: Float, color: Int, alpha: Float) {
    val c = canvas.takeIf { bitmap != null } ?: return
    val r = max(0.1f, rIn)
    val y = PX - yCg
    paint.color = withAlpha(color, alpha)
    c.drawCircle(xCg, y, r, paint)
    markDirty(xCg, y, r)
  }

  private fun markDirty(x: Float, y: Float, r: Float) {
    if (!dirty) { dl = x - r; dt = y - r; dr = x + r; db = y + r; dirty = true; return }
    dl = min(dl, x - r); dt = min(dt, y - r); dr = max(dr, x + r); db = max(db, y + r)
  }

  // ---- GL --------------------------------------------------------------------------------

  /** Push painted pixels to the GPU, at most 20 Hz unless forced. */
  fun upload(nowMs: Long, force: Boolean = false) {
    val bmp = bitmap ?: return
    if (!dirty) return
    if (!force && nowMs - lastUpload < UPLOAD_INTERVAL_MS) return
    lastUpload = nowMs
    if (texture == 0) {
      val ids = IntArray(1)
      GLES20.glGenTextures(1, ids, 0)
      texture = ids[0]
      GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture)
      GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
      GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
      GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
      GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
      GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bmp, 0)
      dirty = false; fullDirty = false
      return
    }
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture)
    val l = dl.toInt().coerceIn(0, PX - 1)
    val t = dt.toInt().coerceIn(0, PX - 1)
    val r = (dr.toInt() + 2).coerceIn(l + 1, PX)
    val b = (db.toInt() + 2).coerceIn(t + 1, PX)
    if (fullDirty || (r - l) * (b - t) > PX * PX / 3) {
      GLUtils.texSubImage2D(GLES20.GL_TEXTURE_2D, 0, 0, 0, bmp)
    } else {
      val sub = Bitmap.createBitmap(bmp, l, t, r - l, b - t)
      GLUtils.texSubImage2D(GLES20.GL_TEXTURE_2D, 0, l, t, sub)
      sub.recycle()
    }
    dirty = false; fullDirty = false
  }

  /** The EGL context was recreated: texture ids are gone, re-upload everything on next draw. */
  fun onContextLost() {
    texture = 0
    dirty = true
    fullDirty = true
  }

  /** Free pixels + texture and detach anchors. */
  fun release() {
    if (texture != 0) GLES20.glDeleteTextures(1, intArrayOf(texture), 0)
    texture = 0
    hosting?.cancel(); hosting = null
    anchor?.detach(); anchor = null
    hostAnchor?.detach(); hostAnchor = null
    bitmap?.recycle(); bitmap = null
  }
}

/** Deterministic PRNG (SplitMix64 seeded by FNV-1a of the stroke id) — bit-identical to the iPhone's, so every phone renders the same speckle for the same stroke. */
class SplitMix(seed: String) {
  private var state: Long

  init {
    var h = 0xcbf29ce484222325UL.toLong()
    for (b in seed.toByteArray(Charsets.UTF_8)) h = (h xor (b.toLong() and 0xff)) * 0x100000001b3L
    state = h
  }

  fun next(): Double {
    state += 0x9e3779b97f4a7c15UL.toLong()
    var z = state
    z = (z xor (z ushr 30)) * 0xbf58476d1ce4e5b9UL.toLong()
    z = (z xor (z ushr 27)) * 0x94d049bb133111ebUL.toLong()
    z = z xor (z ushr 31)
    return (z ushr 11).toDouble() / (1L shl 53).toDouble()
  }

  fun gauss(): Double {
    val u = max(1e-9, next())
    val v = next()
    return (sqrt(-2 * ln(u)) * cos(2 * PI * v)).coerceIn(-2.5, 2.5)
  }
}
