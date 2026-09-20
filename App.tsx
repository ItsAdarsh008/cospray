import 'react-native-url-polyfill/auto';
import React, { useEffect, useState } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { PixelifySans_400Regular, PixelifySans_500Medium, PixelifySans_600SemiBold, PixelifySans_700Bold } from '@expo-google-fonts/pixelify-sans';
import { VT323_400Regular } from '@expo-google-fonts/vt323';
import { Silkscreen_400Regular, Silkscreen_700Bold } from '@expo-google-fonts/silkscreen';
import { hydrateStore, useStore } from './src/store';
import { useLocation } from './src/hooks/useLocation';
import { sfx } from './src/audio/sfx';
import { fetchPainter, flushPending, loadCached, loadNearby, subscribeRealtime } from './src/data/sync';
import { supabase } from './src/lib/supabase';
import type { Session } from '@supabase/supabase-js';
import { LaunchScreen } from './src/screens/LaunchScreen';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { PaintScreen } from './src/screens/PaintScreen';
import { ArPaintScreen } from './src/screens/ArPaintScreen';
import { isArSupported } from './modules/ar-paint';
import { startWidgetSync } from './src/lib/widget';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { ExploreScreen } from './src/screens/ExploreScreen';
import { SocialScreen } from './src/screens/SocialScreen';
import { VaultScreen } from './src/screens/VaultScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { MarketScreen } from './src/screens/MarketScreen';
import { Dock } from './src/ui/Dock';
import { C } from './src/ui/theme';

export default function App() {
  const [ready, setReady] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [fontsLoaded, fontError] = useFonts({ PixelifySans_400Regular, PixelifySans_500Medium, PixelifySans_600SemiBold, PixelifySans_700Bold, VT323_400Regular, Silkscreen_400Regular, Silkscreen_700Bold });
  useEffect(() => {
    (async () => {
      await hydrateStore();
      await loadCached();
      await sfx.init();
      setReady(true);
    })();
  }, []);
  if (!ready || !(fontsLoaded || fontError)) return <View style={{ flex: 1, backgroundColor: C.bg }} />;
  if (!launched) return <><LaunchScreen onEnter={() => setLaunched(true)} /><StatusBar style="light" /></>;
  return <Root />;
}

function Root() {
  const painter = useStore((s) => s.painter);
  const setPainter = useStore((s) => s.setPainter);
  const onboarded = useStore((s) => s.settings.onboarded);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [checkedFor, setCheckedFor] = useState<string | null>(null); // painter row looked up for this uid
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  // keep the persisted painter in sync with whoever is signed in
  useEffect(() => {
    if (!session) { if (session === null && painter) setPainter(null); return; }
    if (painter?.id === session.user.id) { setCheckedFor(session.user.id); return; }
    fetchPainter(session.user.id).then((p) => { setPainter(p); setCheckedFor(session.user.id); }).catch(() => setCheckedFor(session.user.id));
  }, [session?.user.id]);
  const tab = useStore((s) => s.tab);
  const sheet = useStore((s) => s.sheet);
  const setSheet = useStore((s) => s.setSheet);
  const [lastSheet, setLastSheet] = useState(sheet); // keeps the page rendered while the sheet slides away
  useEffect(() => { if (sheet) setLastSheet(sheet); }, [sheet]);
  const [visitedCreate, setVisitedCreate] = useState(false);
  useEffect(() => { if (tab === 'create') setVisitedCreate(true); }, [tab]);
  const settings = useStore((s) => s.settings);
  const location = useStore((s) => s.location);
  useLocation();

  useEffect(() => { sfx.enabled = settings.sound; }, [settings.sound]);
  useEffect(() => startWidgetSync(), []);

  // backend: realtime + periodic nearby refresh + pending flush
  useEffect(() => {
    const unsub = subscribeRealtime();
    const id = setInterval(() => {
      const l = useStore.getState().location;
      if (l) loadNearby(l.lat, l.lng);
      flushPending();
    }, 15000);
    return () => { unsub(); clearInterval(id); };
  }, []);
  const firstFix = !!location;
  useEffect(() => { if (location) loadNearby(location.lat, location.lng); }, [firstFix]);

  if (session === undefined) return <View style={{ flex: 1, backgroundColor: C.bg }} />;
  const signedIn = !!session && !!painter && painter.id === session.user.id;
  if (!signedIn || !onboarded) {
    // returning users: don't flash onboarding while their painter row is still being looked up
    if (session && checkedFor !== session.user.id) return <View style={{ flex: 1, backgroundColor: C.bg }} />;
    return <><OnboardingScreen session={session} /><StatusBar style="light" /></>;
  }

  return (
    <View style={styles.root}>
      {tab === 'profile' && <ProfileScreen />}
      {tab === 'vault' && <VaultScreen />}
      {/* the AR view stays mounted once opened: hiding pauses the session and showing resumes it, so paint keeps its anchors across tabs */}
      {isArSupported ? (visitedCreate && (
        <View style={[StyleSheet.absoluteFill, tab !== 'create' && styles.hidden]} pointerEvents={tab === 'create' ? 'auto' : 'none'}>
          <ArPaintScreen active={tab === 'create' && !sheet} />
        </View>
      )) : tab === 'create' && <PaintScreen active={!sheet} />}
      {tab === 'explore' && <ExploreScreen />}
      {tab === 'social' && <SocialScreen />}
      <Dock />
      {/* Market and Settings slide up over whatever you were doing (swipe down or X to close) */}
      <Modal visible={!!sheet} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSheet(null)}>
        {(sheet ?? lastSheet) === 'market' && <MarketScreen />}
        {(sheet ?? lastSheet) === 'settings' && <SettingsScreen />}
      </Modal>
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  hidden: { display: 'none' },
});
