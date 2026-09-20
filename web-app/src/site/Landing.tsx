import { Globe } from './Globe';
import { useWorld } from './useWorld';
import { ScanToPaint } from './ScanToPaint';

export function Landing() {
  const w = useWorld();
  const strokes = Object.values(w.strokes).reduce((a, s) => a + s.length, 0);
  return (
    <main className="land">
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">HACK THE NORTH 2026</div>
          <h1>FRESCO</h1>
          <p className="lede">The world is your wall. Aim your phone like a spray can, hold to paint, and your piece stays on that spot for everyone who walks up to it later.</p>
          <div className="cta-row">
            <a className="btn" href="/world">See the live world →</a>
            <a className="btn ghost" href="/gallery">Gallery & leaderboard</a>
          </div>
          <div className="pills">
            <span className="pill"><b>{w.canvases.length}</b> canvases</span>
            <span className="pill"><b>{strokes}</b> strokes</span>
            <span className="pill"><b>{w.painters.length}</b> painters</span>
            <span className={`pill ${w.live ? 'ok' : ''}`}>{w.live ? '● live from Supabase' : '○ connecting…'}</span>
          </div>
        </div>
        <div className="hero-globe"><Globe size={Math.min(420, Math.floor(window.innerWidth * 0.9))} /></div>
      </section>
      <ScanToPaint />
      <section className="how">
        <div className="card"><div className="k">01</div><h3>Shake the can</h3><p>Real accelerometer shake charges the can. Hollow rattle when it's low.</p></div>
        <div className="card"><div className="k">02</div><h3>Hold to spray</h3><p>Volume buttons or on-screen hold buttons. ARKit finds the wall; paint is composited into a texture glued to it.</p></div>
        <div className="card"><div className="k">03</div><h3>It stays there</h3><p>The AR world map and every stroke sync to Supabase. Walk up later — or open this site — and the piece is still on the wall.</p></div>
      </section>
      <footer className="foot">Read-only companion. Painting happens on the phone — <a href="/paint">or in a phone browser</a>.</footer>
    </main>
  );
}
