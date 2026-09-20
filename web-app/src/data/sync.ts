import { hasBackend, supabase } from '../lib/supabase';
import { AR_MIN_DISTANCE_M, DISCOVERY_SHIMMER_RADIUS_M, MAG_DECLINATION_DEG, NEARBY_FETCH_RADIUS_M } from '../config';
import { haversineM, wrap360, wrapDiff } from '../lib/geo';
import { useStore } from '../store';
import { getWall } from '../paint/Wall';
import type { Canvas, Painter, Stroke, StrokePoint } from '../types';

/**
 * Local-first sync (port of the native src/data/sync.ts). Every canvas/stroke is applied to the
 * store + wall raster immediately and cached in localStorage; Supabase is the shared source of
 * truth when reachable. Strokes that fail to upload are queued and retried, so a flaky network
 * never blocks painting.
 *
 * Web-only addition: strokes painted with the iPhone's ARKit view carry `anchor_id` + a
 * north-aligned metric `transform`. They are projected onto the compass sphere
 * (`projectArStroke`) before being replayed, so paint from the phone shows on the web. The store
 * and the cache keep the raw row (metres + transform); projection happens at replay time.
 * The native module's ARWorldMap upload/download helpers have no web equivalent.
 *
 * Main-thread budget: the 30 Hz spray tick and the rAF paint layer share this thread, so history
 * is replayed onto walls in idle slices, nearby polls only fetch rows newer than what we hold,
 * and cache writes are debounced, budgeted and run from idle callbacks (never per stroke).
 */

const CACHE_CANVASES = 'tagged:cache:canvases';
const CACHE_STROKES = 'tagged:cache:strokes:';
const PENDING_LEGACY = 'tagged:pending';   // shared queue from before it was scoped per painter
const PENDING_OF = 'tagged:pending:';       // + painter id: rows only that painter can upload (RLS)
const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;
const PAGE = 1000;                    // PostgREST caps a single select at 1000 rows; page through stroke history
const CACHE_DEBOUNCE_MS = 2000;       // coalesce cache writes this long after the last change
const CACHE_BYTE_BUDGET = 2_500_000;  // stroke JSON written per flush; iOS Safari's localStorage quota is ~5 MB
const REPLAY_CHUNK = 40;              // strokes replayed per idle slice (each dab is ~10 gradient fills)
const FALLBACK_STANDOFF_M = 1.5;      // assumed painter-to-wall distance for AR rows without `viewer`

// ---- localStorage (quota / private-mode safe) --------------------------------------------

function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function lsRemove(key: string) {
  try { localStorage.removeItem(key); } catch {}
}
/** Drops stroke caches for every canvas not in `keep` (quota recovery, and walls we walked away from). */
function evictStrokeCaches(keep: Set<string>) {
  try {
    const dead: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CACHE_STROKES) && !keep.has(k.slice(CACHE_STROKES.length))) dead.push(k);
    }
    for (const k of dead) localStorage.removeItem(k);
  } catch {}
}
function lsSetWithEviction(key: string, value: string): boolean {
  if (lsSet(key, value)) return true;
  evictStrokeCaches(new Set(Object.keys(useStore.getState().canvases)));
  return lsSet(key, value);
}
function lsJson<T>(key: string, fallback: T): T {
  const raw = lsGet(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** Runs `fn` when the main thread is idle (setTimeout where requestIdleCallback is missing, e.g. older Safari). */
function idle(fn: (deadline?: IdleDeadline) => void) {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') window.requestIdleCallback(fn, { timeout: 4000 });
  else setTimeout(() => fn(), 0);
}

// ---- row validation ----------------------------------------------------------------------

function isStrokeRow(s: unknown): s is Stroke {
  if (!s || typeof s !== 'object') return false;
  const r = s as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.canvas_id === 'string' && typeof r.color === 'string' && Array.isArray(r.points);
}
function isCanvasRow(c: unknown): c is Canvas {
  if (!c || typeof c !== 'object') return false;
  const r = c as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.lat === 'number' && typeof r.lng === 'number' && typeof r.heading === 'number';
}
function isTransform(t: unknown): t is number[] {
  return Array.isArray(t) && t.length === 16 && t.every((x) => typeof x === 'number' && Number.isFinite(x));
}
/** An ARKit stroke that can be projected: anchor set and a full 4×4 transform. */
function isArStroke(s: Stroke) {
  return !!s.anchor_id && isTransform(s.transform);
}

// ---- AR → compass projection --------------------------------------------------------------

/**
 * Where the painter stood, in the stroke's (north-aligned, metric) frame.
 * Rows that carry `viewer` (camera world position at spray time) use it directly. Older rows
 * only have the anchor: the AR session origin is wherever the app was launched, not where the
 * painter stood (a 30 m walk would make the paint 50× too small and put it at the wrong heading),
 * so we assume they stood FALLBACK_STANDOFF_M in front of the anchor centre c = T[12..14]. "In
 * front" is the anchor normal n = T[4..6] (column 1: +Y of a plane anchor / raycast hit) with its
 * sign chosen to face back along the canvas heading the painter was looking at when they started
 * (native pickCanvas records that heading), or straight back along that heading when the normal is
 * not horizontal enough to tell; floors and ceilings put the viewer above the anchor instead.
 */
function viewerOf(s: Stroke, T: number[], c: Canvas): [number, number, number] {
  const v = s.viewer;
  if (Array.isArray(v) && v.length >= 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])) return [v[0], v[1], v[2]];
  const cx = T[12], cy = T[13], cz = T[14];
  let nx = T[4], nz = T[6];
  const ny = T[5];
  const nl = Math.hypot(nx, ny, nz);
  if (nl > 1e-6 && Math.abs(ny / nl) > 0.7) return [cx, cy + FALLBACK_STANDOFF_M, cz]; // horizontal surface
  // viewing direction in the AR frame (−Z = north, +X = east); the canvas heading is magnetic, the frame is true
  const hTrue = (c.heading + MAG_DECLINATION_DEG) * D2R;
  const fx = Math.sin(hTrue), fz = -Math.cos(hTrue);
  let bx = -fx, bz = -fz; // default: straight back along the viewing direction
  const nh = Math.hypot(nx, nz);
  if (nh > 1e-6) {
    nx /= nh; nz /= nh;
    const facing = -(nx * fx + nz * fz); // > 0: the normal points back toward the painter
    if (Math.abs(facing) > 0.3) { const sgn = facing > 0 ? 1 : -1; bx = sgn * nx; bz = sgn * nz; }
  }
  return [cx + bx * FALLBACK_STANDOFF_M, cy, cz + bz * FALLBACK_STANDOFF_M];
}

/**
 * Projects an ARKit stroke onto the compass sphere of its canvas. Points are [u, v, r, a, kind]
 * in metres in the anchor plane (u = anchor +X, v = anchor −Z); the transform is 16 floats,
 * column-major (m[c*4+r]), in a north-aligned frame (−Z = TRUE north, +X = east, +Y = up). Each
 * point becomes a world position, then a yaw (relative to the canvas heading) / pitch / angular
 * size as seen from where the painter stood (`viewerOf`). ARKit's frame is true-north aligned
 * while canvas headings are magnetic, so the yaw is shifted by the local declination. For drips
 * (kind 1) the third value is the run length in metres and converts the same way.
 * Returns a compass-style stroke (anchor_id null) with the same id so speckle stays deterministic.
 * Malformed points are dropped; a malformed transform yields an empty stroke.
 */
export function projectArStroke(s: Stroke, c: Canvas): Stroke {
  const T = s.transform;
  const points: StrokePoint[] = [];
  if (isTransform(T) && Array.isArray(s.points) && Number.isFinite(c.heading)) {
    const [vx, vy, vz] = viewerOf(s, T, c);
    for (const raw of s.points) {
      if (!Array.isArray(raw) || raw.length < 4) continue;
      const u = Number(raw[0]), v = Number(raw[1]), r = Number(raw[2]), a = Number(raw[3]);
      const kind = raw.length > 4 && Number(raw[4]) === 1 ? 1 : 0;
      if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(r) || !Number.isFinite(a)) continue;
      // p = T · (u, 0, −v, 1)   (column 0 = T[0..3], column 2 = T[8..11], column 3 = T[12..15])
      let px = T[0] * u - T[8] * v + T[12];
      let py = T[1] * u - T[9] * v + T[13];
      let pz = T[2] * u - T[10] * v + T[14];
      const pw = T[3] * u - T[11] * v + T[15];
      // ARKit transforms are affine (pw = 1); tolerate a general matrix anyway
      if (!Number.isFinite(pw) || Math.abs(pw) < 1e-9) continue;
      if (pw !== 1) { px /= pw; py /= pw; pz /= pw; }
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
      // as seen from the painter's position
      const dx = px - vx, dy = py - vy, dz = pz - vz;
      const horiz = Math.hypot(dx, dz);
      const yawTrue = wrap360(Math.atan2(dx, -dz) * R2D); // 0 = true north, clockwise
      const yaw = wrapDiff(wrap360(yawTrue - MAG_DECLINATION_DEG), c.heading); // magnetic = true − declination
      const pitch = Math.atan2(dy, horiz) * R2D;
      const dist = Math.max(Math.hypot(dx, dy, dz), AR_MIN_DISTANCE_M);
      const size = (r / dist) * R2D;
      if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || !Number.isFinite(size)) continue;
      points.push([yaw, pitch, size, a, kind]);
    }
  }
  return { ...s, points, anchor_id: null, transform: null, viewer: null };
}

// ---- apply -------------------------------------------------------------------------------

/**
 * Adds a stroke to the store and paints it onto its wall. Returns false if it was already known
 * or malformed. `cache: false` skips the (debounced) cache write — for rows that came FROM the cache.
 */
export function applyStroke(s: Stroke, opts: { cache?: boolean } = {}) {
  if (!isStrokeRow(s)) return false;
  const st = useStore.getState();
  const ar = isArStroke(s);
  // an AR stroke needs its canvas heading to be projected; leave it for a later apply if unknown
  const canvas = ar ? st.canvases[s.canvas_id] : undefined;
  if (ar && !canvas) return false;
  if (!st.addStroke(s)) return false;
  if (!s.anchor_id) {
    getWall(s.canvas_id).replay(s);
    st.bumpWalls();
  } else if (ar && canvas) {
    getWall(s.canvas_id).replay(projectArStroke(s, canvas));
    st.bumpWalls();
  }
  // anchor_id set but no usable transform: kept in the store (counts, cache) but nothing to draw
  if (opts.cache !== false) scheduleCache(s.canvas_id);
  return true;
}

/** Replays strokes onto their walls a slice at a time so a big history never stalls a frame. */
function applyStrokesChunked(rows: Stroke[], cache: boolean): Promise<void> {
  if (!rows.length) return Promise.resolve();
  return new Promise((resolve) => {
    let i = 0;
    const opts = { cache };
    const step = (deadline?: IdleDeadline) => {
      const end = Math.min(rows.length, i + REPLAY_CHUNK);
      while (i < end) applyStroke(rows[i++], opts);
      while (deadline && i < rows.length && deadline.timeRemaining() > 4) applyStroke(rows[i++], opts);
      if (i < rows.length) idle(step); else resolve();
    };
    idle(step);
  });
}

// ---- painters ----------------------------------------------------------------------------

/**
 * Painter row for the signed-in user (id = auth uid). Insert-only: the tag prompt must never
 * rename an existing painter (an upsert on id would, and RLS "own painter" allows the update), so
 * a duplicate on the primary key means this account already has a tag and that row is returned.
 * Throws with a readable message on failure.
 */
export async function ensurePainter(userId: string, name: string): Promise<Painter> {
  // painters.name is unique project-wide. Somebody who just scanned a QR code shouldn't be sent
  // back to the keyboard because a stranger already took the tag, so try ADARSH, ADARSH-2, ADARSH-3.
  const base = name.slice(0, 18);
  for (let attempt = 1; attempt <= 6; attempt++) {
    const candidate = attempt === 1 ? name : `${base}-${attempt}`;
    const { data, error } = await supabase.from('painters').insert({ id: userId, name: candidate }).select().single();
    if (!error) {
      useStore.getState().setOnline(true);
      return { id: data.id, name: data.name, paint_used: data.paint_used, strokes: data.strokes };
    }
    if (error.code !== '23505') throw new Error(error.message);
    const text = `${error.message} ${error.details ?? ''}`;
    if (/painters_pkey|\(id\)/.test(text)) {
      // this browser already has a painter row: keep the tag it picked before
      const existing = await fetchPainter(userId);
      if (existing) { useStore.getState().setOnline(true); return existing; }
      throw new Error(error.message);
    }
  }
  throw new Error('That tag is taken — pick another.');
}

/** Existing painter row for a signed-in user, or null if they haven't picked a tag yet. */
export async function fetchPainter(userId: string): Promise<Painter | null> {
  const { data, error } = await supabase.from('painters').select('*').eq('id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { id: data.id, name: data.name, paint_used: data.paint_used, strokes: data.strokes } : null;
}

// ---- cache -------------------------------------------------------------------------------

const dirtyCanvases = new Set<string>();
let cacheTimer: number | null = null;

/** Queues a cache write (canvas list + the given canvas's strokes); coalesced and run off the hot path. */
function scheduleCache(canvasId?: string) {
  if (canvasId) dirtyCanvases.add(canvasId);
  if (cacheTimer != null) return;
  cacheTimer = window.setTimeout(() => { cacheTimer = null; idle(() => flushCache()); }, CACHE_DEBOUNCE_MS);
}

/**
 * Writes the canvas list and the changed stroke lists of walkable canvases (within
 * DISCOVERY_SHIMMER_RADIUS_M, nearest first) under a byte budget, and drops stroke caches for
 * canvases we walked away from. A write that hits the quota is not retried here.
 */
function flushCache() {
  if (cacheTimer != null) { clearTimeout(cacheTimer); cacheTimer = null; }
  try {
    const st = useStore.getState();
    const all = Object.values(st.canvases);
    lsSetWithEviction(CACHE_CANVASES, JSON.stringify(all));
    const loc = st.location;
    const near = all
      .map((c) => ({ id: c.id, d: loc ? haversineM(loc.lat, loc.lng, c.lat, c.lng) : 0 }))
      .filter((x) => x.d <= DISCOVERY_SHIMMER_RADIUS_M)
      .sort((a, b) => a.d - b.d);
    let budget = CACHE_BYTE_BUDGET;
    const keep = new Set<string>();
    for (const { id } of near) {
      if (!dirtyCanvases.has(id)) { keep.add(id); continue; }
      const json = JSON.stringify(st.strokes[id] ?? []);
      if (json.length > budget) continue;
      if (lsSetWithEviction(CACHE_STROKES + id, json)) { keep.add(id); budget -= json.length; }
    }
    if (loc) evictStrokeCaches(keep);
    dirtyCanvases.clear();
  } catch {}
}

if (typeof window !== 'undefined') {
  // a pending debounced write must not be lost when the tab closes
  window.addEventListener('pagehide', () => { if (dirtyCanvases.size || cacheTimer != null) flushCache(); });
}

export async function loadCached() {
  try {
    const canvases = lsJson<unknown[]>(CACHE_CANVASES, []).filter(isCanvasRow);
    if (!canvases.length) return;
    useStore.getState().setCanvases(canvases);
    const rows: Stroke[] = [];
    for (const c of canvases) for (const s of lsJson<unknown[]>(CACHE_STROKES + c.id, [])) if (isStrokeRow(s)) rows.push(s);
    await applyStrokesChunked(rows, false);
  } catch {}
}

// ---- canvases / strokes ------------------------------------------------------------------

/** Canvases whose full stroke history has been fetched this session. */
const fetchedCanvases = new Set<string>();
/**
 * Newest server `created_at` among all fetched strokes (server clock, same format on every row):
 * the next poll only asks for rows at or after it, so the steady state moves no history at all.
 */
let strokesSince: string | null = null;
let nearbyInFlight: Promise<void> | null = null;

async function fetchStrokes(ids: string[], since: string | null): Promise<Stroke[]> {
  const out: Stroke[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from('strokes').select('*').in('canvas_id', ids);
    if (since) q = q.gte('created_at', since);
    const { data, error } = await q.order('created_at').order('id').range(from, from + PAGE - 1);
    if (error) throw error;
    const raw = (data ?? []) as unknown[];
    out.push(...raw.filter(isStrokeRow));
    if (raw.length < PAGE) break;
  }
  return out;
}

export async function loadNearby(lat: number, lng: number) {
  if (!hasBackend) return;
  if (nearbyInFlight) return nearbyInFlight; // the 15 s poll must not stack up behind a slow refresh
  nearbyInFlight = (async () => {
    try {
      const { data, error } = await supabase.rpc('nearby_canvases', { qlat: lat, qlng: lng, radius_m: NEARBY_FETCH_RADIUS_M });
      if (error) throw error;
      const canvases = ((data ?? []) as unknown[]).filter(isCanvasRow);
      const st = useStore.getState();
      st.setOnline(true);
      st.setCanvases(canvases);
      scheduleCache();
      // never-seen canvases get their whole history; the rest only rows newer than what we hold
      const fresh = canvases.filter((c) => !fetchedCanvases.has(c.id)).map((c) => c.id);
      const known = canvases.filter((c) => fetchedCanvases.has(c.id)).map((c) => c.id);
      const rows: Stroke[] = [];
      if (fresh.length) rows.push(...await fetchStrokes(fresh, null));
      if (known.length) rows.push(...await fetchStrokes(known, strokesSince));
      for (const id of fresh) fetchedCanvases.add(id);
      for (const r of rows) if (typeof r.created_at === 'string' && (!strokesSince || r.created_at > strokesSince)) strokesSince = r.created_at;
      await applyStrokesChunked(rows, true);
    } catch (e) {
      console.warn('loadNearby failed', e);
      useStore.getState().setOnline(false);
    } finally {
      nearbyInFlight = null;
    }
  })();
  return nearbyInFlight;
}

function canvasRow(c: Canvas) {
  return {
    id: c.id, lat: c.lat, lng: c.lng, heading: c.heading, title: c.title,
    author_id: isLocalId(c.author_id) ? null : c.author_id, author_name: c.author_name,
  };
}

/** Canvas inserts still in flight, so a stroke released a moment after the first dab waits for its FK target. */
const canvasInserts = new Map<string, Promise<void>>();

export async function createCanvas(c: Canvas) {
  const st = useStore.getState();
  st.upsertCanvas(c);
  scheduleCache(c.id);
  if (!hasBackend) return;
  const p = (async () => {
    try {
      const { error } = await supabase.from('canvases').insert(canvasRow(c));
      if (error) throw error;
    } catch (e) { console.warn('createCanvas failed', e); }
  })();
  canvasInserts.set(c.id, p);
  p.finally(() => { if (canvasInserts.get(c.id) === p) canvasInserts.delete(c.id); });
  await p;
}

type StrokeRow = {
  id: string; canvas_id: string; author_id: string | null; author_name: string; color: string; cap: Stroke['cap'];
  points: Stroke['points']; paint_used: number; anchor_id: string | null; transform: number[] | null;
};

// ---- pending queue (per painter: RLS only lets a row's author upload it) -------------------

function pendingKey(painterId: string) { return PENDING_OF + painterId; }
function readPendingRaw(key: string): StrokeRow[] {
  const q = lsJson<unknown>(key, []);
  return Array.isArray(q) ? (q.filter(isStrokeRow) as StrokeRow[]) : [];
}
function writePending(painterId: string, q: StrokeRow[]) {
  if (q.length) lsSetWithEviction(pendingKey(painterId), JSON.stringify(q));
  else lsRemove(pendingKey(painterId));
}
function enqueuePending(painterId: string, row: StrokeRow) {
  const q = readPendingRaw(pendingKey(painterId));
  if (!q.some((r) => r.id === row.id)) q.push(row);
  writePending(painterId, q);
}
/**
 * My queued rows. A queue from before it was scoped per painter is split up on first read: other
 * painters' rows are parked under their own key (they flush when that painter signs in here),
 * ownerless rows can never pass RLS and are dropped.
 */
function readPending(me: string): StrokeRow[] {
  const legacy = readPendingRaw(PENDING_LEGACY);
  if (legacy.length) {
    const byOwner = new Map<string, StrokeRow[]>();
    for (const r of legacy) {
      if (!r.author_id || isLocalId(r.author_id)) { console.warn('dropping ownerless pending stroke', r.id); continue; }
      const list = byOwner.get(r.author_id) ?? [];
      list.push(r);
      byOwner.set(r.author_id, list);
    }
    for (const [owner, rows] of byOwner) for (const r of rows) enqueuePending(owner, r);
  }
  lsRemove(PENDING_LEGACY);
  return readPendingRaw(pendingKey(me));
}

export async function uploadStroke(s: Stroke) {
  scheduleCache(s.canvas_id);
  if (!hasBackend) return;
  // web strokes are compass-anchored: anchor_id / transform are always null here
  const row: StrokeRow = {
    id: s.id, canvas_id: s.canvas_id, author_id: isLocalId(s.author_id) ? null : s.author_id,
    author_name: s.author_name, color: s.color, cap: s.cap, points: s.points, paint_used: s.paint_used,
    anchor_id: s.anchor_id ?? null, transform: s.transform ?? null,
  };
  try {
    await canvasInserts.get(s.canvas_id); // fresh spot: let the canvas row land first
    const { error } = await supabase.from('strokes').insert(row);
    if (error) throw error;
    useStore.getState().setOnline(true);
  } catch (e) {
    console.warn('uploadStroke failed, queued', e);
    useStore.getState().setOnline(false);
    if (row.author_id) { try { enqueuePending(row.author_id, row); } catch {} }
  }
}

/** PostgREST errors that no retry can fix: RLS (42501), bad input (22xxx), FK / not-null / check (23xxx), unknown column (schema not migrated). */
function isPermanentError(e: { code?: string } | null | undefined) {
  const code = e?.code ?? '';
  return /^(42|22|23)/.test(code) || code === 'PGRST204';
}

let flushing: Promise<void> | null = null;

export async function flushPending() {
  if (!hasBackend) return;
  if (flushing) return flushing; // the 15 s timer and the `online` event must not race on the queue
  flushing = (async () => {
    try {
      const st = useStore.getState();
      const me = st.painter?.id;
      if (!me || isLocalId(me)) return; // nothing can pass RLS until its author is signed in
      const q = readPending(me);
      if (!q.length) return;
      // a canvas created while offline never reached the server; (re)insert our own canvases behind
      // the queued strokes first or their FK would fail on every retry (existing rows are skipped)
      const owned = [...new Set(q.map((r) => r.canvas_id))]
        .map((id) => st.canvases[id])
        .filter((c): c is Canvas => !!c && c.author_id === me);
      if (owned.length) {
        const { error: ce } = await supabase.from('canvases').upsert(owned.map(canvasRow), { onConflict: 'id', ignoreDuplicates: true });
        if (ce) console.warn('flushPending: canvas upsert failed', ce);
      }
      const done = new Set<string>();
      // ON CONFLICT DO NOTHING: rows that already landed are skipped without needing an UPDATE policy
      const { error } = await supabase.from('strokes').upsert(q, { onConflict: 'id', ignoreDuplicates: true });
      if (!error) {
        for (const r of q) done.add(r.id);
        useStore.getState().setOnline(true);
      } else {
        // one bad row must not block the rest: retry individually, drop what can never land
        for (const row of q) {
          const { error: e1 } = await supabase.from('strokes').upsert(row, { onConflict: 'id', ignoreDuplicates: true });
          if (!e1) done.add(row.id);
          else if (isPermanentError(e1)) { console.warn('dropping pending stroke that can never upload', row.id, e1.code, e1.message); done.add(row.id); }
        }
      }
      // remove only what was flushed: strokes queued while the request was in flight stay queued
      if (done.size) writePending(me, readPendingRaw(pendingKey(me)).filter((r) => !done.has(r.id)));
    } catch {} finally {
      flushing = null;
    }
  })();
  return flushing;
}

export function subscribeRealtime() {
  if (!hasBackend) return () => {};
  const onStroke = (row: unknown) => {
    if (!isStrokeRow(row)) return;
    if (!useStore.getState().canvases[row.canvas_id]) return; // not nearby / unknown canvas
    applyStroke(row);
  };
  const ch = supabase
    .channel('tagged')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'strokes' }, (payload) => onStroke(payload.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'strokes' }, (payload) => onStroke(payload.new))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'canvases' }, (payload) => {
      const c = payload.new as unknown;
      if (!isCanvasRow(c)) return;
      // only walls we could walk to: every canvas in the store gets its strokes streamed in and a
      // 2160×1440 raster allocated, and iOS caps total canvas memory per page. Far pieces still
      // show on the map through fetchAllCanvases.
      const loc = useStore.getState().location;
      if (loc && haversineM(loc.lat, loc.lng, c.lat, c.lng) > NEARBY_FETCH_RADIUS_M) return;
      useStore.getState().upsertCanvas(c);
      scheduleCache();
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'canvases' }, (payload) => {
      const c = payload.new as unknown;
      if (isCanvasRow(c) && useStore.getState().canvases[c.id]) { useStore.getState().upsertCanvas(c); scheduleCache(); }
    })
    .subscribe();
  return () => { supabase.removeChannel(ch); };
}

export async function incrementViews(canvasId: string) {
  const st = useStore.getState();
  const c = st.canvases[canvasId];
  if (c) st.upsertCanvas({ ...c, views: c.views + 1 });
  if (!hasBackend) return;
  try { await supabase.rpc('increment_views', { cid: canvasId }); } catch {}
}

/** Files a report. Rejects when the server refuses it (expired session, RLS) so the caller can say so. */
export async function reportCanvas(canvasId: string, reporterId: string | null, reason: string) {
  if (!hasBackend) return;
  const { error } = await supabase.from('reports').insert({ canvas_id: canvasId, reporter_id: isLocalId(reporterId) ? null : reporterId, reason });
  if (error) throw new Error(error.message);
}

export async function fetchLeaderboard(): Promise<Painter[]> {
  if (!hasBackend) return [];
  const { data, error } = await supabase.from('painters').select('*').order('paint_used', { ascending: false }).limit(25);
  if (error) throw error;
  return (data ?? []) as Painter[];
}

export async function fetchAllCanvases(): Promise<Canvas[]> {
  if (!hasBackend) return Object.values(useStore.getState().canvases);
  const { data, error } = await supabase.from('canvases').select('*').eq('flagged', false).order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  return ((data ?? []) as unknown[]).filter(isCanvasRow);
}

function isLocalId(id: string | null) { return !id || id.startsWith('local-'); }
