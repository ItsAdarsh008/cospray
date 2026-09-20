# Goal 1 — a web version anyone can join by scanning a QR code

**Done when:** someone points their camera at a QR code, types a name, and is drawing seconds
later — and a second person who scans the same code sees those strokes appear live, both ways. No
accounts, no profile, no tabs. One screen.

The Android app is [goal2.md](goal2.md) and doesn't block this.

---

## Where it stands

You picked: **walls stay where they are** — GPS-anchored canvases inside the Waterloo geofence, so
people see the pieces (and each other) around them — and **camera passthrough** for the surface.
The QR is the way in, not a private room.

| | |
|---|---|
| No login — scanning signs you in anonymously | **done** |
| One screen: name prompt → paint, no tabs, no map, no leaderboard | **done** |
| Duplicate tags no longer dead-end you | **done** (ADARSH → ADARSH-2) |
| A QR on the landing page pointing at this site's own `/paint` | **done** |
| Deploy it so phones can reach it over HTTPS | **you** — see below |
| Two phones, one wall, live | **you** — the test at the end |

Verified locally in a browser: `/paint` goes straight to *pick your tag* with no email form, a tag
is accepted, and the paint screen loads behind it. What I can't check from here is a phone
actually spraying — camera, compass and GPS need the real thing.

## What changed in the code

- **`web/src/App.tsx`** — `signInAnonymously()` on load, so the first thing a scanner sees is the
  name prompt. The email form is still there as a fallback if anonymous sign-in is ever off, and
  it now says why it appeared. The three-tab shell (PAINT / MAP / BOARD) is gone; the screen is
  the wall. The settings sheet stayed, because that's where the colours and caps live — removing
  it turned the paint screen's own settings button into a dead end, which I caught by clicking it.
- **`web/src/data/sync.ts`** — `painters.name` is unique across the whole project, so the second
  person to type ADARSH used to be bounced back to the keyboard. Now it tries ADARSH-2, ADARSH-3
  and so on before giving up. Somebody who just scanned a code should not have to negotiate for a
  name.
- **`web/src/site/ScanToPaint.tsx`** — a "Scan to paint" panel on the landing page that renders a
  QR of that site's own `/paint` URL in the browser, so it's right on localhost and right in
  production without anyone regenerating an image.
- **Brand** — the web client still said TAGGED in three places; it says FRESCO now.

## What's left for you

**`main` is the web app** — it carries the QR flow, anonymous sign-in and the live Supabase keys,
and a root `vercel.json` that pins the build to `web/`. Native work sits on `samsung-adarsh`
(Android) and `pixel-ui` (iPhone) and is merged in deliberately.

In the Vercel project:

1. **Production Branch → `main`.** If it's already `main`, nothing to change — that's the point of
   the reshuffle.
2. **Root Directory → `web`** (or leave it at the repo root; the root `vercel.json` covers that).
   What must *not* happen is a deploy with no build step: served raw, `/` resolves to `index.ts`,
   the browser calls it `video/mp2t` and downloads it. That was the "download" file.
3. **Environment variables:** none needed — the publishable key is committed in
   `web/.env.production`. But if `VITE_SUPABASE_*` *are* set in the dashboard, Vite prioritises
   them over the committed file, so they must hold the new project's values or be deleted.
4. **Redeploy** with the build cache off, then open the site on a laptop — the landing page carries
   the QR.

iOS Safari only grants camera and motion over HTTPS, so phones need the deployed URL; `localhost`
won't do.

**Later web changes** go out with:

```powershell
git checkout main
git checkout samsung-adarsh -- web/    # or whichever branch has the change
git commit -am "web: ..." && git push
```

Send me the deployed URL and I'll check what's actually live — which Supabase project the bundle
points at, and whether the no-login flow made it in.

## Then: the test that says it's done

1. Scan the QR on phone 1. Type a name. You should be drawing without ever seeing a login.
2. Scan the same QR on phone 2, **standing next to phone 1**, and type a different name. (Within
   15 m you join the same wall; further apart you each start your own, which is the point of
   keeping walls geographic.)
3. Draw on phone 1 → it appears on phone 2 within a second or two, without either of you
   reloading. Draw on phone 2 → it comes back the other way.
4. Reload both. The wall still has everything on it — strokes are stored, not just broadcast.
5. Walk 30 m away and look back: the piece should still render (it fades in from ~35 m).
6. Hand the QR to someone who has never seen the app. From scan to first stroke, with nobody
   explaining anything, is the actual bar.

## The backend (already done)

Goal 1 used to be about this part, and it's finished. Your own Supabase project
(`xevbnegilqjyjzxhrcwo`) has the schema, the AR migration, the seed pieces and anonymous sign-in
turned on, and every client — phone app, website, painter — points at it:

```
ok  schema.sql ran (strokes table reachable)
ok  migration_ar.sql ran (anchor_id, transform, viewer)
ok  canvases carry a world map pointer
ok  nearby_canvases RPC exists
ok  worldmaps storage bucket exists
ok  anonymous sign-in enabled
```

`npm run supabase:check` re-runs that (`--anon` includes the sign-in test, which creates one
throwaway user).

**If you also run the phone app against this project:** restart Metro with
`npx expo start --dev-client -c` (`-c` matters — `EXPO_PUBLIC_*` is inlined at bundle time), and on
an iPhone that already had the app, sign out and redo onboarding, because the saved painter belongs
to the old project's auth user. Queued strokes drain by themselves; the backlog is capped at 120.

**Pointing at a different project later:** create it, paste `supabase/setup_all.sql` into the SQL
editor (it warns about destructive statements — on a fresh project there's nothing to lose), turn
on **Allow anonymous sign-ins** under Authentication → Sign In / Providers *and press Save changes
at the bottom*, copy the **publishable** key (never `service_role` — it bypasses RLS), then:

```powershell
node scripts/use_supabase.mjs https://<ref>.supabase.co <publishable key>
```

That writes `.env`, `web/.env`, `web/.env.production` and `eas.json`, and re-runs the checks.

## What will bite

- **Tags are unique** project-wide, which is why duplicates now get a `-2` suffix instead of a
  rejection. Six tries, then it does ask for a different name.
- **Every scan creates an auth user.** Anonymous sign-ins are cheap but they are rows, and Supabase
  counts monthly active users. Fine for a demo, worth knowing before it's on a poster.
- **iOS Safari needs a gesture** before camera, motion and audio — the paint screen's START button
  already covers that, so it has to stay.
- **Sync is per wall, not per person.** Everyone on the wall sees everything; there's no undo for
  someone else's paint and no moderation beyond the existing report flow.
- **Realtime on the free tier** is fine for a handful of painters. A crowd is untested.
- **The paint screen animates before you press START.** Its render loop runs as soon as the screen
  mounts, which on a phone means battery burn while somebody reads the intro. Pre-existing, not
  from this work, worth fixing if the QR ends up on a poster.
- **Indoor GPS drifts.** Two people in the same room can land on separate walls, since joining is
  still by 15 m proximity. If that shows up in testing, the fix is to widen the join radius for
  web clients or to put a wall id in the QR link after all.
