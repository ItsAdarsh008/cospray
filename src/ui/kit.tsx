import React, { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type StyleProp, type TextProps, type TextStyle, type ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Backdrop } from './Backdrop';
import { PixelBox } from './PixelBox';
import { PixelIcon, type IconName } from './PixelIcon';
import { BACKDROPS, C, DOCK_INSET, F, outline, TONES, ui, uiLabel, type BackdropName, type Tone } from './theme';
import { useStore } from '../store';

export function hapticTap() {
  if (useStore.getState().settings.haptics) Haptics.selectionAsync().catch(() => {});
}

// ---- text ---------------------------------------------------------------------------------
type V = 'title' | 'h' | 'sub' | 'body' | 'small' | 'label' | 'num' | 'mono';
const TEXT: Record<V, TextStyle> = {
  title: { fontFamily: F.display, fontSize: 32, letterSpacing: 1, color: C.white, ...outline() },
  h: { fontFamily: F.display, fontSize: 20, color: C.white, ...outline() },
  sub: { ...ui(14, '500'), color: C.dim },
  body: { ...ui(15, '500'), color: C.white },
  small: { ...ui(13, '500'), color: C.dim },
  label: { ...uiLabel(11.5, 1.1), color: C.yellow },
  num: { fontFamily: F.display, fontSize: 30, color: C.white, ...outline() },
  mono: { fontFamily: F.mono, fontSize: 22, color: C.phosphor },
};
export function T({ v = 'body', color, style, ...rest }: TextProps & { v?: V; color?: string }) {
  return <Text {...rest} style={[TEXT[v], color ? { color } : null, style]} />;
}

// ---- screen scaffolding ---------------------------------------------------------------------
export function Screen({ tone = 'purple', children, scroll = true, loading, onRefresh, contentStyle, sheet }: {
  tone?: BackdropName; children?: React.ReactNode; scroll?: boolean; loading?: boolean; onRefresh?: () => void; contentStyle?: StyleProp<ViewStyle>;
  /** Presented as a page sheet (Market, Settings): no status bar or dock to clear. */
  sheet?: boolean;
}) {
  return (
    <View style={{ flex: 1, backgroundColor: BACKDROPS[tone].bottom }}>
      <Backdrop tone={tone} />
      {scroll ? (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.scroll, sheet && styles.sheetScroll, contentStyle]}
          refreshControl={onRefresh ? <RefreshControl refreshing={!!loading} onRefresh={onRefresh} tintColor="#fff" /> : undefined}>
          {children}
        </ScrollView>
      ) : children}
    </View>
  );
}

export function Header({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <View style={styles.header}>
      <View style={{ flex: 1 }}>
        <T v="title">{title}</T>
        {sub ? <T v="sub" style={{ marginTop: 2 }}>{sub}</T> : null}
      </View>
      {right}
    </View>
  );
}

/** Panel with a big pixel title strip, like the Subway Surfers mission cards. */
export function Panel({ title, tone = 'panel', right, children, style, pad = 14 }: {
  title?: string; tone?: Tone; right?: React.ReactNode; children?: React.ReactNode; style?: StyleProp<ViewStyle>; pad?: number;
}) {
  const t = TONES[tone];
  return (
    <PixelBox fill={t.fill} hi={t.hi} lo={t.lo} n={6} depth={5} style={style} contentStyle={{ padding: pad, gap: 12 }}>
      {title ? (
        <View style={styles.panelHead}>
          <T v="label" color={tone === 'yellow' ? '#2a1a00' : C.yellow}>{title}</T>
          {right}
        </View>
      ) : null}
      {children}
    </PixelBox>
  );
}

// ---- controls -------------------------------------------------------------------------------
const SIZES = { lg: { h: 58, font: 22, icon: 24, n: 6, px: 22 }, md: { h: 48, font: 18, icon: 24, n: 3, px: 16 }, sm: { h: 40, font: 16, icon: 24, n: 3, px: 12 } };
/** Chunky 3D button (Subway Surfers "RESUME"): thick slab underneath that squashes when pressed. */
export function Btn({ label, onPress, onPressIn, onPressOut, tone = 'green', icon, size = 'md', style, disabled }: {
  label?: string; onPress?: () => void; onPressIn?: () => void; onPressOut?: () => void; tone?: Tone; icon?: IconName;
  size?: keyof typeof SIZES; style?: StyleProp<ViewStyle>; disabled?: boolean;
}) {
  const [down, setDown] = useState(false);
  const t = TONES[tone], s = SIZES[size];
  const shadow = tone === 'yellow' || tone === 'white' ? {} : outline(t.lo, 2);
  return (
    <Pressable onPress={onPress} disabled={disabled}
      onPressIn={() => { setDown(true); hapticTap(); onPressIn?.(); }} onPressOut={() => { setDown(false); onPressOut?.(); }}
      style={[style, disabled && { opacity: 0.45 }]}>
      <PixelBox fill={t.fill} hi={t.hi} lo={t.lo} n={s.n} depth={down ? 1 : 5} style={{ marginTop: down ? 4 : 0 }}
        contentStyle={{ height: s.h, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: s.px }}>
        {icon ? <PixelIcon name={icon} size={s.icon} color={t.text} /> : null}
        {label ? <Text style={[{ fontFamily: F.display, fontSize: s.font, color: t.text, letterSpacing: 0.5 }, shadow]}>{label}</Text> : null}
      </PixelBox>
    </Pressable>
  );
}

export function IconBtn({ icon, onPress, tone = 'dark', size = 44, active }: { icon: IconName; onPress?: () => void; tone?: Tone; size?: number; active?: boolean }) {
  const [down, setDown] = useState(false);
  const t = TONES[active ? 'yellow' : tone];
  return (
    <Pressable onPress={onPress} onPressIn={() => { setDown(true); hapticTap(); }} onPressOut={() => setDown(false)} hitSlop={6}>
      <PixelBox fill={t.fill} hi={t.hi} lo={t.lo} depth={down ? 1 : 4} style={{ marginTop: down ? 3 : 0, width: size }}
        contentStyle={{ height: size - 4, alignItems: 'center', justifyContent: 'center' }}>
        <PixelIcon name={icon} size={24} color={active ? '#2a1a00' : C.white} />
      </PixelBox>
    </Pressable>
  );
}

export function Chip({ label, on, onPress, icon }: { label: string; on?: boolean; onPress?: () => void; icon?: IconName }) {
  const t = TONES[on ? 'yellow' : 'dark'];
  return (
    <Pressable onPress={() => { hapticTap(); onPress?.(); }}>
      <PixelBox fill={t.fill} hi={t.hi} lo={t.lo} depth={3} contentStyle={{ height: 34, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {icon ? <PixelIcon name={icon} size={12} color={on ? '#2a1a00' : C.white} /> : null}
        <Text style={{ ...uiLabel(11, 0.8), color: on ? '#2a1a00' : C.dim }}>{label}</Text>
      </PixelBox>
    </Pressable>
  );
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable onPress={() => { hapticTap(); onChange(!on); }} hitSlop={8} style={{ width: 62, height: 34 }}>
      <PixelBox fill={on ? C.green : '#3a2a78'} hi={on ? C.greenHi : '#4d3a99'} lo={on ? C.greenLo : '#241a55'} depth={0} style={{ width: 62, height: 34 }}>
        <View style={{ height: 34 }} />
      </PixelBox>
      <View style={[styles.knob, { left: on ? 33 : 5 }]} pointerEvents="none">
        <PixelBox fill="#fff" hi="#fff" lo="#c8bdea" depth={0} bw={3} n={3} style={{ width: 24, height: 24 }}><View style={{ height: 24 }} /></PixelBox>
      </View>
      <View style={[styles.onOff, on ? { left: 9 } : { right: 9 }]} pointerEvents="none">
        <Text style={{ ...uiLabel(9.5, 0.4), color: on ? '#fff' : C.faint }}>{on ? 'ON' : 'OFF'}</Text>
      </View>
    </Pressable>
  );
}

// ---- meters, tiles, badges --------------------------------------------------------------------
/** Segmented (chunky) meter. value 0..1. */
export function SegBar({ value, color, segs = 10, h = 16, bg = '#000000' }: { value: number; color: string; segs?: number; h?: number; bg?: string }) {
  const lit = Math.round(Math.max(0, Math.min(1, value)) * segs);
  return (
    <View style={{ backgroundColor: C.ink, padding: 3, flexDirection: 'row', gap: 2 }}>
      {Array.from({ length: segs }, (_, i) => (
        <View key={i} style={{ flex: 1, height: h, backgroundColor: i < lit ? color : bg + '55' }}>
          {i < lit ? <View style={{ height: 3, backgroundColor: '#ffffff44' }} /> : null}
        </View>
      ))}
    </View>
  );
}

/** Stat tile in the Airbuds style: big number over a small caption on a muted plate. */
export function Tile({ n, label, style, big }: { n: string | number; label: string; style?: StyleProp<ViewStyle>; big?: boolean }) {
  return (
    <PixelBox fill="#2b2059" hi="#3a2d78" lo="#1c1440" depth={3} style={[{ flex: 1 }, style]} contentStyle={{ paddingVertical: 12, paddingHorizontal: 8, alignItems: 'center', gap: 2 }}>
      <Text style={{ fontFamily: F.display, fontSize: big ? 34 : 26, color: '#fff', ...outline() }} numberOfLines={1} adjustsFontSizeToFit>{n}</Text>
      <Text style={{ ...ui(12.5, '600'), color: C.dim }} numberOfLines={1}>{label}</Text>
    </PixelBox>
  );
}

/** Small pill: pixel icon + value (coins, streak…). */
export function Pill({ icon, value, iconColor = C.yellow, alt }: { icon: IconName; value: string | number; iconColor?: string; alt?: string }) {
  return (
    <PixelBox fill="#160b36" hi="#2a1c5c" depth={3} n={3} contentStyle={{ height: 38, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10 }}>
      <PixelIcon name={icon} size={24} color={iconColor} alt={alt} />
      <Text style={{ fontFamily: F.display, fontSize: 17, color: '#fff', minWidth: 14 }}>{value}</Text>
    </PixelBox>
  );
}

export function Avatar({ name, color, size = 48 }: { name?: string | null; color: string; size?: number }) {
  return (
    <PixelBox fill={color} hi="#ffffff55" lo="#00000033" depth={3} n={3} style={{ width: size }} contentStyle={{ height: size - 3, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontFamily: F.display, fontSize: size * 0.5, color: C.ink }}>{(name?.[0] ?? 'F').toUpperCase()}</Text>
    </PixelBox>
  );
}

export function Rank({ n }: { n: number }) {
  const tone: Tone = n === 1 ? 'yellow' : n === 2 ? 'white' : n === 3 ? 'red' : 'dark';
  const t = TONES[tone];
  return (
    <PixelBox fill={t.fill} hi={t.hi} lo={t.lo} depth={2} n={3} style={{ width: 30 }} contentStyle={{ height: 28, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontFamily: F.display, fontSize: 16, color: n <= 2 ? '#2a1a00' : '#fff' }}>{n}</Text>
    </PixelBox>
  );
}

export function Divider() {
  return <View style={{ height: 3, borderStyle: 'dashed', borderTopWidth: 3, borderColor: '#ffffff22' }} />;
}

const styles = StyleSheet.create({
  scroll: { padding: 18, paddingTop: 62, paddingBottom: DOCK_INSET, gap: 16 },
  sheetScroll: { paddingTop: 26, paddingBottom: 48 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 2 },
  panelHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  knob: { position: 'absolute', top: 5 },
  onOff: { position: 'absolute', top: 11 },
});
