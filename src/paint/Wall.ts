import { BlurStyle, Skia, type SkCanvas, type SkImage, type SkSurface } from '@shopify/react-native-skia';
import { WALL_PITCH_RANGE, WALL_PX_PER_DEG, WALL_YAW_RANGE } from '../config';
import { seededRng } from '../lib/ids';
import type { Stroke, StrokePoint } from '../types';

export const WALL_W = 2 * WALL_YAW_RANGE * WALL_PX_PER_DEG;
export const WALL_H = 2 * WALL_PITCH_RANGE * WALL_PX_PER_DEG;

/**
 * A Wall is the persistent raster for one canvas: an offscreen Skia surface in angular space
 * (x = yaw relative to the canvas heading, y = pitch). Every spray dab is composited into it
 * once; the view just draws the snapshot with a transform, so rendering cost is independent
 * of how much paint is on the wall.
 *
 * Spray model, cheaply adapted from Curtis et al. "Computer-Generated Watercolor":
 *  - buildup:       low-alpha dabs composited source-over, so repeated passes saturate/darken
 *                   (their pigment density accumulation);
 *  - edge darkening: each dab carries a faint, slightly darker halo ring wider than its body, so
 *                   where strokes overlap only at their edges you get the dark rim of a dried
 *                   spray blob (their backrun / edge darkening);
 *  - granulation:   per-dab alpha jitter + overspray speckle from a seeded RNG (their paper
 *                   granulation), deterministic so every phone renders the same speckle;
 *  - drips:         gone. Paint stays where you sprayed it, and kind = 1 points from older
 *                   strokes are skipped rather than drawn.
 */
export class Wall {
  readonly id: string;
  private surface: SkSurface | null;
  private canvas: SkCanvas | null;
  image: SkImage | null = null;
  private dirty = false;
  readonly backend: 'gpu' | 'cpu' | 'none' = 'none';
  private paints = new Map<string, ReturnType<typeof Skia.Paint>>();

  constructor(id: string) {
    this.id = id;
    this.surface = Skia.Surface.MakeOffscreen(WALL_W, WALL_H);
    (this as any).backend = this.surface ? 'gpu' : 'cpu';
    if (!this.surface) this.surface = Skia.Surface.Make(WALL_W, WALL_H); // raster fallback
    this.canvas = this.surface ? this.surface.getCanvas() : null;
    if (!this.canvas) (this as any).backend = 'none';
    this.canvas?.clear(Skia.Color('transparent'));
  }

  dispose() {
    this.image?.dispose?.();
    this.surface?.dispose?.();
    this.surface = null; this.canvas = null; this.image = null;
  }

  static toPx(yaw: number, pitch: number) {
    return { x: (yaw + WALL_YAW_RANGE) * WALL_PX_PER_DEG, y: (WALL_PITCH_RANGE - pitch) * WALL_PX_PER_DEG };
  }

  private paint(color: string, alpha: number, blur: number) {
    const key = `${color}|${alpha.toFixed(2)}|${blur.toFixed(1)}`;
    let p = this.paints.get(key);
    if (!p) {
      p = Skia.Paint();
      p.setColor(Skia.Color(color));
      p.setAlphaf(alpha);
      p.setAntiAlias(true);
      if (blur > 0.3) p.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, blur, true));
      this.paints.set(key, p);
    }
    return p;
  }

  /** One spray tick at (yaw, pitch) canvas degrees. radiusDeg = nozzle spread, alpha = flow. */
  dab(yaw: number, pitch: number, radiusDeg: number, alpha: number, color: string, rng: () => number) {
    const c = this.canvas; if (!c) return;
    const { x, y } = Wall.toPx(yaw, pitch);
    const r = radiusDeg * WALL_PX_PER_DEG;
    const dark = darken(color, 0.72);
    // edge-darkening halo
    c.drawCircle(x, y, r * 0.98, this.paint(dark, alpha * 0.1, r * 0.22));
    // scattered body: barely blurred, so passes build solid colour instead of haze
    for (let i = 0; i < 4; i++) {
      const a = rng() * Math.PI * 2, d = gauss(rng) * r * 0.36;
      const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
      c.drawCircle(px, py, r * 0.55, this.paint(color, alpha * (0.34 + 0.16 * rng()), r * 0.16));
    }
    // dense core
    c.drawCircle(x, y, r * 0.46, this.paint(color, alpha * 0.9, r * 0.05));
    // overspray speckle
    for (let i = 0; i < 2; i++) {
      const a = rng() * Math.PI * 2, d = r * (0.8 + rng() * 0.9);
      c.drawCircle(x + Math.cos(a) * d, y + Math.sin(a) * d, r * 0.06 + rng() * r * 0.05, this.paint(color, alpha * 0.45, 0));
    }
    this.dirty = true;
  }

  applyPoint(p: StrokePoint, color: string, rng: () => number) {
    const [yaw, pitch, size, alpha, kind] = p;
    // kind 1 is a drip from an older build. Paint doesn't run any more, so it isn't drawn at all
    // (the rng still advances, so every client skips it the same way).
    if (kind === 1) { rng(); return; }
    this.dab(yaw, pitch, size, alpha, color, rng);
  }

  replay(stroke: Stroke) {
    const rng = seededRng(stroke.id);
    for (const p of stroke.points) this.applyPoint(p, stroke.color, rng);
  }

  /** Returns a fresh snapshot only if something was drawn since the last one. */
  snapshot(): SkImage | null {
    if (!this.surface) return this.image;
    if (this.dirty) {
      this.surface.flush();
      const old = this.image;
      this.image = this.surface.makeImageSnapshot();
      old?.dispose?.();
      this.dirty = false;
    }
    return this.image;
  }
}

function gauss(rng: () => number) {
  // Box–Muller, clamped
  const u = Math.max(1e-6, rng()), v = rng();
  return Math.max(-2.5, Math.min(2.5, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)));
}

function darken(hex: string, f: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** Registry of live walls (one per canvas id). */
const walls = new Map<string, Wall>();
export function getWall(id: string) {
  let w = walls.get(id);
  if (!w) { w = new Wall(id); walls.set(id, w); }
  return w;
}
export function hasWall(id: string) { return walls.has(id); }
export function dropWall(id: string) { walls.get(id)?.dispose(); walls.delete(id); }
