import React, { useEffect, useMemo, useState } from 'react';
import { Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import { Canvas, Circle, Group, Path, Skia, BlurMask, RadialGradient, vec } from '@shopify/react-native-skia';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming, runOnJS } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Backdrop } from '../ui/Backdrop';
import { C, F, outline, uiLabel } from '../ui/theme';

const { width: W, height: H } = Dimensions.get('window');
const R = Math.min(W, H) * 0.34;
const CX = W / 2, CY = H * 0.44;
const TILT = 0.42; // radians, tip the pole toward the viewer
const WATERLOO = { lat: 43.47, lng: -80.54 };
// a few glowing "cities" so the globe reads as Earth without shipping coastline data
const CITIES = [WATERLOO, { lat: 40.7, lng: -74 }, { lat: 37.8, lng: -122.4 }, { lat: 51.5, lng: -0.1 }, { lat: 48.9, lng: 2.3 }, { lat: 35.7, lng: 139.7 },
  { lat: -33.9, lng: 151.2 }, { lat: 19.4, lng: -99.1 }, { lat: -23.5, lng: -46.6 }, { lat: 28.6, lng: 77.2 }, { lat: 1.3, lng: 103.8 }, { lat: 30, lng: 31.2 }, { lat: 55.8, lng: 37.6 }, { lat: -1.3, lng: 36.8 }];

function project(latDeg: number, lngDeg: number, spin: number) {
  const lat = (latDeg * Math.PI) / 180, lng = (lngDeg * Math.PI) / 180 + spin;
  const x = Math.cos(lat) * Math.sin(lng), y0 = Math.sin(lat), z0 = Math.cos(lat) * Math.cos(lng);
  const y = y0 * Math.cos(TILT) - z0 * Math.sin(TILT), z = y0 * Math.sin(TILT) + z0 * Math.cos(TILT);
  return { sx: CX + R * x, sy: CY - R * y, z };
}

/** Wireframe globe: meridians + parallels, front hemisphere bright, back hemisphere ghosted. */
function useGlobePaths(spin: number) {
  return useMemo(() => {
    const front = Skia.Path.Make(), back = Skia.Path.Make();
    const seg = (pts: { sx: number; sy: number; z: number }[]) => {
      let pf = false, pb = false;
      for (const p of pts) {
        if (p.z >= 0) { pf ? front.lineTo(p.sx, p.sy) : front.moveTo(p.sx, p.sy); pf = true; pb = false; }
        else { pb ? back.lineTo(p.sx, p.sy) : back.moveTo(p.sx, p.sy); pb = true; pf = false; }
      }
    };
    for (let m = 0; m < 360; m += 20) seg(Array.from({ length: 61 }, (_, i) => project(-90 + i * 3, m, spin)));
    for (let p = -60; p <= 60; p += 30) seg(Array.from({ length: 121 }, (_, i) => project(p, i * 3, spin)));
    return { front, back };
  }, [spin]);
}

export function LaunchScreen({ onEnter }: { onEnter: () => void }) {
  const [spin, setSpin] = useState(0);
  const [entering, setEntering] = useState(false);
  useEffect(() => {
    let raf = 0, last = Date.now();
    const tick = () => { const n = Date.now(); setSpin((s) => s + ((n - last) / 1000) * (entering ? 0.05 : 0.35)); last = n; raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [entering]);
  const { front, back } = useGlobePaths(spin);
  const wl = project(WATERLOO.lat, WATERLOO.lng, spin);
  // orbiting logo on an inclined ring
  const a = spin * 2.2;
  const orb = { x: CX + R * 1.38 * Math.cos(a), y: CY + R * 0.42 * Math.sin(a) - R * 0.1, z: Math.sin(a) };

  const zoom = useSharedValue(1);
  const fade = useSharedValue(1);
  const enter = () => {
    if (entering) return;
    setEntering(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    zoom.value = withTiming(7, { duration: 1100, easing: Easing.in(Easing.cubic) });
    fade.value = withTiming(0, { duration: 1100, easing: Easing.in(Easing.quad) }, (done) => { if (done) runOnJS(onEnter)(); });
  };
  // zoom toward wherever Waterloo currently sits on the sphere
  const globeStyle = useAnimatedStyle(() => ({
    opacity: fade.value,
    transform: [{ translateX: (CX - wl.sx) * (zoom.value - 1) }, { translateY: (CY - wl.sy) * (zoom.value - 1) }, { scale: zoom.value }],
  }));
  const textStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

  return (
    <Pressable style={styles.root} onPress={enter}>
      <Backdrop tone="night" />
      <Animated.View style={[StyleSheet.absoluteFill, globeStyle]}>
        <Canvas style={StyleSheet.absoluteFill}>
          {/* atmosphere */}
          <Circle cx={CX} cy={CY} r={R * 1.12} color={C.phosphor} opacity={0.35}><BlurMask blur={26} style="normal" /></Circle>
          <Circle cx={CX} cy={CY} r={R}>
            <RadialGradient c={vec(CX - R * 0.35, CY - R * 0.4)} r={R * 1.4} colors={['#1b2440', '#0a0d1c', '#03040a']} />
          </Circle>
          <Path path={back} style="stroke" strokeWidth={1} color={C.phosphor} opacity={0.12} />
          <Path path={front} style="stroke" strokeWidth={1.2} color={C.phosphor} opacity={0.55} />
          <Circle cx={CX} cy={CY} r={R} style="stroke" strokeWidth={1.5} color={C.phosphor} opacity={0.8} />
          {CITIES.map((c, i) => { const p = project(c.lat, c.lng, spin); if (p.z < 0) return null; return <Circle key={i} cx={p.sx} cy={p.sy} r={2.2 + p.z * 1.5} color={i === 0 ? C.pink : C.yellow} opacity={0.5 + 0.5 * p.z} />; })}
          {wl.z >= 0 && (
            <Group>
              <Circle cx={wl.sx} cy={wl.sy} r={12 + 6 * Math.abs(Math.sin(spin * 4))} color={C.pink} opacity={0.35}><BlurMask blur={8} style="normal" /></Circle>
              <Circle cx={wl.sx} cy={wl.sy} r={4} color={C.pink} />
            </Group>
          )}
          {/* orbiting logo: behind the globe on the far half of the ring, in front on the near half */}
          <Group opacity={orb.z > 0 ? 1 : 0.35}>
            <Circle cx={orb.x} cy={orb.y} r={16 + 4 * orb.z} color={C.yellow} opacity={0.5}><BlurMask blur={10} style="normal" /></Circle>
            <Circle cx={orb.x} cy={orb.y} r={13 + 3 * orb.z} color={C.yellow} />
            <Circle cx={orb.x} cy={orb.y} r={13 + 3 * orb.z} style="stroke" strokeWidth={3} color={C.ink} />
          </Group>
        </Canvas>
        <View style={[styles.logoLetter, { left: orb.x - 10, top: orb.y - 12, opacity: orb.z > 0 ? 1 : 0.35 }]} pointerEvents="none"><Text style={styles.logoF}>F</Text></View>
      </Animated.View>
      <Animated.View style={[styles.copy, textStyle]} pointerEvents="none">
        <Text style={styles.brand}>FRESCO</Text>
        <Text style={styles.tag}>the world is your wall</Text>
        <Text style={styles.cta}>tap to drop into Waterloo</Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  logoLetter: { position: 'absolute', width: 20, height: 24, alignItems: 'center', justifyContent: 'center' },
  logoF: { color: C.ink, fontFamily: F.display, fontSize: 18 },
  copy: { position: 'absolute', left: 0, right: 0, bottom: H * 0.14, alignItems: 'center', gap: 8 },
  brand: { color: '#fff', fontFamily: F.display, fontSize: 56, letterSpacing: 8, ...outline('#4a22b8', 4) },
  tag: { color: C.dim, fontFamily: F.body, fontSize: 16, letterSpacing: 1 },
  cta: { color: C.yellow, ...uiLabel(12, 2.5), marginTop: 18 },
});
