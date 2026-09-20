import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { C } from './theme';

type Region = { top: number; bottom: number; left?: number; right?: number; n: number; color: string };
/** A rectangle with its four corners notched by n px: two overlapping bars, no border-radius. */
function Notch({ top, bottom, left = 0, right = 0, n, color }: Region) {
  return (
    <>
      <View style={[styles.abs, { backgroundColor: color, left, right, top: top + n, bottom: bottom + n }]} />
      <View style={[styles.abs, { backgroundColor: color, left: left + n, right: right + n, top, bottom }]} />
    </>
  );
}

/**
 * The building block of the pixel look: a flat panel with a hard outline, notched (stair-step)
 * corners, a 3D "slab" underneath and optional bevel highlight/shade strips. No blur, no radius.
 */
export function PixelBox({
  fill = C.panel, border = C.ink, hi = null, lo = null, slab, bw = 3, n = 3, depth = 4, style, contentStyle, children,
}: {
  fill?: string; border?: string; hi?: string | null; lo?: string | null; slab?: string;
  bw?: number; n?: number; depth?: number; style?: StyleProp<ViewStyle>; contentStyle?: StyleProp<ViewStyle>; children?: React.ReactNode;
}) {
  const nIn = Math.max(0, n - bw);
  return (
    <View style={[{ paddingBottom: depth }, style]}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {depth > 0 && <Notch top={depth} bottom={0} n={n} color={slab ?? border} />}
        <Notch top={0} bottom={depth} n={n} color={border} />
        <Notch top={bw} bottom={depth + bw} left={bw} right={bw} n={nIn} color={fill} />
        {hi && <View style={[styles.abs, { top: bw, height: 3, left: bw + nIn, right: bw + nIn, backgroundColor: hi }]} />}
        {lo && <View style={[styles.abs, { bottom: depth + bw, height: 3, left: bw + nIn, right: bw + nIn, backgroundColor: lo }]} />}
      </View>
      <View style={contentStyle}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({ abs: { position: 'absolute' } });
