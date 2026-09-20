import { createClient } from '@supabase/supabase-js';
import { SUPABASE_KEY, SUPABASE_URL } from '../config';

// Anonymous, stateless client: the companion pages never sign in, and must not pick up a stale
// painter session from localStorage (an expired token would turn public reads into 401s).
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const hasBackend = SUPABASE_URL.length > 0 && SUPABASE_KEY.length > 0;
import type { Canvas, Painter, Stroke } from '../types';

/** Read-only world state for the judge-facing pages. Plain fetches + one realtime channel; no auth, no store. */
export type World = { canvases: Canvas[]; strokes: Record<string, Stroke[]>; painters: Painter[]; live: boolean };

export async function fetchWorld(maxCanvasesWithStrokes = 80): Promise<World> {
  if (!hasBackend) return { canvases: [], strokes: {}, painters: [], live: false };
  const [{ data: cs, error: e1 }, { data: ps, error: e2 }] = await Promise.all([
    supabase.from('canvases').select('*').eq('flagged', false).order('updated_at', { ascending: false }).limit(300),
    supabase.from('painters').select('*').order('paint_used', { ascending: false }).limit(50),
  ]);
  if (e1) throw e1; if (e2) throw e2;
  const canvases = (cs ?? []) as Canvas[];
  const painters = (ps ?? []) as Painter[];
  const ids = canvases.slice(0, maxCanvasesWithStrokes).map((c) => c.id);
  const strokes: Record<string, Stroke[]> = {};
  for (let i = 0; i < ids.length; i += 20) {
    const { data, error } = await supabase.from('strokes').select('*').in('canvas_id', ids.slice(i, i + 20)).order('created_at');
    if (error) throw error;
    for (const s of (data ?? []) as Stroke[]) (strokes[s.canvas_id] ??= []).push(s);
  }
  return { canvases, strokes, painters, live: true };
}

/** Live inserts/updates so the map + gallery move while someone paints. */
export function subscribeWorld(on: { stroke: (s: Stroke) => void; canvas: (c: Canvas) => void }) {
  if (!hasBackend) return () => {};
  const ch = supabase.channel('fresco-site')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'strokes' }, (p) => on.stroke(p.new as Stroke))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'canvases' }, (p) => on.canvas(p.new as Canvas))
    .subscribe();
  return () => { supabase.removeChannel(ch); };
}

export function trendingScore(c: Canvas) {
  const age = (Date.now() - new Date(c.updated_at).getTime()) / 3600e3;
  return (c.views + c.stroke_count * 2) / Math.pow(age + 2, 0.6);
}

export function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Sample spots so the pages never look dead before anyone paints. Marked as samples in the UI. */
export const SAMPLE_CANVASES: Canvas[] = [
  { id: 'sample-e7', lat: 43.4729, lng: -80.5397, heading: 200, title: 'E7 underpass', author_id: null, author_name: 'NEON_KID', views: 128, stroke_count: 41, flags: 0, flagged: false, created_at: ago(3), updated_at: ago(1) },
  { id: 'sample-slc', lat: 43.4716, lng: -80.5451, heading: 90, title: 'SLC wall', author_id: null, author_name: 'sprayzilla', views: 96, stroke_count: 29, flags: 0, flagged: false, created_at: ago(8), updated_at: ago(2) },
  { id: 'sample-dc', lat: 43.4727, lng: -80.5421, heading: 320, title: 'DC library', author_id: null, author_name: 'mira.wav', views: 61, stroke_count: 18, flags: 0, flagged: false, created_at: ago(20), updated_at: ago(5) },
];
export const isSample = (id: string) => id.startsWith('sample-');
function ago(h: number) { return new Date(Date.now() - h * 3600e3).toISOString(); }

/** Deterministic scribble for sample canvases. */
export function sampleStrokes(id: string): Stroke[] {
  let a = 0; for (const ch of id) a = (a * 31 + ch.charCodeAt(0)) >>> 0;
  const rng = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const colors = ['#ff2d95', '#19e6ff', '#ffe600', '#7cff3a'];
  const out: Stroke[] = [];
  for (let k = 0; k < 3; k++) {
    const color = colors[Math.floor(rng() * colors.length)];
    const points: number[][] = [];
    let x = rng() * 100, y = rng() * 60, vx = rng() - 0.5, vy = rng() - 0.5;
    for (let i = 0; i < 60; i++) { vx += (rng() - 0.5) * 0.6; vy += (rng() - 0.5) * 0.6; x += vx * 2; y += vy * 2; points.push([x, -y, 3 + rng() * 3, 0.25, 0]); }
    out.push({ id: `${id}-${k}`, canvas_id: id, author_id: null, author_name: 'sample', color, cap: 'fat', points, paint_used: 0, created_at: new Date().toISOString() });
  }
  return out;
}
