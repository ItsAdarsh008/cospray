# Tagged web — module contracts

Mobile-web port of the native app in `../src` (React Native). Same Supabase project, same tables,
same canvas model. Read the native file named for each module before writing the web one — most
are direct ports. Platform differences: no volume buttons (two on-screen HOLD buttons), no ARKit
(compass-anchored walls, like the native fallback `../src/screens/PaintScreen.tsx`), Web APIs
instead of Expo modules. Files below are the ONLY files each module owns; import the others by
these signatures.

Shared, already written: `config.ts`, `types.ts`, `store.ts`, `lib/geo.ts`, `lib/ids.ts`,
`lib/supabase.ts`.

## hooks/usePose.ts  (native ref: ../src/hooks/usePose.ts)
```ts
export type PoseListener = (p: Pose) => void;
export function startPose(opts: { onShake?: (magG: number) => void }): Promise<'granted' | 'denied' | 'unsupported'>;
  // Must be called from a user gesture on iOS (DeviceOrientationEvent.requestPermission / DeviceMotionEvent.requestPermission).
export function getPose(): Pose;             // latest, cheap, for rAF loops
export function subscribePose(fn: PoseListener): () => void;
export function usePose(): Pose;             // React state, throttled to ~20 Hz for HUD use
```
Yaw = compass heading of the BACK CAMERA axis (0 = north, clockwise), pitch = camera elevation
(deg, + up), roll = clockwise tilt of the phone (deg). Build from `deviceorientation`
(alpha/beta/gamma, W3C Z-X'-Y'' intrinsic) → rotation matrix → camera axis (device −Z). On iOS
alpha is relative: replace alpha with `360 - webkitCompassHeading` when present. On Android prefer
`deviceorientationabsolute`. Shake = `devicemotion.acceleration` magnitude > SHAKE_ACCEL_THRESHOLD g,
debounced 120 ms.

## paint/Wall.ts + paint/PaintLayer.tsx  (native refs: ../src/paint/Wall.ts, ../src/paint/PaintLayer.tsx)
```ts
export class Wall { constructor(id: string); applyPoint(p: StrokePoint, color: string, rng: () => number): void; replay(stroke: Stroke): void; readonly canvas: HTMLCanvasElement /* WALL_W×WALL_H */; }
export function getWall(id: string): Wall; export function hasWall(id: string): boolean;
export type WallView = { canvasId: string; heading: number; resolve: number /* 0 blurred/invisible → 1 crisp */ };
export function PaintLayer(props: { walls: WallView[] }): JSX.Element;
  // full-screen <canvas> under the HUD; rAF loop reads getPose() + useStore.getState().settings.hfov
  // and draws each wall raster with the same transform as the native PaintLayer (translate to centre,
  // rotate by −roll, offset by (Δyaw − WALL_YAW_RANGE)·s and −(WALL_PITCH_RANGE − pitch)·s, scale s/WALL_PX_PER_DEG).
  // resolve < 1 → ctx.filter blur + reduced alpha. Redraw when store.wallVersion bumps or pose changes.
```
Wall.applyPoint must reproduce the native spray look (halo / 5 scattered soft body dabs / dense core /
3 speckles; drips for kind 1) using radial gradients on a 2D context.

## hooks/useSprayEngine.ts  (native ref: ../src/hooks/useSprayEngine.ts)
```ts
export function useSprayEngine(): { start: (side: Side) => void; end: (side: Side) => void; onShake: (magG: number) => void;
  blocker: React.MutableRefObject<Blocker>; held: React.MutableRefObject<Side | null>; sprayingNow: React.MutableRefObject<boolean> };
```
Identical rules: geofence, shake charge, paint economy, dwell → drip, 30 Hz rAF tick, stroke record
uploaded via `data/sync.uploadStroke` on release, `createCanvas` for a fresh spot. Haptics via
`navigator.vibrate` when available. Sound via `audio/sfx`.

## audio/sfx.ts  (native ref: ../src/audio/sfx.ts)
```ts
export const sfx: { init(): Promise<void> /* user gesture */; enabled: boolean; click(): void; rattle(strength?: number): void; emptyRattle(): void; pool(): void; setHiss(on: boolean, strength: number, near: number): void };
```
Web Audio; files at `/sfx/{hiss,rattle,empty_rattle,pool,click}.wav`; hiss loops with gain/playbackRate.

## data/sync.ts  (native ref: ../src/data/sync.ts)
Same exports: `applyStroke, ensurePainter(userId, name), fetchPainter(userId), loadCached, loadNearby(lat,lng),
createCanvas, uploadStroke, flushPending, subscribeRealtime, incrementViews, reportCanvas, fetchLeaderboard, fetchAllCanvases`.
localStorage instead of AsyncStorage. PLUS: AR strokes (anchor_id set) must be projected into compass
points before `applyStroke`: for each [u,v,r,a,kind] compute world p = T·(u,0,−v,1) (T column-major),
yaw = wrap360(atan2(p.x, −p.z)·180/π) relative to canvas.heading via wrapDiff, pitch = atan2(p.y, hypot(p.x,p.z)),
size = r / max(dist, AR_MIN_DISTANCE_M) · 180/π, drips: length likewise. Export `projectArStroke(s: Stroke, c: Canvas): Stroke`.

## hooks/useDiscovery.ts  (native ref: ../src/hooks/useDiscovery.ts) — same shape, uses getPose().
## hooks/useLocation.ts — `navigator.geolocation.watchPosition` → store.setLocation; returns 'pending'|'granted'|'denied'.

## screens/*.tsx + components/*.tsx + App.tsx (native refs: ../src/screens/*, ../src/components/*, ../App.tsx)
`AuthScreen`, `NameScreen({userId})`, `PaintScreen`, `MapScreen` (Leaflet + OSM tiles), `LeaderboardScreen`,
`SettingsScreen` (modal), `components/HUD.tsx` (Reticle, PaintMeters, CanMeter, BlockerBanner, HoldButtons),
`components/DiscoveryOverlay.tsx`. Plain CSS (`src/styles.css`), dark theme #0b0b0f, accent #ff2d95, mobile-first,
100dvh, safe-area insets, no horizontal scroll. Camera: `<video>` from getUserMedia({video:{facingMode:'environment'}}),
object-fit cover, behind PaintLayer. A "Start" gate button (needed for camera/sensor/audio permissions on iOS) before PaintScreen goes live.
