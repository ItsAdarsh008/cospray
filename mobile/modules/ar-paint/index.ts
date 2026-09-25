import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { EventSubscription } from 'expo-modules-core';
import type { ComponentType, Ref } from 'react';
import type { ViewProps } from 'react-native';

/** Where a quad sat on Earth when it was painted (ARCore Geospatial): WGS84 degrees / metres, east-up-south quaternion [x, y, z, w]. */
export type GeoPose = { lat: number; lng: number; alt: number; q: number[]; hAcc?: number; yawAcc?: number };

export type ArStroke = {
  id: string;
  anchorId: string;
  transform: number[]; // 16 floats, column-major, north-aligned world space of the canvas's world map
  color: string;
  points: number[][]; // [u, v, radiusM, alpha, kind] in the anchor's plane, metres
  viewer?: number[]; // camera world position when the stroke started (same frame as transform)
  /** Android with Geospatial: the quad's pose on Earth, when the painter's fix was good (≤ 5 m, ≤ 10°). */
  geo?: GeoPose;
};

export type ArTrackingEvent = {
  state: 'normal' | 'limited' | 'notAvailable' | 'mapLoaded' | 'mapLoadFailed';
  reason?: string;
  mapping?: 'notAvailable' | 'limited' | 'extending' | 'mapped' | 'unknown' | '';
  planes?: number;
  surfaces?: number;
  anchors?: number;
  lidar?: boolean;
  /** Android: ARCore Depth API active (depth-from-motion on phones without a depth sensor). */
  depth?: boolean;
  /** Android: the compass → north-aligned frame calibration. */
  heading?: 'calibrating' | 'ready';
  /** Android: Geospatial status for the debug line: 'off' | 'searching' | '±1.2m ±3°'. */
  geo?: string;
};

/** What the reticle is on: plane = detected geometry (locked), extended = known plane's extension, mesh = LiDAR (iPhone) / depth (Android), estimated = feature points. */
export type HitKind = 'plane' | 'extended' | 'mesh' | 'estimated' | 'none';
/** `drip` is only sent by builds made before paint stopped running; it is ignored. */
/** `watched` / `moved`: pieces on furniture-sized planes, and how many of those the depth map
 *  currently says are floating because the thing they were painted on has been carried off.
 *  Android only — ARKit's world is just as static, but the iPhone has no equivalent check yet. */
export type ArHitEvent = { hit: boolean; distance: number; drip?: boolean; kind?: HitKind; vertical?: boolean; locked?: boolean; watched?: number; moved?: number };

export type ArPaintViewProps = ViewProps & {
  spraying?: boolean;
  paintColor?: string;
  radius?: number; // metres
  flow?: number; // 0..1
  showPlanes?: boolean;
  /** Hide paint behind real things in front of it: people on iPhone (A12+), anything the depth map sees on Android. Default on. */
  occlusion?: boolean;
  worldMapPath?: string | null;
  onTracking?: (e: { nativeEvent: ArTrackingEvent }) => void;
  onHit?: (e: { nativeEvent: ArHitEvent }) => void;
  onStrokeEnd?: (e: { nativeEvent: ArStroke }) => void;
  onSurface?: (e: { nativeEvent: { id: string; count: number; restored?: boolean; kind?: HitKind } }) => void;
};

export type ArPaintViewRef = {
  saveWorldMap: (path: string) => Promise<{ bytes: number; anchors: number }>;
  /** Writes a JPEG of the camera frame + paint (no reticle, no surface grids) to `path`. Needs a native rebuild: guard with `canSnapshot`. */
  snapshot: (path: string) => Promise<{ width: number; height: number; bytes: number }>;
  /** Repaints the wall without your last stroke of this session and returns it. Guard with `canUndo`. */
  undoLast: () => Promise<{ id: string; anchorId: string } | null>;
  /** mode 'absolute' (default): same world map as this session. 'relative': no map — place from where the painter stood, relative to the camera now. */
  addStrokes: (strokes: ArStroke[], mode?: 'absolute' | 'relative') => Promise<void>;
  clearAll: () => Promise<void>;
  resetSession: () => Promise<void>;
};

export type ArPlatform = 'arkit' | 'arcore';
export type VolumeKeyEvent = { key: 'up' | 'down'; action: 'down' | 'up' };

type ArPaintNativeModule = {
  isSupported?: boolean;
  hasLidar?: boolean;
  hasSnapshot?: boolean;
  hasUndo?: boolean;
  platform?: ArPlatform;
  cloudAnchors?: boolean;
  setVolumeKeysIntercepted?: (enabled: boolean) => void;
  addListener: (event: 'onVolumeKey', fn: (e: VolumeKeyEvent) => void) => EventSubscription;
};

// Optional: the module exists on iOS (ARKit) and Android (ARCore) dev builds, not on web.
const NativeModule = requireOptionalNativeModule<ArPaintNativeModule>('ArPaint');
export const isArSupported: boolean = !!NativeModule?.isSupported;
export const hasLidar: boolean = !!NativeModule?.hasLidar;
/** False on binaries built before wall photos existed, so the UI can hide the capture button. */
export const canSnapshot: boolean = !!NativeModule?.hasSnapshot;
/** False on binaries built before undo existed, so the UI can hide the undo button. */
export const canUndo: boolean = !!NativeModule?.hasUndo;
/** Which AR stack wrote a saved map / stroke; each platform can only relocalise against its own maps. */
export const arPlatform: ArPlatform | null = NativeModule ? (NativeModule.platform ?? 'arkit') : null;
/** Android: Cloud Anchors are configured (keyless auth or an ARCore API key), so pieces can be saved for exact re-placement. */
export const hasCloudAnchors: boolean = !!NativeModule?.cloudAnchors;
/** Path of the app's own App Group container (iOS only). */
export const appGroupPath: string | null = (NativeModule as any)?.appGroupPath ?? null;
export type MapSnapshotResult = { path: string; width: number; height: number; pts: { id: string; x: number; y: number; w: number }[] };
/** Apple Maps snapshot into the App Group for the widget (iOS only; rejects elsewhere). */
export const mapSnapshot = (opts: { name: string; lat: number; lng: number; spanM: number; width: number; height: number; spots: { id: string; lat: number; lng: number; w: number }[] }): Promise<MapSnapshotResult> =>
  (NativeModule as any)?.mapSnapshot ? (NativeModule as any).mapSnapshot(opts) : Promise.reject(new Error('unsupported'));
/** Path of the App Group container expo-live-activity loads images from (iOS only). */
export const liveActivityGroupPath: string | null = (NativeModule as any)?.liveActivityGroupPath ?? null;
export const ArPaintView = (NativeModule ? requireNativeView('ArPaint') : () => null) as ComponentType<ArPaintViewProps & { ref?: Ref<ArPaintViewRef> }>;

/** Android only: real volume-key press/release (the keys are swallowed while intercepted). */
export const volumeKeys = NativeModule?.setVolumeKeysIntercepted
  ? {
      setIntercepted: (enabled: boolean) => NativeModule.setVolumeKeysIntercepted!(enabled),
      addListener: (fn: (e: VolumeKeyEvent) => void) => NativeModule.addListener('onVolumeKey', fn),
    }
  : null;

/** Quads made on Android are named "paint-a-…", iPhone ones "paint-…". */
export function strokePlatform(anchorId: string): ArPlatform {
  return anchorId.startsWith('paint-a-') ? 'arcore' : 'arkit';
}

/** Saved maps: iPhone ARWorldMap = "<canvas>.arworldmap", Android Cloud Anchor list = "<canvas>.arcore.json". */
export function worldMapPlatform(path: string): ArPlatform {
  return path.endsWith('.arcore.json') ? 'arcore' : 'arkit';
}
export const worldMapExtension = arPlatform === 'arcore' ? '.arcore.json' : '.arworldmap';
