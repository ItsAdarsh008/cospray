import React, { useMemo } from 'react';
import { Image } from 'react-native';
import { Canvas, Group, Path, Rect, Skia } from '@shopify/react-native-skia';
import { useStore } from '../store';
import { isMock } from '../data/mock';
import { seededRng } from '../lib/ids';
import type { Stroke } from '../types';

export type Dab = { x: number; y: number; r: number; a: number; color: string };

/**
 * A piece as a pixel mosaic: every dab is snapped to a coarse grid, so a 4000-dab wall becomes at
 * most a couple of thousand squares and reads as chunky digitised art. Compass strokes are in
 * degrees, AR strokes in anchor-local metres; either way the cloud is normalised to its bounds.
 * Mock canvases (no strokes) get a deterministic scribble so grids aren't empty.
 *
 * `wall` puts the paint on a brick wall instead of a flat plate, for the places that show a piece
 * as a piece (Vault, Explore). A real photo of the wall, when the painter took one, beats both.
 */
export function StrokeThumb({ canvasId, width, height, radius = 0, bg = '#171033', cell = 3, wall = false }: {
  canvasId: string; width: number; height: number; radius?: number; bg?: string; cell?: number; wall?: boolean;
}) {
  const strokes = useStore((s) => s.strokes[canvasId] ?? s.previewStrokes[canvasId]);
  const tiles = useMemo(() => mosaic(layoutDabs(strokes ?? [], canvasId, width, height), cell), [strokes, canvasId, width, height, cell]);
  const bricks = useMemo(() => (wall ? wallPaths(canvasId, width, height) : null), [wall, canvasId, width, height]);
  const clip = useMemo(() => (radius > 0 ? Skia.RRectXY(Skia.XYWHRect(0, 0, width, height), radius, radius) : Skia.RRectXY(Skia.XYWHRect(0, 0, width, height), 0, 0)), [radius, width, height]);
  return (
    <Canvas style={{ width, height }} pointerEvents="none">
      <Group clip={clip}>
        <Rect x={0} y={0} width={width} height={height} color={bricks ? BRICK.base : bg} />
        {bricks ? (
          <>
            <Path path={bricks.light} color={BRICK.light} antiAlias={false} />
            <Path path={bricks.dark} color={BRICK.dark} antiAlias={false} />
            <Path path={bricks.mortar} color={BRICK.mortar} antiAlias={false} />
          </>
        ) : null}
        {tiles.map((t, i) => <Rect key={i} x={t.x} y={t.y} width={t.s} height={t.s} color={t.color} opacity={t.a} />)}
      </Group>
    </Canvas>
  );
}

/**
 * A piece the way you'd recognise it on the street: the photo the painter took of that wall if
 * there is one (Create → camera button, kept on the phone), otherwise the paint on a brick wall.
 */
export function PieceImage({ canvasId, width, height, cell = 3, radius = 0 }: { canvasId: string; width: number; height: number; cell?: number; radius?: number }) {
  const photo = useStore((s) => s.photos[canvasId]);
  if (photo) return <Image source={{ uri: photo }} style={{ width, height, borderRadius: radius }} resizeMode="cover" />;
  return <StrokeThumb canvasId={canvasId} width={width} height={height} cell={cell} radius={radius} wall />;
}

const BRICK = { base: '#463c66', light: '#51466f', dark: '#352d55', mortar: '#2a2447' };

/** Seeded brick courses: mortar grid plus a few lighter and darker bricks, so no two walls match. */
export function wallPaths(id: string, w: number, h: number) {
  const rng = seededRng(`wall-${id}`);
  const bh = Math.max(4, Math.round(h / 9));
  const bw = Math.max(8, Math.round(bh * 2.3));
  const m = Math.max(1, Math.round(bh / 6));
  const mortar = Skia.Path.Make(), light = Skia.Path.Make(), dark = Skia.Path.Make();
  for (let row = 0, y = 0; y < h; row++, y += bh) {
    mortar.addRect(Skia.XYWHRect(0, y, w, m));
    for (let x = row % 2 ? -bw / 2 : 0; x < w; x += bw) {
      mortar.addRect(Skia.XYWHRect(x, y, m, bh));
      const t = rng();
      const brick = Skia.XYWHRect(x + m, y + m, bw - m, bh - m);
      if (t > 0.74) light.addRect(brick);
      else if (t < 0.2) dark.addRect(brick);
    }
  }
  return { mortar, light, dark };
}

export function mosaic(dabs: Dab[], cell: number) {
  const m = new Map<string, { x: number; y: number; s: number; color: string; a: number }>();
  for (const d of dabs) {
    const s = Math.max(cell, Math.round((d.r * 2) / cell) * cell);
    const x = Math.round((d.x - s / 2) / cell) * cell, y = Math.round((d.y - s / 2) / cell) * cell;
    const a = d.a > 0.6 ? 1 : d.a > 0.3 ? 0.85 : 0.7;
    const k = `${x},${y},${s}`;
    const prev = m.get(k);
    if (!prev || a >= prev.a) m.set(k, { x, y, s, color: d.color, a });
  }
  return [...m.values()];
}

export function layoutDabs(strokes: Stroke[], id: string, w: number, h: number): Dab[] {
  let pts: { x: number; y: number; s: number; a: number; color: string }[] = [];
  for (const st of strokes) for (const p of st.points) {
    if (p[4] === 1) continue; // drips from older strokes aren't painted any more
    pts.push({ x: p[0], y: -p[1], s: p[2], a: Math.min(1, p[3] * 2.5), color: st.color });
  }
  if (!pts.length) {
    if (!isMock(id) && !strokes.length) return [];
    const rng = seededRng(id);
    const colors = ['#ff2d95', '#19e6ff', '#ffe600', '#7cff3a'];
    for (let k = 0; k < 3; k++) {
      const color = colors[Math.floor(rng() * colors.length)];
      let x = rng() * 100, y = rng() * 60, vx = rng() - 0.5, vy = rng() - 0.5;
      for (let i = 0; i < 60; i++) { vx += (rng() - 0.5) * 0.6; vy += (rng() - 0.5) * 0.6; x += vx * 2; y += vy * 2; pts.push({ x, y, s: 3 + rng() * 3, a: 0.5, color }); }
    }
  }
  if (pts.length > 4000) pts = pts.filter((_, i) => i % Math.ceil(pts.length / 4000) === 0);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const span = Math.max(maxX - minX, maxY - minY, 1e-3);
  const scale = (Math.min(w, h) * 0.8) / span;
  const ox = w / 2 - ((minX + maxX) / 2) * scale, oy = h / 2 - ((minY + maxY) / 2) * scale;
  const sizeScale = scale * (pts[0].s > 1 ? 0.35 : 1); // degrees are chunkier than metres
  return pts.map((p) => ({ x: ox + p.x * scale, y: oy + p.y * scale, r: Math.max(1.2, Math.min(w * 0.08, p.s * sizeScale)), a: p.a, color: p.color }));
}
