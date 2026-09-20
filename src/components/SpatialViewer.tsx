import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Image, Linking, Modal, PanResponder, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Canvas, Group, Picture, Rect, Skia, type SkPicture } from '@shopify/react-native-skia';
import { cancelAnimation, Easing, useDerivedValue, useSharedValue, withDecay, withRepeat, withTiming } from 'react-native-reanimated';
import { Btn, IconBtn, Panel, T, Tile } from '../ui/kit';
import { PixelBox } from '../ui/PixelBox';
import { PixelIcon } from '../ui/PixelIcon';
import { layoutDabs, mosaic } from '../ui/StrokeThumb';
import { C, F, uiLabel } from '../ui/theme';
import { mix } from '../ui/color';
import { seededRng } from '../lib/ids';
import { useStore } from '../store';
import { fetchPreviewStrokes, reportCanvas } from '../data/sync';
import { isMock } from '../data/mock';
import { timeAgo } from './DiscoveryOverlay';
import type { Canvas as CanvasT, Stroke } from '../types';

// ---- scene constants (world units are "px at scale 1"; 1 m = TILE) --------------------------
const TILE = 34;
const R = TILE * 5; // the 5 m capture radius
const WALL_W = TILE * 4, WALL_H = TILE * 3;
const PANO_W = 1500;
const SKY_H = 190;
const PERSPECTIVE = 620;
const SCENE_H = 400;

/**
 * StreetView-style spatial viewer. The piece stands on its wall inside a 5 m circle; drag to
 * orbit the whole scene (yaw + tilt), buttons zoom, and a skyline panorama wraps 360° behind.
 * The surroundings are a stylised reconstruction seeded from the canvas id; the one real picture
 * is the painter's photo of the wall, shown below the scene when they took one.
 */
export function PieceDetail({ canvas: c, onClose }: { canvas: CanvasT; onClose: () => void }) {
  const strokes = useStore((s) => s.strokes[c.id] ?? s.previewStrokes[c.id] ?? []);
  const discovered = useStore((s) => s.discovered[c.id]);
  const me = useStore((s) => s.painter);
  const photo = useStore((s) => s.photos[c.id]); // the painter's own shot of this wall, if they took one
  useEffect(() => { if (!isMock(c.id)) fetchPreviewStrokes([c.id]).catch(() => {}); }, [c.id]);
  const paint = strokes.reduce((a, s) => a + s.paint_used, 0);
  const colors = [...new Set(strokes.map((s) => s.color))].slice(0, 8);
  const mapsUrl = `https://maps.apple.com/?ll=${c.lat},${c.lng}&q=${encodeURIComponent(c.title ?? 'Fresco piece')}`;
  const canReport = !isMock(c.id) && c.author_id !== me?.id;
  const report = () => Alert.alert('Report this piece?', 'Two reports hide a piece for everyone.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Report', style: 'destructive', onPress: () => { reportCanvas(c.id, me?.id ?? null, 'inappropriate'); onClose(); } },
  ]);
  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={styles.root}>
        <Scene canvas={c} strokes={strokes} onClose={onClose} />
        <ScrollView contentContainerStyle={styles.sheet} showsVerticalScrollIndicator={false}>
          <View>
            <T v="h" numberOfLines={1}>{c.title ?? `${c.author_name}'s piece`}</T>
            <T v="small">by {c.author_name}{c.author_id === me?.id ? ' (you)' : ''} · {timeAgo(c.created_at)}{discovered ? ' · found by you' : ''}</T>
          </View>
          {photo ? (
            <View style={styles.photoFrame}>
              <Image source={{ uri: photo }} style={styles.photo} resizeMode="cover" />
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Tile n={c.views} label="views" /><Tile n={c.stroke_count} label="strokes" /><Tile n={Math.round(paint)} label="paint" /><Tile n={colors.length} label="colours" />
          </View>
          <Panel title="LOCATION">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <PixelIcon name="pin" size={24} color={C.white} />
              <Text style={styles.mono}>{c.lat.toFixed(5)}, {c.lng.toFixed(5)}</Text>
            </View>
            <T v="small">facing {Math.round(c.heading)}° · {isMock(c.id) ? 'sample spot' : c.world_map_path ? 'AR world map saved' : 'compass-anchored'}</T>
            <Btn label="OPEN IN MAPS" icon="share" tone="blue" onPress={() => Linking.openURL(mapsUrl)} />
          </Panel>
          {colors.length > 0 && (
            <View style={{ flexDirection: 'row', gap: 6 }}>{colors.map((col) => <View key={col} style={{ width: 24, height: 24, backgroundColor: col, borderWidth: 3, borderColor: C.ink }} />)}</View>
          )}
          {canReport && <Btn label="REPORT PIECE" icon="flag" tone="dark" size="sm" onPress={report} />}
        </ScrollView>
      </View>
    </Modal>
  );
}

function Scene({ canvas: c, strokes, onClose }: { canvas: CanvasT; strokes: Stroke[]; onClose: () => void }) {
  const { width } = useWindowDimensions();
  const sw = width, cy = SCENE_H * 0.62;
  const yaw = useSharedValue(0.75);
  const tilt = useSharedValue(0.42);
  const zoom = useSharedValue(0.92);
  const [auto, setAuto] = useState(true);
  const start = useRef({ yaw: 0, tilt: 0 });

  const wallPic = useMemo(() => wallPicture(c.id, strokes), [c.id, strokes]);
  const floorPic = useMemo(() => floorPicture(), []);
  const skyPic = useMemo(() => skylinePicture(c.id), [c.id]);

  useEffect(() => {
    if (auto) yaw.value = withRepeat(withTiming(yaw.value + Math.PI * 2, { duration: 30000, easing: Easing.linear }), -1);
    else cancelAnimation(yaw);
  }, [auto]);

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { cancelAnimation(yaw); setAuto(false); start.current = { yaw: yaw.value, tilt: tilt.value }; },
    onPanResponderMove: (_, g) => {
      yaw.value = start.current.yaw + g.dx * 0.009;
      tilt.value = Math.max(0.1, Math.min(1.1, start.current.tilt + g.dy * 0.004));
    },
    onPanResponderRelease: (_, g) => { yaw.value = withDecay({ velocity: g.vx * 9, deceleration: 0.996 }); },
  }), []);

  const cam = useDerivedValue(() => [
    { translateX: sw / 2 }, { translateY: cy }, { scale: zoom.value }, { perspective: PERSPECTIVE }, { rotateX: tilt.value }, { rotateY: yaw.value },
  ] as any);
  const skyA = useDerivedValue(() => [{ translateX: -(((yaw.value * PANO_W) / (Math.PI * 2)) % PANO_W + PANO_W) % PANO_W }]);
  const skyB = useDerivedValue(() => [{ translateX: PANO_W - (((yaw.value * PANO_W) / (Math.PI * 2)) % PANO_W + PANO_W) % PANO_W }]);
  const floorT = useMemo(() => [{ rotateX: Math.PI / 2 }, { translateX: -R }, { translateY: -R }] as any, []);
  const wallT = useMemo(() => [{ translateX: -WALL_W / 2 }, { translateY: -WALL_H }] as any, []);
  const bands = useMemo(() => Array.from({ length: 12 }, (_, i) => mix('#3b1a8a', '#150a36', i / 11)), []);
  const horizon = cy - 34;

  return (
    <View style={{ height: SCENE_H, backgroundColor: '#150a36' }} {...pan.panHandlers}>
      <Canvas style={{ width: sw, height: SCENE_H }}>
        {bands.map((col, i) => <Rect key={i} x={0} y={(i * SCENE_H) / 12} width={sw} height={SCENE_H / 12 + 1} color={col} />)}
        <Group transform={[{ translateY: horizon - SKY_H }]}>
          <Group transform={skyA}><Picture picture={skyPic} /></Group>
          <Group transform={skyB}><Picture picture={skyPic} /></Group>
        </Group>
        <Rect x={0} y={horizon} width={sw} height={SCENE_H - horizon} color="#150a36" />
        <Group transform={cam}>
          <Group transform={floorT}><Picture picture={floorPic} /></Group>
          <Group transform={wallT}><Picture picture={wallPic} /></Group>
        </Group>
      </Canvas>
      <View style={styles.topRow} pointerEvents="box-none">
        <PixelBox fill="#160b36" depth={3} contentStyle={{ height: 36, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <PixelIcon name="cube" size={24} color={C.white} alt={C.faint} />
          <Text style={styles.chip}>5 M CAPTURE RADIUS</Text>
        </PixelBox>
        <IconBtn icon="x" onPress={onClose} size={44} />
      </View>
      <View style={styles.bottomRow} pointerEvents="box-none">
        <View style={styles.hint}><Text style={styles.hintText}>DRAG TO ORBIT</Text></View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <IconBtn icon="minus" size={40} onPress={() => { zoom.value = withTiming(Math.max(0.55, zoom.value - 0.18), { duration: 180 }); }} />
          <IconBtn icon="plus" size={40} onPress={() => { zoom.value = withTiming(Math.min(1.6, zoom.value + 0.18), { duration: 180 }); }} />
          <IconBtn icon="target" size={40} active={auto} onPress={() => setAuto((a) => !a)} />
        </View>
      </View>
    </View>
  );
}

// ---- pictures (recorded once, drawn every frame by the GPU) ---------------------------------
function paintOf(color: string, alpha = 1) { const p = Skia.Paint(); p.setColor(Skia.Color(color)); p.setAlphaf(alpha); p.setAntiAlias(false); return p; }
function record(w: number, h: number, draw: (c: any) => void): SkPicture {
  const rec = Skia.PictureRecorder();
  const cv = rec.beginRecording(Skia.XYWHRect(0, 0, w, h));
  draw(cv);
  return rec.finishRecordingAsPicture();
}
const rect = (cv: any, x: number, y: number, w: number, h: number, p: any) => cv.drawRect(Skia.XYWHRect(x, y, w, h), p);

/** Brick wall with the piece's dabs snapped to a 2 px grid on top. */
function wallPicture(id: string, strokes: Stroke[]) {
  const rng = seededRng(`wall-${id}`);
  return record(WALL_W, WALL_H, (cv) => {
    rect(cv, 0, 0, WALL_W, WALL_H, paintOf('#4b3e82'));
    const mortar = paintOf('#332a63');
    for (let r = 0, y = 0; y < WALL_H; r++, y += 8) {
      rect(cv, 0, y, WALL_W, 2, mortar);
      for (let x = r % 2 ? 11 : 0; x < WALL_W; x += 22) {
        rect(cv, x, y, 2, 8, mortar);
        if (rng() > 0.7) rect(cv, x + 2, y + 2, 20, 6, paintOf('#ffffff', 0.06));
      }
    }
    rect(cv, 0, 0, WALL_W, 3, paintOf('#ffffff', 0.18)); // cap highlight
    rect(cv, 0, WALL_H - 3, WALL_W, 3, paintOf('#000000', 0.25));
    const cache = new Map<string, any>();
    for (const t of mosaic(layoutDabs(strokes, id, WALL_W, WALL_H), 2)) {
      const k = `${t.color}|${t.a}`;
      let p = cache.get(k); if (!p) { p = paintOf(t.color, t.a); cache.set(k, p); }
      rect(cv, t.x, t.y, t.s, t.s, p);
    }
  });
}

/** The 5 m disc: pixel checker floor, dashed capture ring, wall contact shadow. Origin = top-left of a 2R box. */
function floorPicture() {
  return record(R * 2, R * 2, (cv) => {
    const clip = Skia.Path.Make(); clip.addCircle(R, R, R); cv.save(); cv.clipPath(clip, 1, false);
    const a = paintOf('#2b1a66'), b = paintOf('#35227a');
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) rect(cv, i * TILE, j * TILE, TILE, TILE, (i + j) % 2 ? a : b);
    rect(cv, R - WALL_W / 2, R - 7, WALL_W, 14, paintOf('#000000', 0.35)); // contact shadow
    cv.restore();
    const dots = paintOf('#ffd21f'), white = paintOf('#ffffff');
    for (let i = 0; i < 48; i++) { const ang = (i / 48) * Math.PI * 2; rect(cv, R + Math.cos(ang) * (R - 3) - 3, R + Math.sin(ang) * (R - 3) - 3, 6, 6, i % 2 ? dots : white); }
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) rect(cv, R + dx * (R - 14) - 5, R + dy * (R - 14) - 5, 10, 10, dots); // compass ticks
  });
}

/** 360° skyline strip that wraps exactly at PANO_W: two building layers, lit windows, a pixel moon. */
function skylinePicture(id: string) {
  const rng = seededRng(`sky-${id}`);
  return record(PANO_W, SKY_H, (cv) => {
    const layer = (color: string, minH: number, maxH: number, minW: number, maxW: number, windows: boolean) => {
      const p = paintOf(color); const win = paintOf('#ffd21f', 0.75); const win2 = paintOf('#57ffa0', 0.6);
      for (let x = 0; x < PANO_W;) {
        let w = Math.round(minW + rng() * (maxW - minW)); if (x + w > PANO_W - 20) w = PANO_W - x;
        const h = Math.round(minH + rng() * (maxH - minH));
        rect(cv, x, SKY_H - h, w, h, p);
        if (windows) for (let wy = SKY_H - h + 8; wy < SKY_H - 6; wy += 12) for (let wx = x + 5; wx < x + w - 6; wx += 10) if (rng() > 0.62) rect(cv, wx, wy, 4, 6, rng() > 0.85 ? win2 : win);
        x += w;
      }
    };
    layer('#3f2a86', 40, 110, 40, 90, false);
    layer('#22124f', 60, 160, 36, 84, true);
    const moon = paintOf('#fff3a8');
    const mx = Math.round(200 + rng() * 1000), my = 18;
    for (let dy = -18; dy <= 18; dy += 3) { const hw = Math.round(Math.sqrt(18 * 18 - dy * dy) / 3) * 3; rect(cv, mx - hw, my + dy, hw * 2, 3, moon); }
  });
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#150a36' },
  photoFrame: { borderWidth: 3, borderColor: C.ink },
  photo: { width: '100%', height: 210 },
  sheet: { padding: 18, gap: 14, paddingBottom: 50 },
  topRow: { position: 'absolute', top: 56, left: 14, right: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  bottomRow: { position: 'absolute', bottom: 12, left: 14, right: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chip: { ...uiLabel(11, 0.6), color: C.white },
  hint: { backgroundColor: '#0a062088', paddingHorizontal: 10, paddingVertical: 6 },
  hintText: { ...uiLabel(10.5, 0.8), color: C.dim },
  mono: { fontFamily: F.mono, fontSize: 22, color: C.phosphor },
});
