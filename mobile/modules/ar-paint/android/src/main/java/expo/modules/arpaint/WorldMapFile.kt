package expo.modules.arpaint

import android.content.Context
import android.content.pm.PackageManager
import com.google.ar.core.ArCoreApk
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Android's stand-in for ARWorldMap. ARCore can't export its map, so a "world map" here is the
 * list of paint quads with the Cloud Anchor each one was hosted as, the quad's pose relative to
 * that anchor, and its pose in the saving session's north-aligned frame (used to place quads whose
 * own anchor didn't resolve once any one of them has). Uploaded to the same Supabase bucket as
 * `<canvas>.arcore.json`; the iPhone ignores it and vice versa.
 */
internal object WorldMapFile {
  const val FORMAT = "fresco-arcore-v1"

  data class Entry(val id: String, val cloudId: String?, val offset: M4?, val north: M4)

  fun write(path: String, entries: List<Entry>): Int {
    val arr = JSONArray()
    for (e in entries) {
      arr.put(JSONObject().apply {
        put("id", e.id)
        put("cloudId", e.cloudId ?: JSONObject.NULL)
        put("offset", e.offset?.let { floats(it) } ?: JSONObject.NULL)
        put("transform", floats(e.north))
      })
    }
    val json = JSONObject().put("format", FORMAT).put("createdAt", System.currentTimeMillis()).put("anchors", arr).toString()
    val bytes = json.toByteArray(Charsets.UTF_8)
    File(path).apply { parentFile?.mkdirs() }.writeBytes(bytes)
    return bytes.size
  }

  /** Null if the file is missing, corrupt, or not an ARCore map (e.g. an iPhone ARWorldMap). */
  fun read(path: String): List<Entry>? = try {
    val json = JSONObject(File(path).readText(Charsets.UTF_8))
    if (json.optString("format") != FORMAT) null else {
      val arr = json.getJSONArray("anchors")
      (0 until arr.length()).mapNotNull { i ->
        val o = arr.getJSONObject(i)
        val north = matrix(o.optJSONArray("transform")) ?: return@mapNotNull null
        Entry(o.getString("id"), o.optString("cloudId").takeIf { !o.isNull("cloudId") && it.isNotEmpty() }, matrix(o.optJSONArray("offset")), north)
      }
    }
  } catch (_: Exception) {
    null
  }

  private fun floats(m: M4) = JSONArray().apply { m.forEach { put(it.toDouble()) } }

  private fun matrix(a: JSONArray?): M4? {
    if (a == null || a.length() != 16) return null
    return FloatArray(16) { a.getDouble(it).toFloat() }
  }
}

internal object ArSupport {
  @Volatile private var cached: Boolean? = null

  /**
   * ARCore device support (the Google Play Services for AR app may still need installing — the
   * view asks for that). JS reads this as a module constant at import time, so the wait for a
   * transient answer is kept short and the result is cached.
   */
  fun isSupported(context: Context): Boolean = cached ?: try {
    val apk = ArCoreApk.getInstance()
    var a = apk.checkAvailability(context)
    var tries = 0
    while (a.isTransient && tries < 5) { Thread.sleep(100); a = apk.checkAvailability(context); tries++ }
    // Still checking: assume supported — the view reports notAvailable if the session can't start.
    (a.isSupported || a.isTransient).also { cached = it }
  } catch (_: Throwable) {
    false
  }

  /** How ARCore's cloud services are authorised in this build (see app.plugin.js). */
  enum class Auth { NONE, API_KEY, KEYLESS }

  fun auth(context: Context): Auth = try {
    @Suppress("DEPRECATION")
    val meta = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA).metaData
    when {
      !meta?.getString("com.google.android.ar.API_KEY").isNullOrBlank() -> Auth.API_KEY
      meta?.get("expo.modules.arpaint.KEYLESS")?.toString() == "true" -> Auth.KEYLESS
      else -> Auth.NONE
    }
  } catch (_: Exception) {
    Auth.NONE
  }

  /** Cloud Anchors / Geospatial are usable: either kind of auth is configured. */
  fun hasCloudAuth(context: Context) = auth(context) != Auth.NONE

  /** Longest Cloud Anchor lifetime ARCore allows for this auth: 365 days keyless, 1 day with an API key. */
  fun hostTtlDays(context: Context) = if (auth(context) == Auth.KEYLESS) 365 else 1
}
