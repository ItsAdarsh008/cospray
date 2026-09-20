import React from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useStore } from '../store';
import { supabase } from '../lib/supabase';
import { Btn, Chip, Header, IconBtn, Panel, Screen, T, Toggle } from '../ui/kit';
import { C, ui, uiLabel } from '../ui/theme';
import { CREWS } from '../lib/economy';

/** App settings only. Paint colours, size and opacity are picked in Create (tools button next to the colours). */
export function SettingsScreen() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const painter = useStore((s) => s.painter);
  const setPainter = useStore((s) => s.setPainter);
  const setShake = useStore((s) => s.setShake);
  const setSheet = useStore((s) => s.setSheet);
  const crew = CREWS.find((c) => c.id === settings.crew);

  return (
    <Screen tone="night" sheet>
      <Header title="SETTINGS" sub={painter ? `signed in as ${painter.name}` : undefined} right={<IconBtn icon="x" onPress={() => setSheet(null)} />} />

      <Panel title="INPUT & FEEL">
        <Row label="Volume buttons also spray" sub="on-screen hold buttons are always on" value={settings.volumeButtons} onChange={(v) => setSettings({ volumeButtons: v })} />
        <Row label="Haptics" value={settings.haptics} onChange={(v) => setSettings({ haptics: v })} />
        <Row label="Sound" value={settings.sound} onChange={(v) => setSettings({ sound: v })} />
        <Row label="Show detected AR surfaces" value={settings.showPlanes} onChange={(v) => setSettings({ showPlanes: v })} />
        <Row label="Debug line in Create" sub="tracking, planes, GPS accuracy" value={settings.debugHud} onChange={(v) => setSettings({ debugHud: v })} />
        <Row label="Paint anywhere" sub="bypass the Waterloo Region geofence" value={settings.geofenceBypass} onChange={(v) => setSettings({ geofenceBypass: v })} />
      </Panel>

      <Panel title="COMPASS MODE SCALE" right={<T v="label" color="#fff">{settings.hfov}°</T>}>
        <T v="small">Camera field of view for the non-AR fallback.</T>
        <View style={styles.row}>{[42, 48, 52, 58, 66].map((v) => <Chip key={v} label={String(v)} on={settings.hfov === v} onPress={() => setSettings({ hfov: v })} />)}</View>
      </Panel>

      <Panel title="ACCOUNT & PRIVACY">
        <Static k="Handle" v={painter?.name ?? '—'} />
        <Static k="Crew" v={crew?.name ?? 'none'} />
        <Static k="Apple sign-in" v="SOON" dim />
        <Static k="Google sign-in" v="SOON" dim />
        <Static k="Snapchat" v="SOON" dim />
        <Static k="Discord presence" v="SOON" dim />
      </Panel>

      <Panel title="ABOUT">
        <Static k="Version" v="0.1.0 · Hack the North 2026" />
        <Static k="Backend" v="Supabase · Waterloo" />
        <Static k="Web" v="open the companion site" onPress={() => Linking.openURL('https://tagged-web.vercel.app')} />
      </Panel>

      <Panel title="DEBUG">
        <View style={styles.row}>
          <Btn label="FILL CAN" size="sm" tone="dark" onPress={() => setShake(1)} />
          <Btn label="REDO ONBOARDING" size="sm" tone="dark" onPress={() => { setSheet(null); setSettings({ onboarded: false }); }} />
          <Btn label="SIGN OUT" size="sm" tone="red" onPress={() => { setSheet(null); setPainter(null); setSettings({ onboarded: false }); supabase.auth.signOut().catch(() => {}); }} />
        </View>
      </Panel>
    </Screen>
  );
}

function Row({ label, sub, value, onChange }: { label: string; sub?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.switchRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.switchLabel}>{label}</Text>
        {sub ? <T v="small">{sub}</T> : null}
      </View>
      <Toggle on={value} onChange={onChange} />
    </View>
  );
}
function Static({ k, v, onPress, dim }: { k: string; v: string; onPress?: () => void; dim?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={styles.switchRow}>
      <Text style={[styles.switchLabel, dim && { color: C.faint }]}>{k}</Text>
      <Text style={[styles.staticVal, onPress && { color: C.blueHi }, dim && { color: C.faint, ...uiLabel(10.5, 0.6) }]}>{v}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 36 },
  switchLabel: { ...ui(15, '700'), color: '#fff' },
  staticVal: { ...ui(13, '600'), color: C.dim, maxWidth: '55%', textAlign: 'right' },
});
