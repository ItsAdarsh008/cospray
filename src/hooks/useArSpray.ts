import { useEffect, useRef, useState } from 'react';
import * as Haptics from 'expo-haptics';
import {
  CANVAS_JOIN_RADIUS_M, GEOFENCE, PAINT_COST_PER_SEC, PAINT_EMPTY_THRESHOLD, PAINT_LOW_THRESHOLD, PAINT_MAX,
  PAINT_REGEN_PER_SEC, SHAKE_DECAY_SECONDS, SHAKE_GAIN_PER_EVENT, SHAKE_MIN_TO_SPRAY, SPRAY_RADIUS_M, STROKE_CAP,
} from '../config';
import { haversineM, wrap360 } from '../lib/geo';
import { uuid } from '../lib/ids';
import { sfx } from '../audio/sfx';
import { useStore, type Side } from '../store';
import { createCanvas, uploadStroke } from '../data/sync';
import type { Pose } from './usePose';
import type { Canvas, Stroke, StrokePoint } from '../types';
import type { ArStroke } from '../../modules/ar-paint';
import type { Blocker } from './useSprayEngine';
import { OPACITY, THICKNESS } from '../lib/economy';

/**
 * The spray simulation for the ARKit view. Native ARKit does the surface hit-testing and the
 * texture painting; this hook owns the game rules (can charge, paint economy, geofence), drives
 * the native props (spraying / colour / radius / flow), and turns finished native strokes into
 * records for the shared canvas.
 */
export function useArSpray(pose: React.MutableRefObject<Pose>, opts: { onStrokeSaved?: (s: Stroke) => void }) {
  const held = useRef<Side | null>(null);
  const blocker = useRef<Blocker>(null);
  const activeCanvas = useRef<Canvas | null>(null);
  const hit = useRef(false);
  const dist = useRef(1); // metres from the camera to the reticle hit (ARKit)
  const strokePaint = useRef(0);
  const hapticsAt = useRef(0);
  const lastLowRattle = useRef(0);
  const [native, setNative] = useState({ spraying: false, color: '#ff2d95', radius: 0.06, flow: 1 });
  const cb = useRef(opts); cb.current = opts;

  // can decay + paint regen
  useEffect(() => {
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const dt = (now - last) / 1000; last = now;
      const st = useStore.getState();
      if (st.shake > 0) st.setShake(Math.max(0, st.shake - dt / SHAKE_DECAY_SECONDS));
      for (const side of ['A', 'B'] as Side[]) {
        if (held.current === side) continue;
        if (st.paint[side] < PAINT_MAX) st.setPaint(side, Math.min(PAINT_MAX, st.paint[side] + PAINT_REGEN_PER_SEC * dt));
      }
    }, 250);
    return () => clearInterval(id);
  }, []);

  const onShake = (mag: number) => {
    const st = useStore.getState();
    st.setShake(Math.min(1, st.shake + SHAKE_GAIN_PER_EVENT * Math.min(2, mag / 2.4)));
    const low = Math.min(st.paint.A, st.paint.B) < PAINT_LOW_THRESHOLD;
    if (st.settings.sound) low ? sfx.emptyRattle() : sfx.rattle(Math.min(1, mag / 4));
    if (st.settings.haptics) Haptics.impactAsync(low ? Haptics.ImpactFeedbackStyle.Rigid : Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
  };

  const computeBlocker = (): Blocker => {
    const st = useStore.getState();
    if (!st.location) return 'no-location';
    if (!st.settings.geofenceBypass && haversineM(st.location.lat, st.location.lng, GEOFENCE.lat, GEOFENCE.lng) > GEOFENCE.radiusM) return 'outside-geofence';
    if (st.shake < SHAKE_MIN_TO_SPRAY) return 'shake';
    const side = held.current;
    if (side && st.paint[side] <= PAINT_EMPTY_THRESHOLD) return 'empty';
    return null;
  };

  /** The canvas you're standing at (nearest within join radius), or a fresh one. */
  const pickCanvas = (): Canvas | null => {
    if (activeCanvas.current) return activeCanvas.current;
    const st = useStore.getState();
    const loc = st.location; if (!loc) return null;
    let best: Canvas | null = null, bestD = Infinity;
    for (const c of Object.values(st.canvases)) {
      if (c.flagged) continue;
      const d = haversineM(loc.lat, loc.lng, c.lat, c.lng);
      if (d < CANVAS_JOIN_RADIUS_M && d < bestD) { best = c; bestD = d; }
    }
    if (best) { activeCanvas.current = best; return best; }
    const p = st.painter;
    const c: Canvas = {
      id: uuid(), lat: loc.lat, lng: loc.lng, heading: wrap360(pose.current.yaw), title: null,
      author_id: p?.id ?? null, author_name: p?.name ?? 'anon', views: 0, stroke_count: 0, flags: 0, flagged: false,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), world_map_path: null,
    };
    createCanvas(c);
    activeCanvas.current = c;
    return c;
  };

  const applyNativeProps = (side: Side) => {
    const st = useStore.getState();
    const opt = side === 'A' ? st.settings.optionA : st.settings.optionB;
    const strength = Math.min(1, st.shake / 0.35);
    const paintFrac = st.paint[side] / PAINT_MAX;
    const flow = strength * (0.55 + 0.45 * Math.min(1, paintFrac * 3));
    // Create tools: size + opacity steppers. Distance: close to the wall = tight, strong "focus";
    // stepping back widens the spray and thins it out into "mist".
    const th = THICKNESS[st.settings.thickness]?.mult ?? 1;
    const op = OPACITY[st.settings.opacity]?.mult ?? 1;
    const mist = Math.max(0, Math.min(1, (dist.current - 0.5) / 1.2));
    setNative({ spraying: true, color: opt.color, radius: SPRAY_RADIUS_M * th * (0.8 + 0.9 * mist), flow: Math.max(0.05, flow * op * (1 - 0.45 * mist)) });
    return { flow, th };
  };

  const start = (side: Side) => {
    if (held.current === side) return;
    if (held.current) end(held.current);
    held.current = side;
    const b = computeBlocker();
    blocker.current = b;
    const st = useStore.getState();
    if (b) {
      if (st.settings.haptics) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      if (b === 'empty' && st.settings.sound) sfx.emptyRattle();
      if (b === 'shake' && st.settings.sound) sfx.click();
      return;
    }
    if (!pickCanvas()) return;
    strokePaint.current = 0;
    applyNativeProps(side);
    if (st.settings.sound) sfx.click();
  };

  const end = (side: Side) => {
    if (held.current !== side) return;
    held.current = null;
    sfx.setHiss(false, 0, 0);
    setNative((n) => ({ ...n, spraying: false }));
  };

  // 10 Hz game tick while held: cost, hiss, haptics, blockers
  useEffect(() => {
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const dt = Math.min(0.3, (now - last) / 1000); last = now;
      const side = held.current;
      if (!side) { blocker.current = null; return; }
      const st = useStore.getState();
      const b = computeBlocker();
      blocker.current = b;
      if (b) {
        setNative((n) => (n.spraying ? { ...n, spraying: false } : n));
        sfx.setHiss(false, 0, 0);
        if (b === 'empty' && now - lastLowRattle.current > 1500 && st.settings.sound) { lastLowRattle.current = now; sfx.emptyRattle(); }
        return;
      }
      const { flow, th } = applyNativeProps(side);
      if (!hit.current) { sfx.setHiss(false, 0, 0); return; } // aiming at nothing: no paint, no cost
      const cost = PAINT_COST_PER_SEC * dt * (0.6 + 0.4 * flow) * (0.7 + 0.3 * th); // fatter lines burn more paint
      strokePaint.current += cost;
      st.setPaint(side, Math.max(0, st.paint[side] - cost));
      if (st.settings.sound) sfx.setHiss(true, flow, 0.5);
      if (st.settings.haptics && now - hapticsAt.current > 70) {
        hapticsAt.current = now;
        Haptics.impactAsync(flow > 0.6 ? Haptics.ImpactFeedbackStyle.Light : Haptics.ImpactFeedbackStyle.Soft).catch(() => {});
      }
      if (st.paint[side] < PAINT_LOW_THRESHOLD && now - lastLowRattle.current > 2500 && st.settings.sound) {
        lastLowRattle.current = now; sfx.emptyRattle();
      }
    }, 100);
    return () => clearInterval(id);
  }, []);

  /** Native finished a stroke (one per surface quad): persist + share it. */
  const onNativeStroke = (a: ArStroke) => {
    const st = useStore.getState();
    const canvas = activeCanvas.current;
    if (!canvas || a.points.length === 0) return;
    const s: Stroke = {
      id: a.id, canvas_id: canvas.id, author_id: st.painter?.id ?? null, author_name: st.painter?.name ?? 'anon',
      color: a.color, cap: STROKE_CAP, points: a.points as StrokePoint[], paint_used: Math.round(strokePaint.current * 100) / 100,
      created_at: new Date().toISOString(), anchor_id: a.anchorId, transform: a.transform, viewer: a.viewer ?? null,
    };
    strokePaint.current = 0;
    st.addStroke(s);
    const p = st.painter;
    if (p) st.setPainter({ ...p, strokes: p.strokes + 1, paint_used: p.paint_used + s.paint_used });
    uploadStroke(s);
    cb.current.onStrokeSaved?.(s);
  };

  return { start, end, onShake, onNativeStroke, native, held, blocker, hit, dist, activeCanvas };
}
