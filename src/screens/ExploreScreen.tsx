import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Btn, Chip, Header, IconBtn, Panel, Pill, Rank, Screen, T } from '../ui/kit';
import { PixelBox } from '../ui/PixelBox';
import { PieceImage } from '../ui/StrokeThumb';
import { C, F, ui } from '../ui/theme';
import { useStore } from '../store';
import { fetchAllCanvases, fetchPreviewStrokes } from '../data/sync';
import { MOCK_CANVASES, isMock } from '../data/mock';
import { haversineM } from '../lib/geo';
import { timeAgo } from '../components/DiscoveryOverlay';
import { HeatMap } from '../components/HeatMap';
import { PieceDetail } from '../components/SpatialViewer';
import type { Canvas } from '../types';

type Filter = 'all' | 'fresh' | 'collab' | 'found' | 'mine';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'fresh', label: 'Fresh' }, { key: 'collab', label: 'Collab' }, { key: 'found', label: 'Found' }, { key: 'mine', label: 'Mine' },
];

/** Trending = most viewed pieces; Nearby = canvases within reach of your GPS fix; Hot zones = where the paint is. */
export function ExploreScreen() {
  const local = useStore((s) => s.canvases);
  const loc = useStore((s) => s.location);
  const discovered = useStore((s) => s.discovered);
  const me = useStore((s) => s.painter);
  const strokes = useStore((s) => s.strokes);
  const preview = useStore((s) => s.previewStrokes);
  const [remote, setRemote] = useState<Canvas[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Canvas | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const load = useCallback(async () => {
    setLoading(true);
    try { const cs = await fetchAllCanvases(); setRemote(cs); fetchPreviewStrokes(cs.slice(0, 20).map((c) => c.id)).catch(() => {}); } catch {}
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const all = useMemo(() => {
    const m = new Map<string, Canvas>();
    for (const c of remote) m.set(c.id, c);
    for (const c of Object.values(local)) m.set(c.id, { ...m.get(c.id), ...c });
    const real = [...m.values()].filter((c) => !c.flagged);
    return real.length ? real : MOCK_CANVASES; // stubs only when the wall is empty
  }, [remote, local]);
  const usingSamples = all === MOCK_CANVASES;

  const passes = useCallback((c: Canvas) => {
    if (filter === 'fresh') return Date.now() - new Date(c.updated_at).getTime() < 24 * 3600e3;
    if (filter === 'found') return !!discovered[c.id];
    if (filter === 'mine') return !!me && c.author_id === me.id;
    if (filter === 'collab') return new Set((strokes[c.id] ?? preview[c.id] ?? []).map((s) => s.author_name)).size >= 2;
    return true;
  }, [filter, discovered, me?.id, strokes, preview]);
  const shown = useMemo(() => all.filter(passes), [all, passes]);
  const trending = useMemo(() => [...shown].sort((a, b) => score(b) - score(a)).slice(0, 12), [shown]);
  const nearby = useMemo(() => {
    if (!loc) return [];
    return shown.map((c) => ({ c, d: haversineM(loc.lat, loc.lng, c.lat, c.lng) })).sort((a, b) => a.d - b.d).slice(0, 8);
  }, [shown, loc]);

  return (
    <Screen tone="terminal" loading={loading} onRefresh={load}>
      <Header title="EXPLORE" sub={usingSamples ? 'no pieces yet · showing sample spots' : `${all.length} walls across Waterloo`} right={<Pill icon="eye" value={all.reduce((a, c) => a + c.views, 0)} iconColor={C.phosphor} alt={C.phosDim} />} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 18 }} style={styles.bleed}>
        {FILTERS.map((f) => <Chip key={f.key} label={f.label} on={filter === f.key} onPress={() => setFilter(f.key)} />)}
      </ScrollView>

      <T v="label">TRENDING FRESCOS</T>
      {trending.length === 0 ? <T v="sub">Nothing matches this filter yet.</T> : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14, paddingRight: 18, paddingBottom: 6 }} style={styles.bleed}>
          {trending.map((c, i) => (
            <Pressable key={c.id} onPress={() => setOpen(c)}>
              <PixelBox n={6} depth={5} fill="#0f2a22" hi="#1d4a3a" lo="#0a1c17" style={{ width: 188 }} contentStyle={{ padding: 8, gap: 8 }}>
                <View>
                  <PieceImage canvasId={c.id} width={172} height={124} />
                  <View style={styles.rank}><Rank n={i + 1} /></View>
                </View>
                <View>
                  <Text style={styles.title} numberOfLines={1}>{c.title ?? `${c.author_name}'s piece`}</Text>
                  <Text style={styles.meta}>{c.views} views · {c.stroke_count} strokes</Text>
                </View>
              </PixelBox>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <Panel title="HOT ZONES" right={<T v="small">bigger glow = more paint</T>}>
        <View style={styles.mapFrame}><HeatMap canvases={all} height={190} /></View>
        <Btn label="OPEN MAP" icon="pin" tone="blue" size="sm" onPress={() => setMapOpen(true)} />
      </Panel>

      <T v="label">NEARBY CANVASES</T>
      {!loc && <T v="sub">waiting for GPS…</T>}
      {nearby.map(({ c, d }) => (
        <Pressable key={c.id} onPress={() => setOpen(c)}>
          <PixelBox n={6} depth={4} fill="#0f2a22" hi="#1d4a3a" lo="#0a1c17" contentStyle={styles.row}>
            <PieceImage canvasId={c.id} width={64} height={64} cell={2} />
            <View style={{ flex: 1 }}>
              <Text style={styles.title} numberOfLines={1}>{c.title ?? `${c.author_name}'s piece`}</Text>
              <Text style={styles.meta} numberOfLines={1}>{c.author_name} · {timeAgo(c.updated_at)} · {c.stroke_count} strokes</Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              <Text style={styles.dist}>{d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`}</Text>
              <T v="label" color={discovered[c.id] ? C.greenHi : isMock(c.id) ? C.faint : C.yellow} style={{ fontSize: 10.5 }}>{discovered[c.id] ? 'FOUND' : isMock(c.id) ? 'SAMPLE' : 'UNDISCOVERED'}</T>
            </View>
          </PixelBox>
        </Pressable>
      ))}
      {open && <PieceDetail canvas={open} onClose={() => setOpen(null)} />}
      <Modal visible={mapOpen} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setMapOpen(false)}>
        <View style={{ flex: 1, backgroundColor: '#03100b' }}>
          <HeatMap canvases={all} interactive />
          <View style={styles.mapTop}>
            <PixelBox fill="#160b36" depth={3} contentStyle={{ height: 40, paddingHorizontal: 12, justifyContent: 'center' }}><T v="label" color={C.white}>{all.length} WALLS · TAP A PIN</T></PixelBox>
            <IconBtn icon="x" onPress={() => setMapOpen(false)} />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

function score(c: Canvas) { const age = (Date.now() - new Date(c.updated_at).getTime()) / 3600e3; return (c.views + c.stroke_count * 2) / Math.pow(age + 2, 0.6); }

const styles = StyleSheet.create({
  bleed: { marginHorizontal: -18, paddingHorizontal: 18, flexGrow: 0 },
  rank: { position: 'absolute', left: 4, top: 4 },
  title: { fontFamily: F.display, fontSize: 17, color: '#fff' },
  meta: { ...ui(12.5, '500'), color: C.dim },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 8 },
  dist: { fontFamily: F.display, fontSize: 16, color: '#fff' },
  mapFrame: { borderWidth: 3, borderColor: C.ink },
  mapTop: { position: 'absolute', top: 56, left: 14, right: 14, flexDirection: 'row', justifyContent: 'space-between' },
});
