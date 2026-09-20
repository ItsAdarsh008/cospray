import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';

/**
 * All SFX are procedurally generated WAVs (scripts/gen_sfx.py) — no licensing, tiny, loopable.
 *  hiss: seamless loop, volume+rate driven by spray strength ("distance" proxy)
 *  rattle / emptyRattle: one-shots; click: nozzle press.
 */
class Sfx {
  private hiss?: AudioPlayer;
  private rattleP?: AudioPlayer;
  private emptyP?: AudioPlayer;
  private clickP?: AudioPlayer;
  private ready = false;
  enabled = true;
  private hissing = false;

  async init() {
    if (this.ready) return;
    try {
      await setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'mixWithOthers', shouldPlayInBackground: false });
    } catch {}
    this.hiss = createAudioPlayer(require('../../assets/sfx/hiss.wav'));
    this.hiss.loop = true;
    this.hiss.volume = 0;
    this.rattleP = createAudioPlayer(require('../../assets/sfx/rattle.wav'));
    this.emptyP = createAudioPlayer(require('../../assets/sfx/empty_rattle.wav'));
    this.clickP = createAudioPlayer(require('../../assets/sfx/click.wav'));
    this.ready = true;
  }

  private oneShot(p?: AudioPlayer, volume = 1, rate = 1) {
    if (!p || !this.enabled) return;
    try {
      p.volume = volume;
      p.setPlaybackRate(rate, 'low');
      p.seekTo(0).catch(() => {});
      p.play();
    } catch {}
  }

  click() { this.oneShot(this.clickP, 0.6, 0.9 + Math.random() * 0.2); }
  rattle(strength = 1) { this.oneShot(this.rattleP, 0.5 + 0.5 * strength, 0.9 + 0.3 * Math.random()); }
  emptyRattle() { this.oneShot(this.emptyP, 0.9, 1); }

  /** strength 0..1 (can charge × paint), near 0..1 (aim pitch proxy for distance to surface). */
  setHiss(on: boolean, strength: number, near: number) {
    const p = this.hiss;
    if (!p) return;
    if (!on || !this.enabled) {
      if (this.hissing) { p.volume = 0; p.pause(); this.hissing = false; }
      return;
    }
    try {
      if (!this.hissing) { p.play(); this.hissing = true; }
      p.volume = Math.min(1, 0.25 + 0.65 * strength);
      p.setPlaybackRate(0.85 + 0.3 * strength + 0.2 * near, 'low');
    } catch {}
  }
}

export const sfx = new Sfx();
