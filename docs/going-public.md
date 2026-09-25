# Going public: AR, scale, money, store approval, growth

What stands between the Hack the North build and a public app, based on a read of the code as of
`d345403`. File references point at the code that causes each problem. Numbers marked **(est.)**
are back-of-envelope estimates to set the order of magnitude, not measurements. Measure them before
you rely on them.

---

## Status: what the `public-hardening` branch did, and what's left

### Done (one commit each; the commit messages carry the detail)

| Commit | What |
|---|---|
| `security: lock down reports, counters, views and write volume` | §0.1, 0.2, 0.3, 0.5, 0.6: one report per person, trust-weighted hiding, counters writable only by triggers, `paint_used` clamped, one view per person, size caps + rate limits, server-owned `author_name`/timestamps/counters |
| `security: world maps can only be written by the painter who uploaded them` | §0.4: storage writes limited to `<uid>/…`, `set_world_map` only for people who painted there |
| `security: debug tools and the geofence bypass only exist in dev builds` | §0.8 |
| `data: refresh nearby paint incrementally` | The 15 s full re-download (§3, fix 1): walls are re-fetched only when `updated_at` moves, and then only the new strokes |
| `data: store stroke points in a compact binary format` | §3, fix 4: 14.7× smaller (4 bytes/dab, 0.5 mm max error, measured), both apps; the phone cache uses it too |
| `ar(android): keyless ARCore auth` (+ boolean fix) | §1a: Cloud Anchors last 365 days instead of 1, no key in the APK |
| `ar: record each stroke's pose on Earth (Geospatial)` | §1a: Android records a WGS84 pose per stroke and moves placed-from-memory pieces onto it once its own VPS fix is good |
| `ar: hide paint behind people and objects` | §1b(i): Android depth-map occlusion in the paint shader; iPhone people occlusion |

### Before this runs anywhere: deploy steps

1. **Run the new SQL**, in this order, on the Supabase project (or paste the regenerated
   `supabase/setup_all.sql`, which includes all of them):
   `migration_upvotes.sql` (if it was never run) → `migration_security.sql` →
   `migration_worldmaps_owned.sql` → `migration_strokes_v2.sql` → `migration_geo.sql`.
   Until `migration_strokes_v2.sql` runs, new builds can't upload strokes (the offline queue
   holds them and says so in the logs).
2. **Update every phone together.** Builds from before the binary format read only jsonb
   `points`, so they won't draw strokes written by new builds.
3. **Android AR auth**: without `ARCORE_AUTH=keyless` (or `ARCORE_API_KEY`) in `mobile/.env.local`
   at prebuild time, Cloud Anchors **and Geospatial are off**. The geo debug readout says `geo off`.
   Setup is in `goal2.md` §2.

### Verified so far

- TypeScript passes in `mobile/` and `web/`. The ARCore module's Kotlin compiles. A full Android
  debug build (arm64) succeeds and installs on the Galaxy S25, and the app launches with no JS
  errors.
- The stroke codec round-trips real-shaped data (a 1300-dab AR sweep and compass strokes with
  drips, including truncated/invalid input).
- **Windows build gotcha:** from `C:\Users\…\GitHub\cospray\cospray\mobile`, reanimated's CMake
  output passes the 260-character path limit and ninja loops on "build.ninja still dirty". Build
  from a short path instead (a `git worktree` at `C:\cs` works), or enable Windows long paths.

### Not verified yet

- **Nothing here has run against a live database.** The SQL was written against the existing schema
  but hasn't been executed. Watch for errors the first time you run it.
- **iOS changes weren't compiled** (there's no Mac on this machine): the `occlusion` prop and people
  occlusion in `ArPaintView.swift` / `ArPaintModule.swift`. They're small, but build on a Mac
  before trusting them.
- **The Android shader compiles at runtime.** If occlusion is broken, paint will fail to draw, and
  logcat will show `ArPaint: compile failed`. Settings → "Hide paint behind people and objects"
  turns off the depth path, but the shader itself changed either way.
- **Geospatial hasn't been tried outdoors with auth.** It needs keyless auth (or a key) plus Street
  View coverage.

### Left to do, in priority order

1. **§0.7 location privacy / stalking.** Untouched. Public lat/lng + handle + exact time on every
   piece. Coarsen what others see (day-level times, optional anonymous pieces), home-zone blur,
   exclusion zones. This is the most serious real-world risk remaining.
2. **App Store blockers (§5):** block user, in-app account deletion (+ a web URL for Play), EULA /
   community guidelines acceptance, a report reason picker, remove "SOON"/mock/sample content,
   drop the microphone permission + `UIBackgroundModes: audio` + Android `RECORD_AUDIO`, a
   reviewer mode for the geofence, final name + bundle ids, organisation developer account,
   privacy policy + nutrition labels.
3. **Moderation pipeline (§2):** the database now resists brigading, but there's still no review
   queue, admin console, automated image/OCR checks, unflag/appeal path, new-account probation,
   or App Attest / Play Integrity on writes. Report weighting is a stopgap, not moderation.
4. **Server-side currency ledger (§7):** coins are still computed on the phone
   (`paint_used / 8 + bonus − spent`, with `bonus`/`spent`/`owned` in AsyncStorage). `paint_used`
   can no longer be forged, but quest bonuses and purchases can be edited locally, and nothing is
   restorable. Needs `wallet_ledger` + `inventory` + RevenueCat before any IAP.
5. **Data, the rest of §3:** per-cell realtime channels (every phone still receives every stroke
   insert in the world), PostGIS/H3 index for `nearby_canvases`, baked raster tiles + CDN,
   retention/buffing, `expo-sqlite` instead of AsyncStorage, optional backfill of old jsonb
   strokes into `points_bin`.
6. **AR, the rest of §1:**
   - iPhone Geospatial (ARCore iOS SDK pod + JWT auth from an edge function). Until then the iPhone
     neither records nor uses `geo`, so the cross-platform gap only closes for Android viewers.
   - Canvases are still GPS bubbles (`CANVAS_JOIN_RADIUS_M = 15`). Group by geo pose once most
     strokes have one.
   - A pool of world maps per wall instead of last-painter-wins, and wall pose refinement from
     visitors.
   - Paint-free reference keyframes + a "line it up" ghost for indoor relocalisation.
7. **Occlusion, the rest of §1b:** LiDAR-mesh occlusion of non-people on iPhone Pro; persistent
   "this wall got covered" detection (per-visit depth + appearance votes aggregated server-side,
   fade to ghost + notify the author). Android's moved-furniture check is the seed of it.
8. **Growth, monetisation, observability (§4, §6, §8):** unchanged. Sentry + PostHog before
   launch, and backups/PITR.

---

## TL;DR: the order I'd do things in

1. **Before any stranger installs it (security):** fix the holes that let one person hide any
   piece, mint coins, or overwrite anyone's world map (§0). These are cheap to fix and dangerous to
   leave in.
2. **Before 1,000 users (data):** stop re-downloading every nearby stroke every 15 s, move to a
   compact binary stroke format, bake each wall into raster tiles, and use per-area realtime
   channels (§3). As it stands the backend bill grows with users × wall size × time spent in the app.
3. **AR:** use the **ARCore Geospatial API on both iOS and Android** as the shared global frame,
   and keep the existing plane-snap / world-map / Cloud Anchor code as the local fine-alignment
   step (§1a). This fixes the 10–15 m problem outdoors *and* the iPhone↔Android mismatch.
4. **Occlusion** is two different problems. Hiding paint behind things in the current frame is
   handled by ARKit/ARCore depth and needs no new CV. Noticing that a wall is *no longer there or
   has changed* takes a depth check plus an appearance check, with the results pooled across many
   visits (§1b).
5. **Moderation, store approval and a server-side currency ledger have to land together.** Apple's
   UGC rules, account deletion, and real-money IAP all need the same server-side identity and
   trust groundwork (§2, §5, §7).
6. **Growth:** keep the Waterloo geofence and treat it as the launch strategy. Get one campus dense
   before opening a second (§6).

---

## 0. Security holes to fix before going public

These block every other section. Each one is small.

Status: 0.1–0.6 and 0.8 are **fixed** on `public-hardening` (see the Status section above); **0.7 is
open**. App Attest / Play Integrity (part of 0.6) and a pool of maps per wall (part of 0.4) are
still to do.

| # | Problem | Where | Consequence | Fix |
|---|---|---|---|---|
| 0.1 | Reports aren't deduplicated, `reporter_id` is nullable, and 2 reports hide a piece | `supabase/schema.sql` `on_report()`, `reports` table | **One user can hide any piece in the world with two taps.** Anonymous sign-in makes a second account free anyway | `unique (canvas_id, reporter_id)`, `reporter_id not null`, and replace "2 reports ⇒ hidden" with the weighted queue in §2 |
| 0.2 | The `"own painter"` policy is `for all`, so users can `update` their own `paint_used` / `strokes` | `schema.sql` | Anyone can edit their row to top the leaderboard and, since coins = `paint_used / 8`, **mint unlimited coins** | Split the policy: insert your own row, update only `name`. Counters change only through `security definer` triggers |
| 0.3 | `strokes.paint_used` comes from the client | `useArSpray.ts` `onNativeStroke`, `uploadStroke` | Same as 0.2: the client says how much it spent | Compute it server-side from `points` (or stop using it for money) |
| 0.4 | Any signed-in user can overwrite any canvas's world map (`upsert` on the public `worldmaps` bucket + `set_world_map`) | `migration_ar.sql` | Griefing: upload garbage and a piece stops relocalising for everyone | Scope storage writes to `{canvas_id}/{uploader_id}/…`, keep several maps per canvas (this also fixes last-writer-wins), and pick one server-side |
| 0.5 | `increment_views` is uncapped and needs no auth | `schema.sql` | View counts can be inflated by any script. Views feed trending and, per the pitch, currency | `views(canvas_id, viewer_id)` unique table, same pattern as `upvotes` |
| 0.6 | No size or rate limit on `strokes.points` | `schema.sql` | One client can insert a 50 MB jsonb row, or thousands of rows a second | `check (octet_length(points::text) < N)`, a per-user rate limit (edge function or a `pg` token bucket), and App Attest / Play Integrity on writes |
| 0.7 | Location is exposed publicly, tied to a handle, with a timestamp | `canvases` (lat/lng, author, created_at), public `select` | **Stalking.** You can rebuild a named user's movements, and where they live if they paint at home. This is the most serious real-world harm here, especially with students and minors | See §2.5: coarsen the author↔location link, add a "home zone" blur, exclusion zones, and consider age gating |
| 0.8 | Debug paths ship in production: `FILL CAN`, geofence bypass toggle, `REDO ONBOARDING` | `SettingsScreen.tsx` | Cheating, plus confusion during App Review | Put them behind `__DEV__` or a server-side staff flag |

The anon key in `mobile/.env` / `eas.json` is designed to be public, so committing it is fine. It is
only safe because RLS is the entire security model, which is why 0.1–0.6 matter so much.

---

## 1. AR

### How it works today (summarised so the problem is clear)

- A **canvas is a GPS bubble**: the nearest canvas within `CANVAS_JOIN_RADIUS_M = 15`
  (`config.ts`, `useArSpray.pickCanvas`). GPS, not vision, decides which piece you're at.
- **iOS** saves an `ARWorldMap` for each canvas. It relocalises only from roughly the painter's
  viewpoint and lighting, and last writer wins.
- **Android** hosts Cloud Anchors with `HOST_TTL_DAYS = 1` (`ArPaintView.kt:89`). **Every Android
  piece loses its exact placement after 24 h**, because API-key auth caps the TTL at one day.
- **Cross-platform**, each OS only relocalises against its own map. Anything else is "placed from
  memory" (painter's viewpoint + compass heading), which is off by metres.
- **Fallback** is GPS + heading, followed by snapping to a detected plane within 0.6 m / 20°.

So there are three separate problems: (1) no shared, persistent, global coordinate frame;
(2) GPS picks the canvas; (3) the platforms can't read each other's maps.

### 1a. Replace GPS as the source of truth: the localisation ladder

Build it as a ladder. Each rung narrows the error of the one before, and the app works at
whichever rung it reaches:

```
GPS (10–30 m)          → which walls are candidates, what to download
 → VPS / Geospatial    → ~sub-metre position, ~1–2° heading, outdoors (street-level imagery areas)
   → local relocalise  → cm-level: Cloud Anchor / ARWorldMap / your own keyframe match
     → plane snap      → paint glued flat to the real surface (already built)
```

**Recommendation: ARCore Geospatial API as the backbone, on both platforms.**

- It uses Google's Visual Positioning System, built from Street View imagery. It returns
  latitude/longitude/altitude plus orientation, typically well under the 10–15 m you get today, in
  areas with Street View coverage. Uptown Waterloo, the UW and Laurier campuses, and most
  city streets should be covered. Verify with Google's coverage checker before committing.
- **ARCore's iOS SDK supports Geospatial.** That gives iPhone and Android **one shared frame**
  (WGS84), which removes the "each platform only relocalises against its own map" split in
  `sync.ts` / `strokePlatform()`.
- **Streetscape Geometry** gives building and terrain meshes around the user. Paint can then land
  on a building facade even before ARKit/ARCore detects a plane, and the same mesh serves as a
  free occlusion and "is the surface still here" signal (§1b).
- **Rooftop / terrain anchors** cover pieces on the ground or at the top of a building.
- Apple's own `ARGeoTrackingConfiguration` (Location Anchors) is available only in a limited list
  of cities. Check whether Waterloo is on it, but don't build on it.
- Alternatives if Google's terms or quotas don't work out: Niantic Spatial's VPS (coverage is
  wherever their scans exist), Immersal, or MultiSet. All of these require someone to map the
  location first, which is worse for UGC anywhere in a city.

**Data model change.** The anchor stops being "an opaque transform in a session's world frame"
and becomes a **wall**:

```sql
walls(
  id uuid, canvas_id uuid,
  geo geography(PointZ),          -- centre: lat, lng, altitude (WGS84)
  normal / orientation quaternion (EUS frame from Geospatial),
  extent_m, created_at, updated_at,
  loc_quality  -- 'vps' | 'cloud_anchor' | 'worldmap' | 'gps'  (how well we know where it is)
)
strokes.wall_id → walls.id, points stay in wall-local (u, v) metres — exactly what they are now.
```

The stroke format (`[u, v, r, a, kind]` in anchor-local metres) is already right. Only the anchor
changes. That keeps this migration contained.

**Canvas ≠ GPS bubble any more.** A canvas becomes a *group of walls* (a spot on the map),
clustered by geodetic distance after VPS localisation, not by raw GPS. Two pieces 8 m apart on
different walls stop merging.

**Refine walls from every visit.** Each time a visitor localises with VPS and snaps a wall to a
detected plane, upload the observed pose (and its confidence). The server keeps a weighted
average, so walls get *more* accurate as more people visit. This also replaces last-writer-wins
for world maps: you keep a small pool of maps or anchors per wall and pick one.

> **Status:** Android now records a Geospatial pose with each stroke and places pieces from it
> (`b1261af`), and keyless auth is wired up (`70ea360`). Still open: iPhone Geospatial, grouping
> canvases by geo pose instead of GPS radius, per-wall map pools, visitor refinement, keyframes.

**Fix now, whatever else you decide:** move Android to **keyless (OAuth) ARCore auth**. That raises
Cloud Anchor TTL from 1 day to up to 365 days, and API-key auth is discouraged for production
anyway. Also stop shipping the ARCore API key in the APK. On iOS, the ARCore SDK uses API key or
JWT auth, so serve short-lived JWTs from an edge function.

**Indoors / no VPS coverage:** the existing ARWorldMap and Cloud Anchor path stays as the rung
for that case. Also store a **paint-free reference keyframe** per wall (camera image + intrinsics +
pose, a few hundred KB). A guided "line it up" UI then shows a ghost of that frame so the visitor
walks to the painter's viewpoint, which is item 1 in the README's harden list. If that isn't
enough, a server-side relocaliser (SuperPoint/LightGlue-style feature matching against wall
keyframes) is the CV option. It's real infrastructure, so only do it if the data shows indoor
pieces matter.

**Cost / quota:** Geospatial and Cloud Anchors run on a Google Cloud project with quotas. Check
current pricing and quota limits before launch and budget for them in §4.

**Honest limits:** VPS can fail in places with poor Street View coverage, in bad weather, at
night, and under heavy tree cover or tunnels. The UI has to show which rung you're on (it already
has `mapState: 'resolved' | 'approx'`; extend it) and never pretend to be precise.

### 1b. "Is the spray covered by something?" is two separate problems

> **Status:** (i) is done for Android (depth-map occlusion in the paint shader) and for people on
> iPhone (`abf0480`). Still open: LiDAR-mesh occlusion on iPhone Pro, and all of (ii).

**(i) Something is in front of the paint right now** (a person, a car, a pole). Ordinary AR
occlusion handles it and **needs no custom CV**:

- **iOS**: `frameSemantics = .personSegmentationWithDepth` (A12+) for people, and on LiDAR phones
  `sceneDepth` / the scene-reconstruction mesh (already on, `ArPaintView.swift:267`) as an
  occluder. Render the mesh depth-only so paint fragments behind it are discarded.
- **Android**: the Depth API is already enabled (`ArPaintView.kt:351`). Sample the depth texture
  in the paint quad's fragment shader and discard fragments where `sceneDepth < paintDepth − ε`.
  This is the standard ARCore occlusion sample. Nothing is drawn with depth today (see the comment
  at `:622`).
- **Geospatial Streetscape Geometry** lets buildings occlude paint on other buildings for free.

**(ii) The wall has persistently changed** (a poster went up, scaffolding, a parked trailer, a
renovation, the wall was demolished). This is the part that needs new work, and it needs **two
signals** because they catch different cases:

| What changed | Depth signal | Appearance signal |
|---|---|---|
| Truck/trailer parked in front | ✅ something is closer than the wall | ✅ |
| Poster pasted flat on the wall | ❌ depth is unchanged | ✅ texture changed |
| Real graffiti or a mural painted over it | ❌ | ✅ |
| Wall demolished / building gone | ✅ depth is further away (sees through) | ✅ |
| A person walking past | ✅ (transient) | ✅ (transient) |

- **Depth check**: Android already does this for furniture (`verifySurfaces`, `depthDelta`,
  `missScore`). Generalise it to every quad, and port it to iOS using LiDAR depth or the
  reconstructed mesh, falling back to ARKit's estimated depth.
- **Appearance check**: at paint time, store the **paint-free** reference keyframe from 1a. On a
  visit, you already know the wall's plane, so rectify the current frame's wall region to the same
  plane with a homography and compare it to the reference. A cheap first version: ORB/AKAZE
  feature-match inlier ratio on-device. Version two: a small embedding model (MobileNet /
  DINOv2-small class, CoreML + TFLite) with cosine similarity. Use a segmentation mask (people,
  cars) to *ignore* transient occluders, so a crowd doesn't count as "wall changed".
- **Don't decide on one phone.** Each session reports a vote: `{wall_id, depth_ok, appearance_sim,
  occluder_fraction, loc_quality}`. The server aggregates votes over time. A wall moves through
  `live → obstructed (N votes over ≥ 2 days) → changed / gone`, and people's cars don't wipe art.
- **Product behaviour** when obstructed or gone: don't delete. Fade the piece to a ghost, tell the
  author ("your piece at X got covered"), and offer the piece in their Vault as a photo/timelapse.
  This fits graffiti culture (things get buffed), and it feeds the data-retention policy in §3.

The answer to "do we need CV?": for (i), no. For (ii), a bit, and mostly the cheap classical kind.

---

## 2. Moderation

### What exists

A report button (`SpatialViewer.tsx:70`). As of `migration_security.sql` there is one report per
person per piece, and a piece hides only when trust-weighted reports reach max(3, 2% of views).
That's the 2.3 weighting in its simplest form. Everything else below is still to do.

Before the branch: 2 reports hid a canvas (`on_report`), with the exploit in 0.1. There are no blocks, no review queue, no admin tool, no handle filter, no appeals,
and every report is recorded as `'inappropriate'`.

### What a public UGC app needs, in layers

**2.1 Prevention (cheapest per incident)**

- **Identity with a cost.** Anonymous sign-in can stay for *browsing*. **Painting publicly**
  requires Sign in with Apple / Google, plus App Attest (iOS) / Play Integrity (Android) on writes.
  That makes throwaway accounts cost something.
- **New-account probation.** A new user's paint is visible to them straight away (no friction), but
  to everyone else only after automatic checks pass, and for the first N pieces maybe only to
  friends. Trust grows with account age, pieces that got upvoted and not reported, and verified
  sign-in.
- **Rate limits** per user and per device: strokes per minute, new canvases per day.
- **Text filter** on handles and titles, using a blocklist plus a toxicity model. Handles are
  public, and today any string is accepted.

**2.2 Automated review of the art itself**

The content is *drawings*, and most off-the-shelf moderation models are trained on photos. Plan:

- When a painting session ends (debounced, e.g. 60 s after the last stroke on a wall), a server
  job renders that wall's strokes to a PNG (you'll need this renderer for tiles anyway, §3).
- Run it through an image moderation model that handles drawings: Hive (has drawing/hate-symbol
  classes), Google Cloud Vision SafeSearch, AWS Rekognition, OpenAI's omni-moderation (free, takes
  images), plus **OCR → text toxicity** because a lot of graffiti is words. Use a vision LLM (e.g.
  Claude) as a second opinion only when the cheap models are unsure.
- Things to explicitly look for: hate symbols (swastika, SS runes, …), genitalia, slurs, doxxing
  (phone numbers, names + "is a …"), threats.
- Outcomes: `approve` / `hold for human` / `auto-hide`. The cost is per *session*, not per stroke,
  so it stays small.

**2.3 Community reporting that can't be weaponised**

- One report per user per piece, with a reason (hate, sexual, harassment, spam, personal info,
  property owner request, other).
- Weight each report by the reporter's trust. Hide a piece automatically only when the weighted
  score passes a threshold **relative to views**. Everything else goes to the queue.
- **"Hide for me" and "block user" work instantly and locally.** Apple requires blocking (§5).
  Blocking hides all of that user's paint for you.
- Reporters who are consistently wrong lose weight. Mass-reporting from new accounts is ignored.

**2.4 Humans**

- A small **admin console**. The `web/` app could host it behind a staff role: queue, piece
  render + map + author history, actions (hide / delete / ban / shadow-ban / restore), audit log.
- An SLA. Apple expects reports to be acted on promptly; aim for under 24 h. At the start that's
  you and the co-founders. Budget the time.
- Appeals, via an email address that is published in the app (Apple requires contact info).

**2.5 Location-specific rules (the part general UGC apps don't have)**

- **Exclusion zones**: schools, places of worship, cemeteries, memorials, hospitals, and possibly
  private residences. You can source these from OpenStreetMap tags and block painting inside them.
  After the Pokémon Go trespass/nuisance class action, Niantic agreed to remove points of interest
  near residences on request. Expect the same kind of complaint.
- **Property-owner removal flow**: a web form where "I own this building" + location → the pieces
  there are hidden quickly. Later, owners can *claim* a wall and whitelist it (that becomes a
  sponsored/legal wall, §4).
- **Privacy / stalking (0.7)**: don't publish precise `created_at` next to lat/lng and handle for
  others' pieces. Round shown times to the day, and optionally let users hide authorship on the
  map. Blur pieces painted within ~100 m of a user's "home zone" (auto-detected from where they
  open the app at night, or set by the user).
- **Age**: decide the minimum age (13+ with safeguards, or 16+/17+). Location + UGC + strangers is
  exactly the combination regulators look at.

**2.6 Legal obligations to set up before launch**

Terms of service and community guidelines with a zero-tolerance clause (Apple requires an EULA
covering objectionable content), a privacy policy, a copyright/DMCA takedown address (people will
trace brand logos), and a CSAM process. In practice that means hash-matching is unlikely to apply to
drawings, but you need a documented procedure and reporting obligations: NCMEC in the US, and
Canada's mandatory reporting law for internet service providers. Get a lawyer to look at this once.
It's cheap compared with getting it wrong.

---

## 3. Data and memory

### The current costs (est.)

**The biggest issue: polling.** `App.tsx:95` calls `loadNearby()` every **15 s**. It fetches
**every stroke of every canvas within 600 m** (`sync.ts`, `.in('canvas_id', ids)`, with no
`since` filter), and re-applies them all. Each client therefore downloads the whole
neighbourhood's paint about 240 times an hour. With 5 MB of paint within 600 m **(est.)**, that is
about 1.2 GB per user-hour of egress. This is the thing that would take down the backend or the
budget first, and it's an easy fix.

**Stroke size.** Native records one dab per frame (`ArPaintView.swift:598`, about 60/s), each
stored as 5 JSON doubles printed at full precision, roughly 80–100 bytes per point **(est.)**.
A can lasts about 22 s (`PAINT_COST_PER_SEC = 4.5`) → roughly 1,300 points ≈ 120 KB per can
**(est.)**. With regen, an active user doing 2 min of spraying a day comes to around 700 KB/day
**(est.)**.

| DAU | Raw stroke growth / month (est.) |
|---|---|
| 1k | ~20 GB |
| 10k | ~200 GB |
| 100k | ~2 TB |

That's before indexes and the `strokes` realtime WAL, and it only ever grows.

**Realtime.** `subscribeRealtime()` listens to **every stroke insert in the world** and filters on
the client (`sync.ts:231`). Every connected phone receives every stroke. Supabase's
`postgres_changes` also checks RLS for each subscriber on each change. It doesn't scale this way;
Supabase recommends Broadcast for fan-out.

**Proximity query.** `nearby_canvases` computes haversine over the whole table with no spatial
index, so it's a full scan on every call, and it's called every 15 s per user.

**Device memory.** Each wall quad is a 1024² RGBA CGContext (~4 MB) plus its GPU texture, which
is why `MAX_REPLAY_QUADS = 6` exists (`ArPaintScreen.tsx`). The local cache is AsyncStorage holding
entire stroke arrays as JSON. **On Android, AsyncStorage defaults to a 6 MB total cap**, so a busy
area will silently fail to cache. The pending queue is also AsyncStorage JSON (it has already OOM'd
once; see the 8 MB guard in `flushPending`).

### Fixes, in order of payoff

> **Status:** 1 (incremental sync) and 4 (compact encoding, minus distance-based dab decimation)
> are done. 2, 3, 5, 6, 7 and 8 are open. The phone cache now stores the binary format, which eases
> the AsyncStorage cap but doesn't replace moving to SQLite.

1. **Incremental sync, not polling.** Fetch strokes `where created_at > last_seen`, keyed per wall.
   Drop the 15 s loop in favour of realtime plus a refetch on wake. **This alone cuts egress by
   roughly 100×.**
2. **Spatial index.** PostGIS `geography` + a GiST index (`ST_DWithin`), or H3 cell ids as an
   indexed column. Use the same cell id for:
3. **Per-cell realtime channels.** Supabase Realtime *Broadcast* on topic `cell:<h3 res-9>`. A client
   subscribes to its cell and neighbours; the insert path (edge function or trigger) broadcasts to
   that cell. Each phone then only receives paint near it.
4. **Compact stroke encoding** (about 15–25× smaller **(est.)**):
   - Record dabs by **distance moved** (every ~r/3), not every frame. Replay is deterministic
     (seeded RNG), so it looks the same.
   - Quantise: u, v → int16 millimetres (±32 m); radius → uint8 half-mm; alpha → uint8. Drop `kind`.
   - Delta + varint encode, store as `bytea` (or a blob in object storage). Roughly 4–6 bytes per
     dab instead of ~90.
   - Version the format (`points_v smallint`) so old jsonb rows keep working.
5. **Bake walls into raster tiles.** This is the structural fix:
   - A server job (the same renderer as moderation, §2.2) composites each wall's strokes into
     **WebP tiles** with mip levels, e.g. 256 px tiles over the 5 m quad, with transparency. It
     runs when the moderation job does.
   - Tiles go in object storage **behind a CDN**. Cloudflare R2 has no egress fees, which matters
     for exactly this read pattern.
   - Clients download **tiles plus only the strokes since the last bake** (for undo and live
     painting). A wall with a million dabs costs the same to show as one with ten.
   - It fixes device memory as well: stream tile LODs by distance instead of holding every quad at
     full res, and the `MAX_REPLAY_QUADS` cap goes away. It also fixes the web companion, which
     currently replays strokes to draw thumbnails.
   - The tiles are also what you moderate, share, and put in the Vault.
6. **Retention that fits the medium.** Real walls get painted over and buffed. After a bake,
   strokes that are **fully covered** by newer paint can be pruned. Pieces with no views in N days
   fade and archive (you keep a tile snapshot in the author's Vault; the live wall frees the space).
   Upvotes or views keep a piece alive. That gives you a *bounded* dataset per wall instead of
   unbounded growth, and it's a game mechanic rather than a limitation.
7. **Client storage**: move from AsyncStorage to `expo-sqlite` (strokes, queue) + files (tiles),
   with an LRU cap on cached walls.
8. **World maps / keyframes**: `ARWorldMap` files can run to several MB each. Compress them, keep a
   few per wall, expire old ones, and once Geospatial works outdoors, only store them where VPS
   doesn't reach.

With 1–6 in place, the per-user cost should be dominated by tile egress from a CDN, which is cheap,
instead of by Postgres.

---

## 4. Monetisation (paying for §3)

Once the data work is done, the costs are modest: Supabase Pro plus an overage buffer, a CDN, and
moderation API calls per session. Expect **low hundreds of dollars a month at 10k DAU (est.)**.
Without the fixes it is unbounded. So do the data work *first*: it moves the break-even point more
than any revenue feature will.

Revenue options, from best fit to worst:

| Option | Fit | Notes |
|---|---|---|
| **Cosmetics via IAP**: paint colours, finishes (chrome, neon, glitter — already stubbed in `SOON`), can skins, stencil packs, sound packs | ⭐ Best | No pay-to-win, and it fits the culture. Must use Apple/Google IAP (Apple guideline 3.1.1); 15% under the small-business programmes. Needs the server ledger (§7) |
| **Sponsored / legal walls**: businesses, BIAs (Uptown Waterloo), campuses, festivals and brands pay for a featured wall, event, or branded limited-edition can | ⭐ Biggest $ per deal | Niantic's "sponsored locations" (cost-per-visit) is the precedent. Doubles as moderation (a claimed wall is curated) and as content seeding. B2B invoicing is outside the IAP rules |
| **Subscription ("Cospray+")**: cloud Vault (HD photos, timelapses, export), more active pieces kept live at once, extra cosmetics each month | Good | Keep it *off* paint amount/regen, or it becomes pay-to-win and undermines the wall-sharing idea. "Keep my pieces longer" ties directly to the retention costs in §3 |
| **Physical merch**: print your piece on a tee/poster/sticker | Good, low effort | Physical goods are **exempt from IAP**, so Stripe works and you keep ~95% |
| **Artist commissions / creator stencils marketplace** | Later | Payouts need Stripe Connect and tax handling, and IAP rules apply to digital goods. Complex, so wait for product-market fit |
| **Rewarded ads** ("watch to refill a can") | Meh | Easy to add and fits regen, but cheapens the feel. Optional only, never forced |
| Banner ads | ❌ | They get in the way of the camera view and earn almost nothing at this scale |

Don't sell priority placement over someone else's art, or protection from being painted over.
Pay-to-dominate wrecks a shared wall.

---

## 5. App Store (and Play) approval

Concrete issues in the current build, roughly in order of rejection risk:

**Blocking**

1. **UGC (Apple guideline 1.2)** requires: filtering of objectionable content, a reporting
   mechanism with timely response, **the ability to block abusive users** (missing), and published
   contact information. You also need a Terms/EULA that users agree to. All of this is in §2.
2. **Account deletion in-app (5.1.1(v))** is missing. It has to delete the painter row and their
   pieces (or anonymise them), not just sign out. Google Play also requires a **web** deletion URL.
3. **Geofence + AR = "the app doesn't work" (2.1).** App Review is in California. With
   `GEOFENCE` = Waterloo, a reviewer can't paint. You need a review/demo mode: a reviewer account
   that bypasses the geofence server-side (not the Settings toggle), plus a **demo video** and
   clear notes in App Review Information.
4. **Placeholder / incomplete features (2.1, 2.3).** Remove or hide the "SOON" rows in Settings
   (Apple/Google/Snapchat/Discord sign-in), the Market "COMING SOON" panel, the stubbed friends
   and activity (`src/data/mock.ts`), the sample pieces labelled "sample", "Hack the North 2026" in
   About, and the DEBUG panel.
5. **Unneeded permissions.** The microphone usage string literally says "Tagged does not record
   audio". Set `microphonePermission: false` in the `expo-camera` plugin and remove
   `NSMicrophoneUsageDescription`. On Android, drop `RECORD_AUDIO` and `FOREGROUND_SERVICE_MEDIA_PLAYBACK`
   unless something actually uses them (Play requires a declaration for foreground service types).
6. **`UIBackgroundModes: audio` (2.5.4).** It's only allowed for audible background playback. The
   hiss and rattle are foreground sounds, so remove it.

**Required, lower risk**

7. **Sign in with Apple (4.8)** is required once you add Google or other social login, which you
   need for 2.1's identity-with-a-cost.
8. **Consistent naming.** Permission strings say "Tagged", the app is "Cospray", the widget says
   "Fresco Can", the bundle is `com.hamzakhan.tagged`, the slug is `tagged`, the scheme is `tagged`.
   Reviewers do notice. Pick the final name and **new bundle ids now**, because they can't be changed
   after the first release.
9. **Publisher account.** Right now the Apple team is `8H99FU8A8H` (personal?) and the EAS owner is
   `synaraapp`. For a public app with UGC liability, publish under an **organization** developer
   account (needs a legal entity + D-U-N-S number). Moving an app between accounts later is painful.
10. **Privacy.** Needs a privacy policy URL, App Privacy "nutrition labels" (precise location,
    user content, identifiers, all linked to the user), a `PrivacyInfo.xcprivacy` privacy manifest
    (check that Expo's generated one covers the required-reason APIs, including AsyncStorage/
    UserDefaults and file timestamps), and Play's Data safety form.
11. **Safety framing (1.4.5-ish / physical harm + "illegal activity").** It's *graffiti*, so the
    store copy and onboarding should say clearly that this is virtual and never involves real
    paint, and include an "watch your surroundings" warning for walking with the camera up, as
    Pokémon Go does. Exclusion zones (§2.5) help here too.
12. **Age rating questionnaire**: UGC + location + unrestricted web-like content will probably put
    you at 13+/16+ under Apple's newer rating tiers. Answer it honestly.
13. **AR device requirement.** iOS already sets `UIRequiredDeviceCapabilities: arkit`. On Android,
    decide between "AR Required" (Play hides the app on unsupported phones) and "AR Optional"
    (the compass fallback). The compass fallback is lower quality, so "Required" is probably
    cleaner.
14. **TestFlight external testing** needs a lighter Beta App Review, so go through that first. It
    catches most of the above cheaply.

---

## 6. Advertising / growth

The core problem is the **cold start of a location-based network**. The map is empty wherever you
aren't, and an empty wall means a dead app. Everything below serves one rule: **density before
breadth.**

- **Keep the geofence and make it the launch plan.** Launch in Waterloo only (UW + Laurier + Uptown).
  Other cities get a **waitlist** ("open Cospray in Guelph: 312/500"), and a city opens when the
  waitlist passes a threshold. It's scarcity marketing, and it also keeps moderation manageable.
- **Seed before launch.** Commission local artists and campus art clubs to fill 30–50 walls,
  concentrated along routes students walk (E7, SLC, DC, the Laurier concourse, Uptown). This beats
  `seed.sql`'s three pieces by a wide margin. Sponsored/legal walls (§4) are also content seeding.
- **Events.** Frosh/orientation week, Hack the North (the team's own history), club fairs,
  "paint jam" nights. Each piece at an event is permanent advertising at that spot.
- **The reveal is the ad.** Walking up and seeing a piece resolve out of the smear is very
  filmable. Build **one-tap share of a screen recording** of the reveal, watermarked, with a deep
  link to the piece. TikTok/Reels/Shorts with UW creators will do more than paid ads.
- **Physical ↔ AR bridge.** Put QR stickers or posters at pieces ("there's art here"). On iOS, an
  **App Clip** and on Android an Instant App or web fallback lets someone see the piece without
  installing. The `web/` `/paint` compass painter already sketches this path. Give each piece its own
  URL with an OG image (the baked tile, §3) so shared links preview well.
- **Referrals tied to the currency**: invite → both get a cosmetic. Don't give out paint, since
  that's the game balance.
- **Growth metrics** to track: pieces discovered per session, D1/D7/D30 retention, the share of
  sessions that end in a paint or a discovery, K-factor from shares. Add analytics (PostHog) and
  crash reporting (Sentry) before launch. Right now there are none.
- **Paid acquisition**: basically don't, before you see retention. If you do, run small geo-targeted
  Instagram/TikTok campaigns within the geofence only. Installs from outside it churn immediately.
- **ASO**: name + subtitle ("AR graffiti — paint the real world"), and a preview video showing the
  reveal.
- **Ethical/legal line**: stay away from marketing that looks like it encourages real vandalism,
  both for Apple (§5.11) and for the relationship with the campus and city. "Legal walls, zero
  paint" is the pitch.

---

## 7. The currency system

### What exists

> **Status:** unchanged except that `paint_used` is now clamped server-side and painters can't edit
> their own counters, so the `paint_used` part of the balance can't be forged. Everything below is
> still to do.

`economy.ts`: `coins = floor(paint_used / 8) + bonus − spent`. `bonus`, `spent`, `claimed` and
`owned` live in **local settings (AsyncStorage)**, and `paint_used` is client-writable (0.2/0.3).
Reinstalling resets purchases, you can't restore on another device, and anyone can mint coins. The
tech overview also claims coins "impact your global ranking" and that upvotes earn currency, but
neither is implemented.

### Design

**Two currencies, deliberately separate:**

- **Soft currency** ("caps", or keep "coins"): earned only, never bought. Spent on base cosmetics.
- **Premium currency** or **direct IAP SKUs**: bought via IAP. Consider skipping premium currency
  entirely and **selling items directly**. It's simpler, more honest, and avoids the regulatory
  attention paid to virtual currencies in games. If you do add one, keep it non-transferable, never
  cashable, never gambling-adjacent. No loot boxes: Apple requires published odds, and Belgium and
  the Netherlands treat them as gambling.

**Server-authoritative ledger:**

```sql
wallet_ledger(
  id uuid, painter_id uuid, currency text,  -- 'soft' | 'premium'
  delta integer,                            -- + earn / − spend
  reason text,                              -- 'paint' | 'quest:walls' | 'discover' | 'upvote_received' | 'iap:<txn>' | 'purchase:<item>' | 'refund:<txn>' | 'admin'
  ref text unique,                          -- idempotency key (day+quest, iap txn id, …)
  created_at timestamptz
)
inventory(painter_id, item_id, acquired_at, source)
```

- No client insert/update policy. All writes go through `security definer` RPCs or edge functions
  that check the rules. Balance = `sum(delta)` (materialise it if needed).
- **IAP**: use **RevenueCat** (or StoreKit 2 / Play Billing server notifications directly). A
  webhook grants inventory or currency with the transaction id as `ref`, and refunds post a
  negative entry. Restore purchases then works on every device for free.

**Faucets (earning), each with daily caps and diminishing returns to limit farming:**

- Painting: coins per piece *that stays up and isn't reported* (paid out after moderation), not per
  unit of paint. Spraying at your bedroom wall for an hour should earn close to nothing.
- **Discovery**: first view of someone else's piece. It rewards walking around, which is the whole
  point, and it's also what makes the network feel alive for creators. Validate it with VPS/GPS
  plausibility (speed, jumps).
- **Upvotes received**: capped, ignoring votes from brand-new or related accounts.
- Quests (`MISSIONS`), validated server-side from the ledger/strokes, not from the client's
  `dayStats`.

**Sinks (spending):** cosmetics, stencils, event entry, "keep this piece alive for another N days"
(ties into retention, §3), and possibly crew/wall banners later.

**Things to avoid:** any exchange of currency for real money or between users (that becomes money
transmission and a laundering/fraud problem), paying for paint amount or regen, and paying to
overwrite other people's art.

**Balancing:** log every ledger entry, watch faucet/sink ratios weekly, and change the parameters
server-side (a `economy_config` table) rather than hard-coding them in `config.ts` and shipping a
build.

---

## 8. Things not on your list that will bite

- **Stalking / privacy (0.7, 2.5)** is the most likely source of real harm and bad press.
- **Property-owner complaints and city bylaws.** Milwaukee County tried to require permits for AR
  games in parks in 2017; a court blocked it, but expect similar attempts. Have the removal flow
  ready on day one.
- **Legal entity + insurance** before a UGC app with location data goes public.
- **Observability:** Sentry, product analytics, and Supabase backups/PITR. None exist today.
- **Ownership / licensing.** `LICENSE` is in the repo. Check whether it's permissive (it would let
  anyone clone the public app) and agree IP ownership among the hackathon team *now*, before there
  is money involved.
- **Battery / heat**: GPS at `BestForNavigation` every 0.5 m / 700 ms (`useLocation.ts`) plus
  AR plus 15 s polling will drain phones fast. Use lower accuracy when not in Create.
- **Web painter** (`web/` `/paint`) has the same write paths, so it needs the same RLS, rate limits
  and moderation. It's also the easiest place for scripted abuse, since there's no App Attest on
  the web. Consider making the web read-only.
