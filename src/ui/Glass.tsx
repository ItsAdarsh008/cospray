import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { PixelBox } from './PixelBox';
import { C } from './theme';

/** Legacy name kept for old call sites: it is now a pixel panel, not glass. */
export function Glass({ children, style }: { children?: React.ReactNode; style?: StyleProp<ViewStyle>; radius?: number; intensity?: number; tint?: 'dark' | 'light' }) {
  return <PixelBox fill={C.panel} n={6} depth={5} contentStyle={style}>{children}</PixelBox>;
}
export const glassText = { title: { color: C.text, letterSpacing: 2, fontSize: 12 } };
