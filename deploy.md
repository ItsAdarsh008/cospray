# deploy.md — point Fresco at your own Supabase

The app currently talks to someone else's Supabase project, which is why AR paint doesn't sync:
that project is missing the `anchor_id` column, so every AR stroke is refused. Your own project
takes about ten minutes to set up and you can run the migrations yourself.

Nothing here needs a native rebuild. The keys are read from `.env` when Metro bundles, so a
restart is enough.

---

## 1. Create the project

1. <https://supabase.com/dashboard> → **New project**.
2. Name it anything (`fresco`), pick the region closest to you (Canada Central / US East for
   Waterloo), and save the database password somewhere — you won't need it for the app, but you
   can't see it again.
3. Wait for it to finish provisioning (~2 min).

## 2. Run the SQL, in this order

**SQL Editor** → **New query** → paste the whole file → **Run**. All three are safe to re-run.

| # | File | What it makes |
|---|---|---|
| 1 | `supabase/schema.sql` | `painters`, `canvases`, `strokes`, `reports`, the counter triggers, the RLS policies, the `nearby_canvases` + `increment_views` RPCs, and realtime on `strokes` / `canvases` |
| 2 | `supabase/migration_ar.sql` | **the AR half**: `strokes.anchor_id`, `transform`, `viewer`, the `worldmaps` storage bucket + its policies, `set_world_map`, and the `delete own stroke` policy that undo needs |
| 3 | `supabase/seed.sql` | *optional* — three pieces around E7 so there's something to discover without a second phone |

Skipping step 2 is exactly the state you're in now: painting works locally, uploads fail, nothing
syncs. Don't skip it.

## 3. Turn on anonymous sign-in

**Authentication → Providers**:

- **Anonymous sign-ins → enable.** This is the app's normal identity: onboarding creates an
  anonymous user and the painter row is keyed to it.
- **Email → turn off "Confirm email"** (optional). If anonymous sign-in is off, the onboarding
  screen falls back to email + password, and with confirmation on, sign-up waits for a link.

## 4. Copy the keys

**Project Settings → API** (newer dashboards call it **API Keys**):

- **Project URL** → `EXPO_PUBLIC_SUPABASE_URL`
- **`anon` / publishable key** → `EXPO_PUBLIC_SUPABASE_KEY`

Use the publishable key, never `service_role`. The publishable key is meant to ship in a client;
RLS is what protects writes. `service_role` bypasses RLS entirely — if it ends up in the app
bundle, anyone can read and delete everything.

## 5. Point the app at it

`.env` in the repo root:

```sh
EXPO_PUBLIC_SUPABASE_URL=https://<your-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_KEY=<your publishable key>
```

`eas.json` → `build.development.env` — same two values, for cloud builds:

```json
"env": {
  "EXPO_PUBLIC_SUPABASE_URL": "https://<your-ref>.supabase.co",
  "EXPO_PUBLIC_SUPABASE_KEY": "<your publishable key>"
}
```

Then restart Metro so the new values get inlined:

```sh
npx expo start --dev-client -c
```

`-c` matters. `EXPO_PUBLIC_*` is baked into the bundle at transform time, so a plain reload can
keep serving the old URL from cache.

## 6. First run on the phone

Your saved painter belongs to the *old* project's auth user, so:

1. Open the app → **Profile → gear → Settings → SIGN OUT** (or **REDO ONBOARDING**).
2. Pick your tag again. That writes a fresh `painters` row in your project.

For a properly clean slate (old cached canvases still show in Explore / Vault otherwise), delete
the app from the phone and reinstall the dev client instead.

Queued strokes drain on their own: the backlog the old project kept refusing is capped at 120 and
gets retried against the new one, which now has the right columns.

## 7. Check it worked

Paint one stroke, then in the dashboard:

| Where | What you should see |
|---|---|
| **Table editor → painters** | one row, your tag |
| **Table editor → canvases** | a row at your lat/lng |
| **Table editor → strokes** | a row with `anchor_id` and `transform` **filled in** (not null) |
| **Storage → worldmaps** | a `<canvas-id>.arworldmap` file, ~5 s after you stop painting |
| **Metro terminal** | no `uploadStroke failed, queued` warnings |

If all five are right, a second phone (or `/world` on the web app) sees your paint live.

## 8. The companion website (optional)

`web/` is a separate Vite app with its own variable names — `web/.env` and `web/.env.production`:

```sh
VITE_SUPABASE_URL=https://<your-ref>.supabase.co
VITE_SUPABASE_KEY=<your publishable key>
```

If it's deployed on Vercel, set the same two in the project's **Environment Variables** and
redeploy — the values are baked in at build time there too.

## Troubleshooting

| What you see | What it means |
|---|---|
| `column strokes.anchor_id does not exist` | `migration_ar.sql` wasn't run. This is what was crashing the app: refused strokes pile up in the retry queue |
| `Anonymous sign-ins are disabled` | Step 3. Until then onboarding asks for email + password |
| `new row violates row-level security policy` | You're signed out, or the painter row is from the old project — sign out and redo onboarding |
| `Invalid API key` / everything offline | Wrong key, or Metro wasn't restarted with `-c` |
| Paint never reaches another phone | Realtime isn't on those tables — re-run `schema.sql` (the last block adds them to `supabase_realtime`) |
| Undo comes back after a refresh | The `delete own stroke` policy is missing — re-run `migration_ar.sql` |
| `Bucket not found` on world maps | `migration_ar.sql` again — it creates `worldmaps` |

## Notes

- **Going back** is just swapping the two values in `.env` and restarting Metro. Keep the old ones
  in a comment if you want the option during the demo.
- **Painting outside Waterloo**: the geofence is a 25 km circle in `src/config.ts` (`GEOFENCE`).
  Either move it, or flip **Settings → Paint anywhere** on the phone.
- **What doesn't move**: pieces painted against the old project stay there — you can't export from
  a project you don't own. Your own walls still render on your phone from its local cache.
- The App Group used by the widget (`group.com.hamzakhan.tagged` in `src/lib/widget.ts`) is an
  Apple thing, not a Supabase one. Your builds set `FRESCO_NO_WIDGET=1`, so it isn't used.
