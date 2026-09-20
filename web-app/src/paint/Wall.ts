import { CAP_RADIUS_DEG, WALL_PITCH_RANGE, WALL_PX_PER_DEG, WALL_YAW_RANGE, type Cap } from '../config';
import { seededRng } from '../lib/ids';
import type { Stroke, StrokePoint } from '../types';

const D2R = Math.PI / 180;
/**
 * The raster is the texture of a FLAT wall standing in front of the canvas's spot, not a sheet of
 * angular space: a direction (yaw, pitch) lands where that ray pierces the plane (gnomonic
 * projection). That is what lets PaintLayer draw it in perspective, so paint foreshortens when you
 * look along the wall instead of sliding about like a sticker on a sphere.
 *
 * Units on the plane are "at unit distance", so tan(angle); PX_PER_UNIT converts them to raster
 * pixels and is the same on both axes, which keeps the pixels square.
 */
export const WALL_W = Math.round(2 * WALL_YAW_RANGE * WALL_PX_PER_DEG); // 1320
const PX_PER_UNIT = (WALL_W / 2) / Math.tan(WALL_YAW_RANGE * D2R);
export const WALL_H = Math.round(2 * Math.tan(WALL_PITCH_RANGE * D2R) * PX_PER_UNIT);
/** Half-extent of the plane in "unit distance" units — PaintLayer sizes the surface from these. */
export const WALL_HALF_X = Math.tan(WALL_YAW_RANGE * D2R);
export const WALL_HALF_Y = Math.tan(WALL_PITCH_RANGE * D2R);
/** True when a direction (relative to the canvas heading) is on this wall at all. */
export function onWall(yaw: number, pitch: number) {
  return Math.abs(yaw) <= WALL_YAW_RANGE && Math.abs(pitch) <= WALL_PITCH_RANGE;
}

const TAU = Math.PI * 2;
const clampDeg = (v: number, limit: number) => (v < -limit ? -limit : v > limit ? limit : v);
const MAX_POINT_SIZE_DEG = 90; // anything larger is a corrupt row, not paint
const GRADIENT_CACHE_MAX = 1024;

type Rgb = readonly [number, number, number];

/**
 * A Wall is the persistent raster for one canvas: an offscreen 2D canvas in angular space
 * (x = yaw relative to the canvas heading, y = pitch). Every spray dab is composited into it
 * once; PaintLayer just draws the bitmap with a transform, so rendering cost is independent of
 * how much paint is on the wall. Port of the native Skia Wall — same dab geometry, same rng
 * call order, so a stroke replayed from its seeded rng looks the same on every client.
 *
 * Spray model, cheaply adapted from Curtis et al. "Computer-Generated Watercolor":
 *  - buildup:        low-alpha dabs composited source-over, so repeated passes saturate/darken;
 *  - edge darkening: each dab carries a faint, slightly darker halo ring wider than its body;
 *  - granulation:    per-dab alpha jitter + overspray speckle from the seeded rng;
 *  - drips:          dwelling on one spot pools paint which runs down (kind = 1 points).
 *
 * Skia's `drawCircle + MaskFilter.MakeBlur(sigma)` becomes a radial gradient whose profile is
 * a Gaussian-blurred disc: hard core out to r − 2σ, edge falling off to r + 2.5σ, and a centre
 * alpha of 1 − exp(−r²/2σ²) so tiny very-blurry dabs read lighter, exactly as they do in Skia.
 */
export class Wall {
  readonly id: string;
  readonly canvas: HTMLCanvasElement;
  readonly backend: 'canvas' | 'none';
  /** Bumps on every draw; PaintLayer can use it to skip redraws. */
  version = 0;
  private ctx: CanvasRenderingContext2D | null;
  private gradients = new Map<string, { g: CanvasGradient; outer: number }>();

  constructor(id: string) {
    this.id = id;
    const c = document.createElement('canvas');
    c.width = WALL_W;
    c.height = WALL_H;
    this.canvas = c;
    let ctx: CanvasRenderingContext2D | null = null;
    try { ctx = c.getContext('2d', { alpha: true }); } catch { ctx = null; }
    this.ctx = ctx;
    this.backend = ctx ? 'canvas' : 'none';
  }

  dispose() {
    this.gradients.clear();
    this.ctx = null;
    // release the bitmap memory (iOS caps total canvas memory per page)
    this.canvas.width = 1;
    this.canvas.height = 1;
  }

  /** Direction (canvas-relative degrees) → the point where that ray hits the wall, in raster px. */
  static toPx(yaw: number, pitch: number) {
    const y = clampDeg(yaw, WALL_YAW_RANGE) * D2R;
    const p = clampDeg(pitch, WALL_PITCH_RANGE) * D2R;
    return {
      x: WALL_W / 2 + Math.tan(y) * PX_PER_UNIT,
      y: WALL_H / 2 - (Math.tan(p) / Math.cos(y)) * PX_PER_UNIT,
    };
  }

  /**
   * Raster px per degree at that spot. Constant on a sphere, not on a plane: the same nozzle
   * spread covers more of the wall the further along it you aim, which is what makes the paint
   * look like it is lying on a surface.
   */
  static pxPerDeg(yaw: number, pitch: number) {
    const y = clampDeg(yaw, WALL_YAW_RANGE) * D2R;
    const p = clampDeg(pitch, WALL_PITCH_RANGE) * D2R;
    const kx = PX_PER_UNIT / (Math.cos(y) * Math.cos(y));
    const ky = PX_PER_UNIT / (Math.cos(p) * Math.cos(p) * Math.cos(y));
    return D2R * Math.sqrt(kx * ky);
  }

  /** Skia-style blurred disc: radius r, Gaussian sigma `blur` (wall px), colour at `alpha`. */
  private disc(x: number, y: number, r: number, alpha: number, blur: number, rgb: Rgb) {
    const ctx = this.ctx;
    if (!ctx || r <= 0 || alpha <= 0) return;
    if (blur <= 0.3) {
      // native only attaches a mask filter above this threshold; below it the circle is hard-edged
      ctx.fillStyle = rgba(rgb, alpha);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
      return;
    }
    const { g, outer } = this.gradient(rgb, alpha, r, blur);
    // gradients are position-bound, so cache them at the origin and move the pen instead
    ctx.setTransform(1, 0, 0, 1, x, y);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, outer, 0, TAU);
    ctx.fill();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private gradient(rgb: Rgb, alpha: number, r: number, blur: number) {
    // quantise like the native paint cache (alpha to 0.01, radii to 0.1 px) so keys repeat
    const a = Math.round(alpha * 100) / 100;
    const R = Math.round(r * 10) / 10;
    const S = Math.round(blur * 10) / 10;
    const key = `${rgb[0]},${rgb[1]},${rgb[2]}|${a}|${R}|${S}`;
    let hit = this.gradients.get(key);
    if (hit) return hit;
    if (this.gradients.size >= GRADIENT_CACHE_MAX) this.gradients.clear();
    const ctx = this.ctx!;
    const outer = R + 2.5 * S;
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, outer);
    // centre alpha of a Gaussian-blurred disc, then the 1D edge profile rescaled to hit it at d = 0
    const centre = 1 - Math.exp(-(R * R) / (2 * S * S));
    const slab0 = phi(R / S) - phi(-R / S);
    const scale = slab0 > 1e-6 ? centre / slab0 : 0;
    const STOPS = 10;
    for (let i = 0; i <= STOPS; i++) {
      const t = i / STOPS;
      const d = t * outer;
      const cov = i === STOPS ? 0 : Math.max(0, Math.min(1, (phi((R - d) / S) - phi((-R - d) / S)) * scale));
      g.addColorStop(t, rgba(rgb, a * cov));
    }
    hit = { g, outer };
    this.gradients.set(key, hit);
    return hit;
  }

  /** One spray tick at (yaw, pitch) canvas degrees. radiusDeg = nozzle spread, alpha = flow. */
  dab(yaw: number, pitch: number, radiusDeg: number, alpha: number, color: string, rng: () => number) {
    if (!this.ctx) return;
    // Off the surface: draw nothing. Clamping to the edge instead would pile every stray point
    // along the rim and draw a visible rectangle around the piece — which is what pieces painted
    // before the wall became finite used to do.
    if (!onWall(yaw, pitch)) return;
    const { x, y } = Wall.toPx(yaw, pitch);
    const r = radiusDeg * Wall.pxPerDeg(yaw, pitch);
    const rgb = parseColor(color);
    const dark = darken(rgb, 0.72);
    // edge-darkening halo
    this.disc(x, y, r * 0.95, alpha * 0.07, r * 0.28, dark);
    // scattered soft body — rng order (angle, gauss u, gauss v, alpha jitter) matches native
    for (let i = 0; i < 5; i++) {
      const a = rng() * Math.PI * 2, d = gauss(rng) * r * 0.45;
      const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
      this.disc(px, py, r * 0.5, alpha * (0.22 + 0.16 * rng()), r * 0.32, rgb);
    }
    // dense core
    this.disc(x, y, r * 0.24, alpha * 0.55, r * 0.14, rgb);
    // overspray speckle — rng order (angle, distance, radius) matches native
    for (let i = 0; i < 3; i++) {
      const a = rng() * Math.PI * 2, d = r * (0.8 + rng() * 0.9);
      this.disc(x + Math.cos(a) * d, y + Math.sin(a) * d, r * 0.06 + rng() * r * 0.05, alpha * 0.5, 0, rgb);
    }
    this.version++;
  }

  /** A run of paint downward from (yaw, pitch), lengthDeg long. */
  drip(yaw: number, pitch: number, lengthDeg: number, alpha: number, color: string, rng: () => number) {
    if (!onWall(yaw, pitch)) return;
    if (!this.ctx) return;
    const { x, y } = Wall.toPx(yaw, pitch);
    const scale = Wall.pxPerDeg(yaw, pitch);
    const len = lengthDeg * scale;
    const w = (0.18 + rng() * 0.12) * scale;
    const steps = Math.max(4, Math.floor(len / (w * 0.6)));
    const rgb = parseColor(color);
    let px = x + (rng() - 0.5) * w;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      px += (rng() - 0.5) * w * 0.35;
      const rr = w * (1 - 0.45 * t);
      this.disc(px, y + len * t, rr, alpha * (0.75 - 0.35 * t), rr * 0.25, rgb);
    }
    // the blob at the end of the run
    this.disc(px, y + len, w * 0.9, alpha * 0.7, w * 0.35, darken(rgb, 0.85));
    this.disc(x, y, w * 2.2, alpha * 0.25, w * 0.8, darken(rgb, 0.8)); // pooled source
    this.version++;
  }

  applyPoint(p: StrokePoint, color: string, rng: () => number) {
    const [yaw, pitch, size, alpha, kind] = p;
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || !Number.isFinite(size) || !Number.isFinite(alpha)) return;
    if (size <= 0 || size > MAX_POINT_SIZE_DEG) return;
    if (kind === 1) this.drip(yaw, pitch, size, alpha, color, rng);
    else this.dab(yaw, pitch, size, alpha, color, rng);
  }

  /** Replays a stored stroke with its seeded rng. Tolerates the loose `number[][]` rows from the DB. */
  replay(stroke: Stroke) {
    const rng = seededRng(stroke.id);
    for (const raw of stroke.points) {
      const p = toPoint(raw);
      if (p) this.applyPoint(p, stroke.color, rng);
    }
  }
}

export function capRadius(cap: Cap) { return CAP_RADIUS_DEG[cap]; }

function toPoint(raw: unknown): StrokePoint | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const yaw = Number(raw[0]), pitch = Number(raw[1]), size = Number(raw[2]), alpha = Number(raw[3]);
  if (![yaw, pitch, size, alpha].every(Number.isFinite)) return null;
  return [yaw, pitch, size, alpha, raw.length > 4 && Number(raw[4]) === 1 ? 1 : 0];
}

function gauss(rng: () => number) {
  // Box–Muller, clamped
  const u = Math.max(1e-6, rng()), v = rng();
  return Math.max(-2.5, Math.min(2.5, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)));
}

/** Standard normal CDF via Abramowitz–Stegun 7.1.26 erf (|err| < 1.5e-7). */
function phi(z: number) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  const erf = z < 0 ? -y : y;
  return 0.5 * (1 + erf);
}

function darken(rgb: Rgb, f: number): Rgb {
  return [Math.round(rgb[0] * f), Math.round(rgb[1] * f), Math.round(rgb[2] * f)];
}

function rgba(rgb: Rgb, a: number) {
  const alpha = a <= 0 ? 0 : a >= 1 ? 1 : Math.round(a * 1000) / 1000;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

// ---- colour parsing ---------------------------------------------------------------------

const rgbCache = new Map<string, Rgb>();
let probe: CanvasRenderingContext2D | null | undefined;

/** #rgb / #rgba / #rrggbb / #rrggbbaa fast path; any other CSS colour is resolved once through a 1×1 canvas. */
function parseColor(color: string): Rgb {
  const cached = rgbCache.get(color);
  if (cached) return cached;
  let out: Rgb = [255, 255, 255];
  const m = /^#([0-9a-f]{3,8})$/i.exec(color.trim());
  if (m && (m[1].length === 3 || m[1].length === 4 || m[1].length === 6 || m[1].length === 8)) {
    let h = m[1];
    if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    out = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  } else {
    if (probe === undefined) {
      try {
        const c = document.createElement('canvas');
        c.width = 1; c.height = 1;
        probe = c.getContext('2d', { willReadFrequently: true });
      } catch { probe = null; }
    }
    if (probe) {
      try {
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = '#ffffff';
        probe.fillStyle = color;
        probe.fillRect(0, 0, 1, 1);
        const d = probe.getImageData(0, 0, 1, 1).data;
        out = [d[0], d[1], d[2]];
      } catch {}
    }
  }
  rgbCache.set(color, out);
  return out;
}

// ---- registry ---------------------------------------------------------------------------

/** Registry of live walls (one per canvas id). */
const walls = new Map<string, Wall>();
export function getWall(id: string) {
  let w = walls.get(id);
  if (!w) { w = new Wall(id); walls.set(id, w); }
  return w;
}
export function hasWall(id: string) { return walls.has(id); }
export function dropWall(id: string) { walls.get(id)?.dispose(); walls.delete(id); }
