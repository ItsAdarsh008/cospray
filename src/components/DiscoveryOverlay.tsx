import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import type { Discovery } from '../hooks/useDiscovery';
import { useStore } from '../store';
import { PixelBox } from '../ui/PixelBox';
import { PixelIcon } from '../ui/PixelIcon';
import { hapticTap } from '../ui/kit';
import { C, F, PLATE, PLATE_HI, ui, uiLabel } from '../ui/theme';

/**
 * The reveal, drawn over the camera. A pixel shimmer pulls your eye toward an undiscovered piece
 * (edge arrow when it's off screen, twinkling squares where it is when on screen). The words that
 * go with it ("a piece is nearby", the found card) are rendered by the Create HUD's notice column.
 */
export function DiscoveryCues({ d }: { d: Discovery }) {
  const { width, height } = useWindowDimensions();
  const hfov = useStore((s) => s.settings.hfov);
  const pull = d.pull;
  if (!pull || d.justFound) return null;
  const onScreen = Math.abs(pull.relBearing) < hfov / 2 - 3;
  const x = width / 2 + pull.relBearing * (width / hfov);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {onScreen ? <Shimmer x={x} y={height * 0.45} strength={1 - pull.resolve} /> : <EdgeArrow left={pull.relBearing < 0} strength={1 - pull.resolve * 0.5} />}
    </View>
  );
}

function Shimmer({ x, y, strength }: { x: number; y: number; strength: number }) {
  const t = useSharedValue(0);
  useEffect(() => { t.value = withRepeat(withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.sin) }), -1, true); }, []);
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {[0, 1, 2, 3, 4, 5].map((i) => <Spark key={i} i={i} x={x} y={y} t={t} strength={strength} />)}
    </View>
  );
}

function Spark({ i, x, y, t, strength }: { i: number; x: number; y: number; t: SharedValue<number>; strength: number }) {
  const ang = (i / 6) * Math.PI * 2;
  const st = useAnimatedStyle(() => {
    const ph = (t.value + i * 0.17) % 1;
    const r = 26 + 34 * ph;
    return {
      opacity: (1 - ph) * (0.35 + 0.65 * strength),
      transform: [{ translateX: x + Math.cos(ang + ph * 2) * r }, { translateY: y + Math.sin(ang + ph * 2) * r }, { scale: 0.6 + ph }],
    };
  });
  return <Animated.View style={[styles.spark, st]} />;
}

function EdgeArrow({ left, strength }: { left: boolean; strength: number }) {
  const t = useSharedValue(0);
  useEffect(() => { t.value = withRepeat(withSequence(withTiming(1, { duration: 500 }), withTiming(0, { duration: 500 })), -1, true); }, []);
  const st = useAnimatedStyle(() => ({ opacity: 0.5 + 0.5 * t.value * strength, transform: [{ translateX: (left ? -1 : 1) * (4 + 8 * t.value) }] }));
  return (
    <Animated.View pointerEvents="none" style={[styles.edge, left ? { left: 10 } : { right: 10 }, st]}>
      <PixelBox fill={PLATE} hi={PLATE_HI} depth={3} style={{ width: 48 }} contentStyle={{ height: 44, alignItems: 'center', justifyContent: 'center' }}>
        <PixelIcon name={left ? 'left' : 'right'} size={24} color="#fff" />
      </PixelBox>
    </Animated.View>
  );
}

export type FoundPiece = { id: string; author_name: string; views: number };

/** "You found a piece": drops in from the top. VIEW opens the piece page (views, strokes, report). */
export function FoundCard({ c, onView }: { c: FoundPiece; onView?: () => void }) {
  const y = useSharedValue(-80);
  useEffect(() => { y.value = -80; y.value = withSpring(0, { damping: 13, stiffness: 140 }); }, [c.id]);
  const st = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  return (
    <Animated.View style={[{ alignSelf: 'stretch' }, st]}>
      <PixelBox fill={PLATE} hi={PLATE_HI} n={6} depth={5} contentStyle={styles.cardIn}>
        <PixelIcon name="star" size={24} color="#fff" />
        <View style={{ flex: 1 }}>
          <Text style={styles.cardEyebrow}>YOU FOUND A PIECE</Text>
          <Text style={styles.cardTitle} numberOfLines={1}>by {c.author_name}</Text>
          <Text style={styles.cardMeta}>{c.views} {c.views === 1 ? 'view' : 'views'}</Text>
        </View>
        {onView ? (
          <Pressable onPress={() => { hapticTap(); onView(); }} hitSlop={8}>
            <PixelBox fill="#ffffff" hi="#ffffff" lo="#b9aee0" depth={3} contentStyle={styles.viewBtn}>
              <Text style={styles.viewText}>VIEW</Text>
            </PixelBox>
          </Pressable>
        ) : null}
      </PixelBox>
    </Animated.View>
  );
}

export function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const styles = StyleSheet.create({
  spark: { position: 'absolute', width: 9, height: 9, backgroundColor: '#fff' },
  edge: { position: 'absolute', top: '45%' },
  cardIn: { padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardEyebrow: { ...uiLabel(11, 1), color: '#fff' },
  cardTitle: { fontFamily: F.display, fontSize: 20, color: '#fff' },
  cardMeta: { ...ui(12.5, '600'), color: C.dim },
  viewBtn: { height: 34, paddingHorizontal: 12, justifyContent: 'center' },
  viewText: { ...uiLabel(12, 0.8), color: C.ink },
});
