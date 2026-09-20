import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import {
  DEFAULT_OPTION_A, DEFAULT_OPTION_B, GEOFENCE_BYPASS_DEFAULT, HFOV_DEG, PAINT_MAX, SprayOption,
} from './config';
import type { Canvas, Painter, Stroke } from './types';

export type Side = 'A' | 'B';
/** Dock order: your side (profile, vault) · the camera · the world (explore, social). */
export type Tab = 'profile' | 'vault' | 'create' | 'explore' | 'social';
/** Pages that slide up over any tab instead of taking a dock slot. */
export type Sheet = 'market' | 'settings';
export type Settings = {
  optionA: SprayOption;
  optionB: SprayOption;
  volumeButtons: boolean; // hardware volume rocker also sprays (on-screen hold buttons are always on)
  avatarColor: string;
  onboarded: boolean;
  geofenceBypass: boolean;
  hfov: number;
  haptics: boolean;
  sound: boolean;
  showPlanes: boolean; // AR: tint detected surfaces
  // ---- local-only (no backend): crew pick, market wallet + unlocks, Create tools
  crew: string | null;
  owned: string[]; // market item ids
  spent: number; // coins spent
  bonus: number; // coins earned from claimed missions
  claimed: Record<string, true>; // `${yyyy-mm-dd}:${missionId}`
  canSkin: string; // 'paint' = body follows the equipped colour
  thickness: number; // Create: index into THICKNESS
  opacity: number; // Create: index into OPACITY
  debugHud: boolean; // Create: show the tracking/debug line
};
export type Loc = { lat: number; lng: number; accuracy: number };

type State = {
  painter: Painter | null;
  settings: Settings;
  paint: Record<Side, number>;
  shake: number; // 0..1 can charge
  location: Loc | null;
  canvases: Record<string, Canvas>;
  strokes: Record<string, Stroke[]>;
  /** Strokes fetched only for thumbnails (explore/vault): no wall raster is built for these. */
  previewStrokes: Record<string, Stroke[]>;
  setPreviewStrokes: (byCanvas: Record<string, Stroke[]>) => void;
  discovered: Record<string, true>;
  /** canvas id → local file uri of a photo of that wall (camera + paint), taken in Create. */
  photos: Record<string, string>;
  setPhoto: (canvasId: string, uri: string) => void;
  /** Strokes you undid. Kept so a refetch (or a failed server delete) can't bring them back. */
  deleted: Record<string, true>;
  removeStroke: (canvasId: string, id: string) => void;
  wallVersion: number; // bumps whenever any wall raster changes
  online: boolean;
  tab: Tab;
  sheet: Sheet | null;
  debug: { volEvents: number; lastVol: number; held: string; blocker: string; walls: number; poseReady: boolean; surface: string };
  setDebug: (d: Partial<State['debug']>) => void;

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
  setSheet: (s: Sheet | null) => void;
};

const DEFAULT_SETTINGS: Settings = {
  optionA: DEFAULT_OPTION_A,
  optionB: DEFAULT_OPTION_B,
  volumeButtons: true,
  avatarColor: '#ff2d95',
  onboarded: false,
  geofenceBypass: GEOFENCE_BYPASS_DEFAULT,
  hfov: HFOV_DEG,
  haptics: true,
  sound: true,
  showPlanes: true,
  crew: null,
  owned: [],
  spent: 0,
  bonus: 0,
  claimed: {},
  canSkin: 'paint',
  thickness: 1,
  opacity: 3,
  debugHud: false,
};

export const useStore = create<State>((set, get) => ({
  painter: null,
  settings: DEFAULT_SETTINGS,
  paint: { A: PAINT_MAX, B: PAINT_MAX },
  shake: 1, // a fresh can: the first spray works without shaking; charge decays from there
  location: null,
  canvases: {},
  strokes: {},
  previewStrokes: {},
  setPreviewStrokes: (byCanvas) => set((st) => {
    const { deleted } = st;
    const clean = Object.fromEntries(Object.entries(byCanvas).map(([id, ss]) => [id, ss.filter((s) => !deleted[s.id])]));
    return { previewStrokes: { ...st.previewStrokes, ...clean } };
  }),
  discovered: {},
  photos: {},
  setPhoto: (canvasId, uri) => { const photos = { ...get().photos, [canvasId]: uri }; set({ photos }); persist('photos', photos); },
  deleted: {},
  removeStroke: (canvasId, id) => {
    const deleted = { ...get().deleted, [id]: true as const };
    set((st) => ({ deleted, strokes: { ...st.strokes, [canvasId]: (st.strokes[canvasId] ?? []).filter((s) => s.id !== id) } }));
    persist('deleted', deleted);
  },
  wallVersion: 0,
  online: false,
  tab: 'create', // the camera is the centre of the app: it opens there
  sheet: null,
  debug: { volEvents: 0, lastVol: 0.5, held: '-', blocker: '-', walls: 0, poseReady: false, surface: '?' },
  setDebug: (d) => set((st) => ({ debug: { ...st.debug, ...d } })),

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
    if (get().deleted[s.id]) return false; // you took this one back
    const cur = get().strokes[s.canvas_id] ?? [];
    if (cur.some((x) => x.id === s.id)) return false;
    set((st) => ({ strokes: { ...st.strokes, [s.canvas_id]: [...cur, s] } }));
    return true;
  },
  markDiscovered: (id) => { const discovered = { ...get().discovered, [id]: true as const }; set({ discovered }); persist('discovered', discovered); },
  bumpWalls: () => set((st) => ({ wallVersion: st.wallVersion + 1 })),
  setOnline: (online) => set({ online }),
  setTab: (tab) => set({ tab }),
  setSheet: (sheet) => set({ sheet }),
}));

function persist(key: string, value: unknown) {
  AsyncStorage.setItem(`tagged:${key}`, JSON.stringify(value)).catch(() => {});
}

export async function hydrateStore() {
  try {
    const [p, s, d, ph, del] = await Promise.all(['painter', 'settings', 'discovered', 'photos', 'deleted'].map((k) => AsyncStorage.getItem(`tagged:${k}`)));
    useStore.setState({
      painter: p ? JSON.parse(p) : null,
      settings: { ...DEFAULT_SETTINGS, ...(s ? JSON.parse(s) : {}) },
      discovered: d ? JSON.parse(d) : {},
      photos: ph ? JSON.parse(ph) : {},
      deleted: del ? JSON.parse(del) : {},
    });
  } catch {}
}
