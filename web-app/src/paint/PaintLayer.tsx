import { useEffect, useRef, type CSSProperties, type JSX } from 'react';
import { clamp } from '../lib/geo';
import { getPose } from '../hooks/usePose';
import { useStore } from '../store';
import { WALL_HALF_X, WALL_HALF_Y, getWall, hasWall } from './Wall';

export type WallView = {
  canvasId: string;
  heading: number; // canvas centre heading
  resolve: number; // 0 = invisible/blurred, 1 = crisp
};

const D2R = Math.PI / 180;
/** How far in front of the painter their wall stands. A canvas is "the wall I was facing". */
const WALL_STANDOFF_M = 3;
/** World scale. Only the ratio to the viewport matters; this keeps the numbers CSS-friendly. */
const PX_PER_M = 240;
/** Metres per degree of latitude; longitude shrinks by cos(lat). */
const M_PER_DEG = 111_320;
/** GPS jitters by metres, so the position the walls are pinned to is eased rather than followed. */
const POS_SMOOTHING = 0.12;

// fixed, under the HUD (which should sit at z-index ≥ 10), over the camera <video> (z-index ≤ 1)
const STYLE: CSSProperties = {
  position: 'fixed', inset: 0, width: '100%', height: '100%',
  pointerEvents: 'none', zIndex: 2, display: 'block', touchAction: 'none',
  overflow: 'hidden', perspectiveOrigin: '50% 50%',
};

/**
 * Draws every nearby wall as what it is: a flat surface standing at a *place*, three metres in
 * front of the spot its author painted from, facing back at them. Each wall is a 3D-transformed
 * element, so the browser gives it a real perspective divide — look along it and the paint
 * foreshortens, walk past it and it slides by as a wall does.
 *
 * Two bugs this replaces, in order of how wrong they felt:
 *  - walls used to be pinned a fixed distance in front of the *camera*, in the direction of their
 *    heading, so they followed you down the street instead of staying where they were painted;
 *  - before that they were blitted with a 2D translate + rotate, which never foreshortens, so
 *    paint slid about like a sticker on a sphere.
 *
 * The wall element holds the Wall's own offscreen canvas, so painting shows up with no per-frame
 * blit; a frame only rewrites transforms, which stay on the compositor. Runs its own rAF loop off
 * getPose() so it never re-renders React.
 *
 * What this still isn't: plane *detection*. A browser has no depth sensor and no position
 * tracking, so the wall is where the canvas says it is rather than where the real wall is, and
 * walking around doesn't parallax. On the phone, ARKit/ARCore do the real thing.
 */
export function PaintLayer({ walls }: { walls: WallView[] }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const wallsRef = useRef(walls);
  wallsRef.current = walls;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    /** one positioned element per canvas, holding that Wall's raster */
    const mounted = new Map<string, HTMLDivElement>();
    /** eased copy of our own GPS fix, so a noisy reading doesn't fling the walls about */
    let me: { lat: number; lng: number } | null = null;

    const surfaceFor = (id: string) => {
      let el = mounted.get(id);
      if (el) return el;
      const wall = getWall(id);
      // the wall's real size: what ±WALL_YAW_RANGE covers at the standoff distance
      const w = 2 * WALL_HALF_X * WALL_STANDOFF_M * PX_PER_M;
      const h = 2 * WALL_HALF_Y * WALL_STANDOFF_M * PX_PER_M;
      el = document.createElement('div');
      el.style.cssText = [
        'position:absolute', 'left:50%', 'top:50%',
        `width:${w}px`, `height:${h}px`,
        `margin-left:${-w / 2}px`, `margin-top:${-h / 2}px`,
        'transform-origin:50% 50%', 'will-change:transform', 'backface-visibility:hidden',
      ].join(';');
      const c = wall.canvas;
      c.style.cssText = 'width:100%;height:100%;display:block';
      el.appendChild(c);
      host.appendChild(el);
      mounted.set(id, el);
      return el;
    };

    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const pose = getPose();
      const st = useStore.getState();
      const hfov = st.settings.hfov;
      const w = host.clientWidth || window.innerWidth;
      const h = host.clientHeight || window.innerHeight;
      if (!(hfov > 0) || w <= 0 || h <= 0) return;

      // hfov spans the short edge in either orientation (roll levels the layer in landscape)
      const focal = (Math.min(w, h) / 2) / Math.tan((hfov * D2R) / 2);
      host.style.perspective = `${focal.toFixed(1)}px`;
      // CSS puts the eye `focal` in front of the z = 0 plane, so a wall parked at translateZ(-R)
      // sits at depth focal + R and lands at half the angle it should. Step out to the eye first,
      // rotate there, then go R along the rotated view axis: that is the plain pinhole camera,
      // checked against focal·tan(angle) in the browser.
      const eye = focal.toFixed(1);

      // our own position, eased — walls are pinned to the world through it
      const fix = st.location;
      if (fix) {
        me = me
          ? { lat: me.lat + (fix.lat - me.lat) * POS_SMOOTHING, lng: me.lng + (fix.lng - me.lng) * POS_SMOOTHING }
          : { lat: fix.lat, lng: fix.lng };
      }
      const mPerLng = me ? M_PER_DEG * Math.cos(me.lat * D2R) : M_PER_DEG;

      const live = new Set<string>();
      for (const wv of wallsRef.current) {
        if (!hasWall(wv.canvasId)) continue; // nothing painted there yet — don't allocate a blank raster
        const canvas = st.canvases[wv.canvasId];
        live.add(wv.canvasId);
        const el = surfaceFor(wv.canvasId);
        const resolve = clamp(wv.resolve, 0, 1);

        // Where the wall stands, in metres north/east of us: its author's spot, plus the standoff
        // along the way they were facing. With no GPS yet, fall back to straight ahead of us.
        const head = wv.heading * D2R;
        let north = WALL_STANDOFF_M * Math.cos(head);
        let east = WALL_STANDOFF_M * Math.sin(head);
        if (me && canvas) {
          north += (canvas.lat - me.lat) * M_PER_DEG;
          east += (canvas.lng - me.lng) * mPerLng;
        }

        // behind us: CSS would still paint it through the camera plane, so take it off screen
        const depth = -Math.sin(pose.yaw * D2R) * east - Math.cos(pose.yaw * D2R) * north;
        if (depth > -0.5) { el.style.display = 'none'; continue; }
        el.style.display = 'block';

        // Step out to the eye, take the camera's orientation, walk to where the wall is in the
        // world, then turn the surface to face back the way its author was looking. The yaw term
        // is +yaw, not -yaw, because the walk that follows is expressed in world north/east:
        // checked against p·x/z for a wall seen from off to one side.
        el.style.transform =
          `translateZ(${eye}px) rotateZ(${(-pose.roll).toFixed(2)}deg) rotateX(${pose.pitch.toFixed(2)}deg) ` +
          `rotateY(${pose.yaw.toFixed(2)}deg) ` +
          `translate3d(${(east * PX_PER_M).toFixed(1)}px, 0px, ${(-north * PX_PER_M).toFixed(1)}px) ` +
          `rotateY(${(-wv.heading).toFixed(2)}deg)`;
        el.style.opacity = (0.15 + 0.85 * resolve).toFixed(3);
        // resolves from a smear into a piece as you walk up to it
        const blur = (1 - resolve) * 26;
        el.style.filter = blur > 0.5 ? `blur(${blur.toFixed(1)}px)` : '';
      }

      // walls that dropped out of range: unmount, but leave their raster alive in the Wall cache
      for (const [id, el] of mounted) {
        if (live.has(id)) continue;
        el.remove();
        mounted.delete(id);
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      for (const [, el] of mounted) el.remove();
      mounted.clear();
    };
  }, []);

  return <div ref={hostRef} style={STYLE} aria-hidden="true" />;
}
