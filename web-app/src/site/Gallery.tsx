import { useMemo, useState } from 'react';
import { Piece } from './Piece';
import { useWorld } from './useWorld';
import { isSample, timeAgo, trendingScore } from './data';
import type { Canvas } from '../types';

export function Gallery() {
  const w = useWorld();
  const [open, setOpen] = useState<Canvas | null>(null);
  const trending = useMemo(() => [...w.canvases].sort((a, b) => trendingScore(b) - trendingScore(a)), [w.canvases]);
  return (
    <main className="page">
      <header className="page-head">
        <h1>TRENDING FRESCOS</h1>
        <p className="muted">{w.usingSamples ? 'nothing on the wall yet — showing sample spots' : `${w.canvases.length} pieces · ranked by views, strokes and freshness · updates live`}</p>
      </header>
      <section className="grid">
        {trending.map((c, i) => (
          <button key={c.id} type="button" className="tile" onClick={() => setOpen(c)}>
            <Piece strokes={w.strokesFor(c.id)} width={280} height={200} className="tile-img" />
            <div className="tile-meta">
              <span className="rank">#{i + 1}</span>
              <div>
                <div className="title">{c.title ?? `${c.author_name}'s piece`}{isSample(c.id) && <span className="tag">sample</span>}</div>
                <div className="muted">{c.author_name} · {c.views} views · {c.stroke_count} strokes · {timeAgo(c.updated_at)}</div>
              </div>
            </div>
          </button>
        ))}
      </section>

      <header className="page-head"><h1>LEADERBOARD</h1><p className="muted">top painters by paint sprayed</p></header>
      <section className="board">
        {w.painters.length === 0 && <div className="muted">{w.error ? `offline (${w.error})` : 'no painters yet'}</div>}
        {w.painters.map((p, i) => (
          <div key={p.id} className={`row ${i < 3 ? 'top' : ''}`}>
            <span className="rank">{i + 1}</span>
            <span className="name">{p.name}</span>
            <span className="muted">{Math.round(p.paint_used)} paint</span>
            <span className="muted">{p.strokes} strokes</span>
          </div>
        ))}
      </section>
      {open && <Detail c={open} strokes={w.strokesFor(open.id)} onClose={() => setOpen(null)} />}
    </main>
  );
}

export function Detail({ c, strokes, onClose }: { c: Canvas; strokes: ReturnType<ReturnType<typeof useWorld>['strokesFor']>; onClose: () => void }) {
  const paint = strokes.reduce((a, s) => a + (s.paint_used ?? 0), 0);
  const colors = [...new Set(strokes.map((s) => s.color))];
  const size = Math.min(640, window.innerWidth - 48);
  return (
    <div className="modal" onClick={onClose} role="dialog">
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div><h2>{c.title ?? `${c.author_name}'s piece`}</h2><div className="muted">by {c.author_name} · {timeAgo(c.created_at)}</div></div>
          <button type="button" className="x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <Piece strokes={strokes} width={size} height={Math.round(size * 0.7)} className="sheet-img" />
        <div className="stats">
          <div><b>{c.views}</b><span>views</span></div><div><b>{c.stroke_count}</b><span>strokes</span></div><div><b>{Math.round(paint)}</b><span>paint</span></div><div><b>{colors.length}</b><span>colours</span></div>
        </div>
        <div className="muted">{c.lat.toFixed(5)}, {c.lng.toFixed(5)} · facing {Math.round(c.heading)}° · {c.world_map_path ? 'AR world map saved' : 'compass-anchored'} · <a href={`https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lng}#map=18/${c.lat}/${c.lng}`} target="_blank" rel="noopener">open map ↗</a></div>
        <div className="swatches">{colors.map((col) => <span key={col} style={{ background: col }} />)}</div>
      </div>
    </div>
  );
}
