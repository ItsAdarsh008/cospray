import React, { useEffect, useMemo } from 'react';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { darken, lighten } from './color';
import { C } from './theme';

const W = 16, H = 26; // grid cells (the outline adds one on every side)
type R = [number, number, number, number, string];

/**
 * The spray can as pixel art: shaded body in the paint colour, grey cap + nozzle, a label with
 * an F. The paint left shows as the coloured part of the body; the rest reads as empty metal.
 */
export function PixelCan({ color, level = 1, cell = 4, wobble = false }: { color: string; level?: number; cell?: number; wobble?: boolean }) {
  const paths = useMemo(() => {
    const grey = '#b9b3d6', greyHi = '#e6e2f7', greyLo = '#7f78a6';
    const filled = Math.round(Math.max(0, Math.min(1, level)) * 17);
    const rects: R[] = [];
    const sil: [number, number, number, number][] = [[6, 0, 4, 2], [5, 2, 6, 1], [4, 3, 8, 2], [3, 5, 10, 1], [2, 6, 12, 17], [2, 23, 12, 2]];
    // nozzle + cap
    rects.push([6, 0, 4, 2, '#f4f0ff'], [7, 1, 2, 1, '#2a1a55'], [5, 2, 6, 1, greyHi], [4, 3, 8, 2, grey], [4, 3, 2, 2, greyHi], [10, 3, 2, 2, greyLo], [3, 5, 10, 1, grey], [3, 5, 2, 1, greyHi], [11, 5, 2, 1, greyLo]);
    // body: hi / base / mid / lo columns, coloured from the bottom up to the paint level
    const cols = (base: string): [number, number, string][] => [[2, 2, lighten(base, 0.45)], [4, 6, base], [10, 2, darken(base, 0.2)], [12, 2, darken(base, 0.42)]];
    const empty = '#4a3f80';
    for (let row = 0; row < 17; row++) {
      const y = 6 + row;
      const isFilled = row >= 17 - filled;
      for (const [x, w, c] of cols(isFilled ? color : empty)) rects.push([x, y, w, 1, c]);
    }
    // label + F
    rects.push([4, 11, 8, 6, '#f6f2ff'], [4, 16, 8, 1, '#d9d1f3']);
    const f = darken(color, 0.55);
    rects.push([6, 12, 4, 1, f], [6, 13, 1, 4, f], [7, 14, 2, 1, f]);
    // base rim
    rects.push([2, 23, 12, 2, grey], [2, 23, 3, 2, greyHi], [11, 23, 3, 2, greyLo], [2, 24, 12, 1, greyLo]);
    const byColor = new Map<string, ReturnType<typeof Skia.Path.Make>>();
    const add = (c: string, x: number, y: number, w: number, h: number) => {
      let p = byColor.get(c); if (!p) { p = Skia.Path.Make(); byColor.set(c, p); }
      p.addRect(Skia.XYWHRect((x + 1) * cell, (y + 1) * cell, w * cell, h * cell));
    };
    const ink = Skia.Path.Make();
    for (const [x, y, w, h] of sil) ink.addRect(Skia.XYWHRect(x * cell, y * cell, (w + 2) * cell, (h + 2) * cell)); // (x-1)+1 offset cancels
    for (const [x, y, w, h, c] of rects) add(c, x, y, w, h);
    return { ink, layers: [...byColor.entries()] };
  }, [color, level, cell]);

  const rot = useSharedValue(0);
  useEffect(() => {
    rot.value = wobble
      ? withRepeat(withSequence(withTiming(-9, { duration: 110, easing: Easing.inOut(Easing.quad) }), withTiming(9, { duration: 110, easing: Easing.inOut(Easing.quad) })), -1, true)
      : withTiming(0, { duration: 120 });
  }, [wobble]);
  const st = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot.value}deg` }] }));
  return (
    <Animated.View style={st}>
      <Canvas style={{ width: (W + 2) * cell, height: (H + 2) * cell }} pointerEvents="none">
        <Path path={paths.ink} color={C.ink} antiAlias={false} />
        {paths.layers.map(([c, p]) => <Path key={c} path={p} color={c} antiAlias={false} />)}
      </Canvas>
    </Animated.View>
  );
}
