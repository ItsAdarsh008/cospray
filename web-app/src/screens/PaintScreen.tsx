import { useCallback, useEffect, useRef, useState } from 'react';
import { PaintLayer } from '../paint/PaintLayer';
import { getPose, startPose } from '../hooks/usePose';
import { useSprayEngine } from '../hooks/useSprayEngine';
import { useDiscovery } from '../hooks/useDiscovery';
import { sfx } from '../audio/sfx';
import { reportCanvas } from '../data/sync';
import { useStore } from '../store';
import { BlockerBanner, CanMeter, HoldButtons, Line, Reticle, ToolsTray, WallChip } from '../components/HUD';
import { DiscoveryOverlay } from '../components/DiscoveryOverlay';
import { CANVAS_JOIN_RADIUS_M, CANVAS_VISIBLE_RADIUS_M } from '../config';
import { haversineM } from '../lib/geo';
import type { Blocker } from '../types';

/**
 * AR APPROACH — geo-anchored canvases, same as the native compass fallback (../../src/screens/PaintScreen.tsx):
 * a canvas is a virtual cylindrical wall around the spot where its author stood, keyed by GPS.
 * Paint lives in angular coordinates (compass yaw, pitch) so, as you turn the phone, the paint
 * stays glued to the direction you sprayed it. Web differences: the camera is a <video> from
 * getUserMedia, the pose comes from deviceorientation, and two on-screen HOLD buttons replace the
 * volume keys. iOS only grants motion / audio / camera access from a tap, hence the START gate.
 */
type Props = { active: boolean; locationStatus: 'pending' | 'granted' | 'denied' };
type Ui = { spraying: boolean; blocker: Blocker; yaw: number; offWall: boolean };

const LOCATION_DENIED_MSG = 'Location blocked — Tagged needs GPS to place your paint. Allow location for this site and reload.';
const CAMERA_RESTART_MSG = 'Camera stopped — tap here to restart it.';
const SFX_GATE_TIMEOUT_MS = 1500;  // sound is optional: never hold the gate on a slow download
const CAMERA_MUTE_GRACE_MS = 1500; // iOS mutes the track while the page is hidden; restart only if it stays muted

/**
 * Ask for a stream close to the screen's shape at a real resolution: the browser default (640×480,
 * 3:4 in portrait) is upscaled ~5× and cover-cropped to ~60% of its width on a 9:19.5 phone, which
 * both looks soft and shrinks the visible field of view well below the sensor's. All `ideal`, so
 * nothing here can fail as OverconstrainedError.
 */
function camConstraints(): MediaStreamConstraints {
  const w = window.innerWidth || 1, h = window.innerHeight || 1;
  return { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, aspectRatio: { ideal: h / w } }, audio: false };
}

/** Honoured only in standalone / fullscreen; a no-op elsewhere (PaintLayer handles landscape regardless). */
function lockPortrait() {
  try {
    const o = window.screen?.orientation as unknown as { lock?: (t: string) => Promise<void> } | undefined;
    o?.lock?.('portrait')?.catch(() => {});
  } catch {}
}

export function PaintScreen({ active, locationStatus }: Props) {
  const painter = useStore((s) => s.painter);
  const online = useStore((s) => s.online);
  const location = useStore((s) => s.location);
  const debug = useStore((s) => s.debug);
  const setDebug = useStore((s) => s.setDebug);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);

  const engine = useSprayEngine();
  const discovery = useDiscovery();
  // latest-value refs for the 100 ms poll and the shake callback (both run outside render)
  const engineRef = useRef(engine);
  const discoveryRef = useRef(discovery);
  useEffect(() => { engineRef.current = engine; discoveryRef.current = discovery; });

  const [live, setLive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [tools, setTools] = useState(false);
  const [ui, setUi] = useState<Ui>({ spraying: false, blocker: null, yaw: 0, offWall: false });
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wakeRef = useRef<WakeLockSentinel | null>(null);

  // cheap UI poll for spray state (engine runs off refs to stay at 30 Hz without re-rendering)
  useEffect(() => {
    const id = setInterval(() => {
      const eng = engineRef.current;
      const p = getPose();
      const spraying = eng.sprayingNow.current && !eng.blocker.current;
      const blocker = eng.held.current ? eng.blocker.current : null;
      const yaw = Math.round(p.yaw) % 360;
      // only complain about aim while someone is actually holding a colour down
      const offWall = !!eng.held.current && !eng.blocker.current && eng.offWall.current;
      setUi((prev) => (prev.spraying === spraying && prev.blocker === blocker && prev.yaw === yaw && prev.offWall === offWall
        ? prev : { spraying, blocker, yaw, offWall }));
      const d = useStore.getState().debug;
      const held = eng.held.current ?? '-';
      const bl = eng.blocker.current ?? '-';
      const walls = discoveryRef.current.walls.length;
      if (d.held !== held || d.blocker !== bl || d.walls !== walls || d.poseReady !== p.ready) setDebug({ held, blocker: bl, walls, poseReady: p.ready });
    }, 100);
    return () => clearInterval(id);
  }, [setDebug]);

  // ---- wake lock ----------------------------------------------------------
  const requestWakeLock = useCallback(() => {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then((s) => { wakeRef.current = s; }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!live) return;
    const onVis = () => { if (document.visibilityState === 'visible') requestWakeLock(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      wakeRef.current?.release().catch(() => {});
      wakeRef.current = null;
    };
  }, [live, requestWakeLock]);

  // ---- camera -------------------------------------------------------------
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    v.srcObject = stream;
    v.muted = true;
    v.play().catch(() => {});
    // how much of the frame's width survives `object-fit: cover` (helps pick the AR scale in Settings)
    const onMeta = () => {
      const vw = v.videoWidth, vh = v.videoHeight;
      if (!vw || !vh) return;
      const W = v.clientWidth || window.innerWidth, H = v.clientHeight || window.innerHeight;
      const scale = Math.max(W / vw, H / vh);
      const visible = Math.min(1, W / (vw * scale));
      setDebug({ camera: `${vw}×${vh} ${Math.round(visible * 100)}% wide` });
    };
    v.addEventListener('loadedmetadata', onMeta);
    return () => { v.removeEventListener('loadedmetadata', onMeta); v.srcObject = null; };
  }, [stream, live, setDebug]);
  // pause the preview while another tab is showing (saves battery; permissions stay granted)
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    if (active) v.play().catch(() => {}); else v.pause();
  }, [active, stream]);
  useEffect(() => () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; }, []);

  /** (Re)opens the back camera; no gesture is needed once permission has been granted. */
  const acquireCamera = useCallback(async (): Promise<MediaStream> => {
    const md = navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function') throw new Error(window.isSecureContext ? 'no-media-devices' : 'insecure-context');
    const s = await md.getUserMedia(camConstraints());
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = s;
    setStream(s);
    setNotices((prev) => prev.filter((n) => n !== CAMERA_RESTART_MSG));
    return s;
  }, []);

  // iOS ends or mutes the capture track whenever the page is hidden (screen lock, call, app
  // switch) or another app takes the camera; nothing brings it back by itself. Re-request the
  // stream once we are visible again, and fall back to a tap-to-restart notice if that fails.
  useEffect(() => {
    if (!live || !stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    let restarting = false;
    let muteTimer: number | null = null;
    const restart = () => {
      if (restarting || document.visibilityState !== 'visible') return;
      restarting = true;
      acquireCamera()
        .catch(() => { setNotices((prev) => (prev.includes(CAMERA_RESTART_MSG) ? prev : [...prev, CAMERA_RESTART_MSG])); })
        .finally(() => { restarting = false; });
    };
    const onMute = () => {
      if (muteTimer != null) clearTimeout(muteTimer);
      muteTimer = window.setTimeout(() => {
        muteTimer = null;
        if (track.muted && document.visibilityState === 'visible') restart();
      }, CAMERA_MUTE_GRACE_MS);
    };
    const onUnmute = () => { if (muteTimer != null) { clearTimeout(muteTimer); muteTimer = null; } };
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      if (track.readyState !== 'live') restart();
      else if (track.muted) onMute();
    };
    track.addEventListener('ended', restart);
    track.addEventListener('mute', onMute);
    track.addEventListener('unmute', onUnmute);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      track.removeEventListener('ended', restart);
      track.removeEventListener('mute', onMute);
      track.removeEventListener('unmute', onUnmute);
      document.removeEventListener('visibilitychange', onVis);
      if (muteTimer != null) clearTimeout(muteTimer);
    };
  }, [live, stream, acquireCamera]);

  /** The gate. Every permission request is kicked off synchronously inside the tap so iOS honours them. */
  const onGate = () => {
    if (starting || live) return;
    setStarting(true);
    const poseP = startPose({ onShake: (m) => engineRef.current.onShake(m) });
    const sfxP = sfx.init();
    const camP = acquireCamera();
    // the camera can be refused before the sensor/audio awaits below reach it; mark the rejection
    // handled now so it never surfaces as an unhandled rejection (the real handling is the try/catch)
    camP.catch(() => {});
    requestWakeLock();
    lockPortrait();

    void (async () => {
      const msgs: string[] = [];
      // sound is non-essential (every sfx method no-ops until its buffer exists): open the gate once
      // sensors and camera have answered even if the WAVs are still downloading
      await Promise.race([sfxP.catch(() => {}), new Promise<void>((r) => setTimeout(r, SFX_GATE_TIMEOUT_MS))]);

      const sensors = await poseP.catch(() => 'unsupported' as const);
      if (sensors === 'denied') msgs.push('Motion access denied — reload and tap Allow, or turn on Motion & Orientation Access in Settings › Safari, then reload.');
      else if (sensors === 'unsupported') msgs.push('No motion sensors in this browser — open Tagged on a phone to aim. Arrow keys hold A / B here.');

      try {
        await camP;
        setDebug({ camera: 'ok' });
      } catch (e) {
        const name = e instanceof Error ? e.name : 'error';
        const message = e instanceof Error ? e.message : '';
        setDebug({ camera: message === 'insecure-context' ? 'https?' : message === 'no-media-devices' ? 'none' : name });
        msgs.push(cameraMessage(name, message));
      }

      setNotices(msgs);
      setLive(true);
      setStarting(false);
    })();
  };

  const onReport = useCallback((id: string) => {
    if (!window.confirm('Report this piece?\nTwo reports hide a piece for everyone.')) return;
    reportCanvas(id, useStore.getState().painter?.id ?? null, 'inappropriate')
      .catch((e: unknown) => { window.alert(`Could not send the report — ${e instanceof Error ? e.message : 'check your connection'}.`); });
  }, []);

  // Which wall you're standing at, and how far off it is. Walls are pinned to the spot they were
  // painted, so this is the difference between spraying onto a piece and spraying into the air.
  const canvases = useStore((s) => s.canvases);
  const wallState = ((): { kind: 'on' | 'walk' | 'new'; metres?: number; who?: string } => {
    if (!location) return { kind: 'new' };
    let best: { d: number; who: string } | null = null;
    for (const c of Object.values(canvases)) {
      if (c.flagged) continue;
      const d = haversineM(location.lat, location.lng, c.lat, c.lng);
      if (!best || d < best.d) best = { d, who: c.author_name };
    }
    if (!best || best.d > CANVAS_VISIBLE_RADIUS_M) return { kind: 'new' };
    if (best.d <= CANVAS_JOIN_RADIUS_M) return { kind: 'on', metres: 3, who: best.who };
    return { kind: 'walk', metres: best.d };
  })();

  const allNotices = locationStatus === 'denied' ? [...notices, LOCATION_DENIED_MSG] : notices;
  const gps = location ? `±${Math.round(location.accuracy)}m` : locationStatus === 'denied' ? 'denied' : '…';

  return (
    <div className={`paint${active ? '' : ' hidden'}`} aria-hidden={!active}>
      {!live ? (
        <div className="gate">
          <div className="brand">FRESCO</div>
          <div className="sub">Aim your phone at a wall. Hold A or B to spray. Shake the phone to charge the can.</div>
          <button type="button" className="gate-btn" onClick={onGate} disabled={starting}>{starting ? 'STARTING…' : 'START PAINTING'}</button>
          <div className="hint">Uses your camera, motion sensors and location.</div>
          {locationStatus === 'denied' && <div className="err">{LOCATION_DENIED_MSG}</div>}
          <button type="button" className="gate-link" onClick={() => setSettingsOpen(true)}>settings</button>
        </div>
      ) : (
        <>
          <video ref={videoRef} className="cam" playsInline muted autoPlay disablePictureInPicture />
          <PaintLayer walls={discovery.walls} />
          <Reticle spraying={ui.spraying} offWall={ui.offWall} />
          <CanMeter />
          <DiscoveryOverlay d={discovery} onReport={onReport} />
          <div className="hud-stack">
            {ui.blocker ? <BlockerBanner blocker={ui.blocker} />
              : ui.offWall ? <Line title="THAT'S PAST THE EDGE OF THIS WALL" sub="TURN BACK — OR LET GO AND SPRAY AGAIN TO START A NEW ONE" />
              : <WallChip state={wallState} />}
          </div>
          {tools && <ToolsTray onClose={() => setTools(false)} />}
          <HoldButtons onStart={engine.start} onEnd={engine.end} keyboard={active} onTools={() => setTools((v) => !v)} />

          <div className="topbar">
            <div className="topbar-brand">FRESCO</div>
            <div className="topbar-status">{painter?.name ?? '—'} · {online ? 'live' : 'offline'} · {ui.yaw}°</div>
            <button type="button" className="gear" aria-label="Settings" onClick={() => setSettingsOpen(true)}>⚙︎</button>
          </div>

          {allNotices.length > 0 && (
            <div className="notices">
              {allNotices.map((n) => (
                <button
                  key={n} type="button" className="notice"
                  onClick={() => {
                    // the camera notice restarts the camera from this gesture and clears itself on success
                    if (n === CAMERA_RESTART_MSG) acquireCamera().catch(() => {});
                    else setNotices((prev) => prev.filter((x) => x !== n));
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          )}

          <div className="hintline"><span>hold A / B to spray · shake to charge</span></div>
          <div className="debugline">
            held {debug.held} · block {debug.blocker} · walls {debug.walls} · pose {debug.poseReady ? 'ok' : '…'} · gps {gps} · sensors {debug.sensors} · camera {debug.camera}
          </div>
        </>
      )}
    </div>
  );
}

function cameraMessage(name: string, message: string) {
  if (message === 'insecure-context') return 'Camera needs a secure page — open Tagged over https://. Paint still works on a dark background.';
  if (message === 'no-media-devices') return 'This browser has no camera API — paint still works on a dark background.';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera blocked — allow it for this site (Safari: “aA” › Website Settings › Camera) and reload. Paint still works on a dark background.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No back camera found — painting on a dark background.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'Camera is busy in another app — close it and reload.';
  return `Camera unavailable (${name}) — painting on a dark background.`;
}
