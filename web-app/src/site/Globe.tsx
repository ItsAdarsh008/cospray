import { useEffect, useRef } from 'react';

const TILT = 0.42;
const WATERLOO = { lat: 43.47, lng: -80.54 };
const CITIES = [WATERLOO, { lat: 40.7, lng: -74 }, { lat: 37.8, lng: -122.4 }, { lat: 51.5, lng: -0.1 }, { lat: 48.9, lng: 2.3 }, { lat: 35.7, lng: 139.7 },
  { lat: -33.9, lng: 151.2 }, { lat: 19.4, lng: -99.1 }, { lat: -23.5, lng: -46.6 }, { lat: 28.6, lng: 77.2 }, { lat: 1.3, lng: 103.8 }, { lat: 30, lng: 31.2 }, { lat: 55.8, lng: 37.6 }, { lat: -1.3, lng: 36.8 }];

/** Same wireframe globe as the phone's launch screen, drawn with canvas 2D. Spins forever; Waterloo pulses pink. */
export function Globe({ size = 360 }: { size?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = size * dpr; el.height = size * dpr;
    const ctx = el.getContext('2d')!;
    const R = size * 0.36, CX = size / 2, CY = size / 2;
    const project = (latDeg: number, lngDeg: number, spin: number) => {
      const lat = (latDeg * Math.PI) / 180, lng = (lngDeg * Math.PI) / 180 + spin;
      const x = Math.cos(lat) * Math.sin(lng), y0 = Math.sin(lat), z0 = Math.cos(lat) * Math.cos(lng);
      const y = y0 * Math.cos(TILT) - z0 * Math.sin(TILT), z = y0 * Math.sin(TILT) + z0 * Math.cos(TILT);
      return { sx: CX + R * x, sy: CY - R * y, z };
    };
    let raf = 0; const t0 = performance.now();
    const line = (pts: { sx: number; sy: number; z: number }[], front: boolean) => {
      ctx.beginPath(); let pen = false;
      for (const p of pts) { if ((p.z >= 0) === front) { pen ? ctx.lineTo(p.sx, p.sy) : ctx.moveTo(p.sx, p.sy); pen = true; } else pen = false; }
      ctx.stroke();
    };
    const draw = (now: number) => {
      const spin = ((now - t0) / 1000) * 0.3;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      // atmosphere + body
      const glow = ctx.createRadialGradient(CX, CY, R * 0.9, CX, CY, R * 1.25);
      glow.addColorStop(0, 'rgba(25,230,255,0.35)'); glow.addColorStop(1, 'rgba(25,230,255,0)');
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(CX, CY, R * 1.25, 0, Math.PI * 2); ctx.fill();
      const body = ctx.createRadialGradient(CX - R * 0.35, CY - R * 0.4, 0, CX, CY, R * 1.4);
      body.addColorStop(0, '#1b2440'); body.addColorStop(0.6, '#0a0d1c'); body.addColorStop(1, '#03040a');
      ctx.fillStyle = body; ctx.beginPath(); ctx.arc(CX, CY, R, 0, Math.PI * 2); ctx.fill();
      const meridians = [] as { sx: number; sy: number; z: number }[][];
      for (let m = 0; m < 360; m += 20) meridians.push(Array.from({ length: 61 }, (_, i) => project(-90 + i * 3, m, spin)));
      for (let p = -60; p <= 60; p += 30) meridians.push(Array.from({ length: 121 }, (_, i) => project(p, i * 3, spin)));
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(25,230,255,0.12)'; for (const l of meridians) line(l, false);
      ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(25,230,255,0.55)'; for (const l of meridians) line(l, true);
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(25,230,255,0.8)'; ctx.beginPath(); ctx.arc(CX, CY, R, 0, Math.PI * 2); ctx.stroke();
      CITIES.forEach((c, i) => {
        const p = project(c.lat, c.lng, spin); if (p.z < 0) return;
        ctx.globalAlpha = 0.5 + 0.5 * p.z; ctx.fillStyle = i === 0 ? '#ff2d95' : '#ffe600';
        ctx.beginPath(); ctx.arc(p.sx, p.sy, 2.2 + p.z * 1.5, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      });
      const wl = project(WATERLOO.lat, WATERLOO.lng, spin);
      if (wl.z >= 0) {
        const pulse = 12 + 6 * Math.abs(Math.sin(spin * 4));
        const g = ctx.createRadialGradient(wl.sx, wl.sy, 0, wl.sx, wl.sy, pulse);
        g.addColorStop(0, 'rgba(255,45,149,0.6)'); g.addColorStop(1, 'rgba(255,45,149,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(wl.sx, wl.sy, pulse, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ff2d95'; ctx.beginPath(); ctx.arc(wl.sx, wl.sy, 4, 0, Math.PI * 2); ctx.fill();
      }
      // orbiting logo badge
      const a = spin * 2.2, ox = CX + R * 1.38 * Math.cos(a), oy = CY + R * 0.42 * Math.sin(a) - R * 0.1, oz = Math.sin(a);
      ctx.globalAlpha = oz > 0 ? 1 : 0.35;
      ctx.fillStyle = '#ff2d95'; ctx.beginPath(); ctx.arc(ox, oy, 13 + 3 * oz, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = '900 15px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('F', ox, oy + 1);
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);
  return <canvas ref={ref} style={{ width: size, height: size }} aria-hidden />;
}
