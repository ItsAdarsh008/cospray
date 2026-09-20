import type { Painter, Stroke } from '../types';
import type { Settings } from '../store';

/**
 * Local economy. Paint you spray earns coins (1 per 8 paint); missions add bonus coins; the
 * Market spends them. Everything is derived from the painter's synced stats plus a few local
 * counters, so it needs no backend changes.
 */
export const PAINT_PER_COIN = 8;
export const coinsOf = (painter: Painter | null, s: Pick<Settings, 'bonus' | 'spent'>) =>
  Math.max(0, Math.floor((painter?.paint_used ?? 0) / PAINT_PER_COIN) + s.bonus - s.spent);

export type Item = { id: string; name: string; price: number; color: string; blurb: string };
export const MARKET_PAINTS: Item[] = [
  { id: 'p-coral', name: 'Coral', price: 40, color: '#ff6f61', blurb: 'warm and loud' },
  { id: 'p-mint', name: 'Mint', price: 40, color: '#3dffc0', blurb: 'fresh tag' },
  { id: 'p-gold', name: 'Gold', price: 60, color: '#ffb400', blurb: 'king of the wall' },
  { id: 'p-toxic', name: 'Toxic', price: 60, color: '#b6ff00', blurb: 'glows in the dark' },
  { id: 'p-ultra', name: 'Ultraviolet', price: 80, color: '#8a2bff', blurb: 'club lights' },
  { id: 'p-chrome', name: 'Chrome', price: 90, color: '#cfd8e8', blurb: 'mirror silver' },
];
export const MARKET_CANS: Item[] = [
  { id: 'c-void', name: 'Void', price: 100, color: '#3a2a78', blurb: 'matte night can' },
  { id: 'c-gold', name: 'Gold Rush', price: 120, color: '#ffc21a', blurb: 'shiny gold body' },
  { id: 'c-toxic', name: 'Toxic Waste', price: 140, color: '#a6ff00', blurb: 'radioactive green' },
  { id: 'c-chrome', name: 'Chrome', price: 160, color: '#c9d3e6', blurb: 'polished steel' },
];
export const SOON = ['Glitter', 'Metallic shimmer', 'Neon glow', 'Matte finish', 'Stencil pack', 'Sound packs'];
/** Colour of the can body: the equipped paint by default, or a bought skin. */
export const skinColor = (canSkin: string, paintColor: string) => MARKET_CANS.find((c) => c.id === canSkin)?.color ?? paintColor;
/** Every colour the pickers offer: the base palette plus bought paints. */
export const ownedPaints = (owned: string[]) => MARKET_PAINTS.filter((p) => owned.includes(p.id)).map((p) => p.color);
const BASE_NAMES: Record<string, string> = {
  '#ff2d95': 'Hot pink', '#19e6ff': 'Cyan', '#ffe600': 'Yellow', '#7cff3a': 'Lime',
  '#ff5c1a': 'Orange', '#b26bff': 'Violet', '#ffffff': 'White', '#111111': 'Black',
};
/** Display name for a paint colour (base palette or a Market paint). */
export const colorName = (hex: string) => BASE_NAMES[hex.toLowerCase()] ?? MARKET_PAINTS.find((p) => p.color === hex)?.name ?? hex;

// ---- daily stats + missions ---------------------------------------------------------------
export type DayStats = { strokes: number; pieces: number; paint: number; streak: number };
export function dayStats(all: Pick<Stroke, 'author_id' | 'created_at' | 'paint_used' | 'canvas_id'>[], me?: string): DayStats {
  const mine = me ? all.filter((s) => s.author_id === me) : [];
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const today = mine.filter((s) => new Date(s.created_at) >= start);
  const days = new Set(mine.map((s) => s.created_at.slice(0, 10)));
  let streak = 0; const d = new Date();
  while (days.has(d.toISOString().slice(0, 10))) { streak++; d.setDate(d.getDate() - 1); }
  return { strokes: today.length, pieces: new Set(today.map((s) => s.canvas_id)).size, paint: Math.round(today.reduce((a, s) => a + s.paint_used, 0)), streak };
}
export type Mission = { id: string; title: string; hot: string; goal: number; reward: number; get: (d: DayStats) => number };
export const MISSIONS: Mission[] = [
  { id: 'paint', title: 'Spray {n} paint', hot: '60', goal: 60, reward: 20, get: (d) => d.paint },
  { id: 'walls', title: 'Paint on {n} walls', hot: '2', goal: 2, reward: 25, get: (d) => d.pieces },
  { id: 'strokes', title: 'Make {n} strokes', hot: '8', goal: 8, reward: 15, get: (d) => d.strokes },
];
export const dayKey = () => new Date().toISOString().slice(0, 10);

// ---- crews (local pick; a backend for crews is out of scope) --------------------------------
export const CREWS = [
  { id: 'e7', name: 'E7 CREW', blurb: 'engineering courtyard' },
  { id: 'slc', name: 'SLC SQUAD', blurb: 'student life centre' },
  { id: 'dc', name: 'DC DRIPPERS', blurb: 'the library wall' },
  { id: 'uptown', name: 'UPTOWN TAGS', blurb: 'downtown Waterloo' },
];

// ---- Create tools ---------------------------------------------------------------------------
export const THICKNESS = [{ label: 'S', mult: 0.6 }, { label: 'M', mult: 1 }, { label: 'L', mult: 1.6 }, { label: 'XL', mult: 2.4 }];
export const OPACITY = [{ label: '25', mult: 0.25 }, { label: '50', mult: 0.5 }, { label: '75', mult: 0.75 }, { label: '100', mult: 1 }];
