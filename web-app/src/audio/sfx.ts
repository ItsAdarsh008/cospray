/**
 * Spray-can sound effects on Web Audio (port of ../../../src/audio/sfx.ts).
 * All SFX are procedurally generated WAVs (native repo: scripts/gen_sfx.py), copied to /public/sfx.
 *  hiss: seamless loop, volume + playbackRate driven by spray strength ("distance" proxy)
 *  rattle / emptyRattle: one-shots; pool: one-shot; click: nozzle press.
 *
 * `init()` must run from a user gesture (creates + resumes the AudioContext, then fetches and
 * decodes the buffers). Every method is a no-op — never a throw — when audio is unavailable.
 */
type Name = 'hiss' | 'rattle' | 'empty_rattle' | 'pool' | 'click';
const NAMES: Name[] = ['hiss', 'rattle', 'empty_rattle', 'pool', 'click'];

const HISS_FADE_S = 0.03;   // ramp time-constant for gain / rate changes on the loop
const HISS_STOP_S = 0.06;   // loop keeps running this long while its gain fades out
const FETCH_TIMEOUT_MS = 8000; // a stalled download must never pin init(); sound is optional

type AudioContextCtor = new (opts?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  try {
    const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
    return w.AudioContext ?? w.webkitAudioContext ?? null;
  } catch {
    return null;
  }
}

function decode(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  // callback form works on every engine (old Safari has no promise-returning decodeAudioData)
  return new Promise((resolve, reject) => {
    try {
      const maybe = ctx.decodeAudioData(data, resolve, reject);
      if (maybe && typeof (maybe as Promise<AudioBuffer>).then === 'function') (maybe as Promise<AudioBuffer>).then(resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

class Sfx {
  enabled = true;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers: Partial<Record<Name, AudioBuffer>> = {};
  private oneShots: Partial<Record<Name, AudioBufferSourceNode>> = {};
  private hissSrc: AudioBufferSourceNode | null = null;
  private hissGain: GainNode | null = null;
  private hissing = false;
  private initPromise: Promise<void> | null = null;

  /** Call from a user gesture (the Start gate / first HOLD). Safe to call repeatedly. */
  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit().catch(() => {});
    else this.resumeIfNeeded(); // a later gesture re-resumes a context iOS suspended/interrupted
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      try { ctx = new Ctor(); } catch { return; }
    }
    this.ctx = ctx;
    try { await ctx.resume(); } catch {}
    try {
      const master = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
      this.master = master;
    } catch {
      return;
    }
    const base = import.meta.env.BASE_URL ?? '/';
    await Promise.all(NAMES.map(async (name) => {
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ac ? setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS) : null;
      try {
        const res = await fetch(`${base}sfx/${name}.wav`, ac ? { signal: ac.signal } : undefined);
        if (!res.ok) return;
        const data = await res.arrayBuffer();
        this.buffers[name] = await decode(ctx, data);
      } catch {} finally {
        if (timer != null) clearTimeout(timer);
      }
    }));
  }

  private resumeIfNeeded() {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
    } catch {}
  }

  /** Same semantics as the native single-player one-shots: retriggering restarts the sound. */
  private oneShot(name: Name, volume: number, rate: number) {
    if (!this.enabled) return;
    const ctx = this.ctx, master = this.master, buf = this.buffers[name];
    if (!ctx || !master || !buf) return;
    try {
      this.resumeIfNeeded();
      const prev = this.oneShots[name];
      if (prev) {
        try { prev.stop(); } catch {}
        try { prev.disconnect(); } catch {}
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const gain = ctx.createGain();
      gain.gain.value = Math.max(0, Math.min(1, volume));
      src.connect(gain);
      gain.connect(master);
      src.onended = () => {
        try { src.disconnect(); } catch {}
        try { gain.disconnect(); } catch {}
        if (this.oneShots[name] === src) delete this.oneShots[name];
      };
      this.oneShots[name] = src;
      src.start();
    } catch {}
  }

  click() { this.oneShot('click', 0.6, 0.9 + Math.random() * 0.2); }
  rattle(strength = 1) { this.oneShot('rattle', 0.5 + 0.5 * strength, 0.9 + 0.3 * Math.random()); }
  emptyRattle() { this.oneShot('empty_rattle', 0.9, 1); }
  pool() { this.oneShot('pool', 0.8, 0.85 + Math.random() * 0.3); }

  /** strength 0..1 (can charge × paint), near 0..1 (aim pitch proxy for distance to surface). */
  setHiss(on: boolean, strength: number, near: number) {
    const ctx = this.ctx, master = this.master, buf = this.buffers.hiss;
    if (!ctx || !master || !buf) return;
    try {
      if (!on || !this.enabled) {
        if (this.hissing) this.stopHiss();
        return;
      }
      const t = ctx.currentTime;
      if (!this.hissing) {
        this.resumeIfNeeded();
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.connect(master);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.connect(gain);
        src.start();
        this.hissSrc = src;
        this.hissGain = gain;
        this.hissing = true;
      }
      const src = this.hissSrc, gain = this.hissGain;
      if (!src || !gain) return;
      const volume = Math.min(1, 0.25 + 0.65 * strength);
      const rate = 0.85 + 0.3 * strength + 0.2 * near;
      gain.gain.setTargetAtTime(volume, t, HISS_FADE_S);
      src.playbackRate.setTargetAtTime(rate, t, HISS_FADE_S);
    } catch {}
  }

  private stopHiss() {
    const ctx = this.ctx, src = this.hissSrc, gain = this.hissGain;
    this.hissSrc = null;
    this.hissGain = null;
    this.hissing = false;
    if (!ctx || !src || !gain) return;
    try {
      const t = ctx.currentTime;
      gain.gain.setTargetAtTime(0, t, HISS_FADE_S / 2);
      src.stop(t + HISS_STOP_S);
      src.onended = () => {
        try { src.disconnect(); } catch {}
        try { gain.disconnect(); } catch {}
      };
    } catch {
      try { src.stop(); } catch {}
      try { src.disconnect(); } catch {}
      try { gain.disconnect(); } catch {}
    }
  }
}

export const sfx = new Sfx();
