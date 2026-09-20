export const R_EARTH = 6371000;
const d2r = Math.PI / 180;

export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const dLat = (lat2 - lat1) * d2r;
  const dLng = (lng2 - lng1) * d2r;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

/** Compass bearing (0..360, clockwise from north) from point 1 to point 2. */
export function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number) {
  const φ1 = lat1 * d2r, φ2 = lat2 * d2r, Δλ = (lng2 - lng1) * d2r;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return wrap360((Math.atan2(y, x) * 180) / Math.PI);
}

export function wrap360(a: number) {
  return ((a % 360) + 360) % 360;
}
/** Signed shortest angular difference a-b in (-180, 180]. */
export function wrapDiff(a: number, b: number) {
  let d = ((a - b + 180) % 360 + 360) % 360 - 180;
  return d;
}
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
