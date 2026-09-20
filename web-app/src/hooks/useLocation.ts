import { useEffect, useState } from 'react';
import { useStore } from '../store';

export type LocationStatus = 'pending' | 'granted' | 'denied';

const WATCH_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 };
// The native app seeds the store with getLastKnownPositionAsync before the GPS settles; on the web
// that is a one-shot coarse/cached fix (Wi-Fi / cell, up to 2 min old). The watch supersedes it.
const SEED_OPTIONS: PositionOptions = { enableHighAccuracy: false, maximumAge: 120000, timeout: 4000 };

/**
 * Streams the device position into the store (port of the native hook on top of
 * navigator.geolocation.watchPosition). Status is 'pending' until the browser answers: the
 * first fix (or a Permissions API 'granted') → 'granted'; PERMISSION_DENIED, a missing API or an
 * insecure (non-https, non-localhost) context → 'denied'. Transient errors (position unavailable,
 * timeout) keep the watch alive because a later fix usually arrives.
 */
export function useLocation(): LocationStatus {
  const setLocation = useStore((s) => s.setLocation);
  const [status, setStatus] = useState<LocationStatus>('pending');

  useEffect(() => {
    const geo = typeof navigator !== 'undefined' ? navigator.geolocation : undefined;
    if (!geo) { setStatus('denied'); return; }
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      console.warn('Geolocation needs a secure context (https or localhost)');
      setStatus('denied');
      return;
    }

    let cancelled = false;
    let denied = false;
    let watchId: number | null = null;
    let permStatus: PermissionStatus | null = null;
    let newestTs = 0; // timestamp of the fix currently in the store

    const onPosition = (p: GeolocationPosition) => {
      if (cancelled) return;
      const { latitude, longitude, accuracy } = p.coords;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
      // a slow coarse seed must never overwrite a newer precise fix from the watch
      const ts = Number.isFinite(p.timestamp) ? p.timestamp : Date.now();
      if (ts < newestTs) return;
      newestTs = ts;
      setLocation({ lat: latitude, lng: longitude, accuracy: Number.isFinite(accuracy) ? accuracy : 50 });
      setStatus('granted');
    };
    const onError = (e: GeolocationPositionError) => {
      if (cancelled) return;
      if (e.code === e.PERMISSION_DENIED) { denied = true; setStatus('denied'); stopWatch(); return; }
      // POSITION_UNAVAILABLE / TIMEOUT: keep watching, the next fix may succeed
      console.warn('geolocation error', e.code, e.message);
    };
    const stopWatch = () => {
      if (watchId != null) { try { geo.clearWatch(watchId); } catch {} watchId = null; }
    };
    const startWatch = () => {
      if (cancelled || denied || watchId != null) return;
      try {
        watchId = geo.watchPosition(onPosition, onError, WATCH_OPTIONS);
      } catch (e) {
        console.warn('watchPosition failed', e);
        denied = true;
        setStatus('denied');
      }
    };

    // quick first fix (errors here are not conclusive; only an explicit denial counts)
    try { geo.getCurrentPosition(onPosition, (e) => { if (e.code === e.PERMISSION_DENIED) onError(e); }, SEED_OPTIONS); } catch {}
    startWatch();

    // iOS Safari stops delivering watchPosition updates after the tab was backgrounded and does
    // not resume on its own: restart the watch whenever the page becomes visible again.
    const onVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible' || denied) return;
      stopWatch();
      startWatch();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);

    // Permissions API (where available) resolves the status before the first fix lands, and
    // tracks the user flipping the site permission while the page is open.
    try {
      const perms = typeof navigator !== 'undefined' ? navigator.permissions : undefined;
      if (perms && typeof perms.query === 'function') {
        perms.query({ name: 'geolocation' }).then((ps) => {
          if (cancelled) return;
          permStatus = ps;
          const apply = () => {
            if (cancelled) return;
            if (ps.state === 'granted') { denied = false; setStatus('granted'); startWatch(); }
            else if (ps.state === 'denied') { denied = true; setStatus('denied'); stopWatch(); }
            else if (denied) {
              // permission was reset to 'prompt' after a denial: ask again
              denied = false;
              setStatus('pending');
              startWatch();
            }
          };
          ps.onchange = apply;
          apply();
        }).catch(() => {});
      }
    } catch {}

    return () => {
      cancelled = true;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      stopWatch();
      if (permStatus) permStatus.onchange = null;
    };
  }, [setLocation]);

  return status;
}
