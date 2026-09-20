// Central tunables — mirrors the native app's src/config.ts so both clients agree on the
// shared canvas model (angular coordinates, canvas radii, paint economy).

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
export const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY ?? '';

// ---- projection -----------------------------------------------------------
// Horizontal field of view of the camera preview across the phone's SHORT edge, degrees (the
// angle the visible preview spans, not the sensor's). A phone main camera spans ~52° across the
// short edge of a 4:3 stream, but `object-fit: cover` on a 9:19.5 screen only shows ~60% of that
// width, so the preview the user sees is ≈ 36°. Only affects on-screen px/deg (paint is stored in
// degrees); tunable in Settings ("AR scale").
export const HFOV_DEG = 36;
// ARKit's `.gravityAndHeading` frame (the iPhone app's AR strokes) is aligned to TRUE north (it needs
// Location Services for the declination lookup), while every canvas heading is MAGNETIC (raw
// magnetometer natively, webkitCompassHeading / deviceorientationabsolute here). Declination at
// Waterloo Region, east-positive: magnetic = true − declination. Set to 0 if a field check shows
// the AR frame is already magnetic.
export const MAG_DECLINATION_DEG = -9.7;
// Offscreen wall raster: pixels per degree. 12 px/deg over ±90° yaw × ±60° pitch = 2160×1440.
export const WALL_PX_PER_DEG = 12; // raster resolution near the middle of the wall
// How much of a flat wall one canvas covers, as angles from the spot its author stood on. A
// tangent plane can't reach 90° (that is parallel to the wall), and past ~55° you are looking
// along it rather than at it, so this is the useful extent of "the wall in front of me".
export const WALL_YAW_RANGE = 55;
export const WALL_PITCH_RANGE = 40;

// ---- canvases / geo --------------------------------------------------------
export const CANVAS_JOIN_RADIUS_M = 15;
/**
 * You only join a wall you are actually looking at. A canvas is a finite surface facing one way,
 * so the nearest one can easily be the wall behind you — join that and every dab lands off its
 * edge. Past this, spraying starts a new wall facing where you stand.
 */
export const CANVAS_JOIN_YAW_DEG = 45;
export const CANVAS_VISIBLE_RADIUS_M = 35;
export const DISCOVERY_SHIMMER_RADIUS_M = 80;
export const DISCOVERED_RADIUS_M = 14;
export const NEARBY_FETCH_RADIUS_M = 600;

// Waterloo Region geofence: ~25 km circle centred between Kitchener, Waterloo and Cambridge.
export const GEOFENCE = { lat: 43.45, lng: -80.48, radiusM: 25000 };

// ---- paint economy ---------------------------------------------------------
export const PAINT_MAX = 100;
export const PAINT_COST_PER_SEC = { fat: 5.5, skinny: 3.5 } as const;
export const PAINT_REGEN_PER_SEC = 2.2;
export const PAINT_EMPTY_THRESHOLD = 1;
export const PAINT_LOW_THRESHOLD = 18;

// ---- shake-the-can ---------------------------------------------------------
export const SHAKE_DECAY_SECONDS = 60;
export const SHAKE_MIN_TO_SPRAY = 0.12;
export const SHAKE_ACCEL_THRESHOLD = 2.4; // g, user acceleration magnitude
export const SHAKE_GAIN_PER_EVENT = 0.18;

// ---- spray ----------------------------------------------------------------
export type Cap = 'fat' | 'skinny';
export type SprayOption = { color: string; cap: Cap; name: string };
export const DEFAULT_OPTION_A: SprayOption = { color: '#ff2d95', cap: 'fat', name: 'Hot pink · fat cap' };
export const DEFAULT_OPTION_B: SprayOption = { color: '#19e6ff', cap: 'skinny', name: 'Cyan · skinny cap' };
export const PALETTE = ['#ff2d95', '#19e6ff', '#ffe600', '#7cff3a', '#ff5c1a', '#b26bff', '#ffffff', '#111111'];
export const CAP_RADIUS_DEG: Record<Cap, number> = { fat: 2.6, skinny: 1.15 };
export const DWELL_POOL_SECONDS = 1.1;
export const DWELL_RADIUS_DEG = 1.2;

// AR strokes from the iPhone app live in a north-aligned metric frame (ARKit gravityAndHeading,
// origin ≈ the canvas GPS point). The web projects them onto the compass sphere; a stroke this far
// from the origin (metres) is treated as at this distance for sizing.
export const AR_MIN_DISTANCE_M = 0.6;
