import { supabase, hasBackend } from '../lib/supabase';
import { useStore } from '../store';
import { withPoints } from '../lib/strokeCodec';
import type { Stroke } from '../types';

const inflight = new Map<string, Promise<void>>();
/** Pulls a canvas's strokes into the store once (thumbnails for pieces we haven't walked up to). */
export function fetchStrokesFor(canvasId: string): Promise<void> {
  if (!hasBackend || canvasId.startsWith('sample-')) return Promise.resolve();
  const existing = inflight.get(canvasId);
  if (existing) return existing;
  const p: Promise<void> = (async () => {
    try {
      const { data } = await supabase.from('strokes').select('*').eq('canvas_id', canvasId).order('created_at').limit(400);
      useStore.getState().setStrokes(canvasId, ((data ?? []) as Stroke[]).map(withPoints));
    } finally { inflight.delete(canvasId); }
  })();
  inflight.set(canvasId, p);
  return p;
}
