import { useEffect, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { GEOFENCE } from '../config';
import { renderPiece } from './render';
import { Detail } from './Gallery';
import { useWorld } from './useWorld';
import { isSample, timeAgo } from './data';
import type { Canvas } from '../types';

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const CAMPUS: L.LatLngTuple = [43.4723, -80.5449];
const THUMB = 72;

/**
 * Live map of Waterloo. Every canvas is a marker whose icon IS its current paint (strokes
 * rendered to a small canvas element); a realtime stroke insert re-renders that icon in place.
 */
export function World() {
  const w = useWorld();
  const [open, setOpen] = useState<Canvas | null>(null);
  const [selected, setSelected] = useState<Canvas | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markers = useRef(new Map<string, L.Marker>());

  useEffect(() => {
    const el = elRef.current; if (!el || mapRef.current) return;
    const map = L.map(el, { center: CAMPUS, zoom: 15, minZoom: 3, maxZoom: 19, zoomControl: false });
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTR, className: 'dark-tiles' }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.circle([GEOFENCE.lat, GEOFENCE.lng], { radius: GEOFENCE.radiusM, color: '#ff2d95', opacity: 0.35, weight: 1, fillColor: '#ff2d95', fillOpacity: 0.04, interactive: false }).addTo(map);
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; markers.current.clear(); };
  }, []);

  // markers: create/update one per canvas, icon = rendered paint
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    const seen = new Set<string>();
    for (const c of w.canvases) {
      seen.add(c.id);
      const strokes = w.strokesFor(c.id);
      const cv = document.createElement('canvas');
      renderPiece(cv, strokes, THUMB, THUMB, '#0f0f17');
      const wrap = document.createElement('div');
      wrap.className = `pin${isSample(c.id) ? ' sample' : ''}${strokes.length ? '' : ' empty'}`;
      wrap.append(cv);
      const label = document.createElement('div'); label.className = 'pin-label'; label.textContent = `${c.stroke_count} · ${c.author_name}`; wrap.append(label);
      const icon = L.divIcon({ html: wrap, className: 'pin-wrap', iconSize: [THUMB, THUMB + 16], iconAnchor: [THUMB / 2, THUMB / 2] });
      let m = markers.current.get(c.id);
      if (!m) {
        m = L.marker([c.lat, c.lng], { icon }).addTo(map);
        m.on('click', () => { setSelected(c); map.panTo([c.lat, c.lng]); });
        markers.current.set(c.id, m);
      } else { m.setIcon(icon); m.setLatLng([c.lat, c.lng]); m.off('click'); m.on('click', () => { setSelected(c); map.panTo([c.lat, c.lng]); }); }
    }
    for (const [id, m] of markers.current) if (!seen.has(id)) { m.remove(); markers.current.delete(id); }
    // first data: fit everything real
    if (w.canvases.length && !w.usingSamples && !fitted.current) { fitted.current = true; map.fitBounds(L.latLngBounds(w.canvases.map((c) => [c.lat, c.lng] as L.LatLngTuple)).pad(0.3), { maxZoom: 17 }); }
  }, [w.canvases, w.strokes]);
  const fitted = useRef(false);

  const total = w.canvases.reduce((a, c) => a + c.stroke_count, 0);
  return (
    <main className="world">
      <div ref={elRef} className="map" />
      <div className="map-chip">
        <b>{w.canvases.length}</b> canvases · <b>{total}</b> strokes · {w.live ? <span className="ok">● live</span> : '○ connecting…'}{w.usingSamples ? ' · sample spots' : ''}
      </div>
      {selected && (
        <aside className="side">
          <div className="side-head">
            <div><h2>{selected.title ?? `${selected.author_name}'s piece`}</h2><div className="muted">by {selected.author_name} · {timeAgo(selected.updated_at)}</div></div>
            <button type="button" className="x" onClick={() => setSelected(null)} aria-label="Close">✕</button>
          </div>
          <SidePiece id={selected.id} strokes={w.strokesFor(selected.id)} />
          <div className="stats small">
            <div><b>{selected.views}</b><span>views</span></div><div><b>{selected.stroke_count}</b><span>strokes</span></div><div><b>{w.strokesFor(selected.id).length}</b><span>loaded</span></div>
          </div>
          <button type="button" className="btn wide" onClick={() => setOpen(selected)}>Open piece →</button>
        </aside>
      )}
      {open && <Detail c={open} strokes={w.strokesFor(open.id)} onClose={() => setOpen(null)} />}
    </main>
  );
}

function SidePiece({ id, strokes }: { id: string; strokes: ReturnType<ReturnType<typeof useWorld>['strokesFor']> }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => { if (ref.current) renderPiece(ref.current, strokes, 300, 210); }, [id, strokes]);
  return <canvas ref={ref} className="side-img" />;
}
