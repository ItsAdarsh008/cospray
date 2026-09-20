import React, { useMemo } from 'react';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import { COLS, ICONS } from './icons';

export type IconName = keyof typeof ICONS;

/**
 * Pixel-art icon drawn as one Skia path (crisp at any size; use multiples of 12 so every cell
 * lands on whole device pixels). '+' cells use `alt`, or a dimmed `color` when no alt is given.
 */
export function PixelIcon({ name, size = 24, color = '#ffffff', alt }: { name: IconName; size?: number; color?: string; alt?: string }) {
  const { main, accent } = useMemo(() => {
    const cell = size / COLS;
    const main = Skia.Path.Make();
    const accent = Skia.Path.Make();
    (ICONS[name] as string[]).forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const c = row[x];
        if (c === '.') continue;
        (c === '+' ? accent : main).addRect(Skia.XYWHRect(x * cell, y * cell, cell, cell));
      }
    });
    return { main, accent };
  }, [name, size]);
  return (
    <Canvas style={{ width: size, height: size }} pointerEvents="none">
      <Path path={main} color={color} antiAlias={false} />
      <Path path={accent} color={alt ?? color} opacity={alt ? 1 : 0.55} antiAlias={false} />
    </Canvas>
  );
}
