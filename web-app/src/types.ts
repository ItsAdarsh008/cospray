import type { Cap } from './config';

/** [yaw, pitch, size(deg), alpha, kind] — kind 0 = spray dab centre, 1 = drip. Canvas-relative degrees. */
export type StrokePoint = [number, number, number, number, number];

/** A row of `strokes`. Two flavours share the table:
 *  - compass strokes (web + native fallback): `points` in canvas-relative degrees, anchor_id null
 *  - AR strokes (iPhone ARKit): `points` = [u, v, radiusM, alpha, kind] metres in the anchor plane,
 *    `anchor_id` set, `transform` = 16 floats column-major, north-aligned (−Z = north, +X = east, +Y = up). */
export type Stroke = {
  id: string;
  canvas_id: string;
  author_id: string | null;
  author_name: string;
  color: string;
  cap: Cap;
  points: StrokePoint[] | number[][];
  paint_used: number;
  created_at: string;
  anchor_id?: string | null;
  transform?: number[] | null;
  /** AR strokes only: camera world position [x, y, z] (same frame as `transform`) when the stroke
   *  was sprayed, so the web can project it as seen from where the painter stood. Optional column. */
  viewer?: number[] | null;
};

export type Canvas = {
  id: string;
  lat: number;
  lng: number;
  heading: number; // compass heading of the wall centre (magnetic, degrees)
  title: string | null;
  author_id: string | null;
  author_name: string;
  views: number;
  stroke_count: number;
  flags: number;
  flagged: boolean;
  created_at: string;
  updated_at: string;
  world_map_path?: string | null;
  world_map_updated_at?: string | null;
};

export type Painter = { id: string; name: string; paint_used: number; strokes: number };

export type Pose = { yaw: number; pitch: number; roll: number; ready: boolean };
export type Side = 'A' | 'B';
export type Blocker = null | 'no-location' | 'outside-geofence' | 'shake' | 'empty' | 'no-sensors';
