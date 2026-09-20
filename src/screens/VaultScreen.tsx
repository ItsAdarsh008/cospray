import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import { Btn, Header, Panel, Pill, Screen, T } from '../ui/kit';
import { PixelBox } from '../ui/PixelBox';
import { PixelIcon } from '../ui/PixelIcon';
import { PieceImage } from '../ui/StrokeThumb';
import { C, F, ui } from '../ui/theme';
import { useStore } from '../store';
import { fetchAllCanvases, fetchPreviewStrokes } from '../data/sync';
import { timeAgo } from '../components/DiscoveryOverlay';
import { PieceDetail } from '../components/SpatialViewer';
import type { Canvas } from '../types';

export { PieceDetail };

const W = Dimensions.get('window').width;
const CELL = (W - 18 * 2 - 14) / 2;

/** Every wall you painted or added to. Tap one to walk around it in the 3D viewer. */
export function VaultScreen() {
  const me = useStore((s) => s.painter);
  const local = useStore((s) => s.canvases);
  const strokes = useStore((s) => s.strokes);
  const setTab = useStore((s) => s.setTab);
  const [remote, setRemote] = useState<Canvas[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Canvas | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try { const cs = await fetchAllCanvases(); setRemote(cs); fetchPreviewStrokes(cs.filter((c) => c.author_id === me?.id).map((c) => c.id)).catch(() => {}); } catch {}
    setLoading(false);
  }, [me?.id]);
  useEffect(() => { load(); }, [load]);

  const contributed = useMemo(() => {
    const set = new Set<string>();
    if (me) for (const [cid, ss] of Object.entries(strokes)) if (ss.some((s) => s.author_id === me.id)) set.add(cid);
    return set;
  }, [strokes, me?.id]);
  const mine = useMemo(() => {
    const m = new Map<string, Canvas>();
    for (const c of remote) m.set(c.id, c);
    for (const c of Object.values(local)) m.set(c.id, { ...m.get(c.id), ...c });
    return [...m.values()].filter((c) => !c.flagged && me && (c.author_id === me.id || contributed.has(c.id))).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }, [remote, local, me?.id, contributed]);
  const totals = mine.reduce((a, c) => ({ views: a.views + c.views, strokes: a.strokes + c.stroke_count }), { views: 0, strokes: 0 });

  return (
    <Screen tone="terminal" loading={loading} onRefresh={load}>
      <Header title="VAULT" sub={`${mine.length} walls · ${totals.views} views · ${totals.strokes} strokes`} right={<Pill icon="cube" value={mine.length} iconColor={C.phosphor} alt={C.phosDim} />} />
      {mine.length === 0 && (
        <Panel title="EMPTY VAULT">
          <T v="h">Nothing saved yet.</T>
          <T v="sub">Every wall you spray lands here, ready to walk around in 3D.</T>
          <Btn label="PAINT SOMETHING" icon="create" tone="green" onPress={() => setTab('create')} />
        </Panel>
      )}
      <View style={styles.grid}>
        {mine.map((c) => (
          <Pressable key={c.id} onPress={() => setOpen(c)}>
            <PixelBox n={6} depth={5} fill="#0f2a22" hi="#1d4a3a" lo="#0a1c17" style={{ width: CELL }} contentStyle={{ padding: 8, gap: 8 }}>
              <View>
                <PieceImage canvasId={c.id} width={CELL - 16} height={Math.round((CELL - 16) * 0.78)} />
                <View style={styles.badge}><PixelIcon name="cube" size={24} color={C.white} alt={C.phosphor} /></View>
              </View>
              <View style={{ gap: 2 }}>
                <Text style={styles.title} numberOfLines={1}>{c.title ?? timeAgo(c.created_at)}</Text>
                <Text style={styles.meta} numberOfLines={1}>{c.views} views · {c.stroke_count} strokes</Text>
                {c.author_id !== me?.id && <T v="label" color={C.phosphor} style={{ fontSize: 10.5 }}>CONTRIBUTED</T>}
              </View>
            </PixelBox>
          </Pressable>
        ))}
      </View>
      {open && <PieceDetail canvas={open} onClose={() => setOpen(null)} />}
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  badge: { position: 'absolute', right: 4, bottom: 4, backgroundColor: '#0a0620cc', padding: 2 },
  title: { fontFamily: F.display, fontSize: 17, color: '#fff' },
  meta: { ...ui(12.5, '500'), color: C.dim },
});
