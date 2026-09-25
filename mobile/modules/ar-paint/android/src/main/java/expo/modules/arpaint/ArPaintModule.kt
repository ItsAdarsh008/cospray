package expo.modules.arpaint

import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ArPaintModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private val volumeKeys = VolumeKeys { key, down ->
    sendEvent("onVolumeKey", mapOf("key" to key, "action" to if (down) "down" else "up"))
  }

  override fun definition() = ModuleDefinition {
    Name("ArPaint")

    Constant("isSupported") { appContext.reactContext?.let { ArSupport.isSupported(it) } ?: false }
    Constant("hasLidar") { false }
    Constant("hasSnapshot") { true }
    Constant("hasUndo") { true }
    Constant("platform") { "arcore" }
    Constant("cloudAnchors") { appContext.reactContext?.let { ArSupport.hasCloudAuth(it) } ?: false }
    /** How long a hosted piece keeps its exact placement: 365 (keyless auth), 1 (API key), 0 (none). */
    Constant("anchorTtlDays") { appContext.reactContext?.let { if (ArSupport.hasCloudAuth(it)) ArSupport.hostTtlDays(it) else 0 } ?: 0 }

    Events("onVolumeKey")

    Function("setVolumeKeysIntercepted") { enabled: Boolean ->
      main.post { volumeKeys.setEnabled(appContext.currentActivity, enabled) }
    }

    OnActivityEntersBackground { main.post { volumeKeys.releaseAll() } }
    OnActivityEntersForeground { main.post { volumeKeys.reattach(appContext.currentActivity) } }

    View(ArPaintView::class) {
      Events("onTracking", "onHit", "onStrokeEnd", "onSurface")

      Prop("spraying") { view: ArPaintView, value: Boolean -> view.setSpraying(value) }
      Prop("paintColor") { view: ArPaintView, value: String -> view.setPaintColor(value) }
      Prop("radius") { view: ArPaintView, value: Double -> view.radius = value.toFloat() }
      Prop("flow") { view: ArPaintView, value: Double -> view.flow = value.toFloat() }
      Prop("showPlanes") { view: ArPaintView, value: Boolean -> view.showPlanes = value }
      Prop("occlusion") { view: ArPaintView, value: Boolean -> view.occlusion = value }
      Prop("worldMapPath") { view: ArPaintView, value: String? -> view.setWorldMapPath(value) }

      AsyncFunction("saveWorldMap") { view: ArPaintView, path: String, promise: Promise -> view.saveWorldMap(path, promise) }
      AsyncFunction("addStrokes") { view: ArPaintView, strokes: List<Map<String, Any?>>, mode: String? ->
        view.addRemoteStrokes(strokes, mode ?: "absolute")
      }
      AsyncFunction("snapshot") { view: ArPaintView, path: String, promise: Promise -> view.snapshot(path, promise) }
      AsyncFunction("undoLast") { view: ArPaintView, promise: Promise -> view.undoLast(promise) }
      AsyncFunction("clearAll") { view: ArPaintView -> view.clearAll() }
      AsyncFunction("resetSession") { view: ArPaintView -> view.resetSession() }

      OnViewDestroys { view -> view.destroy() }
    }
  }
}
