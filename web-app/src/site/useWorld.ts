import { useEffect, useMemo, useState } from 'react';
import { fetchWorld, SAMPLE_CANVASES, sampleStrokes, subscribeWorld, type World } from './data';
import type { Canvas, Stroke } from '../types';

/** One shared, live-updating snapshot of the world for every judge-facing page. */
export function useWorld() {
  const [world, setWorld] = useState<World>({ canvases: [], strokes: {}, painters: [], live: false });
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const pull = () => fetchWorld().then((w) => { if (alive) { setWorld(w); setError(null); setLoaded(true); } }).catch((e) => { if (alive) { setError(e?.message ?? 'offline'); setLoaded(true); } });
    pull();
    const id = window.setInterval(pull, 30_000);
    const unsub = subscribeWorld({
      stroke: (s: Stroke) => setWorld((w) => ({ ...w, strokes: { ...w.strokes, [s.canvas_id]: [...(w.strokes[s.canvas_id] ?? []), s] } })),
      canvas: (c: Canvas) => setWorld((w) => ({ ...w, canvases: w.canvases.some((x) => x.id === c.id) ? w.canvases.map((x) => (x.id === c.id ? { ...x, ...c } : x)) : [c, ...w.canvases] })),
    });
    return () => { alive = false; window.clearInterval(id); unsub(); };
  }, []);
  // fall back to samples only when the backend has nothing at all
  const canvases = useMemo(() => (world.canvases.length ? world.canvases.filter((c) => !c.flagged) : loaded ? SAMPLE_CANVASES : []), [world.canvases, loaded]);
  const strokesFor = (id: string) => world.strokes[id] ?? (id.startsWith('sample-') ? sampleStrokes(id) : []);
  return { ...world, canvases, strokesFor, error, loaded, usingSamples: loaded && world.canvases.length === 0 };
}
