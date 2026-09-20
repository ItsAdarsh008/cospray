# transition.md — moving today's work to the Android laptop

Everything on `ui/pixel-arcade` is shared JS except the AR module. This is what the Android side has
to match, what to change for Android specifically, and how to run Supabase on that laptop.

Companion docs: `deploy.md` (your own hosted Supabase), `README.md` (how the AR and spray model work).

---

## 1. Get the code

```sh
git clone https://github.com/McMuf/htn26.git   # or: git pull
cd htn26
git checkout ui/pixel-arcade
npm install
```

Two env files are **not** in git — recreate them:

**`.env`** (the backend the app talks to; fill in from section 4)

```sh
EXPO_PUBLIC_SUPABASE_URL=...
EXPO_PUBLIC_SUPABASE_KEY=...
```

**`.env.local`** (build overrides). On Android it matters for one reason: `app.config.js` only
strips the iOS widget plugin when **both** of these are set, and `@bacons/apple-targets` has no
business in an Android build:

```sh
FRESCO_BUNDLE_ID=com.yourname.fresco
FRESCO_NO_WIDGET=1
```

Also change `expo.android.package` in `app.json` — it's still `com.hamzakhan.tagged`.

## 2. What the JS now expects from the AR module

Your Android module registers as `ArPaint` and is consumed through `modules/ar-paint/index.ts`.
The contract, with today's additions marked:

| Kind | Name | Notes |
|---|---|---|
| prop | `spraying`, `paintColor`, `radius` (m), `flow` (0..1), `showPlanes`, `worldMapPath` | unchanged |
| event | `onTracking`, `onHit`, `onStrokeEnd`, `onSurface` | unchanged. `onHit.drip` is ignored now |
| method | `saveWorldMap(path)`, `addStrokes(strokes, mode)`, `clearAll()`, `resetSession()` | unchanged |
| method | **`snapshot(path)` → `{width, height, bytes}`** | **new.** Writes a JPEG of the camera frame with paint composited, reticle and surface grids hidden. Feeds the Vault wall photos |
| method | **`undoLast()` → `{id, anchorId} \| null`** | **new.** Removes your most recent stroke *of this session* and repaints that quad from the strokes that remain |
| constant | `isSupported`, `hasLidar` | unchanged |
| constant | **`hasSnapshot`, `hasUndo`** | **new.** Absent or false ⇒ the UI hides the feature |

**The constants are the safety net.** If your Android module doesn't implement `snapshot` or
`undoLast`, just don't declare `hasSnapshot` / `hasUndo` — `canSnapshot` and `canUndo` come out
false, the undo button disappears from the camera, no photo is ever attempted, and the Vault falls
back to rendering paint on a brick wall. Nothing crashes. Ship without them and add them later.

### Paint parity

Two behaviour rules changed today. Match them or Android paint will look like a different app:

**Dabs are solid, not misty** (`paintAt` / `PaintNode.dab` in the Swift, for reference):

```
per tick:  radius = radius * (0.85 + 0.3 * flow)
           alpha  = 0.28 * flow
dab:  halo   r*0.98, alpha*0.10, hard 0.35      (edge darkening, colour darkened to 72%)
      body   4 blobs, r*0.55, alpha*(0.34 + 0.16*rand), hard 0.40, offset gauss * r*0.36
      core   r*0.46, alpha*0.90, hard 0.80
      spray  2 speckles, alpha*0.45
```

`hard` is where the radial gradient stops being flat: 0 is a soft airbrush, 0.8 is nearly a disc.
That's the whole difference between "mist" and "paint".

**Nothing drips.** Don't generate drip points, and when replaying a stroke **skip every point whose
`kind === 1`** — those are drips recorded by older builds, and they must not be drawn (advance your
RNG once for the skipped point so the rest of the stroke's speckle stays put). Stroke points are
`[u, v, radiusM, alpha, kind]` in anchor-local metres.

Speckle placement is seeded per stroke id (SplitMix in the Swift). Unless you port the same PRNG,
speckle won't land identically across platforms — cosmetic, and only visible if two phones look at
the same wall.

## 3. Android-specific wiring

| Thing | What to do |
|---|---|
| `react-native-maps` | Needs `expo.android.config.googleMaps.apiKey` in `app.json`, or Explore's heat map is blank |
| Volume trigger | `react-native-volume-manager` has no iOS-style auto-repeat on Android. The on-screen hold buttons are always visible and carry it — if the rocker misbehaves, Settings → "Volume buttons also spray" off |
| Widget | iOS only. `FRESCO_NO_WIDGET=1` + `FRESCO_BUNDLE_ID` strips the plugin (see section 1) |
| Permissions | Already declared in `app.json` (camera, fine/coarse location, vibrate, audio) |
| Fonts / system face | Small text uses the system face by design, so it renders in Roboto on Android. That's intended — pixel fonts only above 16px |

## 4. Supabase on that laptop

### Option A — local stack (no internet needed)

```sh
brew install supabase/tap/supabase      # or scoop/apt, see supabase.com/docs/guides/cli
cd htn26
supabase init                           # once; creates supabase/config.toml
supabase start                          # Docker: Postgres, Auth, PostgREST, Realtime, Storage
```

`supabase start` prints the **API URL** (`http://127.0.0.1:54321`) and an **anon key**. Then:

1. **Enable anonymous sign-in** — in `supabase/config.toml`:
   ```toml
   [auth]
   enable_anonymous_sign_ins = true
   ```
   then `supabase stop && supabase start`.
2. **Run the SQL in order** — Studio at <http://127.0.0.1:54323> → SQL Editor:
   `supabase/schema.sql` → `supabase/migration_ar.sql` → `supabase/seed.sql` (optional).
   `migration_ar.sql` is the one that makes AR strokes work at all: `anchor_id`, `transform`,
   `viewer`, the `worldmaps` bucket, and the `delete own stroke` policy undo needs.
3. **Use the laptop's LAN IP, not localhost** — the phone can't reach `127.0.0.1`. `ipconfig
   getifaddr en0` (mac) / `ip addr` (linux) / `ipconfig` (windows), then in `.env`:
   ```sh
   EXPO_PUBLIC_SUPABASE_URL=http://192.168.x.x:54321
   EXPO_PUBLIC_SUPABASE_KEY=<anon key from supabase start>
   ```
   Phone and laptop on the same Wi-Fi, same as Metro.
4. **Allow cleartext on Android** — a local stack is plain `http`/`ws`, which Android blocks by
   default. Extend the existing `expo-build-properties` entry in `app.json`:
   ```json
   ["expo-build-properties", { "ios": { "deploymentTarget": "16.4" }, "android": { "usesCleartextTraffic": true } }]
   ```
   Then rebuild the dev client (this one is a native change).
5. `npx expo start --dev-client -c` — `-c` matters, `EXPO_PUBLIC_*` is inlined at bundle time.

**What a local stack costs you:** it dies with Docker or a sleeping laptop, only devices on that
Wi-Fi can reach it, and the Vercel web companion can't see it at all — so no second-phone-over-the-
internet and no judges-in-a-browser. Fine for building, awkward for demoing.

### Option B — your own hosted project (recommended for anything demo-facing)

Ten minutes, all in a browser, and everything keeps working over the internet: follow `deploy.md`.
Same three SQL files, same key swap, no cleartext flag, no Docker.

You can keep both and switch by editing two lines in `.env`.

## 5. Verify

App:

- [ ] Launches into the camera (Create is the middle dock key and the landing tab)
- [ ] Charge rail top-left, piece preview top-right, two colour buttons + tools tray at the bottom
- [ ] Surface hint disappears once a wall locks
- [ ] Paint is solid and doesn't run
- [ ] Undo button present only if `hasUndo` is declared, and it repaints the wall without the stroke

Backend (Studio → Table editor, after painting one stroke):

- [ ] `painters` — your tag
- [ ] `canvases` — a row at your lat/lng
- [ ] `strokes` — a row with `anchor_id` and `transform` **not null**
- [ ] Storage → `worldmaps` — a `<canvas-id>.arworldmap` file a few seconds after you stop
- [ ] Metro shows no `uploadStroke failed, queued` warnings

## 6. Troubleshooting

| Symptom | Cause |
|---|---|
| App killed a few seconds after launch (`signal 9`) | The stroke retry queue grew unbounded because uploads were being refused. Fixed in `b6625f0`, but the cause is usually the next row |
| `column strokes.anchor_id does not exist` | `migration_ar.sql` wasn't run against *this* database |
| Everything offline, `Invalid API key` | Wrong key, or Metro not restarted with `-c`, or the phone can't reach the LAN IP |
| Android: network requests fail against local Supabase | Cleartext — section 4, step 4 |
| `Anonymous sign-ins are disabled` | `config.toml` (local) or Authentication → Providers (hosted) |
| Undo works, then the stroke comes back | `delete own stroke` policy missing — re-run `migration_ar.sql` |
| Explore map is blank | Google Maps API key missing on Android |
| Paint looks hazy / drips appear | The Android module hasn't picked up the dab values and the `kind === 1` skip in section 2 |
