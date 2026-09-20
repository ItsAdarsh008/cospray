import type { Stroke } from '../types';

/**
 * Draws every dab of a piece into a 2D canvas, auto-fit to the box. Compass strokes are in
 * degrees, AR strokes in anchor-local metres; either way the point cloud is normalised to its
 * own bounds so the result is the piece's silhouette. Deterministic, cheap, no Skia needed.
 */
export function renderPiece(el: HTMLCanvasElement, strokes: Stroke[], w: number, h: number, bg = '#14141e') {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  el.width = Math.round(w * dpr); el.height = Math.round(h * dpr);
  el.style.width = `${w}px`; el.style.height = `${h}px`;
  const ctx = el.getContext('2d'); if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  let pts: { x: number; y: number; s: number; a: number; color: string }[] = [];
  for (const st of strokes) for (const p of st.points as number[][]) {
    if (!Array.isArray(p) || p.length < 4) continue;
    if (p[4] === 1 && pts.length > 3000) continue;
    pts.push({ x: p[0], y: -p[1], s: p[2], a: Math.min(1, p[3] * 2.5), color: st.color });
  }
  if (!pts.length) return;
  if (pts.length > 6000) { const step = Math.ceil(pts.length / 6000); pts = pts.filter((_, i) => i % step === 0); }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const span = Math.max(maxX - minX, maxY - minY, 1e-3);
  const scale = (Math.min(w, h) * 0.8) / span;
  const ox = w / 2 - ((minX + maxX) / 2) * scale, oy = h / 2 - ((minY + maxY) / 2) * scale;
  const sizeScale = scale * (pts[0].s > 1 ? 0.35 : 1); // degree sizes are chunkier than metre ones
  for (const p of pts) {
    ctx.globalAlpha = p.a; ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(ox + p.x * scale, oy + p.y * scale, Math.max(1, Math.min(w * 0.08, p.s * sizeScale)), 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}
