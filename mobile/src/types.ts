import type { Cap } from './config';
import type { GeoPose } from '../modules/ar-paint';

/** [yaw, pitch, size(deg), alpha, kind] — kind 0 = spray dab centre, 1 = a drip from an older build (never drawn now). Canvas-relative degrees. */
export type StrokePoint = [number, number, number, number, number];

export type Stroke = {
  id: string;
  canvas_id: string;
  author_id: string | null;
  author_name: string;
  color: string;
  cap: Cap;
  points: StrokePoint[];
  /** Wire format (lib/strokeCodec): rows from the server carry these instead of `points`; sync decodes them. */
  points_bin?: string | null;
  points_v?: number | null;
  paint_used: number;
  created_at: string;
  /** AR: custom ARAnchor id + its 4x4 transform (column-major) in the canvas world map. Null for compass-mode strokes. */
  anchor_id?: string | null;
  transform?: number[] | null;
  /** AR strokes: camera world position [x,y,z] when sprayed, so other clients project from where the painter stood. */
  viewer?: number[] | null;
  /** AR strokes (Android + Geospatial): the quad's WGS84 pose, so any phone with a VPS fix can place it exactly. */
  geo?: GeoPose | null;
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
  upvotes: number;
  stroke_count: number;
  flags: number;
  flagged: boolean;
  created_at: string;
  updated_at: string;
  world_map_path?: string | null;
  world_map_updated_at?: string | null;
};

export type Painter = { id: string; name: string; paint_used: number; strokes: number };
