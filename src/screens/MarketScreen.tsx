import React, { useMemo } from 'react';
import { Dimensions, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import { Btn, Header, IconBtn, Panel, Pill, Screen, T } from '../ui/kit';
import { PixelBox } from '../ui/PixelBox';
import { PixelIcon } from '../ui/PixelIcon';
import { PixelCan } from '../ui/PixelCan';
import { C, F, ui, uiLabel } from '../ui/theme';
import { useStore } from '../store';
import { MARKET_CANS, MARKET_PAINTS, PAINT_PER_COIN, SOON, coinsOf, type Item } from '../lib/economy';

const CARD = (Dimensions.get('window').width - 18 * 2 - 14) / 2;

/** Spend coins (earned by spraying and missions) on paints and can skins. Everything is stored on the device. */
export function MarketScreen() {
  const painter = useStore((s) => s.painter);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const setSheet = useStore((s) => s.setSheet);
  const coins = coinsOf(painter, settings);
  const buy = (it: Item) => {
    if (coins < it.price || settings.owned.includes(it.id)) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setSettings({ owned: [...settings.owned, it.id], spent: settings.spent + it.price });
  };
  const equip = (side: 'optionA' | 'optionB', it: Item) => setSettings({ [side]: { color: it.color, name: it.name } });

  return (
    <Screen tone="blue" sheet>
      <Header title="MARKET" sub="spend coins on paints and cans" right={
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Pill icon="coin" value={coins} iconColor={C.yellow} alt="#c48f00" />
          <IconBtn icon="x" onPress={() => setSheet(null)} />
        </View>
      } />
      <Panel title="HOW TO EARN">
        <T v="body">Every {PAINT_PER_COIN} paint you spray earns 1 coin. Daily quests on Profile pay bonus coins.</T>
      </Panel>

      <T v="label">PAINTS</T>
      <View style={styles.grid}>
        {MARKET_PAINTS.map((it) => {
          const owned = settings.owned.includes(it.id);
          const onA = settings.optionA.color === it.color, onB = settings.optionB.color === it.color;
          return (
            <Card key={it.id} it={it} preview={<Blob color={it.color} />}>
              {owned ? (
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <Btn label="LEFT" size="sm" tone={onA ? 'yellow' : 'dark'} style={{ flex: 1 }} onPress={() => equip('optionA', it)} />
                  <Btn label="RIGHT" size="sm" tone={onB ? 'yellow' : 'dark'} style={{ flex: 1 }} onPress={() => equip('optionB', it)} />
                </View>
              ) : <BuyBtn it={it} coins={coins} onBuy={() => buy(it)} />}
            </Card>
          );
        })}
      </View>

      <T v="label">CAN SKINS</T>
      <View style={styles.grid}>
        <Card it={{ id: 'paint', name: 'Classic', price: 0, color: settings.optionA.color, blurb: 'follows your colour' }} preview={<PixelCan color={settings.optionA.color} cell={4} />}>
          <Btn label={settings.canSkin === 'paint' ? 'IN USE' : 'USE'} size="sm" tone={settings.canSkin === 'paint' ? 'yellow' : 'dark'} onPress={() => setSettings({ canSkin: 'paint' })} />
        </Card>
        {MARKET_CANS.map((it) => {
          const owned = settings.owned.includes(it.id);
          return (
            <Card key={it.id} it={it} preview={<PixelCan color={it.color} cell={4} />}>
              {owned ? <Btn label={settings.canSkin === it.id ? 'IN USE' : 'USE'} size="sm" tone={settings.canSkin === it.id ? 'yellow' : 'dark'} onPress={() => setSettings({ canSkin: it.id })} />
                : <BuyBtn it={it} coins={coins} onBuy={() => buy(it)} />}
            </Card>
          );
        })}
      </View>

      <Panel title="COMING SOON">
        <View style={styles.soon}>
          {SOON.map((s) => (
            <View key={s} style={styles.soonChip}>
              <PixelIcon name="lock" size={12} color={C.faint} />
              <Text style={styles.soonText}>{s.toUpperCase()}</Text>
            </View>
          ))}
        </View>
        <T v="small">Effects and stencils need new spray rendering, so they are not for sale yet.</T>
      </Panel>
    </Screen>
  );
}

function Card({ it, preview, children }: { it: Item; preview: React.ReactNode; children: React.ReactNode }) {
  return (
    <PixelBox n={6} depth={5} fill="#22449a" hi="#3560c8" lo="#183578" style={{ width: CARD }} contentStyle={{ padding: 10, gap: 8 }}>
      <View style={styles.preview}>{preview}</View>
      <View>
        <Text style={styles.name} numberOfLines={1}>{it.name}</Text>
        <Text style={styles.blurb} numberOfLines={1}>{it.blurb}</Text>
      </View>
      {it.price > 0 && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <PixelIcon name="coin" size={24} color={C.yellow} alt="#c48f00" />
          <Text style={styles.price}>{it.price}</Text>
        </View>
      )}
      {children}
    </PixelBox>
  );
}

function BuyBtn({ it, coins, onBuy }: { it: Item; coins: number; onBuy: () => void }) {
  const can = coins >= it.price;
  return <Btn label={can ? 'BUY' : `NEED ${it.price - coins}`} size="sm" tone={can ? 'green' : 'dark'} disabled={!can} onPress={onBuy} />;
}

/** A pixel spray blob: concentric squares that fade out, like a single dab. */
function Blob({ color }: { color: string }) {
  const layers = useMemo(() => {
    const cell = 8, n = 9, mid = 4;
    const lv: { p: ReturnType<typeof Skia.Path.Make>; a: number }[] = [1, 0.7, 0.42, 0.2].map((a) => ({ p: Skia.Path.Make(), a }));
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const d = Math.hypot(x - mid, y - mid);
      const i = d < 1.6 ? 0 : d < 2.8 ? 1 : d < 3.8 ? 2 : d < 4.6 ? 3 : -1;
      if (i >= 0 && (i < 3 || (x + y) % 2 === 0)) lv[i].p.addRect(Skia.XYWHRect(x * cell, y * cell, cell, cell));
    }
    return lv;
  }, []);
  return (
    <Canvas style={{ width: 72, height: 72 }} pointerEvents="none">
      {layers.map((l, i) => <Path key={i} path={l.p} color={color} opacity={l.a} antiAlias={false} />)}
    </Canvas>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  preview: { height: 116, alignItems: 'center', justifyContent: 'center', backgroundColor: '#152b66', borderWidth: 3, borderColor: C.ink },
  name: { fontFamily: F.display, fontSize: 16, color: '#fff' },
  blurb: { ...ui(12.5, '500'), color: '#bcd0ff' },
  price: { fontFamily: F.display, fontSize: 18, color: C.yellow },
  soon: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  soonChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#150a36', paddingHorizontal: 8, height: 28 },
  soonText: { ...uiLabel(10.5, 0.6), color: C.faint },
});
