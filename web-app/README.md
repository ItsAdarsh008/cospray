> **`main` is the web app, and what Vercel builds.** The QR entry flow, anonymous sign-in and the
> keys for the live Supabase project live here. Native work happens on its own branches and is
> merged in deliberately: `samsung-adarsh` (Android / ARCore) and `pixel-ui` (iPhone).
>
> A `vercel.json` at the repo root pins the build (`cd web-app && npm run build`, output `web/dist`,
> framework detection off), so the site builds whether or not the Root Directory is set to `web`.
> Without it, Vercel sees the Expo app at the root and publishes something that isn't a website —
> the browser just downloads a file.
>
> Vercel settings: **Production Branch** `main`, **Root Directory** `web-app` (or leave it at the repo
> root — the root `vercel.json` handles it). The Supabase keys
> are committed in `web-app/.env.production`, so no dashboard environment variables are needed — and
> if any `VITE_SUPABASE_*` variables *are* set there they win over the committed file, so they
> must hold the same values or be deleted.
>
> To pull web changes made on another branch: `git checkout main && git checkout <branch> -- web/`.

# Tagged — mobile web

Phone-browser version of Tagged (Vite + React 19 + TypeScript). Same Supabase project, tables,
auth and canvas model as the iPhone app in the repo root, so both clients paint the same walls.

```sh
cd web
npm install
npm run dev        # https is needed on a phone for camera/sensors: use `npx vite --host` + a tunnel, or the Vercel URL
npm run build      # tsc + vite → dist/
```

Live: https://tagged-web-devhamzakhans-projects.vercel.app (Vercel project `tagged-web`,
root directory `web`, deploys from GitHub `main`).

## What's different from the iPhone app

| | iPhone app | web |
|---|---|---|
| surfaces | ARKit planes + world maps | compass-anchored walls (camera + deviceorientation) |
| trigger | hold volume buttons | two on-screen HOLD buttons (VOL+/VOL− equivalents) |
| sensors | expo-sensors fusion | `deviceorientation` (+ `webkitCompassHeading` on iOS), `devicemotion` for shake |
| sound | expo-audio | Web Audio, same generated WAVs in `public/sfx` |
| haptics | expo-haptics | `navigator.vibrate` where supported (Android) |
| widget | WidgetKit | — |

## Sync between clients

- Web strokes are compass strokes: `points = [[yaw, pitch, size°, alpha, kind], …]`, `anchor_id = null`.
  The iPhone app renders them as an overlay on top of its AR view (same renderer as its fallback).
- iPhone AR strokes carry an anchor transform in a north-aligned metric frame (ARKit
  `gravityAndHeading`, origin ≈ the canvas GPS point). The web projects each dab onto the compass
  sphere in `src/data/sync.ts` (`projectArStroke`) so pieces painted in AR show up in the browser.
- Realtime: both subscribe to `strokes` inserts; polling every 15 s as backup; local-first with a
  retry queue in `localStorage`.

## Permissions on iOS Safari

Camera, motion/orientation and audio all need a user gesture, so the paint screen starts behind a
single **START PAINTING** button. Add to Home Screen for a full-screen PWA.
