import AsyncStorage from '@react-native-async-storage/async-storage';
import { hasBackend, supabase } from '../lib/supabase';
import { NEARBY_FETCH_RADIUS_M } from '../config';
import { useStore } from '../store';
import { getWall } from '../paint/Wall';
import { File, Paths } from 'expo-file-system';
import type { Canvas, Painter, Stroke } from '../types';

/**
 * Local-first sync. Every canvas/stroke is applied to the store + wall raster immediately and
 * cached in AsyncStorage; Supabase is the shared source of truth when reachable. Strokes that
 * fail to upload are queued and retried, so a flaky hackathon network never blocks painting.
 */

const CACHE_CANVASES = 'tagged:cache:canvases';
const CACHE_STROKES = 'tagged:cache:strokes:';
const PENDING = 'tagged:pending';
/** Strokes carry every dab, so a queue that never drains is measured in megabytes. Keep the newest. */
const PENDING_MAX = 120;
/** Rows the server will never take as they are (missing column = migration_ar.sql hasn't been run). */
const SCHEMA_ERRORS = ['42703', 'PGRST204'];
let schemaBlocked = false; // stops the retry storm for this session once the shape is rejected
let flushing = false;

export function applyStroke(s: Stroke) {
  const st = useStore.getState();
  if (!st.addStroke(s)) return false;
  if (!s.anchor_id) { getWall(s.canvas_id).replay(s); st.bumpWalls(); }
  remoteStrokeListeners.forEach((fn) => fn(s));
  return true;
}
const remoteStrokeListeners = new Set<(s: Stroke) => void>();
/** AR screen subscribes to be told about strokes arriving for the canvas it has loaded. */
export function onRemoteStroke(fn: (s: Stroke) => void) { remoteStrokeListeners.add(fn); return () => { remoteStrokeListeners.delete(fn); }; }

/** Painter row for the signed-in user (id = auth uid). Throws with a readable message on failure. */
export async function ensurePainter(userId: string, name: string): Promise<Painter> {
  const { data, error } = await supabase.from('painters').upsert({ id: userId, name }, { onConflict: 'id' }).select().single();
  if (error) {
    if (error.code === '23505') throw new Error('That tag is taken — pick another.');
    throw new Error(error.message);
  }
  useStore.getState().setOnline(true);
  return { id: data.id, name: data.name, paint_used: data.paint_used, strokes: data.strokes };
}

/** Existing painter row for a signed-in user, or null if they haven't picked a tag yet. */
export async function fetchPainter(userId: string): Promise<Painter | null> {
  const { data, error } = await supabase.from('painters').select('*').eq('id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { id: data.id, name: data.name, paint_used: data.paint_used, strokes: data.strokes } : null;
}

export async function loadCached() {
  try {
    const raw = await AsyncStorage.getItem(CACHE_CANVASES);
    if (!raw) return;
    const canvases: Canvas[] = JSON.parse(raw);
    useStore.getState().setCanvases(canvases);
    for (const c of canvases) {
      const sraw = await AsyncStorage.getItem(CACHE_STROKES + c.id);
      if (sraw) for (const s of JSON.parse(sraw) as Stroke[]) applyStroke(s);
    }
  } catch {}
}

async function cacheCanvas(c: Canvas) {
  try {
    const all = Object.values(useStore.getState().canvases);
    await AsyncStorage.setItem(CACHE_CANVASES, JSON.stringify(all));
    const ss = useStore.getState().strokes[c.id] ?? [];
    await AsyncStorage.setItem(CACHE_STROKES + c.id, JSON.stringify(ss));
  } catch {}
}

export async function loadNearby(lat: number, lng: number) {
  if (!hasBackend) return;
  try {
    const { data: canvases, error } = await supabase.rpc('nearby_canvases', { qlat: lat, qlng: lng, radius_m: NEARBY_FETCH_RADIUS_M });
    if (error) throw error;
    const st = useStore.getState();
    st.setOnline(true);
    st.setCanvases(canvases as Canvas[]);
    const ids = (canvases as Canvas[]).map((c) => c.id);
    if (ids.length) {
      const { data: strokes, error: e2 } = await supabase.from('strokes').select('*').in('canvas_id', ids).order('created_at');
      if (e2) throw e2;
      for (const s of strokes as Stroke[]) applyStroke(s);
    }
    for (const c of canvases as Canvas[]) cacheCanvas(c);
  } catch (e) {
    console.warn('loadNearby failed', e);
    useStore.getState().setOnline(false);
  }
}

export async function createCanvas(c: Canvas) {
  const st = useStore.getState();
  st.upsertCanvas(c);
  cacheCanvas(c);
  if (!hasBackend) return;
  try {
    const { error } = await supabase.from('canvases').insert({
      id: c.id, lat: c.lat, lng: c.lng, heading: c.heading, title: c.title,
      author_id: isLocalId(c.author_id) ? null : c.author_id, author_name: c.author_name,
    });
    if (error) throw error;
  } catch (e) { console.warn('createCanvas failed', e); }
}

export async function uploadStroke(s: Stroke) {
  const c = useStore.getState().canvases[s.canvas_id];
  if (c) cacheCanvas(c);
  if (!hasBackend) return;
  const row = {
    id: s.id, canvas_id: s.canvas_id, author_id: isLocalId(s.author_id) ? null : s.author_id,
    author_name: s.author_name, color: s.color, cap: s.cap, points: s.points, paint_used: s.paint_used,
    anchor_id: s.anchor_id ?? null, transform: s.transform ?? null, viewer: s.viewer ?? null,
  };
  try {
    // make sure our own canvas row exists first (its insert may have failed earlier)
    if (c && c.author_id && c.author_id === useStore.getState().painter?.id) {
      await supabase.from('canvases').upsert({ id: c.id, lat: c.lat, lng: c.lng, heading: c.heading, title: c.title, author_id: c.author_id, author_name: c.author_name }, { onConflict: 'id', ignoreDuplicates: true });
    }
    const { error } = await supabase.from('strokes').insert(row);
    if (error) throw error;
    useStore.getState().setOnline(true);
  } catch (e) {
    console.warn('uploadStroke failed, queued', e);
    useStore.getState().setOnline(false);
    try {
      const q: unknown[] = JSON.parse((await AsyncStorage.getItem(PENDING)) ?? '[]');
      q.push(row);
      if (q.length > PENDING_MAX) q.splice(0, q.length - PENDING_MAX); // never let the queue eat the phone
      await AsyncStorage.setItem(PENDING, JSON.stringify(q));
    } catch {}
  }
}

/**
 * Retry queued strokes. Runs on a timer, so it has to stay cheap and bounded no matter how long the
 * backend has been refusing them: one flush at a time, at most ROW_RETRIES single-row retries, and
 * if the server rejects the shape itself (a column the schema doesn't have yet) it stops for this
 * session instead of re-uploading the whole queue every 15 s.
 */
const ROW_RETRIES = 20;
export async function flushPending() {
  if (!hasBackend || schemaBlocked || flushing) return;
  flushing = true;
  try {
    const raw = (await AsyncStorage.getItem(PENDING)) ?? '[]';
    // A queue this big is the result of the backend refusing strokes for hours; parsing it whole is
    // itself enough to get the app jetsammed, so drop it. The paint is still cached locally and on
    // the wall — only the upload of that backlog is lost, which was never going to succeed anyway.
    if (raw.length > 8_000_000) {
      console.warn(`dropping a ${Math.round(raw.length / 1e6)} MB stroke backlog that the backend kept refusing`);
      await AsyncStorage.removeItem(PENDING);
      return;
    }
    const q: any[] = JSON.parse(raw);
    if (!q.length) return;
    const { error } = await supabase.from('strokes').upsert(q, { onConflict: 'id' });
    if (!error) { await AsyncStorage.removeItem(PENDING); return; }
    if (SCHEMA_ERRORS.includes(error.code ?? '')) {
      schemaBlocked = true;
      console.warn(`stroke upload is blocked by the database schema (${error.message}). Run supabase/migration_ar.sql, then reopen the app.`);
      if (q.length > PENDING_MAX) await AsyncStorage.setItem(PENDING, JSON.stringify(q.slice(-PENDING_MAX)));
      return;
    }
    // batch failed for some other reason: retry a few rows and drop the ones that can never succeed
    // (FK / RLS / duplicate). Anything not reached this time stays queued for the next flush.
    const head = q.slice(0, ROW_RETRIES);
    const keep: any[] = [];
    for (const row of head) {
      const { error: e } = await supabase.from('strokes').upsert(row, { onConflict: 'id' });
      if (e && SCHEMA_ERRORS.includes(e.code ?? '')) { schemaBlocked = true; keep.push(row); break; }
      if (e && !['23503', '42501', '23505'].includes(e.code ?? '')) keep.push(row);
    }
    await AsyncStorage.setItem(PENDING, JSON.stringify([...keep, ...q.slice(ROW_RETRIES)].slice(-PENDING_MAX)));
  } catch (e) {
    console.warn('flushPending failed', e);
  } finally { flushing = false; }
}

export function subscribeRealtime() {
  if (!hasBackend) return () => {};
  const ch = supabase
    .channel('tagged')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'strokes' }, (payload) => {
      const s = payload.new as Stroke;
      if (!useStore.getState().canvases[s.canvas_id]) return; // not nearby / unknown canvas
      applyStroke(s);
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'canvases' }, (payload) => {
      useStore.getState().upsertCanvas(payload.new as Canvas);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'canvases' }, (payload) => {
      const c = payload.new as Canvas;
      if (useStore.getState().canvases[c.id]) useStore.getState().upsertCanvas(c);
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

export async function reportCanvas(canvasId: string, reporterId: string | null, reason: string) {
  if (!hasBackend) return;
  try {
    await supabase.from('reports').insert({ canvas_id: canvasId, reporter_id: isLocalId(reporterId) ? null : reporterId, reason });
  } catch (e) { console.warn('report failed', e); }
}

export async function fetchLeaderboard(): Promise<Painter[]> {
  if (!hasBackend) return [];
  const { data, error } = await supabase.from('painters').select('*').order('paint_used', { ascending: false }).limit(25);
  if (error) throw error;
  return data as Painter[];
}

export async function fetchAllCanvases(): Promise<Canvas[]> {
  if (!hasBackend) return Object.values(useStore.getState().canvases);
  const { data, error } = await supabase.from('canvases').select('*').eq('flagged', false).order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  return data as Canvas[];
}

/**
 * Take a stroke off the shared wall (undo). The app has already dropped it locally and remembers
 * the id, because `strokes` has no delete policy yet: until Hamza adds one this call is refused and
 * the stroke stays on other phones. Also drops it from the retry queue if it never made it up.
 */
export async function deleteStroke(id: string) {
  try {
    const q: { id: string }[] = JSON.parse((await AsyncStorage.getItem(PENDING)) ?? '[]');
    const left = q.filter((r) => r.id !== id);
    if (left.length !== q.length) await AsyncStorage.setItem(PENDING, JSON.stringify(left));
  } catch {}
  if (!hasBackend) return;
  try {
    const { error } = await supabase.from('strokes').delete().eq('id', id);
    if (error) throw error;
  } catch (e) { console.warn('deleteStroke failed (strokes needs an RLS delete policy)', e); }
}

/** Strokes for canvases that aren't nearby, for thumbnails only (no raster replay). */
export async function fetchPreviewStrokes(ids: string[]) {
  if (!hasBackend || !ids.length) return;
  const st = useStore.getState();
  const want = ids.filter((id) => !st.strokes[id] && !st.previewStrokes[id]).slice(0, 40);
  if (!want.length) return;
  const { data, error } = await supabase.from('strokes').select('*').in('canvas_id', want).order('created_at');
  if (error) throw error;
  const by: Record<string, Stroke[]> = {};
  for (const id of want) by[id] = [];
  for (const s of data as Stroke[]) (by[s.canvas_id] ??= []).push(s);
  useStore.getState().setPreviewStrokes(by);
}

function isLocalId(id: string | null) { return !id || id.startsWith('local-'); }

// ---- AR world maps (Supabase Storage bucket "worldmaps") ---------------------------------

export async function uploadWorldMap(canvasId: string, localPath: string) {
  if (!hasBackend) return null;
  try {
    const buf = await new File(localPath).arrayBuffer();
    const objectPath = `${canvasId}.arworldmap`;
    const { error } = await supabase.storage.from('worldmaps').upload(objectPath, buf, { upsert: true, contentType: 'application/octet-stream' });
    if (error) throw error;
    const now = new Date().toISOString();
    const { error: e2 } = await supabase.rpc('set_world_map', { cid: canvasId, path: objectPath });
    if (e2) throw e2;
    const c = useStore.getState().canvases[canvasId];
    if (c) useStore.getState().upsertCanvas({ ...c, world_map_path: objectPath, world_map_updated_at: now });
    return objectPath;
  } catch (e) {
    console.warn('uploadWorldMap failed', e);
    return null;
  }
}

/** Downloads the canvas's world map to the cache and returns its local path (null if none). */
export async function downloadWorldMap(c: Canvas): Promise<string | null> {
  if (!hasBackend || !c.world_map_path) return null;
  try {
    const { data } = supabase.storage.from('worldmaps').getPublicUrl(c.world_map_path);
    const stamp = (c.world_map_updated_at ?? '').replace(/[^0-9]/g, '');
    const dest = new File(Paths.cache, `${c.id}-${stamp}.arworldmap`);
    if (dest.exists) return dest.uri.replace('file://', '');
    const f = await File.downloadFileAsync(data.publicUrl + `?v=${stamp}`, dest);
    return f.uri.replace('file://', '');
  } catch (e) {
    console.warn('downloadWorldMap failed', e);
    return null;
  }
}
