import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dimensions, Share, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { makeImageFromView } from '@shopify/react-native-skia';
import { File, Paths } from 'expo-file-system';
import { Avatar, Btn, Chip, Header, Panel, Pill, Rank, Screen, T, Tile } from '../ui/kit';
import { PixelBox } from '../ui/PixelBox';
import { PixelIcon } from '../ui/PixelIcon';
import { PieceImage } from '../ui/StrokeThumb';
import { C, F, TONES, outline, ui } from '../ui/theme';
import { useStore } from '../store';
import { MOCK_ACTIVITY, MOCK_FRIENDS } from '../data/mock';
import { fetchLeaderboard } from '../data/sync';
import { CREWS, colorName, dayStats } from '../lib/economy';
import { PALETTE } from '../config';
import type { Painter } from '../types';

const CARD_W = Dimensions.get('window').width - 36;
const hueOf = (name: string) => PALETTE[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % (PALETTE.length - 1)];

/** Share card (Airbuds layout, real numbers), a live leaderboard, your crew, and sample friends. */
export function SocialScreen() {
  const painter = useStore((s) => s.painter);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const strokes = useStore((s) => s.strokes);
  const canvases = useStore((s) => s.canvases);
  const discovered = useStore((s) => s.discovered);
  const cardRef = useRef<View>(null);
  const [sharing, setSharing] = useState(false);
  const [board, setBoard] = useState<Painter[]>([]);
  const [loading, setLoading] = useState(false);
  const loadBoard = useCallback(async () => { setLoading(true); try { setBoard(await fetchLeaderboard()); } catch {} setLoading(false); }, []);
  useEffect(() => { loadBoard(); }, [loadBoard]);

  const mine = useMemo(() => Object.values(strokes).flat().filter((s) => s.author_id === painter?.id), [strokes, painter?.id]);
  const found = Object.keys(discovered).length;
  const stats = useMemo(() => dayStats(mine, painter?.id), [mine, painter?.id]);
  const topWalls = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of mine) m.set(s.canvas_id, (m.get(s.canvas_id) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  }, [mine]);
  const topColors = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of mine) m.set(s.color, (m.get(s.color) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  }, [mine]);
  const crew = CREWS.find((c) => c.id === settings.crew);

  const share = async () => {
    setSharing(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    const msg = `My Fresco week · ${painter?.name ?? 'anon'} · ${Math.round(painter?.paint_used ?? 0)} paint sprayed`;
    try {
      const img = await makeImageFromView(cardRef);
      if (!img) throw new Error('snapshot failed');
      const f = new File(Paths.cache, 'fresco-card.png');
      f.write(img.encodeToBytes());
      await Share.share({ url: f.uri, message: msg });
    } catch { await Share.share({ message: `${msg} · ${found} walls found` }).catch(() => {}); }
    setSharing(false);
  };

  return (
    <Screen tone="magenta" loading={loading} onRefresh={loadBoard}>
      <Header title="SOCIAL" right={<Pill icon="flame" value={stats.streak} iconColor={C.orange} alt="#ffd21f" />} />

      {/* the shareable card: this exact view is snapshotted to a PNG */}
      <View style={styles.cardShadow}>
        <View ref={cardRef} collapsable={false} style={styles.card}>
          <LinearGradient colors={['#6a1a78', '#2a0d3f', '#150626']} locations={[0, 0.42, 1]} style={StyleSheet.absoluteFill} />
          <Text style={styles.big}>top walls</Text>
          <LinearGradient colors={['#2a0d3f00', '#2a0d3f']} style={styles.fade} pointerEvents="none" />
          <View style={styles.pills}>
            {[0, 1, 2].map((i) => {
              const w = topWalls[i];
              const c = w ? canvases[w[0]] : null;
              return (
                <View key={i} style={{ flex: 1, alignItems: 'center', gap: 6 }}>
                  <View style={styles.pill}>
                    {w ? <PieceImage canvasId={w[0]} width={PILL_W} height={PILL_H} radius={PILL_W / 2} /> : <View style={styles.pillEmpty}><Text style={styles.q}>?</Text></View>}
                    <View style={styles.badge}><Text style={styles.badgeText}>{i + 1}</Text></View>
                  </View>
                  <Text style={styles.cap} numberOfLines={1}>{w ? (c?.title ?? 'a wall') : 'paint more'}</Text>
                </View>
              );
            })}
          </View>
          <Text style={[styles.big, { marginTop: 4 }]}>on repeat</Text>
          <LinearGradient colors={['#15062600', '#150626']} style={styles.fade2} pointerEvents="none" />
          <View style={styles.pills}>
            {[0, 1, 2].map((i) => {
              const col = topColors[i];
              return (
                <View key={i} style={{ flex: 1, alignItems: 'center', gap: 6 }}>
                  <View style={[styles.sq, { backgroundColor: col ? col[0] : '#2b2059' }]}>{!col && <Text style={styles.q}>?</Text>}</View>
                  <View style={styles.times}><Text style={styles.timesText}>{col ? `${col[1]} times` : '—'}</Text></View>
                  <Text style={styles.cap} numberOfLines={1}>{col ? colorName(col[0]).toLowerCase() : 'no colour'}</Text>
                </View>
              );
            })}
          </View>
          <View style={styles.tiles}>
            <Tile n={painter?.strokes ?? 0} label="strokes" big />
            <Tile n={Math.round(painter?.paint_used ?? 0)} label="paint sprayed" big />
            <Tile n={found} label="walls found" big />
          </View>
          <View style={styles.foot}>
            <View>
              <Text style={styles.footName}>{painter?.name ?? 'anon'}</Text>
              <Text style={styles.footSub}>{crew ? crew.name.toLowerCase() : 'this week on the wall'}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.footSub}>join me on</Text>
              <Text style={styles.footBrand}>fresco</Text>
            </View>
          </View>
        </View>
      </View>
      <Btn label={sharing ? '…' : 'SHARE TO STORY'} icon="share" tone="green" size="lg" disabled={sharing} onPress={share} />

      <Podium rows={board} me={painter?.id} />

      <Panel title="YOUR CREW">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <PixelIcon name="flag" size={24} color={C.yellow} />
          <View style={{ flex: 1 }}>
            <T v="h">{crew?.name ?? 'NO CREW YET'}</T>
            <T v="small">{crew ? crew.blurb : 'pick one to rep it on your card'} · saved on this phone</T>
          </View>
        </View>
        <View style={styles.chips}>
          {CREWS.map((c) => <Chip key={c.id} label={c.name} on={settings.crew === c.id} onPress={() => setSettings({ crew: settings.crew === c.id ? null : c.id })} />)}
        </View>
      </Panel>

      <Panel title="FRIENDS" right={<T v="label" color={C.faint}>SAMPLE DATA</T>}>
        {MOCK_FRIENDS.map((f) => (
          <View key={f.id} style={styles.friend}>
            <Avatar name={f.name} color={f.color} size={38} />
            <View style={{ flex: 1 }}>
              <T v="body" style={{ fontWeight: '700' }}>{f.name}</T>
              <T v="small">{f.status}</T>
            </View>
            <T v="label" color={f.online ? C.greenHi : C.faint}>{f.online ? 'ONLINE' : 'AWAY'}</T>
            {f.streak > 0 && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}><PixelIcon name="flame" size={24} color={C.orange} alt={C.yellow} /><Text style={styles.streak}>{f.streak}</Text></View>}
          </View>
        ))}
      </Panel>
      <Panel title="ACTIVITY" right={<T v="label" color={C.faint}>SAMPLE DATA</T>}>
        {MOCK_ACTIVITY.map((a) => (
          <View key={a.id} style={styles.friend}>
            <T v="small" style={{ flex: 1 }}><Text style={{ fontWeight: '700', color: '#fff' }}>{a.who}</Text> {a.what}</T>
            <T v="small">{a.when}</T>
          </View>
        ))}
      </Panel>
      <T v="small" style={{ textAlign: 'center' }}>friends and crews will sync once the backend supports them</T>
    </Screen>
  );
}

/** Kahoot-style podium: 1st in the middle on the tallest block, then a ranked list. Live from Supabase. */
function Podium({ rows, me }: { rows: Painter[]; me?: string }) {
  const [first, second, third] = rows;
  const col = (p: Painter | undefined, place: 1 | 2 | 3) => {
    const h = place === 1 ? 96 : place === 2 ? 68 : 52;
    const t = TONES[place === 1 ? 'yellow' : place === 2 ? 'white' : 'red'];
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
        {p ? (
          <>
            {place === 1 && <PixelIcon name="crown" size={24} color={C.yellow} alt="#c48f00" />}
            <Avatar name={p.name} color={hueOf(p.name)} size={place === 1 ? 52 : 44} />
            <Text style={styles.pName} numberOfLines={1}>{p.name}</Text>
            <Text style={styles.pPaint}>{Math.round(p.paint_used)}</Text>
          </>
        ) : <Text style={styles.pPaint}>—</Text>}
        <PixelBox fill={t.fill} hi={t.hi} lo={t.lo} depth={4} style={{ width: '100%' }} contentStyle={{ height: h, alignItems: 'center', paddingTop: 8 }}>
          <Text style={{ fontFamily: F.display, fontSize: 28, color: place === 3 ? '#fff' : '#2a1a00' }}>{place}</Text>
        </PixelBox>
      </View>
    );
  };
  return (
    <Panel title="TOP PAINTERS" tone="purple" right={<T v="label" color="#fff">LIVE</T>}>
      {rows.length === 0 ? <T v="sub">No painters yet. Go tag something.</T> : (
        <>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>{col(second, 2)}{col(first, 1)}{col(third, 3)}</View>
          {rows.slice(3, 10).map((p, i) => (
            <View key={p.id} style={[styles.friend, p.id === me && { backgroundColor: '#ffffff18' }]}>
              <Rank n={i + 4} />
              <T v="body" style={{ flex: 1, fontWeight: '700' }} numberOfLines={1}>{p.name}</T>
              <T v="small">{Math.round(p.paint_used)} paint</T>
            </View>
          ))}
        </>
      )}
    </Panel>
  );
}

const PILL_W = (CARD_W - 32 - 24) / 3, PILL_H = Math.round(PILL_W * 1.5);
const styles = StyleSheet.create({
  cardShadow: { backgroundColor: C.ink, paddingBottom: 6 },
  card: { borderWidth: 3, borderColor: C.ink, padding: 16, paddingTop: 6, backgroundColor: '#150626', overflow: 'hidden' },
  big: { fontFamily: F.display, fontSize: 62, color: '#c9b8ff', opacity: 0.6, textAlign: 'center', letterSpacing: -1, marginBottom: -34 },
  fade: { position: 'absolute', left: 0, right: 0, top: 44, height: 40 },
  fade2: { position: 'absolute', left: 0, right: 0, top: 44 + PILL_H + 92, height: 40 },
  pills: { flexDirection: 'row', gap: 12, marginTop: 4, marginBottom: 14 },
  pill: { width: PILL_W, height: PILL_H },
  pillEmpty: { flex: 1, borderRadius: PILL_W / 2, backgroundColor: '#2b2059', alignItems: 'center', justifyContent: 'center' },
  q: { fontFamily: F.display, fontSize: 30, color: '#6a5aa8' },
  badge: { position: 'absolute', right: -2, bottom: 6, width: 28, height: 28, borderRadius: 14, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontFamily: F.display, fontSize: 16, color: '#1c0f42' },
  cap: { ...ui(13, '600'), color: '#e6dcff', maxWidth: PILL_W + 12, textAlign: 'center' },
  sq: { width: PILL_W, height: PILL_W, alignItems: 'center', justifyContent: 'center' },
  times: { backgroundColor: '#ffffff26', paddingHorizontal: 10, paddingVertical: 4 },
  timesText: { ...ui(12.5, '700'), color: '#fff' },
  tiles: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  foot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  footName: { fontFamily: F.display, fontSize: 18, color: '#fff', ...outline('#150626') },
  footSub: { ...ui(12.5, '600'), color: '#bdaee8' },
  footBrand: { fontFamily: F.display, fontSize: 22, color: '#fff' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  friend: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  streak: { ...ui(14, '700'), color: '#fff' },
  pName: { ...ui(13, '700'), color: '#fff', maxWidth: 96 },
  pPaint: { fontFamily: F.mono, fontSize: 22, color: C.phosphor },
});
