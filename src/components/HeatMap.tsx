import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import MapView, { Circle, Marker } from 'react-native-maps';
import { GEOFENCE } from '../config';
import { useStore } from '../store';
import type { Canvas } from '../types';

/** Hot-zone heat map: every canvas glows in proportion to how much paint is on it. */
export function HeatMap({ canvases, height = 190, interactive = false }: { canvases: Canvas[]; height?: number; interactive?: boolean }) {
  const loc = useStore((s) => s.location);
  const discovered = useStore((s) => s.discovered);
  const region = useMemo(() => {
    const c = canvases[0];
    return { latitude: loc?.lat ?? c?.lat ?? GEOFENCE.lat, longitude: loc?.lng ?? c?.lng ?? GEOFENCE.lng, latitudeDelta: 0.014, longitudeDelta: 0.014 };
  }, [loc?.lat, loc?.lng, canvases.length]);
  return (
    <View style={[{ height }, interactive && StyleSheet.absoluteFill]}>
      <MapView style={StyleSheet.absoluteFill} userInterfaceStyle="dark" showsUserLocation initialRegion={region}
        scrollEnabled={interactive} zoomEnabled={interactive} rotateEnabled={false} pitchEnabled={false} toolbarEnabled={false}>
        {canvases.map((c) => {
          const heat = Math.min(1, (c.stroke_count + c.views * 0.5) / 60);
          const r = 40 + heat * 160;
          return (
            <React.Fragment key={c.id}>
              <Circle center={{ latitude: c.lat, longitude: c.lng }} radius={r} strokeWidth={0} fillColor={`rgba(255,61,85,${0.12 + heat * 0.1})`} />
              <Circle center={{ latitude: c.lat, longitude: c.lng }} radius={r * 0.62} strokeWidth={0} fillColor={`rgba(255,138,31,${0.18 + heat * 0.15})`} />
              <Circle center={{ latitude: c.lat, longitude: c.lng }} radius={r * 0.3} strokeWidth={0} fillColor={`rgba(255,210,31,${0.35 + heat * 0.3})`} />
              {interactive && <Marker coordinate={{ latitude: c.lat, longitude: c.lng }} title={`${c.author_name} · ${c.stroke_count} strokes`} description={`${c.views} views${discovered[c.id] ? ' · found' : ''}`} pinColor={discovered[c.id] ? '#59d92d' : '#ff3d55'} />}
            </React.Fragment>
          );
        })}
      </MapView>
    </View>
  );
}
