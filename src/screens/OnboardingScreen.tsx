import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Location from 'expo-location';
import { DeviceMotion } from 'expo-sensors';
import { useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { supabase } from '../lib/supabase';
import { ensurePainter } from '../data/sync';
import { useStore } from '../store';
import { PALETTE } from '../config';
import { CREWS } from '../lib/economy';
import { Backdrop } from '../ui/Backdrop';
import { PixelBox } from '../ui/PixelBox';
import { PixelIcon, type IconName } from '../ui/PixelIcon';
import { Avatar, Btn, Chip, IconBtn, Panel, T } from '../ui/kit';
import { C, F, outline } from '../ui/theme';

/**
 * Three quick steps: 1) sign in, 2) handle + avatar colour + crew, 3) permissions.
 * Identity is a Supabase anonymous session ("Anonymous sign-ins" must be on in the project; if it is
 * off, step 1 asks for email + password instead). Apple / Google / Snapchat are shown but not wired yet.
 * The crew is saved on this phone only.
 */
export function OnboardingScreen({ session }: { session: { user: { id: string } } | null }) {
  const setPainter = useStore((s) => s.setPainter);
  const setSettings = useStore((s) => s.setSettings);
  const painter = useStore((s) => s.painter);
  const settings0 = useStore.getState().settings;
  const [uid, setUid] = useState<string | null>(session?.user.id ?? null);
  const [step, setStep] = useState<1 | 2 | 3>(session ? 2 : 1);
  const [name, setName] = useState(painter?.name ?? '');
  const [color, setColor] = useState(settings0.avatarColor);
  const [crew, setCrew] = useState<string | null>(settings0.crew);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [needEmail, setNeedEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [camPerm, requestCam] = useCameraPermissions();
  const [loc, setLoc] = useState<boolean | null>(null);
  const [motion, setMotion] = useState<boolean | null>(null);
  useEffect(() => { if (session) setUid(session.user.id); }, [session?.user.id]);
  useEffect(() => { Location.getForegroundPermissionsAsync().then((p) => setLoc(p.granted)).catch(() => {}); DeviceMotion.getPermissionsAsync().then((p) => setMotion(p.granted)).catch(() => {}); }, []);

  const ok = () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

  const signIn = async () => {
    setBusy(true); setErr(null);
    try {
      let id: string | null = null;
      if (!needEmail) {
        const { data, error } = await supabase.auth.signInAnonymously();
        if (!error && data.user) id = data.user.id;
        else { setNeedEmail(true); throw new Error('Guest sign-in is off for this project. Use an email and password instead.'); }
      } else {
        const e = email.trim().toLowerCase();
        if (!e || password.length < 6) throw new Error('Email and a 6+ character password, please.');
        const { data, error } = await supabase.auth.signInWithPassword({ email: e, password });
        if (!error && data.user) id = data.user.id;
        else {
          if (error && !/invalid login/i.test(error.message)) throw new Error(error.message);
          const { data: d2, error: e2 } = await supabase.auth.signUp({ email: e, password });
          if (e2) throw new Error(e2.message);
          if (!d2.session) throw new Error('Account created. Confirm the emailed link, then tap again.');
          id = d2.session.user.id;
        }
      }
      setUid(id); ok(); setStep(2);
    } catch (e: any) { setErr(e?.message ?? 'Failed'); }
    setBusy(false);
  };

  const saveProfile = async () => {
    const n = name.trim().slice(0, 20);
    if (!n) { setErr('Pick a handle first.'); return; }
    if (!uid) { setStep(1); return; }
    setBusy(true); setErr(null);
    try {
      const p = await ensurePainter(uid, n);
      setPainter(p);
      setSettings({ avatarColor: color, crew });
      ok(); setStep(3);
    } catch (e: any) { setErr(e?.message ?? 'Failed'); }
    setBusy(false);
  };

  const finish = () => { setSettings({ onboarded: true }); ok(); };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
      <Backdrop tone="purple" />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={styles.top}>
          {step > 1 ? <IconBtn icon="left" size={40} onPress={() => { setErr(null); setStep((s) => (s - 1) as 1 | 2 | 3); }} /> : <View style={{ width: 40 }} />}
          <View style={styles.steps}>{[1, 2, 3].map((n) => <View key={n} style={[styles.step, n <= step && styles.stepOn]} />)}</View>
          <T v="label" color="#fff">{step}/3</T>
        </View>
        <Text style={styles.brand}>FRESCO</Text>

        {step === 1 && (
          <>
            <T v="sub" style={{ textAlign: 'center' }}>The world is your wall. Sign in to start spraying.</T>
            <Panel title="STEP 1 · SIGN IN">
              <Btn label={busy ? '…' : needEmail ? 'SIGN IN / CREATE' : 'PLAY AS GUEST'} tone="green" size="lg" disabled={busy} onPress={signIn} />
              <T v="label" color={C.faint}>OR SIGN IN WITH</T>
              <View style={styles.socials}>
                {['APPLE', 'GOOGLE', 'SNAP'].map((s) => <Btn key={s} label={s} tone="dark" size="sm" disabled style={{ flex: 1 }} />)}
              </View>
              <T v="small">Social sign-in is coming soon. Guest accounts keep their tag and stats.</T>
            </Panel>
            {needEmail && (
              <Panel title="ACCOUNT">
                <Field value={email} onChangeText={setEmail} placeholder="you@uwaterloo.ca" keyboardType="email-address" autoCapitalize="none" />
                <Field value={password} onChangeText={setPassword} placeholder="password (6+)" secureTextEntry onSubmitEditing={signIn} />
              </Panel>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <Panel title="STEP 2 · YOUR TAG">
              <View style={styles.rowC}>
                <Avatar name={name || 'F'} color={color} size={60} />
                <View style={{ flex: 1 }}><Field value={name} onChangeText={setName} placeholder="YOUR_HANDLE" autoCapitalize="characters" maxLength={20} /></View>
              </View>
              <T v="label">AVATAR COLOUR</T>
              <View style={styles.swatches}>
                {PALETTE.filter((c) => c !== '#111111').map((c) => (
                  <Pressable key={c} onPress={() => { setColor(c); Haptics.selectionAsync().catch(() => {}); }}>
                    <PixelBox fill={c} border={color === c ? '#fff' : C.ink} depth={2} style={{ width: 38 }} contentStyle={{ height: 36, alignItems: 'center', justifyContent: 'center' }}>
                      {color === c ? <PixelIcon name="check" size={24} color={c === '#ffffff' ? C.ink : '#fff'} /> : null}
                    </PixelBox>
                  </Pressable>
                ))}
              </View>
            </Panel>
            <Panel title="JOIN A CREW (OPTIONAL)">
              <View style={styles.swatches}>
                <Chip label="No crew" on={crew === null} onPress={() => setCrew(null)} />
                {CREWS.map((c) => <Chip key={c.id} label={c.name} on={crew === c.id} onPress={() => setCrew(c.id)} />)}
              </View>
              <T v="small">Crews are saved on this phone for now.</T>
            </Panel>
          </>
        )}

        {step === 3 && (
          <Panel title="STEP 3 · PERMISSIONS">
            <Perm icon="create" label="Camera" hint="to paint on real walls" ok={!!camPerm?.granted} onPress={() => requestCam()} />
            <Perm icon="pin" label="Location" hint="to pin pieces to a place" ok={!!loc} onPress={async () => setLoc((await Location.requestForegroundPermissionsAsync()).granted)} />
            <Perm icon="bolt" label="Motion" hint="to aim and shake the can" ok={!!motion} onPress={async () => setMotion((await DeviceMotion.requestPermissionsAsync()).granted)} />
          </Panel>
        )}

        {err && <T v="body" color={C.redHi} style={{ textAlign: 'center' }}>{err}</T>}
        {step === 2 && <Btn label={busy ? '…' : 'NEXT'} tone="green" size="lg" disabled={busy} onPress={saveProfile} />}
        {step === 3 && <Btn label="START PAINTING" icon="create" tone="green" size="lg" onPress={finish} />}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field(props: React.ComponentProps<typeof TextInput>) {
  return (
    <PixelBox fill="#150a36" hi={null} depth={0} contentStyle={{ height: 50, justifyContent: 'center' }}>
      <TextInput {...props} autoCorrect={false} placeholderTextColor={C.faint} selectionColor={C.yellow} style={styles.input} returnKeyType="done" />
    </PixelBox>
  );
}

function Perm({ icon, label, hint, ok, onPress }: { icon: IconName; label: string; hint: string; ok: boolean; onPress: () => void }) {
  return (
    <View style={styles.perm}>
      <PixelIcon name={icon} size={24} color="#fff" />
      <View style={{ flex: 1 }}>
        <Text style={styles.permLabel}>{label}</Text>
        <T v="small">{hint}</T>
      </View>
      <Btn label={ok ? 'ALLOWED' : 'ALLOW'} size="sm" tone={ok ? 'dark' : 'yellow'} icon={ok ? 'check' : undefined} disabled={ok} onPress={onPress} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#12082b' },
  scroll: { padding: 20, paddingTop: 64, paddingBottom: 60, gap: 16 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  steps: { flex: 1, flexDirection: 'row', gap: 6 },
  step: { flex: 1, height: 12, backgroundColor: '#ffffff22', borderWidth: 3, borderColor: C.ink },
  stepOn: { backgroundColor: C.yellow },
  brand: { fontFamily: F.display, fontSize: 56, color: '#fff', textAlign: 'center', letterSpacing: 6, ...outline('#4a22b8', 4) },
  socials: { flexDirection: 'row', gap: 8 },
  rowC: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: { fontFamily: F.display, fontSize: 20, color: '#fff', paddingHorizontal: 12, height: 50 },
  perm: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  permLabel: { fontFamily: F.display, fontSize: 17, color: '#fff' },
});
