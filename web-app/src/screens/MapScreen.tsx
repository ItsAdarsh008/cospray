import { useEffect, useMemo, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { GEOFENCE } from '../config';
import { useStore } from '../store';
import { fetchAllCanvases } from '../data/sync';
import type { Canvas } from '../types';

/**
 * Port of the native MapScreen (react-native-maps → Leaflet + OpenStreetMap). Every known canvas
 * is a dot: pink until you've stood next to it, green once discovered. Remote canvases refresh
 * every 10 s and are merged with whatever the store already holds (local wins, same as native).
 */

const REFRESH_MS = 10_000;
const INITIAL_ZOOM = 15;
const PINK = '#ff2d95';
const GREEN = '#7cff3a';
const USER_BLUE = '#2f7bff';

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function markerStyle(found: boolean): L.CircleMarkerOptions {
  const color = found ? GREEN : PINK;
  return { radius: 8, color: '#0b0b0f', weight: 2, opacity: 0.9, fillColor: color, fillOpacity: 0.95 };
}

/** Popup body built from DOM nodes (author names are user content — never interpolate into HTML). */
function popupContent(c: Canvas): HTMLElement {
  const root = document.createElement('div');
  root.className = 'tg-pop';
  const title = document.createElement('div');
  title.className = 'tg-pop-title';
  title.textContent = `${c.author_name} · ${c.stroke_count} strokes`;
  const meta = document.createElement('div');
  meta.className = 'tg-pop-meta';
  meta.textContent = `${c.views} views · ${timeAgo(c.created_at)}`;
  root.append(title, meta);
  return root;
}

export function MapScreen() {
  const loc = useStore((s) => s.location);
  const local = useStore((s) => s.canvases);
  const discovered = useStore((s) => s.discovered);
  const [remote, setRemote] = useState<Canvas[]>([]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, L.CircleMarker>>(new Map());
  const userDotRef = useRef<L.CircleMarker | null>(null);
  const userHaloRef = useRef<L.Circle | null>(null);
  const centeredOnUser = useRef(false);

  // remote canvases: fetch now and every 10 s
  useEffect(() => {
    let alive = true;
    const pull = () => {
      fetchAllCanvases()
        .then((cs: Canvas[]) => { if (alive) setRemote(cs); })
        .catch(() => {});
    };
    pull();
    const id = window.setInterval(pull, REFRESH_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  const canvases = useMemo(() => {
    const all = new Map<string, Canvas>();
    for (const c of remote) all.set(c.id, c);
    for (const c of Object.values(local)) all.set(c.id, c);
    return [...all.values()].filter((c) => !c.flagged);
  }, [remote, local]);

  // map lifecycle: create once, tear down on unmount
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const start = useStore.getState().location;
    const map = L.map(el, {
      center: [start?.lat ?? GEOFENCE.lat, start?.lng ?? GEOFENCE.lng],
      zoom: INITIAL_ZOOM,
      minZoom: 3,
      maxZoom: 19,
      zoomControl: false,
      attributionControl: true,
    });
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);
    // native: strokeColor #ff2d9566 / fillColor #ff2d9511
    L.circle([GEOFENCE.lat, GEOFENCE.lng], {
      radius: GEOFENCE.radiusM,
      color: PINK,
      opacity: 0.4,
      weight: 1,
      fillColor: PINK,
      fillOpacity: 0.067,
      interactive: false,
    }).addTo(map);
    mapRef.current = map;
    centeredOnUser.current = !!start;
    const markers = markersRef.current;

    // the container's size can settle after first paint (address bar, rotation); keep tiles aligned
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    requestAnimationFrame(() => map.invalidateSize());

    return () => {
      ro.disconnect();
      for (const m of markers.values()) m.remove();
      markers.clear();
      userDotRef.current = null;
      userHaloRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // user location: blue dot + accuracy halo; recentre once when the first fix arrives
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!loc) {
      userDotRef.current?.remove(); userDotRef.current = null;
      userHaloRef.current?.remove(); userHaloRef.current = null;
      return;
    }
    const ll: L.LatLngExpression = [loc.lat, loc.lng];
    const acc = Math.max(0, loc.accuracy || 0);
    if (!userHaloRef.current) {
      userHaloRef.current = L.circle(ll, { radius: acc, color: USER_BLUE, opacity: 0.25, weight: 1, fillColor: USER_BLUE, fillOpacity: 0.12, interactive: false }).addTo(map);
    } else {
      userHaloRef.current.setLatLng(ll).setRadius(acc);
    }
    if (!userDotRef.current) {
      userDotRef.current = L.circleMarker(ll, { radius: 7, color: '#ffffff', weight: 2, opacity: 1, fillColor: USER_BLUE, fillOpacity: 1, interactive: false, pane: 'markerPane' }).addTo(map);
    } else {
      userDotRef.current.setLatLng(ll);
    }
    if (!centeredOnUser.current) {
      centeredOnUser.current = true;
      map.setView(ll, INITIAL_ZOOM);
    }
  }, [loc]);

  // canvas markers: diff by id so an open popup survives the 10 s refresh
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markers = markersRef.current;
    const seen = new Set<string>();
    for (const c of canvases) {
      seen.add(c.id);
      const style = markerStyle(!!discovered[c.id]);
      const ll: L.LatLngExpression = [c.lat, c.lng];
      const existing = markers.get(c.id);
      if (existing) {
        existing.setLatLng(ll).setStyle(style);
        existing.setPopupContent(popupContent(c));
      } else {
        const m = L.circleMarker(ll, style).addTo(map);
        m.bindPopup(popupContent(c), { className: 'tg-popup', closeButton: true, autoPanPaddingBottomRight: [16, 110] });
        markers.set(c.id, m);
      }
    }
    for (const [id, m] of markers) {
      if (!seen.has(id)) { m.remove(); markers.delete(id); }
    }
  }, [canvases, discovered]);

  return (
    <div className="tg-map-root">
      <style>{MAP_CSS}</style>
      <div ref={containerRef} className="tg-map" />
      <div className="tg-map-chip">{canvases.length} pieces · pink = undiscovered · green = found</div>
    </div>
  );
}

const MAP_CSS = `
.tg-map-root{position:relative;width:100%;height:100vh;height:100dvh;overflow:hidden;background:#0b0b0f}
.tg-map{position:absolute;left:0;right:0;top:0;bottom:90px;background:#0b0b0f;-webkit-tap-highlight-color:transparent}
.tg-map .leaflet-tile-pane{filter:invert(1) hue-rotate(180deg) brightness(.85) contrast(.9) saturate(.6)}
.tg-map .leaflet-control-attribution{background:#000a;color:#ffffff88;font-size:10px;padding:2px 6px}
.tg-map .leaflet-control-attribution a{color:#ffffffcc}
.tg-map .leaflet-popup-content-wrapper{background:#0b0b0fee;color:#fff;border:1px solid #ffffff22;border-radius:12px;box-shadow:0 6px 20px #000a}
.tg-map .leaflet-popup-content{margin:10px 14px;line-height:1.35}
.tg-map .leaflet-popup-tip{background:#0b0b0fee;border:1px solid #ffffff22;border-top:0;border-left:0}
.tg-map .leaflet-popup-close-button{color:#ffffff88;font-size:16px;padding:4px 6px 0 0}
.tg-map .leaflet-popup-close-button:hover{color:#fff}
.tg-map .leaflet-container{font-family:-apple-system,system-ui,sans-serif}
.tg-pop-title{font-weight:800;font-size:13px;white-space:nowrap}
.tg-pop-meta{color:#ffffffaa;font-size:11px;margin-top:2px;white-space:nowrap}
.tg-map-chip{position:absolute;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top,0px) + 16px);background:#000a;color:#fff;font-size:12px;font-weight:600;padding:6px 14px;border-radius:16px;white-space:nowrap;pointer-events:none;z-index:500}
`;
