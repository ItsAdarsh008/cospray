import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { PixelBox } from '../ui/PixelBox';
import { PixelIcon } from '../ui/PixelIcon';
import { PixelCan } from '../ui/PixelCan';
import { Avatar, Btn, IconBtn, Panel, Pill, SegBar, Screen, T, Tile, hapticTap } from '../ui/kit';
import { C, F, outline } from '../ui/theme';
import { useStore } from '../store';
import { PAINT_MAX, PAINT_REGEN_PER_SEC, SHAKE_MIN_TO_SPRAY } from '../config';
import { CREWS, MISSIONS, coinsOf, colorName, dayKey, dayStats, skinColor } from '../lib/economy';

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function ProfileScreen() {
  const painter = useStore((s) => s.painter);
  const paint = useStore((s) => s.paint);
  const shake = useStore((s) => s.shake);
  const settings = useStore((s) => s.settings);
  const strokes = useStore((s) => s.strokes);
  const online = useStore((s) => s.online);
  const setTab = useStore((s) => s.setTab);
  const setSheet = useStore((s) => s.setSheet);
  const stats = useMemo(() => dayStats(Object.values(strokes).flat(), painter?.id), [strokes, painter?.id]);
  const coins = coinsOf(painter, settings);
  const crew = CREWS.find((c) => c.id === settings.crew);
  const low = shake < SHAKE_MIN_TO_SPRAY;

  return (
    <Screen tone="purple">
      <View style={styles.head}>
        <Avatar name={painter?.name} color={settings.avatarColor} size={52} />
        <View style={{ flex: 1 }}>
          <T v="h" numberOfLines={1}>{painter?.name ?? 'painter'}</T>
          <T v="small">{crew ? crew.name : 'NO CREW'} · {online ? 'LIVE' : 'OFFLINE'}</T>
        </View>
        <Pressable onPress={() => { hapticTap(); setSheet('market'); }} hitSlop={4}>
          <Pill icon="coin" value={coins} iconColor={C.yellow} alt="#c48f00" />
        </Pressable>
        <IconBtn icon="settings" onPress={() => setSheet('settings')} />
      </View>

      <Panel title="SPRAY CAN" right={<T v="label" color={low ? C.red : C.greenHi}>{low ? 'NEEDS A SHAKE' : 'READY'}</T>}>
        <View style={styles.canRow}>
          <View style={styles.canBox}>
            <PixelCan color={skinColor(settings.canSkin, settings.optionA.color)} level={paint.A / PAINT_MAX} cell={5} wobble={low} />
          </View>
          <View style={{ flex: 1, gap: 12 }}>
            <Gauge label={colorName(settings.optionA.color)} color={settings.optionA.color} value={paint.A} />
            <Gauge label={colorName(settings.optionB.color)} color={settings.optionB.color} value={paint.B} />
            <View style={{ gap: 4 }}>
              <View style={styles.rowBetween}>
                <T v="label" color={C.white}>PRESSURE</T>
                <T v="small">{Math.round(shake * 100)}%</T>
              </View>
              <SegBar value={shake} color={low ? C.orange : C.greenHi} />
            </View>
          </View>
        </View>
        <Btn label="GO PAINT" icon="create" tone="green" size="lg" onPress={() => setTab('create')} />
      </Panel>

      <Missions stats={stats} />

      <Panel title="MARKET" right={<T v="label" color={C.white}>{coins} COINS</T>}>
        <T v="sub">New paints and can skins. Spray to earn coins; missions pay extra.</T>
        <Btn label="OPEN MARKET" icon="market" tone="blue" onPress={() => setSheet('market')} />
      </Panel>

      <Panel title="TODAY">
        <View style={styles.tiles}>
          <Tile n={stats.strokes} label="strokes" />
          <Tile n={stats.pieces} label="walls" />
          <Tile n={stats.paint} label="paint" />
          <Tile n={stats.streak} label="day streak" />
        </View>
        <T v="small">all time · {painter?.strokes ?? 0} strokes · {Math.round(painter?.paint_used ?? 0)} paint sprayed</T>
      </Panel>
    </Screen>
  );
}

function Gauge({ label, color, value }: { label: string; color: string; value: number }) {
  const secs = Math.ceil((PAINT_MAX - value) / PAINT_REGEN_PER_SEC);
  const full = value / PAINT_MAX >= 0.995;
  return (
    <View style={{ gap: 4 }}>
      <View style={styles.rowBetween}>
        <T v="label" color={C.white}>{label}</T>
        <T v="small">{full ? 'FULL' : `FULL IN ${mmss(secs)}`}</T>
      </View>
      <SegBar value={value / PAINT_MAX} color={color} />
    </View>
  );
}

/** Daily quests in the Subway Surfers layout: goal, progress box and a claim strip. */
function Missions({ stats }: { stats: ReturnType<typeof dayStats> }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const day = dayKey();
  return (
    <Panel title="DAILY QUESTS" tone="blue" right={<PixelIcon name="star" size={24} color={C.yellow} alt="#c48f00" />}>
      {MISSIONS.map((m) => {
        const key = `${day}:${m.id}`;
        const got = Math.min(m.goal, m.get(stats));
        const done = got >= m.goal;
        const claimed = !!settings.claimed[key];
        const [pre, post] = m.title.split('{n}');
        return (
          <PixelBox key={m.id} fill="#1f4fa8" hi="#2b63c8" lo="#173f88" depth={3} contentStyle={{ padding: 10, gap: 8 }}>
            <View style={styles.rowBetween}>
              <Text style={styles.mTitle}>{pre}<Text style={{ color: C.yellow }}>{m.hot}</Text>{post}</Text>
              <PixelBox fill="#12306b" depth={0} bw={3} n={3} contentStyle={{ paddingHorizontal: 10, height: 30, justifyContent: 'center' }}>
                <Text style={{ fontFamily: F.display, fontSize: 16, color: '#fff' }}>{got}/{m.goal}</Text>
              </PixelBox>
            </View>
            <View style={styles.rowBetween}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <PixelIcon name="coin" size={24} color={C.yellow} alt="#c48f00" />
                <Text style={{ fontFamily: F.display, fontSize: 16, color: C.yellow }}>+{m.reward}</Text>
              </View>
              {claimed ? <T v="label" color={C.greenHi}>CLAIMED</T> : (
                <Btn label={done ? 'CLAIM' : 'IN PROGRESS'} tone={done ? 'green' : 'dark'} size="sm" disabled={!done} onPress={() => {
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
                  setSettings({ claimed: { ...settings.claimed, [key]: true }, bonus: settings.bonus + m.reward });
                }} />
              )}
            </View>
          </PixelBox>
        );
      })}
    </Panel>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  canRow: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  canBox: { width: 112, height: 150, alignItems: 'center', justifyContent: 'center', backgroundColor: '#150a36', borderWidth: 3, borderColor: C.ink },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tiles: { flexDirection: 'row', gap: 8 },
  mTitle: { flex: 1, fontFamily: F.display, fontSize: 17, color: '#fff', ...outline('#173f88') },
});
