import { useEffect, useState, type CSSProperties } from 'react';
import type { Discovery } from '../hooks/useDiscovery';
import type { Canvas } from '../types';
import { useStore } from '../store';

/**
 * The reveal. A shimmer pulls your eye toward an undiscovered piece (edge arrow when it's off
 * screen, a twinkling cluster where it is when on screen), then a card slides up once it locks.
 * Web port of ../../src/components/DiscoveryOverlay.tsx; reanimated → CSS keyframes.
 */
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function DiscoveryOverlay({ d, onReport }: { d: Discovery; onReport: (id: string) => void }) {
  const { width, height } = useViewport();
  const hfov = useStore((s) => s.settings.hfov);
  // hfov spans the short edge in either orientation (same as PaintLayer)
  const pxPerDeg = Math.min(width, height) / hfov;
  // actual horizontal field of view of the viewport: wider than hfov when the long edge is horizontal
  const hfovNow = width > height ? 2 * Math.atan(Math.tan((hfov / 2) * D2R) * width / height) * R2D : hfov;
  const pull = d.pull;
  const onScreen = !!pull && Math.abs(pull.relBearing) < hfovNow / 2 - 3;
  const x = pull ? width / 2 + pull.relBearing * pxPerDeg : 0;
  const focused = d.focused;

  return (
    <div className="dov">
      {pull && !d.justFound && (
        onScreen ? <Shimmer x={x} y={height * 0.45} strength={1 - pull.resolve} /> : <EdgeArrow left={pull.relBearing < 0} strength={1 - pull.resolve * 0.5} />
      )}
      {pull && !d.justFound && (
        <div className="pull-chip">
          {pull.resolve < 0.05 ? '✦ something is painted near here' : pull.resolve < 1 ? `✦ a piece is resolving… ${Math.round(pull.distance)} m` : '✦ look at the wall'}
        </div>
      )}
      {d.justFound && <RevealCard c={d.justFound} onReport={onReport} />}
      {!d.justFound && focused && (
        <div className="focus-chip">
          <span>{focused.author_name} · {focused.views} views · {timeAgo(focused.created_at)}</span>
          <button type="button" className="report" onClick={() => onReport(focused.id)}>report</button>
        </div>
      )}
    </div>
  );
}

function useViewport() {
  const read = () => ({ width: window.innerWidth, height: window.innerHeight });
  const [v, setV] = useState(read);
  useEffect(() => {
    const on = () => setV(read());
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    return () => { window.removeEventListener('resize', on); window.removeEventListener('orientationchange', on); };
  }, []);
  return v;
}

const SPARKS = [0, 1, 2, 3, 4, 5];

function Shimmer({ x, y, strength }: { x: number; y: number; strength: number }) {
  const k = 0.35 + 0.65 * strength;
  return (
    <div className="shimmer">
      {SPARKS.map((i) => (
        <div key={i} className="spark-wrap" style={{ left: x, top: y, transform: `rotate(${(i / 6) * 360}deg)` }}>
          <div className="spark" style={{ '--k': k, animationDelay: `${-i * 238}ms` } as CSSProperties} />
        </div>
      ))}
    </div>
  );
}

function EdgeArrow({ left, strength }: { left: boolean; strength: number }) {
  return (
    <div className={`edge ${left ? 'l' : 'r'}`} style={{ '--s': strength } as CSSProperties} aria-hidden>
      {left ? '‹' : '›'}
    </div>
  );
}

function RevealCard({ c, onReport }: { c: Pick<Canvas, 'id' | 'author_name' | 'views' | 'created_at' | 'stroke_count'>; onReport: (id: string) => void }) {
  return (
    <div className="card" role="status">
      <div className="card-eyebrow">✦ YOU FOUND A PIECE</div>
      <div className="card-title">by {c.author_name}</div>
      <div className="card-meta">{timeAgo(c.created_at)} · {c.views} {c.views === 1 ? 'view' : 'views'} · {c.stroke_count} strokes</div>
      <button type="button" className="report" onClick={() => onReport(c.id)}>report</button>
    </div>
  );
}

export function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
