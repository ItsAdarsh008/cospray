/** '#rrggbb' -> [r,g,b] */
export function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})/i.exec(hex);
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const h2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
/** Mix colour a toward b by t (0..1). */
export function mix(a: string, b: string, t: number) {
  const A = rgb(a), B = rgb(b);
  return `#${h2(A[0] + (B[0] - A[0]) * t)}${h2(A[1] + (B[1] - A[1]) * t)}${h2(A[2] + (B[2] - A[2]) * t)}`;
}
export const lighten = (c: string, t = 0.35) => mix(c, '#ffffff', t);
export const darken = (c: string, t = 0.35) => mix(c, '#000000', t);
/** True for colours light enough to need dark text/marks on top. */
export const isLight = (hex: string) => { const [r, g, b] = rgb(hex); return 0.299 * r + 0.587 * g + 0.114 * b > 150; };
