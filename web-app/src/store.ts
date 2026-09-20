import { create } from 'zustand';
import { DEFAULT_OPTION_A, DEFAULT_OPTION_B, HFOV_DEG, PAINT_MAX, type SprayOption } from './config';
import type { Canvas, Painter, Side, Stroke } from './types';

export type Settings = {
  optionA: SprayOption;
  optionB: SprayOption;
  geofenceBypass: boolean;
  hfov: number;
  haptics: boolean;
  sound: boolean;
};
export type Loc = { lat: number; lng: number; accuracy: number };

export type Debug = { held: string; blocker: string; walls: number; poseReady: boolean; sensors: string; camera: string };

type State = {
  painter: Painter | null;
  settings: Settings;
  paint: Record<Side, number>;
  shake: number; // 0..1 can charge
  location: Loc | null;
  canvases: Record<string, Canvas>;
  strokes: Record<string, Stroke[]>;
  discovered: Record<string, true>;
  wallVersion: number; // bumps whenever any wall raster changes
  online: boolean;
  tab: 'paint' | 'map' | 'board';
  settingsOpen: boolean;
  debug: Debug;

  setPainter: (p: Painter | null) => void;
  setSettings: (s: Partial<Settings>) => void;
  setPaint: (side: Side, v: number) => void;
  setShake: (v: number) => void;
  setLocation: (l: Loc | null) => void;
  upsertCanvas: (c: Canvas) => void;
  setCanvases: (cs: Canvas[]) => void;
  setStrokes: (canvasId: string, ss: Stroke[]) => void;
  addStroke: (s: Stroke) => boolean;
  markDiscovered: (id: string) => void;
  bumpWalls: () => void;
  setOnline: (b: boolean) => void;
  setTab: (t: State['tab']) => void;
  setSettingsOpen: (b: boolean) => void;
  setDebug: (d: Partial<Debug>) => void;
};

const DEFAULT_SETTINGS: Settings = {
  optionA: DEFAULT_OPTION_A,
  optionB: DEFAULT_OPTION_B,
  geofenceBypass: false,
  hfov: HFOV_DEG,
  haptics: true,
  sound: true,
};

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`tagged:${key}`);
    if (!v) return fallback;
    const parsed: unknown = JSON.parse(v);
    // a persisted null (signed-out painter) must stay null, not become a truthy `{}`
    if (parsed === null || typeof parsed !== 'object') return fallback;
    return fallback !== null && typeof fallback === 'object' ? { ...fallback, ...(parsed as object) } as T : (parsed as T);
  } catch { return fallback; }
}
function persist(key: string, value: unknown) {
  try {
    if (value == null) localStorage.removeItem(`tagged:${key}`);
    else localStorage.setItem(`tagged:${key}`, JSON.stringify(value));
  } catch {}
}

export const useStore = create<State>((set, get) => ({
  painter: load<Painter | null>('painter', null),
  settings: load<Settings>('settings', DEFAULT_SETTINGS),
  paint: { A: PAINT_MAX, B: PAINT_MAX },
  shake: 1, // a fresh can: the first spray works without shaking; charge decays from there
  location: null,
  canvases: {},
  strokes: {},
  discovered: load<Record<string, true>>('discovered', {}),
  wallVersion: 0,
  online: false,
  tab: 'paint',
  settingsOpen: false,
  debug: { held: '-', blocker: '-', walls: 0, poseReady: false, sensors: '?', camera: '?' },

  setPainter: (painter) => { set({ painter }); persist('painter', painter); },
  setSettings: (s) => { const settings = { ...get().settings, ...s }; set({ settings }); persist('settings', settings); },
  setPaint: (side, v) => set((st) => ({ paint: { ...st.paint, [side]: v } })),
  setShake: (shake) => set({ shake }),
  setLocation: (location) => set({ location }),
  upsertCanvas: (c) => set((st) => ({ canvases: { ...st.canvases, [c.id]: { ...st.canvases[c.id], ...c } } })),
  setCanvases: (cs) => set((st) => {
    const canvases = { ...st.canvases };
    for (const c of cs) canvases[c.id] = { ...canvases[c.id], ...c };
    return { canvases };
  }),
  setStrokes: (canvasId, ss) => set((st) => ({ strokes: { ...st.strokes, [canvasId]: ss } })),
  addStroke: (s) => {
    const cur = get().strokes[s.canvas_id] ?? [];
    if (cur.some((x) => x.id === s.id)) return false;
    set((st) => ({ strokes: { ...st.strokes, [s.canvas_id]: [...cur, s] } }));
    return true;
  },
  markDiscovered: (id) => { const discovered = { ...get().discovered, [id]: true as const }; set({ discovered }); persist('discovered', discovered); },
  bumpWalls: () => set((st) => ({ wallVersion: st.wallVersion + 1 })),
  setOnline: (online) => set({ online }),
  setTab: (tab) => set({ tab }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setDebug: (d) => set((st) => ({ debug: { ...st.debug, ...d } })),
}));
