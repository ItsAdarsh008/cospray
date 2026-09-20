# Fresco — the world is your wall (formerly "Tagged")

Aim your phone like a spray can, **hold to spray** (on-screen buttons or the volume rocker), and
your paint stays on that spot for everyone who walks up to it later. Built for Hack the North
(36h MVP), Expo SDK 57, iOS dev build. Bundle id / package names still say `tagged`.

## Three surfaces, one wall

- **iPhone app** (this repo root): ARKit surface painting, glass dock shell, widget.
- **Companion site** (`web/`, live at **https://tagged-web.vercel.app**): judge-facing, read-only.
  `/` landing + globe, `/world` live map of Waterloo with every canvas's paint rendered as its
  marker (realtime), `/gallery` trending pieces + leaderboard. Same Supabase project.
- **Mobile web painter** (`/paint` on the same site): compass-anchored painting from any phone browser.

## What's real vs. stubbed (Sept 19 pass)

| Area | Status |
|---|---|
| Spray loop (shake → hold → paint on ARKit surfaces → sync) | **real**, unchanged |
| Input | **real**: two colours, one on-screen hold button each (always visible) + volume rocker in parallel (toggle in Settings). No fat/skinny caps: line width comes from the SIZE tool |
| Launch globe → tap zooms into Waterloo | **real** (Skia wireframe globe, orbiting logo; not a textured 3D earth) |
| Onboarding (handle + avatar colour + permissions, one screen) | **real**; identity = Supabase anonymous session — enable *Anonymous sign-ins* in Authentication → Providers. If it's off the same screen unfolds email + password. Avatar colour is local-only (no column) |
| Dock: Profile · Vault · **Create** · Explore · Social | **real**. The app opens on Create (the raised centre key); your side on the left, the world on the right. Market and Settings slide up as sheets from Profile (Market also from the Create tools tray) |
| Create overlay | **real**: charge rail, undo + the piece so far on the right, the two colour buttons + a tools tray (colour per button, size, opacity), one surface hint that disappears once a wall locks, one notice at a time (blockers, discovery, first-run tip). Social info (author, views, report) lives in the piece page, reached from the found card |
| Undo (Create, top right) | **real**: repaints that wall from the strokes that remain, so paint someone else put over the top survives, and deletes the row. Needs the `delete own stroke` policy (in `schema.sql` / `migration_ar.sql`) — without it the stroke stays on other phones, and the app remembers the id so it can't come back on yours |
| Profile: can status, paint gauges + refill timer, daily quests, daily stats | **real** (stats computed from locally cached strokes; streak = consecutive days with a stroke) |
| Explore: trending + nearby | **real backend data**; `src/data/mock.ts` sample spots appear only when the wall is empty (labelled "sample") |
| Social: stat card → share sheet | **real** (view snapshot → PNG → iOS share sheet). Friends / activity lists = **stubs** in `src/data/mock.ts` |
| Vault: grid of your pieces + detail (photo, location, stats) | **real**. Create photographs the wall (camera frame + paint) a few seconds after you spray and after an undo; photos live on the phone, so other people's pieces fall back to the paint rendered on a brick wall |
| Settings | real toggles (input, AR surfaces, debug line, geofence); About section static |
| Widgets (small/medium + lock screen): equipped colour swatches, paint gauges + refill countdown, streak, stats | **real** (`targets/widget`, App Group). Countdown assumes the in-app regen rate; paint only regenerates while the app is open |
| Web `/world`, `/gallery` | **real** Supabase reads + realtime; samples only when empty |

Cut this pass: Market tab, social auth, 360° viewer, friends backend, a textured 3D globe.

## Run it

```sh
npm install
# 1) backend: paste supabase/schema.sql, then supabase/migration_ar.sql (the AR columns,
#    world-map bucket and undo policy), then supabase/seed.sql, into the Supabase SQL editor.
#    Pointing the app at your own Supabase project: see deploy.md
# 2) native build onto your iPhone (once; later changes are JS-only):
npx expo run:ios --device          # or: eas build --profile development --platform ios
# 3) dev server (any port; the dev client asks for the URL / scans the QR):
npx expo start --dev-client
```

Signing: `npx expo run:ios --device` signs with the team's *development* certificate, and iOS
asks you once to trust it (Settings → General → VPN & Device Management). Your other apps skip
that because they're TestFlight builds. To skip it here too, build an **ad hoc** dev client
instead (no trust prompt, ~15 min in the cloud, Apple login on first run):

```sh
eas build --profile development --platform ios   # then install from the link/QR it prints
``` Env: `.env` holds `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_KEY`
(also baked into `eas.json` for cloud builds).

## Demo path

Open → sign in with email + password (same button creates the account) → pick a tag →
**shake the phone** (ball rattle, can charge fills) → hold **VOL+** and sweep
across a wall (hiss + haptics, paint meter drains) → hold **VOL−** for the second colour →
undo a stroke you don't like → paint runs low (hollow rattle) → walk toward a seeded
piece near E7 → shimmer/edge arrow pulls you in → it resolves from a smear into a piece →
"YOU FOUND A PIECE by …", views tick up → BOARD tab shows the leaderboard.

## AR approach: real surfaces with ARKit (and a compass fallback)

`modules/ar-paint` is a custom Expo native module (Swift, ~770 lines) wrapping `ARSCNView`. It is
our own ARKit bridge on purpose: nothing better-maintained exists for Expo, and owning it is what
lets us do plane snapping and world-map persistence.

### Detection

- `ARWorldTrackingConfiguration` with horizontal **and vertical** plane detection, `gravityAndHeading`
  alignment (north-aligned metres, so transforms mean the same thing on the web). On phones with
  LiDAR (`supportsSceneReconstruction(.mesh)`: iPhone Pro models) scene reconstruction is turned
  on and blank walls are hit-testable immediately. The base iPhone 17 has no LiDAR, so there it is
  feature-point plane detection: textured walls lock in ~1–2 s, blank white walls take longer or
  need a slow sweep.
- The reticle raycasts, in order: **detected plane geometry** (locked) → the **infinite extension of a
  detected plane** within 0.9 m of its known extent (so a whole wall is paintable once any patch of
  it is found) → **LiDAR mesh / feature-point estimate** (yellow reticle, "FINDING SURFACE…").
  Nothing hit → "AIM AT A WALL OR FLOOR".
- Feedback: detected planes fade in as a 25 cm grid (cyan = wall, lime = floor); the plane under the
  reticle brightens ("WALL LOCKED" chip). `Settings → Show detected AR surfaces` hides the grids.

### Anchoring

- Paint lives in textures: each surface gets a 5 m × 5 m transparent quad (2048² CoreGraphics
  canvas) glued to a custom `ARAnchor` in the session's world map, frame chosen so X runs along
  the wall and −Z is up (drips run down). Strokes are recorded in anchor-local metres `(u, v)`.
  ARKit owns the anchor's world pose, so paint holds its spot as you walk, approach at an angle,
  or look away — it is never billboarded or camera-relative.
- **Plane snapping** (the big fix): a quad started on an estimated surface is bound to the real
  `ARPlaneAnchor` the moment ARKit detects one that is coplanar (< 15 cm, < 14°), re-anchored onto
  it (position projected along the normal, orientation = plane's), and then follows ARKit's plane
  refinement (re-snap when it drifts > 1.2 cm or > 2°, debounced). Quads on a plane that ARKit
  merges away re-adopt the survivor. This is what stops paint floating off the wall at 45°.
- **Across tabs**: the AR view stays mounted; leaving Create pauses the session and returning
  *resumes* it (no reset), so in-session anchors survive tab switches.
- **Across app restarts** (what survives): after you paint, the session's `ARWorldMap` (which
  contains the paint anchors) is saved 5 s later and uploaded to Supabase Storage keyed by canvas,
  alongside every stroke's anchor id + transform. Coming back within 15 m downloads the map and
  ARKit relocalises against it — paint re-attaches to the same wall region **if you look from
  roughly the painter's viewpoint under similar lighting**. That is the documented limit of
  ARWorldMap; expect it to work indoors and on textured walls, and to be flaky on blank walls
  or after big lighting changes.
- **Fallback when relocalisation fails** (15 s timeout, missing/corrupt map, or a canvas whose map
  upload failed): the session resets and each quad is placed at its stored offset from where the
  painter stood, relative to the camera now (valid because the frame is heading-aligned), marked
  *loose*; as soon as a detected plane within 0.6 m / 20° appears, the quad snaps onto it. HUD
  shows "piece placed from memory · walk to where it was painted". Accuracy here is GPS + heading
  class (metres), corrected to the real wall by the snap.
- Last writer wins on the shared world map.

### On-device test protocol (do this, not theory)

Paint a piece on a textured wall → walk 5 m away → approach from 45° → look away 10 s → return.
Expected: "WALL LOCKED" within ~2 s of raising the phone, paint flat on the wall from every angle,
no float, no drift. Then kill the app, reopen within 15 m: "look around to resolve the piece" →
"piece resolved" once ARKit relocalises (or the "placed from memory" fallback after 15 s).

Run `supabase/migration_ar.sql` once for the new columns (`anchor_id`, `transform`, `viewer`, world map), the `set_world_map` RPC and the storage bucket.

### Compass fallback (`src/screens/PaintScreen.tsx`)

Used only when ARKit is unavailable:

- A **canvas** is a virtual cylindrical wall around the spot where its author stood (GPS) with
  a compass heading for its centre. Paint is stored in **angular coordinates** (yaw, pitch).
- Camera pose comes from our own sensor fusion (`src/hooks/usePose.ts`): pitch/roll from
  gravity, yaw from gyro integration about world-up, corrected toward a tilt-compensated
  magnetometer heading of the *camera axis* (not the phone's top, which is ambiguous when the
  phone is upright). Paint therefore stays glued to the direction you sprayed it, rotates with
  phone roll, and is smooth at 60 Hz.
- Anyone within ~15 m joins the same canvas and sees the same paint in the same direction.
- **Tradeoff:** paint is anchored to a direction from a point, not to a surface. Step several
  metres sideways and it drifts against the real wall; GPS jitter offsets two phones slightly.
  For a campus-scale shared wall demo this reads convincingly; true plane anchoring is the
  first thing to harden (below).
- Rendering: each canvas is an offscreen Skia raster ("Wall", `src/paint/Wall.ts`) that dabs
  are composited into once; the view draws the snapshot with a pose transform, so frame cost
  doesn't grow with paint. FOV scale is tunable in Settings ("AR scale").

## Spray rendering (Curtis et al. adapted cheaply)

`Wall.dab()` (and its Swift twin in `modules/ar-paint`): a hard, nearly opaque core plus a few
softer blobs composited source-over (pigment **buildup** with repeated passes), a faint darker
halo wider than the body (**edge darkening** where blobs overlap only at rims), and seeded-RNG
alpha jitter with light overspray speckle (**granulation**, deterministic across phones). Paint
reads as paint rather than mist, and nothing drips: a piece keeps the shape you drew. Drip points
(`kind = 1`) recorded by older builds are skipped, so old pieces stop running too.

## Volume buttons as the trigger + fallback

`src/hooks/useVolumeTrigger.ts` (react-native-volume-manager): system volume is pinned to 0.5
with the native HUD hidden. A press nudges it up/down → that tells us VOL+ (option A) vs VOL−
(option B) and we immediately snap back to 0.5. iOS auto-repeats volume changes while a button
is **held**, so "held" = events keep arriving and "released" = no event for ~380 ms. Instant
press-on, ~0.4 s release latency. Hacky but it feels like a nozzle.

The two on-screen HOLD buttons are always visible (one per can, with its fill level) and work in
parallel; Settings → "Volume buttons also spray" turns the rocker off if it misbehaves.

## Interaction model

- **Shake to charge**: user-acceleration spikes fill the can (rattle + heavy haptic). Charge
  decays to empty over 60 s; below 12 % the spray weakens then stops ("SHAKE CAN").
- **Paint economy**: per colour, 100 units; ~4.5/s at size M (bigger sizes burn more); regen 2.2/s while
  not spraying that colour; empty can can't spray (empty-can rattle).
- **Paint look**: solid, not misty — each tick lays a hard core plus a little buildup, and dwelling
  on a spot no longer starts a drip, so a piece keeps the shape you drew.
- **Haptics**: light impacts at ~14 Hz while paint flows, soft when weak; success on discovery.
- **Geofence**: 25 km circle over Waterloo Region (`GEOFENCE` in `src/config.ts`); bypass toggle
  in Settings for testing elsewhere.

## Discovery mode

`src/hooks/useDiscovery.ts` + `src/components/DiscoveryOverlay.tsx`. Undiscovered pieces within
80 m produce a pull: an edge arrow when off-screen, a twinkling shimmer at their bearing when
on-screen. From 35 m → 14 m the wall raster fades and un-blurs in (Skia blur driven by
distance). Inside 14 m, facing the wall for 0.8 s locks it: views increment (RPC), success
haptic, reveal card with author, time, views, strokes. Discovered/own pieces stay resolved and
show an info chip + report button.

## Data model (Supabase, `supabase/schema.sql`)

| table | purpose |
|---|---|
| `painters` | `id` = Supabase auth user id, unique `name` (your tag); `paint_used`, `strokes` kept by trigger |
| `canvases` | lat/lng + `heading`, author, `views`, `stroke_count`, `flags`/`flagged` |
| `strokes` | `canvas_id`, colour, cap, `points` jsonb `[[yaw,pitch,size,alpha,kind],…]`, `paint_used` |
| `reports` | trigger bumps `canvases.flags`; 2 reports → `flagged` (hidden everywhere) |

RPCs: `nearby_canvases(lat,lng,radius_m)` (haversine), `increment_views(cid)`. Undo deletes a stroke row, which needs the `delete own stroke` policy. Realtime on
`strokes`/`canvases` inserts so a second phone sees strokes live; polling every 15 s as backup.
Auth is Supabase email + password (`src/screens/AuthScreen.tsx`): one button signs in, or
creates the account if it doesn't exist. RLS: everyone can read; inserts require
`author_id`/`reporter_id` = `auth.uid()`, so pieces are always signed by the logged-in user.
For the demo turn **off "Confirm email"** in Authentication → Providers → Email, otherwise
sign-up waits for the emailed link. The client is local-first: strokes render immediately,
are cached in AsyncStorage, and failed uploads queue and retry.

`supabase/seed.sql` (from `scripts/gen_seed.mjs`) drops three pieces around E7 so judges can
discover art without a second phone.

## Home-screen + lock-screen widgets

`targets/widget` (via `@bacons/apple-targets`, plugin listed in `app.json` so EAS/prebuild generate
the extension target) is a WidgetKit extension. Families: **small** (two colour swatches with colour
names, three bars, streak), **medium** (swatches, both gauges with a live "full in mm:ss" countdown,
streak, can charge, all-time strokes/paint), and lock screen **rectangular / circular / inline**
(colours + levels + streak). Add it from the iOS widget gallery under "Fresco Can".

Data flow: the app mirrors state into the App Group `group.com.hamzakhan.tagged`
(`src/lib/widget.ts`: `paintA/B`, `colorA/B`, `nameA/B`, `shake`, `refillAtA/B`, `streak`, `strokes`,
`paintUsed`, `tag`) at most once every 3 s while it changes, then asks WidgetKit to reload; the
widget also refreshes itself every 15 min. Countdown assumes the in-app regen rate (paint only
regenerates while the app is open). Building needs the App Groups capability on the app id:
`xcodebuild … -allowProvisioningUpdates` or EAS (plain `expo run:ios` can't register it).

## Sound assets

All SFX are **procedurally generated** by `scripts/gen_sfx.py` (numpy → WAV, 44.1 kHz mono),
so there are no licensing questions: `rattle.wav` (ball clicks), `empty_rattle.wav` (hollow
can + resonance), `hiss.wav` (filtered noise, seamless 1 s loop; volume/rate follow spray
strength and aim pitch as a distance proxy), `click.wav` (nozzle). `pool.wav` is no longer played
(it went with the drips).
Played via `expo-audio` (expo-av is deprecated in SDK 57).

## Layout

```
App.tsx                  launch → onboarding → dock shell (home/vault/create/explore/social) + market/settings sheets
src/ui/*                 Dock, Glass, StrokeThumb, theme;  src/data/mock.ts  every stub in one place
src/screens/*            Launch, Onboarding, Home, Explore, ArPaint/Paint (create), Social, Vault, Settings
src/config.ts            every tunable
src/store.ts             zustand store + AsyncStorage persistence
src/hooks/usePose.ts     sensor fusion → yaw/pitch/roll (shared values)
src/hooks/useVolumeTrigger.ts, useSprayEngine.ts, useDiscovery.ts, useLocation.ts
src/paint/Wall.ts        offscreen raster + spray model;  PaintLayer.tsx  Skia view
src/data/sync.ts         Supabase + local cache
src/screens/*            Paint, Map, Leaderboard, Name, Settings
src/audio/sfx.ts         expo-audio players
supabase/schema.sql, seed.sql;  scripts/gen_sfx.py, gen_seed.mjs
```

## What I'd harden next

1. **Relocalisation UX**: guide the viewer to the painter's original viewpoint (store a thumbnail
   of the first frame), and merge world maps instead of last-writer-wins.
2. **Texture tiling**: 5 m quads per surface are simple; real walls want a tiled atlas so long
   murals don't create seams or overlapping quads.
3. **Volume trigger robustness**: handle the 0/100 % edge cases, Control Center changes, and
   audio-session interruptions; consider a screen-edge squeeze fallback.
4. **Abuse controls**: rate limits per user, stroke size caps, and an admin unflag path.
5. **Stroke compaction**: batch points, delta-encode, and paginate strokes for busy walls.
6. **Battery**: drop sensor rate when idle, pause the camera on other tabs.
