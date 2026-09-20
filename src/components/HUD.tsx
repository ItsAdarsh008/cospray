import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { PAINT_EMPTY_THRESHOLD, PAINT_MAX, PAINT_REGEN_PER_SEC, PALETTE, SHAKE_MIN_TO_SPRAY } from '../config';
import { useStore, type Side } from '../store';
import type { Blocker } from '../hooks/useSprayEngine';
import type { Discovery } from '../hooks/useDiscovery';
import { PixelBox } from '../ui/PixelBox';
import { PixelIcon, type IconName } from '../ui/PixelIcon';
import { hapticTap } from '../ui/kit';
import { C, F, HOLD_BOTTOM, HOLD_H, HOLD_TOP, PLATE, PLATE_HI, ui, uiLabel } from '../ui/theme';
import { isLight } from '../ui/color';
import { OPACITY, THICKNESS, colorName, ownedPaints } from '../lib/economy';
import { FoundCard, type FoundPiece } from './DiscoveryOverlay';
import { PieceImage } from '../ui/StrokeThumb';

/**
 * The Create overlay. Everything drawn over the camera is deliberately colourless (dark plates, white
 * text); the only colour on screen is paint itself. Creation only: who painted what, views and
 * reporting live in the piece detail (Explore / Vault), reached from the found card.
 *
 * Layout never overlaps by construction:
 *  - left rail: can charge
 *  - right rail: undo your last stroke, and the piece you're painting so far
 *  - top centre column: at most one status line (surface / distance), the found card, one notice
 *  - bottom: the two colours + the tools toggle; the tools tray opens directly above them
 */
export type HudLine = { title: string; sub?: string; icon?: IconName; onPress?: () => void };

export const BLOCKER_LINE: Record<NonNullable<Blocker>, HudLine> = {
  'no-location': { title: 'WAITING FOR GPS', icon: 'pin' },
  'outside-geofence': { title: 'OUTSIDE THE PAINT ZONE', sub: 'PAINTING IS OPEN IN WATERLOO REGION', icon: 'pin' },
  shake: { title: 'SHAKE THE CAN', sub: 'THE RATTLE CHARGES IT', icon: 'can' },
  empty: { title: 'OUT OF PAINT', sub: 'THIS COLOUR IS REFILLING', icon: 'drop' },
};

/** The words that go with the discovery shimmer. */
export function pullLine(pull: NonNullable<Discovery['pull']>): HudLine {
  return pull.resolve >= 1 ? { title: 'LOOK AT THE WALL', icon: 'star' }
    : { title: 'A PIECE IS NEARBY', sub: `${Math.round(pull.distance)} M · FOLLOW THE SPARKLE`, icon: 'star' };
}

export function CreateHud({ status, found, onOpenFound, notice, debug, onStart, onEnd, onUndo, pieceId, onOpenPiece }: {
  status?: HudLine | null; found?: FoundPiece | null; onOpenFound?: () => void; notice?: HudLine | null; debug?: string | null;
  onStart: (s: Side) => void; onEnd: (s: Side) => void;
  /** Take back your last stroke (hidden when the build doesn't support it). */
  onUndo?: (() => void) | null; pieceId?: string | null; onOpenPiece?: () => void;
}) {
  const [tools, setTools] = useState(false);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <ChargeMeter />
      <View style={styles.rightRail} pointerEvents="box-none">
        {onUndo ? <RailButton icon="undo" onPress={onUndo} /> : null}
        {pieceId ? (
          <Pressable onPress={() => { hapticTap(); onOpenPiece?.(); }} hitSlop={4}>
            <PixelBox fill={PLATE} hi={PLATE_HI} depth={4} contentStyle={styles.railThumb}>
              <PieceImage canvasId={pieceId} width={38} height={38} cell={2} />
            </PixelBox>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.column} pointerEvents="box-none">
        {status ? <Line line={status} /> : null}
        {found ? <FoundCard c={found} onView={onOpenFound} /> : null}
        {notice ? <Line line={notice} /> : null}
        {debug ? <Text style={styles.debug}>{debug}</Text> : null}
      </View>
      {tools && <ToolsTray />}
      <View style={styles.holdRow}>
        <HoldButton side="A" onStart={onStart} onEnd={onEnd} />
        <HoldButton side="B" onStart={onStart} onEnd={onEnd} />
        <ToolsButton on={tools} onPress={() => setTools((v) => !v)} />
      </View>
    </View>
  );
}

/** Reticle for the compass fallback (ARKit draws its own on the surface). */
export function Reticle({ spraying }: { spraying: boolean }) {
  const pulse = useSharedValue(1);
  useEffect(() => {
    pulse.value = spraying
      ? withRepeat(withSequence(withTiming(1.25, { duration: 90 }), withTiming(1, { duration: 90 })), -1, true)
      : withTiming(1, { duration: 150 });
  }, [spraying]);
  const st = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));
  return (
    <View pointerEvents="none" style={styles.reticleWrap}>
      <Animated.View style={[styles.reticle, spraying && styles.reticleOn, st]}><View style={styles.reticleDot} /></Animated.View>
    </View>
  );
}

function RailButton({ icon, onPress }: { icon: IconName; onPress: () => void }) {
  const [down, setDown] = useState(false);
  return (
    <Pressable onPress={() => { hapticTap(); onPress(); }} onPressIn={() => setDown(true)} onPressOut={() => setDown(false)} hitSlop={6}>
      <PixelBox fill={PLATE} hi={PLATE_HI} depth={down ? 1 : 4} style={{ marginTop: down ? 3 : 0 }} contentStyle={styles.railBtn}>
        <PixelIcon name={icon} size={24} color="#fff" />
      </PixelBox>
    </Pressable>
  );
}

function Line({ line }: { line: HudLine }) {
  const body = (
    <PixelBox fill={PLATE} hi={PLATE_HI} depth={4} contentStyle={styles.lineIn}>
      {line.icon ? <PixelIcon name={line.icon} size={24} color="#fff" /> : null}
      <View style={{ flexShrink: 1, alignItems: line.icon || line.onPress ? 'flex-start' : 'center' }}>
        <Text style={styles.lineTitle} numberOfLines={1}>{line.title}</Text>
        {line.sub ? <Text style={styles.lineSub} numberOfLines={2}>{line.sub}</Text> : null}
      </View>
      {line.onPress ? <PixelIcon name="right" size={12} color={C.dim} /> : null}
    </PixelBox>
  );
  if (!line.onPress) return <View pointerEvents="none">{body}</View>;
  return <Pressable onPress={() => { hapticTap(); line.onPress?.(); }} hitSlop={6}>{body}</Pressable>;
}

/** Can charge as a slim rail down the left edge. Runs down over a minute; shake to refill. */
export function ChargeMeter() {
  const shake = useStore((s) => s.shake);
  const low = shake < SHAKE_MIN_TO_SPRAY;
  const rot = useSharedValue(0);
  useEffect(() => {
    rot.value = low
      ? withRepeat(withSequence(withTiming(-12, { duration: 110, easing: Easing.inOut(Easing.quad) }), withTiming(12, { duration: 110, easing: Easing.inOut(Easing.quad) })), -1, true)
      : withTiming(0, { duration: 120 });
  }, [low]);
  const wobble = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot.value}deg` }] }));
  const segs = 8, lit = Math.round(Math.max(0, Math.min(1, shake)) * segs);
  return (
    <View style={styles.charge} pointerEvents="none">
      <PixelBox fill={PLATE} hi={PLATE_HI} depth={4} contentStyle={styles.chargeIn}>
        <Animated.View style={wobble}><PixelIcon name="can" size={24} color="#fff" /></Animated.View>
        <View style={styles.vbar}>
          {Array.from({ length: segs }, (_, i) => (
            <View key={i} style={{ height: 8, backgroundColor: segs - 1 - i < lit ? '#ffffff' : '#ffffff1c' }} />
          ))}
        </View>
        <Text style={styles.chargeText}>{low ? 'SHAKE' : `${Math.round(shake * 100)}%`}</Text>
      </PixelBox>
    </View>
  );
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** One colour. Hold to spray it; the fill behind the label is how much of it is left. */
function HoldButton({ side, onStart, onEnd }: { side: Side; onStart: (s: Side) => void; onEnd: (s: Side) => void }) {
  const color = useStore((s) => (side === 'A' ? s.settings.optionA.color : s.settings.optionB.color));
  const paint = useStore((s) => s.paint[side]);
  const volume = useStore((s) => s.settings.volumeButtons);
  const pct = Math.round((paint / PAINT_MAX) * 100);
  const empty = paint <= PAINT_EMPTY_THRESHOLD;
  const sub = empty ? `REFILL ${mmss(Math.ceil((PAINT_MAX - paint) / PAINT_REGEN_PER_SEC))}` : `${volume ? (side === 'A' ? 'VOL+ · ' : 'VOL− · ') : ''}${pct}%`;
  return (
    <Pressable style={{ flex: 1 }} onPressIn={() => onStart(side)} onPressOut={() => onEnd(side)}>
      {({ pressed }) => (
        <PixelBox fill={pressed ? '#3a2a78' : PLATE} hi={pressed ? '#5a44a8' : PLATE_HI} depth={pressed ? 1 : 5} style={{ marginTop: pressed ? 4 : 0 }} n={3}
          contentStyle={styles.holdIn}>
          <View style={styles.holdFill} pointerEvents="none"><View style={{ width: `${pct}%`, height: '100%', backgroundColor: color, opacity: 0.35 }} /></View>
          <View style={[styles.swatch, { backgroundColor: color }]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.holdText} numberOfLines={1} adjustsFontSizeToFit>{colorName(color).toUpperCase()}</Text>
            <Text style={styles.holdSub} numberOfLines={1}>{sub}</Text>
          </View>
        </PixelBox>
      )}
    </Pressable>
  );
}

function ToolsButton({ on, onPress }: { on: boolean; onPress: () => void }) {
  const [down, setDown] = useState(false);
  return (
    <Pressable onPress={() => { hapticTap(); onPress(); }} onPressIn={() => setDown(true)} onPressOut={() => setDown(false)} hitSlop={4} style={{ width: 56 }}>
      <PixelBox fill={on ? '#ffffff' : PLATE} hi={on ? '#ffffff' : PLATE_HI} lo={on ? '#b9aee0' : null} depth={down ? 1 : 5} style={{ marginTop: down ? 4 : 0 }} n={3}
        contentStyle={[styles.holdIn, { justifyContent: 'center', paddingHorizontal: 0 }]}>
        <PixelIcon name={on ? 'x' : 'sliders'} size={24} color={on ? C.ink : '#fff'} />
      </PixelBox>
    </Pressable>
  );
}

/** The in-camera tools: a colour for each hold button, line size and paint opacity. */
function ToolsTray() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const setSheet = useStore((s) => s.setSheet);
  const palette = [...PALETTE, ...ownedPaints(settings.owned)];
  const pick = (key: 'optionA' | 'optionB', c: string) => { hapticTap(); setSettings({ [key]: { color: c, name: colorName(c) } }); };
  const colours = (key: 'optionA' | 'optionB') => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
      {palette.map((c) => {
        const on = settings[key].color === c;
        return (
          <Pressable key={c} onPress={() => pick(key, c)} hitSlop={2}>
            <PixelBox fill={c} border={on ? '#ffffff' : C.ink} depth={2} style={{ width: 34 }} contentStyle={styles.swatchBtn}>
              {on ? <PixelIcon name="check" size={24} color={isLight(c) ? C.ink : '#fff'} /> : null}
            </PixelBox>
          </Pressable>
        );
      })}
      <Pressable onPress={() => { hapticTap(); setSheet('market'); }} hitSlop={2}>
        <PixelBox fill="#1f1348" hi={PLATE_HI} depth={2} style={{ width: 34 }} contentStyle={styles.swatchBtn}>
          <PixelIcon name="plus" size={24} color={C.dim} />
        </PixelBox>
      </Pressable>
    </ScrollView>
  );
  const steps = (items: { label: string }[], value: number, key: 'thickness' | 'opacity') => (
    <View style={{ flexDirection: 'row', gap: 6 }}>
      {items.map((it, i) => (
        <Pressable key={it.label} style={{ flex: 1 }} onPress={() => { hapticTap(); setSettings({ [key]: i }); }}>
          <PixelBox fill={value === i ? '#ffffff' : '#1f1348'} hi={value === i ? '#ffffff' : null} depth={2} n={3} contentStyle={styles.segIn}>
            <Text style={[styles.segText, value === i && { color: C.ink }]}>{it.label}</Text>
          </PixelBox>
        </Pressable>
      ))}
    </View>
  );
  const row = (label: string, body: React.ReactNode) => (
    <View style={styles.trayRow}>
      <Text style={styles.trayLabel}>{label}</Text>
      <View style={{ flex: 1 }}>{body}</View>
    </View>
  );
  return (
    <View style={styles.tray}>
      <PixelBox fill={PLATE} hi={PLATE_HI} depth={4} contentStyle={{ padding: 10, gap: 10 }}>
        {row('LEFT', colours('optionA'))}
        {row('RIGHT', colours('optionB'))}
        {row('SIZE', steps(THICKNESS, settings.thickness, 'thickness'))}
        {row('OPACITY', steps(OPACITY, settings.opacity, 'opacity'))}
      </PixelBox>
    </View>
  );
}

const RAIL_W = 46;
const styles = StyleSheet.create({
  reticleWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  reticle: { width: 44, height: 44, borderRadius: 22, borderWidth: 2, borderColor: '#ffffff99', alignItems: 'center', justifyContent: 'center' },
  reticleOn: { borderColor: '#ffffff', borderStyle: 'dashed' },
  reticleDot: { width: 4, height: 4, backgroundColor: '#fff' },

  charge: { position: 'absolute', top: 58, left: 12, width: RAIL_W },
  rightRail: { position: 'absolute', top: 58, right: 12, width: RAIL_W, gap: 8 },
  railBtn: { height: 42, alignItems: 'center', justifyContent: 'center' },
  railThumb: { height: 42, alignItems: 'center', justifyContent: 'center' },
  chargeIn: { paddingVertical: 8, alignItems: 'center', gap: 6 },
  vbar: { backgroundColor: C.ink, padding: 2, gap: 2, width: 20 },
  chargeText: { ...uiLabel(10, 0.4), color: '#fff' },

  column: { position: 'absolute', top: 58, left: 12 + RAIL_W + 8, right: 12 + RAIL_W + 8, alignItems: 'center', gap: 8 },
  lineIn: { minHeight: 36, paddingHorizontal: 12, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 8 },
  lineTitle: { ...uiLabel(12.5, 0.6), color: '#fff' },
  lineSub: { ...ui(11.5, '600'), color: C.dim, marginTop: 2 },
  debug: { ...ui(11, '600'), color: '#ffffffcc', textAlign: 'center', backgroundColor: '#000a', paddingHorizontal: 4 },

  holdRow: { position: 'absolute', bottom: HOLD_BOTTOM, left: 12, right: 12, flexDirection: 'row', gap: 10 },
  holdIn: { height: HOLD_H, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12 },
  holdFill: { position: 'absolute', left: 3, top: 3, bottom: 3, right: 3 },
  swatch: { width: 22, height: 22, borderWidth: 2, borderColor: '#ffffffb0' },
  holdText: { fontFamily: F.display, fontSize: 18, color: '#fff' },
  holdSub: { ...uiLabel(10.5, 0.4), color: C.dim, marginTop: 2 },

  tray: { position: 'absolute', left: 12, right: 12, bottom: HOLD_TOP + 6 },
  trayRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  trayLabel: { width: 62, ...uiLabel(11, 0.6), color: '#fff' },
  swatchBtn: { height: 32, alignItems: 'center', justifyContent: 'center' },
  segIn: { height: 32, alignItems: 'center', justifyContent: 'center' },
  segText: { fontFamily: F.display, fontSize: 17, color: '#fff' },
});
