import { useEffect, useState } from 'react';
import { SHAKE_ACCEL_THRESHOLD } from '../config';
import { clamp, wrap360, wrapDiff } from '../lib/geo';
import { useStore } from '../store';
import type { Pose } from '../types';

/**
 * Camera pose from the browser's fused orientation sensor (port of ../../../src/hooks/usePose.ts).
 *
 * `deviceorientation` gives W3C intrinsic Z-X'-Y'' angles (alpha, beta, gamma) of the device's
 * natural (portrait) frame — X right, Y up (top of phone), Z out of the screen — relative to the
 * Earth frame X east, Y north, Z up. We build the full rotation matrix R = Rz(α)·Rx(β)·Ry(γ) and read
 * off the back-camera axis (device −Z) and the gravity direction; this is exact even where the Euler
 * angles themselves are degenerate (an upright phone sits right at the β = 90° gimbal lock, where
 * the browser's α and γ swing wildly against each other while the matrix stays put).
 *
 *  yaw   = compass heading of the camera axis, 0 = north, clockwise (deg, 0..360)
 *  pitch = camera elevation (deg, + up)
 *  roll  = clockwise tilt of the phone as seen on screen (deg, upright → 0), screen-orientation aware
 *
 * Absolute heading:
 *  - Android: `deviceorientationabsolute` (or `event.absolute === true`) — alpha is already magnetic-north referenced.
 *  - iOS: alpha is relative to an arbitrary start; `webkitCompassHeading` is the tilt-compensated
 *    compass heading of the camera axis. Substituting α = 360 − heading is exactly a rotation of the
 *    relative attitude about world Z, so we apply it as a yaw offset (fast relative yaw + slowly
 *    corrected offset = the same complementary filter as the native gyro/magnetometer fusion), which
 *    avoids the 180° flips the raw substitution produces at the gimbal lock.
 * Shake = `devicemotion.acceleration` (user acceleration, no gravity) magnitude in g above
 * SHAKE_ACCEL_THRESHOLD, debounced 120 ms — same as native.
 */
export type PoseListener = (p: Pose) => void;
export type PoseStatus = 'granted' | 'denied' | 'unsupported';

// ---- tunables (native equivalents in comments) -------------------------------------------------
const YAW_CORRECT_TAU_S = 0.5;        // native: 0.03 per 16 ms sample ≈ 0.53 s toward the magnetometer
const COMPASS_SNAP_DEG = 90;          // gross disagreement (frame reset / interference recovery) → snap
const SMOOTH_TAU_S = 0.04;            // native: gravity low-pass k = 0.35 per 16 ms sample ≈ 37 ms
const SHAKE_DEBOUNCE_S = 0.12;        // native: 0.12
const GRAVITY_LP_K = 0.1;             // only for the accelerationIncludingGravity fallback
const COMPASS_MAX_PITCH_DEG = 60;     // compass model (camera-axis heading) valid when aiming roughly level…
const COMPASS_MAX_ROLL_DEG = 45;      // …with the phone roughly portrait
const FIRST_EVENT_TIMEOUT_MS = 1500;  // no event this long after permission → no usable sensors
const HUD_INTERVAL_MS = 50;           // usePose() React updates ≈ 20 Hz
const G = 9.80665;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// ---- module state ------------------------------------------------------------------------------
let pose: Pose = { yaw: 0, pitch: 0, roll: 0, ready: false };
const listeners = new Set<PoseListener>();
let shakeCb: ((magG: number) => void) | undefined;
let attached = false;
let startPromise: Promise<PoseStatus> | null = null;
let startResult: PoseStatus | null = null;

// filter state
let gotEvent = false;             // any orientation event has arrived (sensors exist), absolute or not
let gotAbsolute = false;          // an absolute (magnetic-north) orientation stream is flowing → ignore relative events
let yawOffset = 0;                // world-Z correction added to the relative yaw (iOS compass)
let yawOffsetInit = false;
let lastOriT = 0;                 // s
let sYaw = 0, sPitch = 0, sRoll = 0, smoothInit = false;
let gravityLP: [number, number, number] | null = null;
let lastShakeT = 0;               // s
let sensorsMode = 'none';

function wrap180(a: number) {
  return wrapDiff(a, 0);
}

function screenAngle(): number {
  try {
    const o = window.screen?.orientation;
    if (o && typeof o.angle === 'number' && Number.isFinite(o.angle)) return o.angle;
    const legacy = (window as unknown as { orientation?: unknown }).orientation; // older iOS: -90 / 0 / 90 / 180
    if (typeof legacy === 'number' && Number.isFinite(legacy)) return legacy;
  } catch {}
  return 0;
}

function eventSeconds(e: Event): number {
  const t = e.timeStamp;
  return Number.isFinite(t) && t > 0 ? t / 1000 : performance.now() / 1000;
}

function setSensorsMode(mode: string) {
  if (mode === sensorsMode) return;
  sensorsMode = mode;
  try { useStore.getState().setDebug({ sensors: mode }); } catch {}
}

function publish(p: Pose) {
  pose = p;
  for (const fn of listeners) {
    try { fn(p); } catch {}
  }
}

// ---- orientation ---------------------------------------------------------------------------------
type OrientationEventExt = DeviceOrientationEvent & { webkitCompassHeading?: unknown; webkitCompassAccuracy?: unknown };

function onOrientation(e: DeviceOrientationEvent, fromAbsoluteEvent: boolean) {
  const { alpha, beta, gamma } = e;
  if (beta == null || gamma == null || !Number.isFinite(beta) || !Number.isFinite(gamma)) return;

  const absolute = fromAbsoluteEvent || e.absolute === true;
  if (absolute) gotAbsolute = true;
  else if (gotAbsolute) return; // Android fires both streams; the absolute one wins
  gotEvent = true;

  const a = (alpha != null && Number.isFinite(alpha) ? alpha : 0) * D2R;
  const b = beta * D2R;
  const g = gamma * D2R;
  const cA = Math.cos(a), sA = Math.sin(a);
  const cB = Math.cos(b), sB = Math.sin(b);
  const cG = Math.cos(g), sG = Math.sin(g);

  // R = Rz(α)·Rx(β)·Ry(γ), device (natural frame) → Earth (X east, Y north, Z up). Only the columns/rows we need:
  const m13 = cG * sA * sB + cA * sG;
  const m23 = sA * sG - cA * cG * sB;
  const m31 = -cB * sG;
  const m32 = sB;
  const m33 = cB * cG;

  // back camera axis = R·(0,0,−1)
  const dx = -m13, dy = -m23, dz = -m33;
  const yawRel = wrap360(Math.atan2(dx, dy) * R2D);
  const pitch = Math.asin(clamp(dz, -1, 1)) * R2D;

  // gravity in the device frame = Rᵀ·(0,0,−1) = −(row 3); clockwise tilt of the natural frame…
  const gx = -m31, gy = -m32;
  const rollDevice = Math.atan2(gx, -gy) * R2D;
  // …then into the screen frame (three.js: rotate about the screen normal by −screen angle → roll += angle)
  const roll = wrap180(rollDevice + screenAngle());

  const t = eventSeconds(e);
  const dt = lastOriT ? clamp(t - lastOriT, 0, 0.1) : 0;
  lastOriT = t;

  // ---- absolute heading -----------------------------------------------------------------------
  let yaw: number;
  if (absolute) {
    yawOffset = 0; yawOffsetInit = true;
    yaw = yawRel;
    setSensorsMode('absolute');
  } else {
    const ext = e as OrientationEventExt;
    const h = ext.webkitCompassHeading;
    const acc = ext.webkitCompassAccuracy;
    const compassOk = typeof h === 'number' && Number.isFinite(h) && !(typeof acc === 'number' && acc < 0);
    const horizontalEnough = Math.abs(pitch) < COMPASS_MAX_PITCH_DEG; // camera-axis heading well defined
    const portraitEnough = Math.abs(rollDevice) < COMPASS_MAX_ROLL_DEG; // iOS heading is tilt-compensated for portrait
    if (compassOk && horizontalEnough && portraitEnough) {
      // α := 360 − heading  ≡  rotate the relative attitude about world Z so the camera heading reads `heading`
      const want = wrapDiff(h, yawRel);
      if (!yawOffsetInit) { yawOffset = want; yawOffsetInit = true; }
      else {
        const err = wrapDiff(want, yawOffset);
        const k = dt > 0 ? 1 - Math.exp(-dt / YAW_CORRECT_TAU_S) : 1;
        yawOffset = wrap360(yawOffset + (Math.abs(err) > COMPASS_SNAP_DEG ? err : k * err));
      }
    }
    yaw = wrap360(yawRel + yawOffset);
    setSensorsMode(compassOk ? 'ios-compass' : yawOffsetInit ? 'ios-compass·held' : 'relative');
  }

  // ---- light smoothing (≈ 40 ms, well under the 100 ms budget) --------------------------------
  if (!smoothInit || dt <= 0) {
    sYaw = yaw; sPitch = pitch; sRoll = roll; smoothInit = true;
  } else {
    const k = 1 - Math.exp(-dt / SMOOTH_TAU_S);
    const dYaw = wrapDiff(yaw, sYaw);
    sYaw = wrap360(Math.abs(dYaw) > COMPASS_SNAP_DEG ? yaw : sYaw + k * dYaw);
    sPitch += k * (pitch - sPitch);
    const dRoll = wrapDiff(roll, sRoll);
    sRoll = wrap180(sRoll + k * dRoll);
  }

  // `ready` means the yaw is a compass heading. A relative-only stream (iOS compass absent / needing
  // calibration / phone outside the compass window, Android without a magnetometer) still publishes
  // for the HUD, but a canvas created from it would face an arbitrary direction on every client, so
  // the spray engine and discovery wait until an absolute heading has been applied at least once.
  publish({ yaw: sYaw, pitch: sPitch, roll: sRoll, ready: absolute || yawOffsetInit });
}

// ---- shake ---------------------------------------------------------------------------------------
function onMotion(e: DeviceMotionEvent) {
  const cb = shakeCb;
  if (!cb) return;
  let ax: number, ay: number, az: number;
  const ua = e.acceleration;
  if (ua && ua.x != null && ua.y != null && ua.z != null && Number.isFinite(ua.x) && Number.isFinite(ua.y) && Number.isFinite(ua.z)) {
    ax = ua.x; ay = ua.y; az = ua.z;
  } else {
    const ag = e.accelerationIncludingGravity;
    if (!ag || ag.x == null || ag.y == null || ag.z == null) return;
    if (!Number.isFinite(ag.x) || !Number.isFinite(ag.y) || !Number.isFinite(ag.z)) return;
    // no user-acceleration channel: low-pass gravity out of the raw accelerometer
    if (!gravityLP) gravityLP = [ag.x, ag.y, ag.z];
    else {
      gravityLP[0] += GRAVITY_LP_K * (ag.x - gravityLP[0]);
      gravityLP[1] += GRAVITY_LP_K * (ag.y - gravityLP[1]);
      gravityLP[2] += GRAVITY_LP_K * (ag.z - gravityLP[2]);
    }
    ax = ag.x - gravityLP[0]; ay = ag.y - gravityLP[1]; az = ag.z - gravityLP[2];
  }
  const mg = Math.hypot(ax, ay, az) / G;
  const t = eventSeconds(e);
  if (mg > SHAKE_ACCEL_THRESHOLD && t - lastShakeT > SHAKE_DEBOUNCE_S) {
    lastShakeT = t;
    try { cb(mg); } catch {}
  }
}

// ---- wiring --------------------------------------------------------------------------------------
function attach() {
  if (attached) return;
  attached = true;
  if ('ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', ((e: Event) => onOrientation(e as DeviceOrientationEvent, true)) as EventListener, true);
  }
  window.addEventListener('deviceorientation', (e) => onOrientation(e, false), true);
  window.addEventListener('devicemotion', onMotion, true);
}

type PermissionResult = 'granted' | 'denied' | 'n/a';
function requestPermissionOf(ctor: unknown): Promise<PermissionResult> {
  const fn = (ctor as { requestPermission?: () => Promise<unknown> }).requestPermission;
  if (typeof fn !== 'function') return Promise.resolve('n/a');
  try {
    return fn.call(ctor).then((r) => (r === 'granted' ? 'granted' : 'denied'), () => 'denied');
  } catch {
    return Promise.resolve('denied');
  }
}

/** Resolves once any orientation event has been published (the compass fix may come later). */
function waitForFirstEvent(ms: number): Promise<boolean> {
  if (gotEvent) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const unsub = subscribePose(() => {
      if (done) return;
      done = true; unsub(); clearTimeout(timer); resolve(true);
    });
    const timer = window.setTimeout(() => {
      if (done) return;
      done = true; unsub(); resolve(false);
    }, ms);
  });
}

async function doStart(): Promise<PoseStatus> {
  if (typeof window === 'undefined' || typeof DeviceOrientationEvent === 'undefined') {
    setSensorsMode('unsupported');
    return 'unsupported';
  }
  // iOS 13+: both prompts must be issued synchronously inside the user gesture — create both
  // promises before the first await.
  const orientationReq = requestPermissionOf(DeviceOrientationEvent);
  const motionReq = typeof DeviceMotionEvent !== 'undefined' ? requestPermissionOf(DeviceMotionEvent) : Promise.resolve<PermissionResult>('n/a');
  const o = await orientationReq;
  if (o === 'denied') {
    setSensorsMode('denied');
    return 'denied';
  }
  await motionReq; // motion denied only disables shake; the pose still works
  attach();
  const got = await waitForFirstEvent(FIRST_EVENT_TIMEOUT_MS);
  if (!got) setSensorsMode('none'); // listeners stay attached: a late-starting sensor still makes the pose ready
  return got ? 'granted' : 'unsupported';
}

/** Start the sensors. Must be invoked from a user gesture on iOS (permission prompts). Idempotent. */
export function startPose(opts: { onShake?: (magG: number) => void } = {}): Promise<PoseStatus> {
  if (opts.onShake) shakeCb = opts.onShake;
  if (startResult === 'granted') return Promise.resolve('granted');
  if (startPromise) return startPromise;
  startPromise = doStart()
    .catch((): PoseStatus => 'unsupported')
    .then((r) => { startResult = r; startPromise = null; return r; });
  return startPromise;
}

/** Latest pose — cheap, for rAF loops. */
export function getPose(): Pose {
  return pose;
}

export function subscribePose(fn: PoseListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** React state view of the pose, throttled to ≈ 20 Hz for HUD use. */
export function usePose(): Pose {
  const [p, setP] = useState<Pose>(() => pose);
  useEffect(() => {
    let last = 0;
    let timer: number | null = null;
    const push = () => { timer = null; last = performance.now(); setP(pose); };
    const unsub = subscribePose(() => {
      if (timer != null) return;
      const wait = HUD_INTERVAL_MS - (performance.now() - last);
      if (wait <= 0) push();
      else timer = window.setTimeout(push, wait);
    });
    // pick up anything published between render and subscribe, through the same throttle
    timer = window.setTimeout(push, 0);
    return () => {
      unsub();
      if (timer != null) clearTimeout(timer);
    };
  }, []);
  return p;
}
