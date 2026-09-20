import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * The way into the painter: a QR of this site's own /paint URL, generated in the browser so it is
 * always right — localhost while developing, the deployed origin in production. Show it on a
 * screen (or print it), scan, type a tag, paint. No account, no app install.
 */
export function ScanToPaint() {
  const [src, setSrc] = useState<string | null>(null);
  const url = `${window.location.origin}/paint`;

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, { margin: 1, width: 512, color: { dark: '#0b0b0f', light: '#ffffff' } })
      .then((d) => { if (!cancelled) setSrc(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [url]);

  return (
    <section className="scan">
      <div className="scan-copy">
        <h3>Scan to paint</h3>
        <p>
          Point a phone camera at this. You'll be asked for a tag, then you're spraying — no app,
          no account. Everyone painting nearby is on the same walls, and strokes show up live.
        </p>
        <a className="scan-url" href="/paint">{url}</a>
      </div>
      {src ? (
        <img className="scan-qr" src={src} width={220} height={220} alt={`QR code for ${url}`} />
      ) : (
        <div className="scan-qr scan-qr--empty" aria-hidden />
      )}
    </section>
  );
}
