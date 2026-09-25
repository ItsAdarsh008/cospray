/**
 * Compact binary encoding of a stroke's dabs (strokes.points_bin, format 1).
 *
 * A dab is [u, v, radius, alpha, kind]: metres on an AR quad, or degrees on a compass canvas. As
 * jsonb each one cost ~90 bytes (five doubles printed at full precision), and a phone records
 * ~30–60 a second while spraying. Here each field is quantised to a fixed step, delta-coded
 * against the previous dab and written as a zigzag varint. Consecutive dabs sit millimetres apart
 * with the same radius and alpha, so a dab is typically 4–6 bytes.
 *
 *   byte 0      format (1)
 *   byte 1      flags: bit 0 = a kind byte follows each dab (only strokes from old builds have drips)
 *   varint      dab count
 *   per dab     zz(du) zz(dv) zz(dr) zz(da) [kind]
 *
 * Steps: u, v = 0.001 (1 mm / 0.001°), radius = 0.0001 (0.1 mm), alpha = 0.001. Replay is seeded by
 * stroke id, so a decoded stroke paints the same dabs everywhere; the painter's own phone keeps the
 * unrounded values, which differ by under half a millimetre.
 *
 * web/src/lib/strokeCodec.ts is a copy of this file. Keep them identical.
 */
export const POINTS_FORMAT = 1;
const STEP = [1000, 1000, 10000, 1000];

// Arithmetic rather than bit operators: `|` and `>>` truncate to 32 bits, and a compass yaw in
// millidegrees delta-coded from 0 is fine, but nothing here should depend on that staying true.
function zig(n: number) { return n >= 0 ? n * 2 : -n * 2 - 1; }
function unzig(n: number) { return n % 2 === 0 ? n / 2 : -(n + 1) / 2; }

export function encodePoints(points: readonly (readonly number[])[]): Uint8Array {
  const hasKind = points.some((p) => (p[4] ?? 0) !== 0);
  const out: number[] = [POINTS_FORMAT, hasKind ? 1 : 0];
  const varint = (v: number) => {
    while (v >= 128) { out.push((v % 128) + 128); v = Math.floor(v / 128); }
    out.push(v);
  };
  varint(points.length);
  const prev = [0, 0, 0, 0];
  for (const p of points) {
    for (let i = 0; i < 4; i++) {
      const q = Math.round((Number.isFinite(p[i]) ? p[i] : 0) * STEP[i]);
      varint(zig(q - prev[i]));
      prev[i] = q;
    }
    if (hasKind) out.push(Math.max(0, Math.min(255, Math.round(p[4] ?? 0))));
  }
  return Uint8Array.from(out);
}

/** Throws on a truncated or unknown buffer; callers treat that stroke as empty. */
export function decodePoints(buf: Uint8Array): number[][] {
  if (buf.length < 3 || buf[0] !== POINTS_FORMAT) throw new Error(`unknown points format ${buf[0]}`);
  const hasKind = (buf[1] & 1) === 1;
  let at = 2;
  const varint = () => {
    let v = 0, mul = 1;
    for (;;) {
      if (at >= buf.length) throw new Error('truncated points');
      const b = buf[at++];
      v += (b % 128) * mul;
      if (b < 128) return v;
      mul *= 128;
    }
  };
  const n = varint();
  const out: number[][] = new Array(n);
  const acc = [0, 0, 0, 0];
  for (let k = 0; k < n; k++) {
    const p = [0, 0, 0, 0, 0];
    for (let i = 0; i < 4; i++) { acc[i] += unzig(varint()); p[i] = acc[i] / STEP[i]; }
    if (hasKind) { if (at >= buf.length) throw new Error('truncated points'); p[4] = buf[at++]; }
    out[k] = p;
  }
  return out;
}

// PostgREST (and Realtime) carry bytea as a "\x0a1b…" hex string, both ways.
const HEX = '0123456789abcdef';
export function toBytea(buf: Uint8Array): string {
  let s = '\\x';
  for (let i = 0; i < buf.length; i++) s += HEX[buf[i] >> 4] + HEX[buf[i] & 15];
  return s;
}
export function fromBytea(v: unknown): Uint8Array | null {
  if (typeof v !== 'string' || !v.startsWith('\\x') || v.length % 2 !== 0) return null;
  const out = new Uint8Array((v.length - 2) / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(v.substr(2 + i * 2, 2), 16);
    if (Number.isNaN(b)) return null;
    out[i] = b;
  }
  return out;
}

/**
 * A strokes row as it comes off the wire (select, realtime, or a cached/queued row), with `points`
 * filled in from whichever format it was stored in. Rows written before the binary format keep
 * their jsonb `points`; newer rows have `points: null` and `points_bin`.
 */
export function withPoints<T extends { points?: unknown; points_bin?: unknown }>(row: T): T & { points: number[][] } {
  if (Array.isArray(row.points)) return row as T & { points: number[][] };
  const bin = fromBytea(row.points_bin);
  let points: number[][] = [];
  if (bin) { try { points = decodePoints(bin); } catch (e) { console.warn('undecodable stroke points', e); } }
  return { ...row, points, points_bin: null }; // decoded: don't keep the hex copy around as well
}

/** The wire shape of a stroke's dabs: binary only, jsonb left null. */
export function wirePoints(points: readonly (readonly number[])[]) {
  return { points: null, points_bin: toBytea(encodePoints(points)), points_v: POINTS_FORMAT };
}
