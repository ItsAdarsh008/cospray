# Goal 2 — Fresco running on the Galaxy S25

**Done when:** the app is installed on your S25, the Create tab tracks real walls through ARCore,
and paint you spray there lands in the same Supabase project the iPhone uses.

The backend half is [goal1.md](goal1.md) and it's already finished, so this goal is just: get the
build onto the phone and see whether the AR holds up.

---

## Where it stands

| | |
|---|---|
| ARCore module (Kotlin, ~1,900 lines) | written, compiles, autolinked |
| PC environment variables | set (`ANDROID_HOME`, `JAVA_HOME`) |
| `android/` project + Gradle cache | generated, warm |
| Debug APK | built and current: `android\app\build\outputs\apk\debug\app-debug.apk` (101 MB, arm64) |
| Keystore SHA-1 | read out for the API-key step below |
| Branch | pushed to `origin/samsung-adarsh` |
| Emulator smoke test | boots, bundles, renders the UI, no crashes |
| **Never run on real hardware** | every AR behaviour below is unverified |

What's left needs the phone: steps 1, 3 and 4. Step 2 is optional.

## 0. The machine (already set up)

I ran these here, so they only matter on a different PC. Android Studio, the SDK and JDK 17 were
already installed:

```powershell
setx ANDROID_HOME "$env:LOCALAPPDATA\Android\Sdk"
setx JAVA_HOME "C:\Program Files\Eclipse Adoptium\jdk-17.0.15.6-hotspot"
```

`setx` only affects new terminals, so reopen yours. Gradle pulled the SDK pieces it needed while
building (Android platform 36, build-tools 36, NDK 27, CMake) into `%LOCALAPPDATA%\Android\Sdk`;
nothing else to install. `android/` and its debug keystore are generated — re-run
`npx expo prebuild -p android --no-install` only after changing `app.json`, native dependencies or
anything under `modules/`.

You'll need the S25, a USB data cable, and (for §2 only) a Google account.

## 1. Phone setup (once)

1. **Developer options:** Settings → About phone → Software information → tap **Build number**
   seven times.
2. **USB debugging:** Settings → Developer options → turn on **USB debugging**.
3. Plug the phone in with a data cable and accept **Allow USB debugging** on the phone:
   ```powershell
   adb devices        # should list your phone as "device", not "unauthorized"
   ```
4. **Google Play Services for AR:** the S25 supports ARCore but may not have the service app. The
   app asks on first opening the Create tab, or install "Google Play Services for AR" from the
   Play Store first. Without it Fresco falls back to the compass painter — no crash, just the
   older mode.

## 2. Optional: Cloud Anchors, so saved pieces come back exactly

ARCore has no equivalent of ARKit's ARWorldMap, so Android saves a piece as **Cloud Anchors**
(hosted by Google, indexed by a small JSON file in the same Supabase bucket). That's what makes a
piece re-attach to the exact wall spot when you return.

**Without a key the app still works** — it paints in AR and, on return, shows "placed from memory ·
walk to where it was painted", which snaps onto the wall once ARCore finds a plane. Same fallback
the iPhone uses when relocalisation fails. Adding the key later costs one more build.

I got one step into this for you and stopped: your Google account hasn't accepted the Google Cloud
Platform terms, and accepting an agreement on your behalf isn't something I'll do. Open
<https://console.cloud.google.com/> once, tick the terms, and either come back to me or continue:

1. Create a project (any name).
2. **APIs & Services → Library →** search **ARCore API** → **Enable**.
3. **APIs & Services → Credentials → Create credentials → API key.**
4. Restrict it: **Application restrictions → Android apps**, then add
   - package name: `com.hamzakhan.tagged`
   - SHA-1 fingerprint — read out of your keystore already:
     ```
     5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25
     ```
     That's the debug keystore Expo ships in every project, not one unique to you, so the
     restriction keeps honest apps out and little else. Fine for a demo; for anything real,
     generate your own keystore and re-read it with:
     ```powershell
     keytool -list -v -keystore android\app\debug.keystore -alias androiddebugkey -storepass android -keypass android | findstr SHA1
     ```
   Under **API restrictions**, limit it to the ARCore API.
5. Put it in `.env.local` at the repo root (gitignored, unlike `.env`):
   ```
   ARCORE_API_KEY=AIza...
   ```
6. Fold it into the manifest and rebuild:
   ```powershell
   npx expo prebuild -p android --no-install
   npx expo run:android --device
   ```

**Limitation:** an API key caps an anchor's life at **1 day**. Longer (up to a year) needs keyless
OAuth auth — a Google Cloud OAuth client plus a small Gradle dependency, worth it only if pieces
should outlive the demo:
<https://developers.google.com/ar/develop/java/cloud-anchors/developer-guide-android>

## 3. Install and run

The APK is already built, so with the phone plugged in:

```powershell
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
npx expo start --dev-client      # then open Fresco on the phone
```

Or build and install in one go — also what you want after changing native code:

```powershell
npx expo run:android --device
```

A from-scratch build takes about 10 minutes; JS changes after that just reload. Phone and PC need
to be on the same Wi-Fi; on Wi-Fi that isolates clients, use `adb reverse tcp:8081 tcp:8081` or
`--tunnel`.

Rebuild natively (not just reload) after changes under `modules/`, `targets/`, `app.json`, the
native dependencies, or adding the ARCore key.

## 4. Test it on the phone (do this, don't trust the build)

Roughly in order of what's most likely to need fixing:

1. **Boot:** app opens, onboarding appears, you can pick a tag. (It signs in anonymously against
   the project from goal 1.)
2. **Create tab:** camera preview appears; the status reads `WALL LOCKED` within a couple of
   seconds of aiming at a textured wall. With the debug HUD on it shows `compass ready` shortly
   after opening the tab, and `depth` on an S25.
3. **Spray:** hold a colour button and sweep. Paint lands on the wall, stays flat as you walk
   sideways and approach at 45°, and doesn't float. A second pass should cover, not haze.
4. **Volume rocker:** holding VOL+ / VOL− sprays, and the Samsung volume panel should *not* appear
   — the module swallows those keys while the Create tab is open. Settings has a toggle if it
   misbehaves.
5. **Undo and the wall photo:** spray, then undo — the stroke goes and the wall repaints with
   everyone else's paint intact. A few seconds after spraying, the Vault should show a photo of
   the wall (camera + paint, no reticle or grids).
6. **Leave and return:** switch tabs and back — paint keeps its place, the session resumes. Kill
   the app and reopen within 15 m: with Cloud Anchors the piece resolves; without, it says "placed
   from memory".
7. **Compass check:** paint facing a wall, then view the piece from the side. If it sits at the
   wrong angle *from a second device*, compass calibration is the suspect (§5).
8. **Cross-platform:** that's goal 1's two-client test — Android and iPhone see each other's paint
   placed from the painter's viewpoint, so stand roughly where they stood.
9. **No widgets on Android.** WidgetKit is iPhone-only; the Android build simply has none.

## 5. Known limits on Android

- **North alignment is compass-based.** ARKit hands the iPhone a true-north world frame; ARCore
  doesn't, so the module averages the compass against ARCore's yaw for the first ~2 seconds of
  tracking and then locks it. Expect a few degrees of error, more near metal, speakers or a
  laptop. It only matters for sharing paint between devices, not within your own session.
- **Depth, not LiDAR.** The S25 estimates depth from motion, so blank white walls still need a
  slow sweep; textured walls lock in a second or two.
- **Floor pieces painted in the first ~2 seconds**, before the compass locks, can rotate slightly
  when ARCore later refines the floor plane. Walls aren't affected.
- **Cloud Anchors need line-of-sight scanning.** Hosting fails if the wall was barely looked at;
  the app logs it and that piece falls back to placed-from-memory.

## 6. Troubleshooting

| What you see | What it means |
|---|---|
| Create tab shows the compass painter, not AR | Google Play Services for AR isn't installed (§1.4), or the install prompt was declined |
| `Cloud Anchors not configured` in the logs | No ARCore API key — §2, or live with placed-from-memory |
| Camera stays black on the Create tab | Camera permission denied; Settings → Apps → Fresco → Permissions |
| `adb devices` shows `unauthorized` | Accept the debugging prompt on the phone; re-plug the cable if it never appeared |
| Paint is faint or hazy | Shouldn't happen any more — a Skia paint-alpha bug that did exactly this was fixed. If you see it, say so |
| Volume keys change the volume instead of spraying | The interceptor isn't installed; toggle **Volume buttons also spray** off and on in Settings |
| Strokes don't reach the iPhone | That's the backend, not Android — [goal1.md](goal1.md) troubleshooting |

## 7. Building in the cloud instead (EAS)

```powershell
eas build -p android --profile development   # produces an installable .apk
```

- `app.json` has `"owner": "synaraapp"` and that account's EAS project id, so you need to be a
  member of that Expo account. Otherwise change `owner`, delete `extra.eas.projectId` and run
  `eas init` to make it your own.
- `.env.local` doesn't travel to the cloud: add `ARCORE_API_KEY` as an EAS environment variable
  (Expo dashboard → project → Environment variables), or put it in `eas.json` beside the Supabase
  values.

Android builds need **no** paid developer account and no Mac, unlike iOS.

## Notes

- The branch is at <https://github.com/McMuf/htn26/tree/samsung-adarsh>; later commits go up with
  a plain `git push`. It is `main` (the web app) plus the ARCore module and the Android fixes, so
  merging it into `main` would also publish the native work — merge deliberately, not by habit.
- The App Group behind the widget (`group.com.hamzakhan.tagged` in `src/lib/widget.ts`) is an Apple
  thing — Android ignores it. On iOS, building with `FRESCO_NO_WIDGET=1` (see `app.config.js`)
  drops the widget target and that entitlement, which is what a free Apple "Personal Team" account
  needs.

## What actually changed in the code

`modules/ar-paint` gained a Kotlin/ARCore implementation behind the same module interface as the
Swift one, so every screen, the spray model and the stroke format stay shared: plane detection plus
the Depth API, quads on ARCore anchors with plane snapping, a compass-derived north-aligned frame,
Cloud Anchors in place of ARWorldMap, undo and wall photos, and the volume rocker as a real
trigger. The per-platform table is in `README.md`.
