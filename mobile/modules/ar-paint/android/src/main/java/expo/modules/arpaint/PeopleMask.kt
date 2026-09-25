package expo.modules.arpaint

import android.graphics.Bitmap
import android.opengl.GLES20
import android.os.SystemClock
import android.util.Log
import com.google.ar.core.Coordinates2d
import com.google.ar.core.Frame
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.segmentation.Segmentation
import com.google.mlkit.vision.segmentation.SegmentationMask
import com.google.mlkit.vision.segmentation.selfie.SelfieSegmenterOptions
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import kotlin.math.roundToInt

/**
 * Where people (and hands, arms) are on screen, as a GL texture, so paint can be hidden behind them.
 *
 * The depth map alone can't do this on a phone without a depth sensor: depth-from-motion assumes a
 * still scene and smooths over time, so a hand passing in front of a wall barely registers, and
 * anything closer than ~0.5 m is unreliable. A segmentation model looks at the colour image instead.
 *
 * Every [INTERVAL_MS] the CPU camera image is resampled straight into *view* orientation and size
 * ([W] wide, the view's aspect), so the resulting mask is indexed by view-normalised coordinates
 * with no further transform, then ML Kit's selfie segmenter (stream mode, temporally smoothed) runs
 * on a worker thread. The GL thread uploads the newest mask as a LUMINANCE texture. The mask lags
 * the camera by one inference (~30-60 ms), which reads as a slightly soft edge on fast motion.
 */
internal class PeopleMask {
  companion object {
    private const val TAG = "ArPaint"
    const val W = 128
    const val INTERVAL_MS = 66L
    /** A mask older than this is no longer where the person is: stop occluding with it. */
    const val STALE_MS = 400L
  }

  private val segmenter = Segmentation.getClient(
    SelfieSegmenterOptions.Builder().setDetectorMode(SelfieSegmenterOptions.STREAM_MODE).build()
  )
  private val worker = Executors.newSingleThreadExecutor()
  @Volatile private var busy = false
  private var lastRun = 0L
  private var bitmap: Bitmap? = null
  private var pixels = IntArray(0)
  private val corners = floatArrayOf(0f, 0f, 1f, 0f, 0f, 1f)
  private val mapped = FloatArray(6)

  // worker → GL thread handoff
  @Volatile private var pending: ByteArray? = null
  @Volatile private var pendingW = 0
  @Volatile private var pendingH = 0
  private var upload: ByteBuffer? = null

  var textureId = 0; private set
  var ready = false; private set
  private var lastMaskAt = 0L
  /** For the debug line: share of the screen the last mask called a person, and inference time. */
  @Volatile var coverage = 0f; private set
  @Volatile var latencyMs = 0L; private set
  @Volatile private var failed = false

  fun create() {
    val ids = IntArray(1)
    GLES20.glGenTextures(1, ids, 0)
    textureId = ids[0]
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textureId)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
    ready = false
    lastMaskAt = 0L
  }

  /** GL thread, every frame: start a segmentation if one is due and none is running. */
  fun offer(frame: Frame, viewW: Int, viewH: Int, now: Long) {
    if (failed || busy || now - lastRun < INTERVAL_MS || viewW <= 0 || viewH <= 0) return
    val h = (W * viewH.toFloat() / viewW).roundToInt().coerceIn(32, 512)
    val img = try { frame.acquireCameraImage() } catch (_: Exception) { return } // NotYetAvailable is normal
    try {
      frame.transformCoordinates2d(Coordinates2d.VIEW_NORMALIZED, corners, Coordinates2d.IMAGE_PIXELS, mapped)
      resample(img, h)
    } catch (e: Exception) {
      Log.w(TAG, "people mask: could not read the camera image", e)
      return
    } finally {
      img.close()
    }
    lastRun = now
    busy = true
    val started = SystemClock.elapsedRealtime()
    try {
      segmenter.process(InputImage.fromBitmap(bitmap!!, 0))
        .addOnSuccessListener(worker) { m -> publish(m, started) }
        .addOnFailureListener(worker) { e -> Log.w(TAG, "people mask: segmentation failed", e); busy = false }
    } catch (e: Exception) {
      Log.w(TAG, "people mask: segmenter unavailable, occluding with depth only", e)
      failed = true
      busy = false
    }
  }

  /** Nearest-neighbour YUV → RGB, sampled on a view-aligned grid (so rotation and crop come free). */
  private fun resample(img: android.media.Image, h: Int) {
    if (bitmap?.height != h) {
      bitmap?.recycle()
      bitmap = Bitmap.createBitmap(W, h, Bitmap.Config.ARGB_8888)
      pixels = IntArray(W * h)
    }
    val yP = img.planes[0]; val uP = img.planes[1]; val vP = img.planes[2]
    val yB = yP.buffer; val uB = uP.buffer; val vB = vP.buffer
    val yRow = yP.rowStride; val yPix = yP.pixelStride
    val uRow = uP.rowStride; val uPix = uP.pixelStride
    val vRow = vP.rowStride; val vPix = vP.pixelStride
    val iw = img.width; val ih = img.height
    // view-normalised (x, y) → image pixels = O + x·X + y·Y
    val ox = mapped[0]; val oy = mapped[1]
    val xx = mapped[2] - ox; val xy = mapped[3] - oy
    val yx = mapped[4] - ox; val yy = mapped[5] - oy
    var k = 0
    for (j in 0 until h) {
      val vy = (j + 0.5f) / h
      for (i in 0 until W) {
        val vx = (i + 0.5f) / W
        val px = (ox + vx * xx + vy * yx).toInt().coerceIn(0, iw - 1)
        val py = (oy + vx * xy + vy * yy).toInt().coerceIn(0, ih - 1)
        val y = (yB.get(py * yRow + px * yPix).toInt() and 0xff).toFloat()
        val cx = px / 2; val cy = py / 2
        val u = (uB.get(cy * uRow + cx * uPix).toInt() and 0xff) - 128f
        val v = (vB.get(cy * vRow + cx * vPix).toInt() and 0xff) - 128f
        val r = (y + 1.402f * v).toInt().coerceIn(0, 255)
        val g = (y - 0.344f * u - 0.714f * v).toInt().coerceIn(0, 255)
        val b = (y + 1.772f * u).toInt().coerceIn(0, 255)
        pixels[k++] = (0xff shl 24) or (r shl 16) or (g shl 8) or b
      }
    }
    bitmap!!.setPixels(pixels, 0, W, 0, 0, W, h)
  }

  /** Worker thread: foreground confidence (0..1 floats) → bytes, handed to the GL thread. */
  private fun publish(m: SegmentationMask, started: Long) {
    try {
      val buf = m.buffer.order(ByteOrder.nativeOrder())
      buf.rewind()
      val n = m.width * m.height
      val out = ByteArray(n)
      var on = 0
      for (i in 0 until n) {
        val p = buf.float
        if (p > 0.5f) on++
        out[i] = (p * 255f).toInt().coerceIn(0, 255).toByte()
      }
      coverage = on.toFloat() / n
      pendingW = m.width
      pendingH = m.height
      pending = out
      latencyMs = SystemClock.elapsedRealtime() - started
    } finally {
      busy = false
    }
  }

  /** GL thread: upload the newest mask, and say whether there's a fresh one to occlude with. */
  fun upload(now: Long) {
    val p = pending
    if (p != null) {
      pending = null
      val buf = upload?.takeIf { it.capacity() >= p.size } ?: ByteBuffer.allocateDirect(p.size).also { upload = it }
      buf.clear(); buf.put(p); buf.flip()
      GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textureId)
      GLES20.glPixelStorei(GLES20.GL_UNPACK_ALIGNMENT, 1)
      GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_LUMINANCE, pendingW, pendingH, 0, GLES20.GL_LUMINANCE, GLES20.GL_UNSIGNED_BYTE, buf)
      GLES20.glPixelStorei(GLES20.GL_UNPACK_ALIGNMENT, 4)
      lastMaskAt = now
    }
    ready = lastMaskAt > 0 && now - lastMaskAt < STALE_MS
  }

  fun label(): String = when {
    failed -> "ppl ✗"
    !ready -> "ppl …"
    else -> "ppl ${(coverage * 100).roundToInt()}% ${latencyMs}ms"
  }

  fun close() {
    try { segmenter.close() } catch (_: Exception) {}
    worker.shutdown()
  }
}
