import React, { useMemo } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { Canvas, Path, Rect, Skia } from '@shopify/react-native-skia';
import { BACKDROPS, type BackdropName } from './theme';
import { mix } from './color';
import { seededRng } from '../lib/ids';

const BANDS = 14;
const CELL = 3;

/**
 * Full-screen CRT backdrop: a banded (posterised) gradient with ordered-dither seams, a few
 * pixel stars and faint scanlines. Drawn once with Skia rects, so it costs nothing per frame.
 */
export function Backdrop({ tone = 'purple' }: { tone?: BackdropName }) {
  const { width, height } = useWindowDimensions();
  const t = BACKDROPS[tone];
  const scene = useMemo(() => {
    const bandH = Math.ceil(height / BANDS);
    const bands = Array.from({ length: BANDS }, (_, i) => ({ y: i * bandH, color: mix(t.top, t.bottom, i / (BANDS - 1)) }));
    // dither seam: the next band's colour pokes into the last two rows of the previous band in a checker
    const seams = bands.slice(1).map((b, i) => {
      const p = Skia.Path.Make();
      for (let row = 0; row < 2; row++) {
        for (let x = 0; x < width; x += CELL) if (((x / CELL) + row) % 2 === 0) p.addRect(Skia.XYWHRect(x, b.y - CELL * (2 - row), CELL, CELL));
      }
      return { path: p, color: b.color, key: i };
    });
    const stars = Skia.Path.Make();
    const rng = seededRng(`stars-${tone}`);
    for (let i = 0; i < 46; i++) {
      const x = Math.floor((rng() * width) / CELL) * CELL, y = Math.floor((rng() * height * 0.62) / CELL) * CELL;
      const big = rng() > 0.86;
      stars.addRect(Skia.XYWHRect(x, y, CELL, CELL));
      if (big) {
        stars.addRect(Skia.XYWHRect(x - CELL, y, CELL, CELL)); stars.addRect(Skia.XYWHRect(x + CELL, y, CELL, CELL));
        stars.addRect(Skia.XYWHRect(x, y - CELL, CELL, CELL)); stars.addRect(Skia.XYWHRect(x, y + CELL, CELL, CELL));
      }
    }
    const scan = Skia.Path.Make();
    for (let y = 0; y < height; y += 6) scan.addRect(Skia.XYWHRect(0, y, width, 2));
    return { bands, seams, stars, scan, bandH };
  }, [width, height, tone]);
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      {scene.bands.map((b, i) => <Rect key={i} x={0} y={b.y} width={width} height={scene.bandH + 1} color={b.color} />)}
      {scene.seams.map((s) => <Path key={s.key} path={s.path} color={s.color} antiAlias={false} />)}
      <Path path={scene.stars} color={t.star} opacity={0.5} antiAlias={false} />
      <Path path={scene.scan} color="#000000" opacity={0.13} antiAlias={false} />
    </Canvas>
  );
}
