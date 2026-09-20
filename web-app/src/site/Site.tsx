import { Landing } from './Landing';
import { World } from './World';
import { Gallery } from './Gallery';
import './site.css';

/** Judge-facing, read-only pages. Path-based so each one is a shareable URL. */
export function Site({ path }: { path: string }) {
  const page = path.startsWith('/world') ? 'world' : path.startsWith('/gallery') ? 'gallery' : 'home';
  return (
    <div className={`site site-${page}`}>
      <nav className="topnav">
        <a href="/" className="logo"><span className="logo-f">F</span> FRESCO</a>
        <div className="links">
          <a href="/world" className={page === 'world' ? 'on' : ''}>Live world</a>
          <a href="/gallery" className={page === 'gallery' ? 'on' : ''}>Gallery</a>
          <a href="/paint" className="paint">Paint on phone</a>
        </div>
      </nav>
      {page === 'home' && <Landing />}
      {page === 'world' && <World />}
      {page === 'gallery' && <Gallery />}
    </div>
  );
}
