import { Platform } from 'react-native';
import { ExtensionStorage } from '@bacons/apple-targets';
import { useStore } from '../store';
import { PAINT_MAX, PAINT_REGEN_PER_SEC } from '../config';
import { colorName } from './economy';

/** Mirrors paint levels into the App Group so the home-screen widget (targets/widget) can show the can. */
const APP_GROUP = 'group.com.hamzakhan.tagged';
let storage: ExtensionStorage | null = null;
let last = '';
let timer: ReturnType<typeof setTimeout> | null = null;

export function startWidgetSync() {
  if (Platform.OS !== 'ios') return () => {};
  try { storage = new ExtensionStorage(APP_GROUP); } catch { return () => {}; }
  const push = () => {
    const st = useStore.getState();
    const snap = {
      paintA: Math.round(st.paint.A), paintB: Math.round(st.paint.B), shake: Math.round(st.shake * 100),
      colorA: st.settings.optionA.color, colorB: st.settings.optionB.color, nameA: colorName(st.settings.optionA.color), nameB: colorName(st.settings.optionB.color),
      tag: st.painter?.name ?? 'FRESCO', strokes: st.painter?.strokes ?? 0, paintUsed: Math.round(st.painter?.paint_used ?? 0),
      // when each can is full again at the in-app regen rate (unix seconds; widget shows a countdown)
      refillAtA: Math.floor(Date.now() / 1000 + (PAINT_MAX - st.paint.A) / PAINT_REGEN_PER_SEC),
      refillAtB: Math.floor(Date.now() / 1000 + (PAINT_MAX - st.paint.B) / PAINT_REGEN_PER_SEC),
      streak: streakDays(st),
    };
    const key = JSON.stringify({ ...snap, refillAtA: Math.round(snap.refillAtA / 5), refillAtB: Math.round(snap.refillAtB / 5) });
    if (key === last) return;
    last = key;
    try {
      storage!.set('paintA', snap.paintA); storage!.set('paintB', snap.paintB); storage!.set('shake', snap.shake);
      storage!.set('colorA', snap.colorA); storage!.set('colorB', snap.colorB); storage!.set('tag', snap.tag);
      storage!.set('nameA', snap.nameA); storage!.set('nameB', snap.nameB); storage!.set('strokes', snap.strokes); storage!.set('paintUsed', snap.paintUsed);
      storage!.set('refillAtA', snap.refillAtA); storage!.set('refillAtB', snap.refillAtB); storage!.set('streak', snap.streak);
      storage!.set('updatedAt', Math.floor(Date.now() / 1000));
      ExtensionStorage.reloadWidget();
    } catch {}
  };
  // paint changes 30×/s while spraying; the widget only needs a few updates a minute
  const unsub = useStore.subscribe(() => { if (!timer) timer = setTimeout(() => { timer = null; push(); }, 3000); });
  push();
  return () => { unsub(); if (timer) clearTimeout(timer); };
}

/** Consecutive days (ending today) with at least one of your strokes in the local cache. */
export function streakDays(st: ReturnType<typeof useStore.getState>) {
  const me = st.painter?.id; if (!me) return 0;
  const days = new Set<string>();
  for (const ss of Object.values(st.strokes)) for (const s of ss) if (s.author_id === me) days.add(s.created_at.slice(0, 10));
  let n = 0; const d = new Date();
  while (days.has(d.toISOString().slice(0, 10))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
