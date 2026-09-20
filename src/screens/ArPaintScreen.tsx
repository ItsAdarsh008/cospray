import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import { File, Paths } from 'expo-file-system';
import { ArPaintView, canSnapshot, canUndo, hasLidar, type ArHitEvent, type ArPaintViewRef, type ArStroke, type ArTrackingEvent, type HitKind } from '../../modules/ar-paint';
import { usePose } from '../hooks/usePose';
import { PaintLayer } from '../paint/PaintLayer';
import { useArSpray } from '../hooks/useArSpray';
import { useVolumeTrigger } from '../hooks/useVolumeTrigger';
import { useDiscovery } from '../hooks/useDiscovery';
import { BLOCKER_LINE, CreateHud, pullLine, type HudLine } from '../components/HUD';
import { DiscoveryCues } from '../components/DiscoveryOverlay';
import { PieceDetail } from '../components/SpatialViewer';
import { useStore } from '../store';
import { deleteStroke, downloadWorldMap, incrementViews, onRemoteStroke, uploadWorldMap } from '../data/sync';
import { CANVAS_JOIN_RADIUS_M } from '../config';
import { haversineM } from '../lib/geo';
import type { Blocker } from '../hooks/useSprayEngine';
import type { Canvas, Stroke } from '../types';

/**
 * AR APPROACH — real surfaces via ARKit (rung 1 of the ladder), in a small custom Expo module
 * (modules/ar-paint). ARKit detects horizontal + vertical planes; a raycast from the reticle
 * finds the surface you're aiming at; paint is composited into a texture on a 5 m quad glued to
 * a custom ARAnchor on that surface. Persistence + sharing: each canvas (GPS spot) stores its
 * ARWorldMap in Supabase Storage plus strokes in anchor-local metres. Walking up to a canvas
 * downloads its map; ARKit relocalises against it ("the piece resolves") and the strokes are
 * replayed onto anchors in the same world frame, so a second phone sees paint on the same wall.
 * Tradeoff: relocalisation needs roughly the same viewpoint and lighting as the painter had.
 */
/**
 * DETECTION: ARKit horizontal + vertical planes (+ LiDAR mesh when the phone has it). The reticle
 * raycasts detected plane geometry first, then the infinite extension of a known plane, then a
 * feature-point estimate — so you can spray within a second or two of raising the phone, and the
 * quad is pulled onto the real wall the moment ARKit confirms it (see ArPaintView.snap).
 * ANCHORING: every quad is a custom ARAnchor in the session's world map; the view stays mounted
 * across tabs and resumes (not resets) the session, so paint keeps its world pose. Restart: the
 * saved ARWorldMap relocalises the anchors; if that fails within RELOC_TIMEOUT_MS, strokes are
 * placed from where the painter stood relative to the camera now, then snapped to detected planes.
 */
const RELOC_TIMEOUT_MS = 15000;
/** How much of a wall's history ARKit is asked to rebuild when you walk up to it (see arStrokes). */
const MAX_REPLAY_QUADS = 6;
const MAX_REPLAY_STROKES = 80;

export function ArPaintScreen({ active = true }: { active?: boolean }) {
  useKeepAwake();
  const settings = useStore((s) => s.settings);
  const painter = useStore((s) => s.painter);
  const location = useStore((s) => s.location);
  const canvases = useStore((s) => s.canvases);
  const markDiscovered = useStore((s) => s.markDiscovered);

  const viewRef = useRef<ArPaintViewRef | null>(null);
  const engineRef = useRef<ReturnType<typeof useArSpray> | null>(null);
  const { pose, yawSV, pitchSV, rollSV } = usePose((m) => engineRef.current?.onShake(m));
  const mapCanvas = useRef<Canvas | null>(null); // canvas whose world map is loaded in the session
  const paintedThisSession = useRef(false);
  const failedMaps = useRef(new Set<string>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [worldMapPath, setWorldMapPath] = useState<string | null>(null);
  const [tracking, setTracking] = useState<ArTrackingEvent>({ state: 'limited', reason: 'initializing' });
  const [surfaces, setSurfaces] = useState(0);
  const [justFound, setJustFound] = useState<Canvas | null>(null);
  const [mapState, setMapState] = useState<'none' | 'loading' | 'relocalizing' | 'resolved' | 'approx'>('none');
  const [hitInfo, setHitInfo] = useState<{ kind: HitKind; vertical: boolean; locked: boolean; dist: number }>({ kind: 'none', vertical: false, locked: false, dist: 1 });
  const [hinted, setHinted] = useState(true); // first-run hint, hidden after the first spray
  const [detail, setDetail] = useState<Canvas | null>(null);
  const [mapNote, setMapNote] = useState<HudLine | null>(null);
  const [pieceId, setPieceId] = useState<string | null>(null); // the wall you're painting on / standing at
  const [flash, setFlash] = useState<HudLine | null>(null); // short-lived "that worked" line
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capturing = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const relocTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleMapSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const c = engineRef.current?.activeCanvas.current;
      if (!c || !viewRef.current) return;
      try {
        const path = `${Paths.cache.uri.replace('file://', '')}/${c.id}.arworldmap`;
        await viewRef.current.saveWorldMap(path);
        await uploadWorldMap(c.id, path);
      } catch (e) { console.warn('world map save failed', e); }
    }, 5000);
  }, []);

  /**
   * A photo of this wall for the Vault: the camera frame with the paint on it, kept on the phone
   * (there's no bucket for it on the backend). Taken a few seconds after you stop spraying, and on
   * demand from the camera button; the newest one replaces the last.
   */
  const captureWall = useCallback(async (): Promise<boolean> => {
    const c = engineRef.current?.activeCanvas.current;
    // a paused session (you left the tab) renders black, so never shoot one
    if (!c || !canSnapshot || !viewRef.current || capturing.current || !activeRef.current) return false;
    capturing.current = true;
    try {
      const path = `${Paths.document.uri.replace('file://', '')}/wall-${c.id}-${Date.now()}.jpg`;
      await viewRef.current.snapshot(path);
      const prev = useStore.getState().photos[c.id];
      useStore.getState().setPhoto(c.id, `file://${path}`);
      setPieceId(c.id);
      if (prev) { try { new File(prev).delete(); } catch {} }
      return true;
    } catch (e) {
      console.warn('wall photo failed', e);
      return false;
    } finally { capturing.current = false; }
  }, []);

  /** Take back your last stroke: the wall repaints without it and it leaves the shared canvas. */
  const onUndo = useCallback(async () => {
    let undone: { id: string } | null = null;
    try { undone = (await viewRef.current?.undoLast()) ?? null; } catch (e) { console.warn('undo failed', e); }
    if (undone) {
      const st = useStore.getState();
      const found = Object.entries(st.strokes).find(([, ss]) => ss.some((x) => x.id === undone!.id));
      if (found) {
        const [canvasId, ss] = found;
        const gone = ss.find((x) => x.id === undone!.id)!;
        st.removeStroke(canvasId, gone.id);
        const p = st.painter;
        if (p) st.setPainter({ ...p, strokes: Math.max(0, p.strokes - 1), paint_used: Math.max(0, p.paint_used - gone.paint_used) });
      }
      deleteStroke(undone.id);
      if (settings.haptics) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid).catch(() => {});
      // the wall photo now shows paint that isn't there any more
      if (captureTimer.current) clearTimeout(captureTimer.current);
      captureTimer.current = setTimeout(() => { captureWall(); }, 1500);
    }
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlash(undone ? { title: 'LAST STROKE UNDONE', icon: 'undo' } : { title: 'NOTHING TO UNDO', sub: 'ONLY THE STROKES YOU PAINTED HERE', icon: 'undo' });
    flashTimer.current = setTimeout(() => setFlash(null), 2200);
  }, [captureWall, settings.haptics]);

  useEffect(() => () => { [flashTimer, captureTimer].forEach((t) => t.current && clearTimeout(t.current)); }, []);

  const engine = useArSpray(pose, { onStrokeSaved: (s) => {
    paintedThisSession.current = true;
    scheduleMapSave();
    setPieceId(s.canvas_id);
    if (captureTimer.current) clearTimeout(captureTimer.current);
    captureTimer.current = setTimeout(() => { captureWall(); }, 4000);
  } });
  engineRef.current = engine;
  // canvases with a world map resolve by relocalisation; web-made canvases (no map) resolve by proximity
  const discovery = useDiscovery(pose, (c) => !c.world_map_path);

  useVolumeTrigger(settings.volumeButtons && active, { onHoldStart: engine.start, onHoldEnd: engine.end });
  useEffect(() => { if (!active && engine.held.current) engine.end(engine.held.current); }, [active]);

  // The canvas you're standing at: load its world map (relocalise), or, if it has AR strokes but
  // no usable map, place them from the painter's viewpoint. Once, and only before you paint here.
  useEffect(() => {
    if (!location || mapCanvas.current || paintedThisSession.current || mapState === 'approx') return;
    let best: Canvas | null = null, bestD = Infinity, approx: Canvas | null = null, approxD = Infinity;
    const st = useStore.getState();
    for (const c of Object.values(canvases)) {
      if (c.flagged || failedMaps.current.has(c.id)) continue;
      const d = haversineM(location.lat, location.lng, c.lat, c.lng);
      if (d >= CANVAS_JOIN_RADIUS_M) continue;
      if (c.world_map_path) { if (d < bestD) { best = c; bestD = d; } }
      else if ((st.strokes[c.id] ?? []).some((s) => s.anchor_id && s.viewer) && d < approxD) { approx = c; approxD = d; }
    }
    if (best) {
      mapCanvas.current = best;
      engine.activeCanvas.current = best;
      setPieceId(best.id);
      setMapState('loading');
      downloadWorldMap(best).then((p) => { if (p) setWorldMapPath(p); else { const c = mapCanvas.current; mapCanvas.current = null; if (c) placeApprox(c); } });
    } else if (approx) placeApprox(approx);
  }, [location?.lat, location?.lng, canvases, mapState]);

  // Strokes arriving live for the loaded canvas
  useEffect(() => onRemoteStroke((s: Stroke) => {
    const c = engine.activeCanvas.current;
    if (!c || s.canvas_id !== c.id || !s.anchor_id || !s.transform) return;
    if (s.author_id && s.author_id === painter?.id) return;
    viewRef.current?.addStrokes([{ id: s.id, anchorId: s.anchor_id, transform: s.transform, color: s.color, points: s.points as number[][] }]).catch(() => {});
  }), [painter?.id]);

  /**
   * Strokes to hand back to ARKit for a canvas. Every distinct anchor becomes its own quad with its
   * own texture, which is tens of megabytes each, so a wall with a day of painting on it can't be
   * replayed whole — the app gets killed for memory before it draws a frame. Newest anchors win.
   */
  const arStrokes = (c: Canvas | null) => {
    const all = (c ? useStore.getState().strokes[c.id] ?? [] : []).filter((s) => s.anchor_id && s.transform);
    const keep: Stroke[] = [];
    const anchors = new Set<string>();
    for (let i = all.length - 1; i >= 0; i--) { // newest first
      const s = all[i];
      if (!anchors.has(s.anchor_id!)) {
        if (anchors.size >= MAX_REPLAY_QUADS) continue;
        anchors.add(s.anchor_id!);
      }
      keep.push(s);
      if (keep.length >= MAX_REPLAY_STROKES) break;
    }
    return keep.reverse() // back to paint order, so later strokes sit on top
      .map((s) => ({ id: s.id, anchorId: s.anchor_id!, transform: s.transform!, color: s.color, points: s.points as number[][], viewer: s.viewer ?? undefined }));
  };

  /** No usable world map: fresh session, strokes placed from the painter's viewpoint relative to ours. */
  const placeApprox = useCallback(async (c: Canvas) => {
    failedMaps.current.add(c.id);
    engine.activeCanvas.current = c;
    setPieceId(c.id);
    try {
      await viewRef.current?.resetSession();
      setWorldMapPath(null);
      const ss = arStrokes(c).filter((s) => s.viewer);
      setTimeout(() => { if (ss.length) viewRef.current?.addStrokes(ss, 'relative').catch(() => {}); }, 1500); // let tracking initialise first
      setMapState(ss.length ? 'approx' : 'none');
      const st = useStore.getState();
      if (ss.length && !st.discovered[c.id] && c.author_id !== st.painter?.id) {
        markDiscovered(c.id); incrementViews(c.id);
        setJustFound({ ...c, views: c.views + 1 });
        setTimeout(() => setJustFound(null), 7000);
      }
    } catch { setMapState('none'); }
  }, []);

  const onTracking = useCallback((e: { nativeEvent: ArTrackingEvent }) => {
    const ev = e.nativeEvent;
    if (ev.state === 'mapLoaded') {
      setMapState('relocalizing');
      const strokes = arStrokes(mapCanvas.current);
      if (strokes.length) viewRef.current?.addStrokes(strokes, 'absolute').catch(() => {});
      if (relocTimer.current) clearTimeout(relocTimer.current);
      relocTimer.current = setTimeout(() => {
        const c = mapCanvas.current;
        if (c && !paintedThisSession.current) { mapCanvas.current = null; placeApprox(c); }
      }, RELOC_TIMEOUT_MS);
      return;
    }
    if (ev.state === 'mapLoadFailed') { const c = mapCanvas.current; mapCanvas.current = null; if (c) placeApprox(c); else setMapState('none'); return; }
    setTracking(ev);
    if (ev.state === 'normal' && mapCanvas.current && mapState === 'relocalizing') {
      if (relocTimer.current) { clearTimeout(relocTimer.current); relocTimer.current = null; }
      setMapState('resolved');
      const c = mapCanvas.current;
      const st = useStore.getState();
      if (!st.discovered[c.id] && c.author_id !== st.painter?.id) {
        markDiscovered(c.id); incrementViews(c.id);
        setJustFound({ ...c, views: c.views + 1 });
        setTimeout(() => setJustFound(null), 7000);
      }
    }
  }, [mapState, worldMapPath]);

  const onHit = useCallback((e: { nativeEvent: ArHitEvent }) => {
    const ev = e.nativeEvent;
    engine.hit.current = ev.hit;
    const kind = ev.kind ?? (ev.hit ? 'estimated' : 'none');
    if (ev.hit && ev.distance > 0) engine.dist.current = ev.distance;
    setHitInfo((p) => (p.kind === kind && p.vertical === !!ev.vertical && p.locked === !!ev.locked && Math.abs(p.dist - (ev.distance ?? p.dist)) < 0.1 ? p
      : { kind, vertical: !!ev.vertical, locked: !!ev.locked, dist: ev.distance || p.dist }));
  }, []);
  const onStrokeEnd = useCallback((e: { nativeEvent: ArStroke }) => engine.onNativeStroke(e.nativeEvent), []);
  const onSurface = useCallback((e: { nativeEvent: { count: number } }) => setSurfaces(e.nativeEvent.count), []);

  const [ui, setUi] = useState<{ blocker: Blocker; held: string }>({ blocker: null, held: '-' });
  useEffect(() => {
    const id = setInterval(() => {
      const blocker = engine.held.current ? engine.blocker.current : null;
      const held = engine.held.current ?? '-';
      if (held !== '-') setHinted(false);
      setUi((p) => (p.blocker === blocker && p.held === held ? p : { blocker, held }));
    }, 100);
    return () => clearInterval(id);
  }, []);

  // sharing state of the wall you're standing at, as one short-lived notice
  useEffect(() => {
    setMapNote(mapState === 'loading' ? { title: 'LOADING THE WALL HERE' }
      : mapState === 'relocalizing' ? { title: 'RESOLVING THE PIECE HERE', sub: 'LOOK AROUND SLOWLY' }
      : mapState === 'approx' ? { title: 'PIECE PLACED FROM MEMORY', sub: 'WALK TO WHERE IT WAS PAINTED' }
      : mapState === 'resolved' ? { title: 'PIECE RESOLVED' } : null);
    if (mapState !== 'approx' && mapState !== 'resolved') return;
    const id = setTimeout(() => setMapNote(null), 5000);
    return () => clearTimeout(id);
  }, [mapState]);

  const found = justFound ?? discovery.justFound;
  const piece = (pieceId ? canvases[pieceId] : null) ?? (pieceId === engine.activeCanvas.current?.id ? engine.activeCanvas.current : null);
  const notice: HudLine | null = ui.blocker ? BLOCKER_LINE[ui.blocker]
    : flash ? flash
    : found ? null
    : discovery.pull ? pullLine(discovery.pull)
    : mapNote ? mapNote
    : discovery.focused ? { title: `${discovery.focused.author_name}'s piece`.toUpperCase(), sub: 'TAP TO VIEW', icon: 'eye', onPress: () => setDetail(discovery.focused) }
    : hinted && (painter?.strokes ?? 0) < 5 ? { title: 'SHAKE TO CHARGE', sub: settings.volumeButtons ? 'THEN HOLD A COLOUR OR VOL+ / VOL−' : 'THEN HOLD A COLOUR TO SPRAY' }
    : null;

  return (
    <View style={styles.root}>
      <ArPaintView
        ref={viewRef}
        style={StyleSheet.absoluteFill}
        spraying={engine.native.spraying}
        paintColor={engine.native.color}
        radius={engine.native.radius}
        flow={engine.native.flow}
        showPlanes={settings.showPlanes}
        worldMapPath={worldMapPath}
        onTracking={onTracking}
        onHit={onHit}
        onStrokeEnd={onStrokeEnd}
        onSurface={onSurface}
      />
      {/* strokes painted from the web app (compass-anchored) render as an overlay on top of the AR view */}
      <PaintLayer yawSV={yawSV} pitchSV={pitchSV} rollSV={rollSV} walls={discovery.walls} />
      <DiscoveryCues d={{ ...discovery, justFound: found }} />
      <CreateHud
        status={surfaceLine(tracking, hitInfo, engine.native.spraying)}
        found={found}
        onOpenFound={() => found && setDetail(found)}
        notice={notice}
        debug={settings.debugHud ? `planes ${tracking.planes ?? 0} · quads ${surfaces} · ${hasLidar ? 'lidar' : 'no lidar'} · hit ${hitInfo.kind} · held ${ui.held} · block ${ui.blocker ?? '-'} · gps ${location ? `±${Math.round(location.accuracy)}m` : '…'} · map ${tracking.mapping || '-'}` : null}
        onStart={engine.start}
        onEnd={engine.end}
        onUndo={canUndo ? onUndo : null}
        pieceId={pieceId}
        onOpenPiece={() => piece && setDetail(piece)}
      />
      {detail && <PieceDetail canvas={detail} onClose={() => setDetail(null)} />}
    </View>
  );
}

/**
 * What the reticle is on, only while it matters: until a wall or floor locks (the hint disappears
 * once it does), and while spraying close or far enough to change the spray (focus / mist).
 */
function surfaceLine(tracking: ArTrackingEvent, hit: { kind: HitKind; locked: boolean; dist: number }, spraying: boolean): HudLine | null {
  if (hit.locked) {
    if (!spraying) return null;
    const mode = hit.dist < 0.8 ? 'FOCUS' : hit.dist > 1.5 ? 'MIST' : null;
    return mode ? { title: mode, sub: `${hit.dist.toFixed(1)} M FROM THE SURFACE` } : null;
  }
  if (tracking.state !== 'normal' && tracking.reason !== 'relocalizing' && hit.kind === 'none') {
    if (tracking.reason === 'excessiveMotion') return { title: 'SLOW DOWN', sub: 'MOVE THE PHONE GENTLY' };
    if (tracking.reason === 'insufficientFeatures') return { title: 'NOT ENOUGH DETAIL', sub: 'MORE LIGHT OR A TEXTURED WALL' };
    return { title: 'STARTING CAMERA', sub: 'MOVE THE PHONE SLOWLY' };
  }
  if (hit.kind === 'none') return { title: 'AIM AT A WALL OR FLOOR' };
  return { title: 'FINDING SURFACE', sub: 'MOVE SLOWLY' };
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
});
