import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { useStore } from './store';
import { sfx } from './audio/sfx';
import { useLocation } from './hooks/useLocation';
import { fetchPainter, flushPending, loadCached, loadNearby, subscribeRealtime } from './data/sync';
import { AuthScreen } from './screens/AuthScreen';
import { NameScreen } from './screens/NameScreen';
import { PaintScreen } from './screens/PaintScreen';
import { SettingsScreen } from './screens/SettingsScreen';

/**
 * The QR client: scan → type a tag → paint. One screen, no account and no tabs — anyone who scans
 * the code is signed in anonymously before they see anything, and the only thing they are asked
 * for is the name that signs their pieces.
 *
 * Walls are still the geo-anchored canvases the phone app uses, so everyone painting inside the
 * geofence sees the pieces around them (and each other's strokes live, via Supabase realtime).
 * The store hydrates synchronously from localStorage; sound, camera and sensors unlock from the
 * user gesture on the paint screen, which iOS requires.
 */
export default function App() {
  const painter = useStore((s) => s.painter);
  const setPainter = useStore((s) => s.setPainter);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  // set only when anonymous sign-in itself fails (e.g. the provider is disabled on the project):
  // the email form is then the way in rather than a dead end.
  const [anonError, setAnonError] = useState<string | null>(null);
  // outcome of the painter-row lookup for an auth uid. A browser is a "new device" for every
  // iPhone painter, so the tag prompt must wait for a SUCCESSFUL lookup: a failed one (offline,
  // timeout, RLS) must not be read as "no painter yet", or NameScreen would let them pick a
  // second tag for an account that already has one.
  const [painterLookup, setPainterLookup] = useState<{ uid: string; status: 'ok' | 'error'; message?: string } | null>(null);
  const [lookupAttempt, setLookupAttempt] = useState(0);
  const retryLookup = useCallback(() => { setPainterLookup(null); setLookupAttempt((n) => n + 1); }, []);

  useEffect(() => {
    loadCached().catch(() => {});
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (data.session) { setSession(data.session); return; }
      // first visit from the QR code: no account, no password, just a session
      const { data: anon, error } = await supabase.auth.signInAnonymously();
      if (cancelled) return;
      if (error) { setAnonError(error.message); setSession(null); return; }
      setSession(anon.session);
    })().catch((e: unknown) => {
      if (cancelled) return;
      setAnonError(e instanceof Error ? e.message : 'Could not reach the server');
      setSession(null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, []);

  // keep the persisted painter in sync with whoever is signed in
  useEffect(() => {
    if (session === undefined) return;
    if (!session) { if (painter) setPainter(null); setPainterLookup(null); return; }
    const uid = session.user.id;
    if (painter?.id === uid) { setPainterLookup({ uid, status: 'ok' }); return; }
    let cancelled = false;
    fetchPainter(uid)
      .then((p) => { if (cancelled) return; setPainter(p); setPainterLookup({ uid, status: 'ok' }); })
      .catch((e: unknown) => {
        if (cancelled) return;
        setPainterLookup({ uid, status: 'error', message: e instanceof Error ? e.message : 'Network error' });
      });
    return () => { cancelled = true; };
  }, [session, lookupAttempt]);

  // a failed lookup retries by itself when the connection comes back
  useEffect(() => {
    if (painterLookup?.status !== 'error') return;
    window.addEventListener('online', retryLookup);
    return () => window.removeEventListener('online', retryLookup);
  }, [painterLookup?.status, retryLookup]);

  if (session === undefined) return <Splash line="Getting you a can…" />;
  if (!session) return anonError ? <AuthScreen note={anonError} /> : <Splash line="Getting you a can…" />;
  if (!painter || painter.id !== session.user.id) {
    if (painterLookup?.uid !== session.user.id) return <Splash line="Getting you a can…" />;
    if (painterLookup.status === 'error') return <RetryScreen message={painterLookup.message} onRetry={retryLookup} />;
    return <NameScreen userId={session.user.id} />;
  }
  return <Shell />;
}

function Splash({ line }: { line: string }) {
  return (
    <div className="form-screen">
      <div className="form">
        <div className="brand">FRESCO</div>
        <div className="sub">{line}</div>
      </div>
    </div>
  );
}

/** Shown when the painter lookup failed: the user keeps their existing tag instead of being asked for a new one. */
function RetryScreen({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <div className="form-screen">
      <div className="form">
        <div className="brand">FRESCO</div>
        <div className="sub">Could not reach the server to load your tag.</div>
        {message && <div className="err" role="alert">{message}</div>}
        <button type="button" className="btn" onClick={onRetry}>RETRY</button>
        <div className="hint">Check your connection — this retries by itself once you are back online.</div>
      </div>
    </div>
  );
}

/**
 * One screen: the wall. The map and leaderboard tabs are gone. The settings sheet stays because it
 * is where the colours and caps live — the paint screen's own button opens it.
 */
function Shell() {
  const sound = useStore((s) => s.settings.sound);
  const location = useStore((s) => s.location);
  const locationStatus = useLocation();

  useEffect(() => { sfx.enabled = sound; }, [sound]);

  // backend: realtime + periodic nearby refresh + pending flush
  useEffect(() => {
    const unsub = subscribeRealtime();
    const id = setInterval(() => {
      const l = useStore.getState().location;
      if (l) loadNearby(l.lat, l.lng).catch(() => {});
      flushPending().catch(() => {});
    }, 15000);
    const onOnline = () => { flushPending().catch(() => {}); };
    window.addEventListener('online', onOnline);
    return () => { unsub(); clearInterval(id); window.removeEventListener('online', onOnline); };
  }, []);

  // first GPS fix → pull the canvases around us, so other people's walls are already there
  const firstFix = !!location;
  useEffect(() => { if (location) loadNearby(location.lat, location.lng).catch(() => {}); }, [firstFix]);

  return (
    <>
      <PaintScreen active locationStatus={locationStatus} />
      <SettingsScreen />
    </>
  );
}
