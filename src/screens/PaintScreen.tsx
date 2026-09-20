import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Btn } from '../ui/kit';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useKeepAwake } from 'expo-keep-awake';
import { PaintLayer } from '../paint/PaintLayer';
import { usePose } from '../hooks/usePose';
import { useSprayEngine, type Blocker } from '../hooks/useSprayEngine';
import { useVolumeTrigger } from '../hooks/useVolumeTrigger';
import { useDiscovery } from '../hooks/useDiscovery';
import { BLOCKER_LINE, CreateHud, pullLine, Reticle, type HudLine } from '../components/HUD';
import { F } from '../ui/theme';
import { DiscoveryCues } from '../components/DiscoveryOverlay';
import { PieceDetail } from '../components/SpatialViewer';
import { useStore } from '../store';
import type { Canvas } from '../types';

/**
 * AR APPROACH — geo-anchored canvases (rung 2 of the fallback ladder), chosen deliberately:
 *  - True plane-anchored ARKit via Viro would need a native AR module fighting a brand-new
 *    RN/Expo SDK, and world-anchor sharing across phones (ARWorldMap/cloud anchors) is a
 *    multi-day problem on its own. Not a 36-hour bet.
 *  - So a canvas = a virtual cylindrical wall around the spot where its author stood, keyed
 *    by GPS. Paint lives in angular coordinates (compass yaw, pitch). Sensor fusion (gyro +
 *    magnetometer + gravity) gives a smooth camera pose, so as you turn the phone the paint
 *    stays glued to the direction you sprayed it — it reads as "on the wall" from where the
 *    painter stood, and anyone standing within ~15 m sees the same piece in the same direction.
 *  - Tradeoff: parallax. Step 5 m sideways and the paint drifts relative to the real wall
 *    (it's anchored to a direction, not a surface). GPS jitter (~3-5 m) also means two phones
 *    a few metres apart see slightly offset paint. For a campus-scale r/place demo that's
 *    acceptable; the README lists what real plane anchoring would fix.
 */
export function PaintScreen({ active = true }: { active?: boolean }) {
  useKeepAwake();
  const [perm, requestPerm] = useCameraPermissions();
  const settings = useStore((s) => s.settings);
  const painter = useStore((s) => s.painter);
  const location = useStore((s) => s.location);
  const debug = useStore((s) => s.debug);
  const setDebug = useStore((s) => s.setDebug);
  const engineRef = useRef<ReturnType<typeof useSprayEngine> | null>(null);
  const { yawSV, pitchSV, rollSV, pose } = usePose((m) => engineRef.current?.onShake(m));
  const engine = useSprayEngine(pose);
  engineRef.current = engine;
  const discovery = useDiscovery(pose);
  const discoveryRef = useRef(discovery);
  discoveryRef.current = discovery;
  const [hinted, setHinted] = useState(true); // first-run hint, hidden after the first spray
  const [detail, setDetail] = useState<Canvas | null>(null);

  useVolumeTrigger(settings.volumeButtons && active, { onHoldStart: engine.start, onHoldEnd: engine.end });
  useEffect(() => { if (!active && engine.held.current) engine.end(engine.held.current); }, [active]);

  // cheap UI poll for spray state (engine runs off refs to stay at 30Hz without re-rendering)
  const [ui, setUi] = useState<{ spraying: boolean; blocker: Blocker }>({ spraying: false, blocker: null });
  useEffect(() => {
    const id = setInterval(() => {
      const spraying = engine.sprayingNow.current && !engine.blocker.current;
      const blocker = engine.held.current ? engine.blocker.current : null;
      setUi((p) => (p.spraying === spraying && p.blocker === blocker ? p : { spraying, blocker }));
      const d = useStore.getState().debug;
      const held = engine.held.current ?? '-';
      if (held !== '-') setHinted(false);
      const bl = engine.blocker.current ?? '-';
      if (d.held !== held || d.blocker !== bl || d.walls !== discoveryRef.current.walls.length || d.poseReady !== pose.current.ready)
        setDebug({ held, blocker: bl, walls: discoveryRef.current.walls.length, poseReady: pose.current.ready });
    }, 100);
    return () => clearInterval(id);
  }, []);

  useEffect(() => { if (perm && !perm.granted && perm.canAskAgain) requestPerm(); }, [perm]);

  if (!perm?.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.msg}>Camera permission is needed to paint.</Text>
        <Btn label="ALLOW CAMERA" tone="green" onPress={requestPerm} />
      </View>
    );
  }

  const found = discovery.justFound;
  const notice: HudLine | null = ui.blocker ? BLOCKER_LINE[ui.blocker]
    : found ? null
    : discovery.pull ? pullLine(discovery.pull)
    : discovery.focused ? { title: `${discovery.focused.author_name}'s piece`.toUpperCase(), sub: 'TAP TO VIEW', icon: 'eye', onPress: () => setDetail(discovery.focused) }
    : hinted && (painter?.strokes ?? 0) < 5 ? { title: 'SHAKE TO CHARGE', sub: settings.volumeButtons ? 'THEN HOLD A COLOUR OR VOL+ / VOL−' : 'THEN HOLD A COLOUR TO SPRAY' }
    : null;

  return (
    <View style={styles.root}>
      <CameraView style={StyleSheet.absoluteFill} facing="back" animateShutter={false} mute />
      <PaintLayer yawSV={yawSV} pitchSV={pitchSV} rollSV={rollSV} walls={discovery.walls} />
      <Reticle spraying={ui.spraying} />
      <DiscoveryCues d={discovery} />
      <CreateHud
        found={found}
        onOpenFound={() => found && setDetail(found)}
        notice={notice}
        debug={settings.debugHud ? `vol events ${debug.volEvents} (last ${debug.lastVol}) · held ${debug.held} · block ${debug.blocker} · walls ${debug.walls} · pose ${debug.poseReady ? 'ok' : '…'} · gps ${location ? `±${Math.round(location.accuracy)}m` : '…'} · surface ${debug.surface}` : null}
        onStart={engine.start}
        onEnd={engine.end}
      />
      {detail && <PieceDetail canvas={detail} onClose={() => setDetail(null)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#12082b', padding: 24, gap: 16 },
  msg: { fontFamily: F.body, color: '#fff', fontSize: 16, textAlign: 'center' },
});
