import { useCallback, useEffect, useRef, useState } from 'react';
import { PALETTE, PAINT_EMPTY_THRESHOLD, PAINT_MAX, PAINT_REGEN_PER_SEC, SHAKE_MIN_TO_SPRAY, type Cap } from '../config';
import { useStore } from '../store';
import type { Blocker, Side } from '../types';

/**
 * Web port of the phone's Create HUD (../../src/components/HUD.tsx): the same pixel-arcade
 * furniture — a charge rail down the left, status plates stacked under it, and two chunky
 * hold-to-spray buttons with a tools button beside them. Reanimated becomes CSS animation and
 * Pressable becomes pointer events; the pixel "boxes" are the .px-box class in styles.css.
 */

export function Reticle({ spraying, offWall = false }: { spraying: boolean; offWall?: boolean }) {
  return (
    <div className="reticle-wrap">
      <div className={`reticle${spraying ? ' on' : ''}${offWall ? ' off' : ''}`}>
        <span className="reticle-arm t" />
        <span className="reticle-arm r" />
        <span className="reticle-arm b" />
        <span className="reticle-arm l" />
        <div className="reticle-dot" />
      </div>
    </div>
  );
}

/** Can charge as a slim rail down the left edge — shake to refill, like the phone's. */
export function CanMeter() {
  const shake = useStore((s) => s.shake);
  const low = shake < SHAKE_MIN_TO_SPRAY;
  const segs = 8;
  const lit = Math.round(Math.max(0, Math.min(1, shake)) * segs);
  return (
    <div className="charge px-box" aria-hidden="true">
      <div className={`charge-can${low ? ' wobble' : ''}`} />
      <div className="charge-bar">
        {Array.from({ length: segs }, (_, i) => (
          <span key={i} className={segs - 1 - i < lit ? 'seg on' : 'seg'} />
        ))}
      </div>
      <div className="charge-text">{low ? 'SHAKE' : `${Math.round(shake * 100)}%`}</div>
    </div>
  );
}

const BLOCKER_MSG: Record<Exclude<Blocker, null>, { title: string; sub?: string }> = {
  'no-location': { title: 'WAITING FOR GPS' },
  'outside-geofence': { title: 'OUTSIDE THE PAINT ZONE', sub: 'WATERLOO REGION ONLY' },
  shake: { title: 'SHAKE TO CHARGE', sub: 'THEN HOLD A COLOUR' },
  empty: { title: 'OUT OF PAINT', sub: 'IT REFILLS ON ITS OWN' },
  'no-sensors': { title: 'NO COMPASS YET', sub: 'ALLOW MOTION ACCESS AND MOVE THE PHONE' },
};
const NO_COMPASS_FIX_MSG = { title: 'NO COMPASS FIX YET', sub: 'HOLD IT UPRIGHT AND MOVE IN A FIGURE-8' };

/** One status plate. The phone stacks these in the middle of the screen; so do we. */
export function Line({ title, sub, tone }: { title: string; sub?: string; tone?: 'warn' }) {
  return (
    <div className={`hud-line px-box${tone === 'warn' ? ' warn' : ''}`} role="status">
      <div className="hud-line-title">{title}</div>
      {sub ? <div className="hud-line-sub">{sub}</div> : null}
    </div>
  );
}

export function BlockerBanner({ blocker }: { blocker: Blocker }) {
  const sensors = useStore((s) => s.debug.sensors);
  if (!blocker) return null;
  const msg = blocker === 'no-sensors' && sensors === 'relative' ? NO_COMPASS_FIX_MSG : BLOCKER_MSG[blocker];
  return <Line title={msg.title} sub={msg.sub} tone="warn" />;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Where the wall you're painting on actually is. Walls stand at the place they were painted, so
 * "3 m ahead" and "walk 12 m" are the difference between spraying onto a piece and spraying into
 * the air — the phone gets this from AR tracking, here it comes from GPS.
 */
export function WallChip({ state }: { state: { kind: 'on' | 'walk' | 'new'; metres?: number; who?: string } }) {
  const m = state.metres == null ? null : `${Math.round(state.metres)} M`;
  if (state.kind === 'on') return <Line title={`ON ${(state.who ?? 'THIS').toUpperCase()}${state.who ? "'S" : ''} WALL`} sub={m ? `${m} AHEAD` : undefined} />;
  if (state.kind === 'walk') return <Line title={`A PIECE IS ${m ?? 'NEARBY'} AWAY`} sub="WALK TO IT — IT STAYS WHERE IT WAS PAINTED" />;
  return <Line title="NO WALL HERE YET" sub="SPRAY TO START ONE WHERE YOU STAND" />;
}

/** The in-camera tools: a colour for each hold button and the cap, as on the phone's Create tab. */
export function ToolsTray({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const row = (key: 'optionA' | 'optionB') => (
    <div className="tools-row" key={key}>
      <div className="tools-label">{key === 'optionA' ? 'HOLD A' : 'HOLD B'}</div>
      <div className="tools-swatches">
        {PALETTE.map((c) => (
          <button
            key={c} type="button" aria-label={c} aria-pressed={settings[key].color === c}
            className={`tools-swatch${settings[key].color === c ? ' on' : ''}`}
            style={{ backgroundColor: c }}
            onClick={() => setSettings({ [key]: { ...settings[key], color: c } })}
          />
        ))}
      </div>
      <div className="tools-caps">
        {(['fat', 'skinny'] as Cap[]).map((cap) => (
          <button
            key={cap} type="button" aria-pressed={settings[key].cap === cap}
            className={`tools-cap${settings[key].cap === cap ? ' on' : ''}`}
            onClick={() => setSettings({ [key]: { ...settings[key], cap } })}
          >{cap.toUpperCase()}</button>
        ))}
      </div>
    </div>
  );
  return (
    <div className="tools-tray px-box">
      {row('optionA')}
      {row('optionB')}
      <button type="button" className="tools-done" onClick={onClose}>DONE</button>
    </div>
  );
}

/**
 * Two big hold-to-spray buttons and the tools button, as on the phone: each carries its colour
 * swatch, the paint left as a fill behind the label, and a refill countdown when it runs dry.
 * Pointer events cover touch, mouse and pen; ArrowUp / ArrowDown hold on a keyboard for desktop
 * testing. Everything releases if the page hides or loses focus so a stroke can't get stuck on.
 */
export function HoldButtons({ onStart, onEnd, keyboard = true, onTools }: {
  onStart: (s: Side) => void; onEnd: (s: Side) => void; keyboard?: boolean; onTools?: () => void;
}) {
  const settings = useStore((s) => s.settings);
  const paint = useStore((s) => s.paint);
  const [pressed, setPressed] = useState<Record<Side, boolean>>({ A: false, B: false });
  const cbs = useRef({ onStart, onEnd });
  useEffect(() => { cbs.current = { onStart, onEnd }; });
  const press = useCallback((side: Side, on: boolean) => {
    setPressed((p) => (p[side] === on ? p : { ...p, [side]: on }));
    if (on) cbs.current.onStart(side); else cbs.current.onEnd(side);
  }, []);

  useEffect(() => {
    if (!keyboard) return;
    const sideOf = (e: KeyboardEvent): Side | null => (e.key === 'ArrowUp' ? 'A' : e.key === 'ArrowDown' ? 'B' : null);
    const down = (e: KeyboardEvent) => { const s = sideOf(e); if (!s) return; e.preventDefault(); if (!e.repeat) press(s, true); };
    const up = (e: KeyboardEvent) => { const s = sideOf(e); if (!s) return; e.preventDefault(); press(s, false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [keyboard, press]);

  useEffect(() => {
    const release = () => { press('A', false); press('B', false); };
    const onVis = () => { if (document.visibilityState !== 'visible') release(); };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', onVis);
    return () => { window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', onVis); release(); };
  }, [press]);

  return (
    <div className="hold-row">
      {(['A', 'B'] as Side[]).map((side) => {
        const opt = side === 'A' ? settings.optionA : settings.optionB;
        const left = paint[side];
        const pct = Math.round((left / PAINT_MAX) * 100);
        const empty = left <= PAINT_EMPTY_THRESHOLD;
        const sub = empty ? `REFILL ${mmss(Math.ceil((PAINT_MAX - left) / PAINT_REGEN_PER_SEC))}` : `${pct}%`;
        return (
          <button
            key={side}
            type="button"
            className={`hold-btn px-box${pressed[side] ? ' pressed' : ''}`}
            aria-label={`Hold to spray option ${side} (${opt.name})`}
            onPointerDown={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); press(side, true); }}
            onPointerUp={() => press(side, false)}
            onPointerCancel={() => press(side, false)}
            onPointerLeave={() => press(side, false)}
            onContextMenu={(e) => e.preventDefault()}
          >
            <span className="hold-fill" style={{ width: `${pct}%`, backgroundColor: opt.color }} aria-hidden="true" />
            <span className="hold-swatch" style={{ backgroundColor: opt.color }} aria-hidden="true" />
            <span className="hold-text">
              <span className="hold-name">{opt.name.toUpperCase()}</span>
              <span className="hold-sub">{sub}</span>
            </span>
          </button>
        );
      })}
      {onTools ? (
        <button type="button" className="tools-btn px-box" aria-label="Colours and settings" onClick={onTools}>
          <span className="tools-glyph" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
