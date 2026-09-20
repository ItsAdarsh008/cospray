# deploy.md

Split into two, so they can be finished one at a time:

- **[goal1.md](goal1.md) — a web version anyone can join by scanning a QR code.** One screen: scan,
  type a name, draw, and everyone who scanned the same code sees it live. Mostly trimming the
  existing `web/` client. The shared backend it runs on is already set up and documented there.
- **[goal2.md](goal2.md) — Fresco running on the Galaxy S25.** The ARCore build: phone setup, the
  optional Cloud Anchors key, installing, and what to test on a real wall.

They're independent; both paint into the same Supabase project.

**Branches:** `main` is the web app and what Vercel deploys. `samsung-adarsh` is the Android /
ARCore line. `pixel-ui` is the iPhone line (the pixel-arcade UI on top of `main`). Each native
branch starts from `main`, so the web app rides along on all of them.
