import { useEffect, useRef, useState } from 'react';
import { CANVAS_VISIBLE_RADIUS_M, DISCOVERED_RADIUS_M, DISCOVERY_SHIMMER_RADIUS_M } from '../config';
import { bearingDeg, clamp, haversineM, wrapDiff } from '../lib/geo';
import { useStore } from '../store';
import { incrementViews } from '../data/sync';
import { getPose } from './usePose';
import type { Canvas } from '../types';
import type { WallView } from '../paint/PaintLayer';

export type Discovery = {
  walls: WallView[];
  /** The nearest undiscovered piece pulling at you, if any. */
  pull: null | { canvas: Canvas; distance: number; bearing: number; relBearing: number; resolve: number };
  /** Canvas just discovered (for the reveal card). */
  justFound: Canvas | null;
  /** Discovered/own canvas currently in front of you (for the info chip). */
  focused: Canvas | null;
};

const TICK_MS = 120;
const LOCK_MS = 800;
const REVEAL_MS = 6000;

/** Success notification haptic (expo-haptics equivalent); Android Chrome only, silently no-op elsewhere. */
function buzz() {
  if (!useStore.getState().settings.haptics) return;
  try { if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate([30, 40, 30]); } catch {}
}

/**
 * Discovery = the emotional beat (port of the native hook; heading comes from getPose()).
 * Ranks nearby canvases by distance; anything not yet discovered (and not yours) shimmers from
 * DISCOVERY_SHIMMER_RADIUS_M, fades/blurs in across CANVAS_VISIBLE_RADIUS_M → DISCOVERED_RADIUS_M,
 * and once you're inside DISCOVERED_RADIUS_M looking at it for a beat, it "locks": view count
 * increments and the author tag appears. `autoLock = false` keeps the pull/walls but never locks.
 */
export function useDiscovery(autoLock = true): Discovery {
  const [state, setState] = useState<Discovery>({ walls: [], pull: null, justFound: null, focused: null });
  const lookingSince = useRef<Record<string, number>>({});
  const foundTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoLockRef = useRef(autoLock);
  autoLockRef.current = autoLock;

  useEffect(() => {
    const id = setInterval(() => {
      const st = useStore.getState();
      const loc = st.location;
      const me = st.painter?.id;
      const pose = getPose();
      const yaw = pose.yaw;
      // without a compass fix (sensors denied / not yet delivered) "facing the wall" is unknowable
      const hasHeading = pose.ready;
      const walls: WallView[] = [];
      let pull: Discovery['pull'] = null;
      let focused: Canvas | null = null;
      let focusedRel = 999;
      let justFound: Canvas | null = null;
      if (loc) {
        for (const c of Object.values(st.canvases)) {
          if (c.flagged) continue;
          const d = haversineM(loc.lat, loc.lng, c.lat, c.lng);
          if (d > DISCOVERY_SHIMMER_RADIUS_M) continue;
          const mine = !!me && c.author_id === me;
          const known = mine || !!st.discovered[c.id];
          const b = bearingDeg(loc.lat, loc.lng, c.lat, c.lng);
          // when standing on top of a canvas, bearing is meaningless — use its wall heading
          const towards = d < 6 ? c.heading : b;
          const rel = wrapDiff(towards, yaw);
          const facingRel = Math.abs(wrapDiff(c.heading, yaw));
          let resolve = known ? 1 : clamp((CANVAS_VISIBLE_RADIUS_M - d) / (CANVAS_VISIBLE_RADIUS_M - DISCOVERED_RADIUS_M), 0, 1);
          if (!known) {
            // lock-on: inside the discovered radius and roughly facing the wall for ~0.8s
            const facing = (hasHeading && facingRel < 45) || d < 4;
            if (autoLockRef.current && d <= DISCOVERED_RADIUS_M && facing) {
              const since = lookingSince.current[c.id] ?? (lookingSince.current[c.id] = Date.now());
              if (Date.now() - since > LOCK_MS) {
                st.markDiscovered(c.id);
                incrementViews(c.id);
                justFound = c;
                resolve = 1;
                buzz();
              }
            } else delete lookingSince.current[c.id];
            if (!pull || d < pull.distance) pull = { canvas: c, distance: d, bearing: b, relBearing: rel, resolve };
          } else if (hasHeading && d < CANVAS_VISIBLE_RADIUS_M && facingRel < focusedRel && facingRel < 40) {
            focused = c; focusedRel = facingRel;
          }
          if (d < CANVAS_VISIBLE_RADIUS_M || known) walls.push({ canvasId: c.id, heading: c.heading, resolve });
        }
      }
      setState((prev) => {
        const jf = justFound ?? prev.justFound;
        if (justFound) {
          if (foundTimer.current) clearTimeout(foundTimer.current);
          foundTimer.current = setTimeout(() => setState((p) => ({ ...p, justFound: null })), REVEAL_MS);
        }
        // avoid re-render churn when nothing meaningful changed
        const same = prev.justFound === jf && prev.focused?.id === focused?.id && prev.pull?.canvas.id === pull?.canvas.id &&
          Math.abs((prev.pull?.distance ?? 0) - (pull?.distance ?? 0)) < 0.3 && Math.abs((prev.pull?.relBearing ?? 0) - (pull?.relBearing ?? 0)) < 2 &&
          prev.walls.length === walls.length && prev.walls.every((w, i) => w.canvasId === walls[i].canvasId && Math.abs(w.resolve - walls[i].resolve) < 0.02);
        if (same) return prev;
        return { walls, pull, justFound: jf, focused: justFound ?? focused };
      });
    }, TICK_MS);
    return () => {
      clearInterval(id);
      if (foundTimer.current) { clearTimeout(foundTimer.current); foundTimer.current = null; }
    };
  }, []);

  return state;
}
