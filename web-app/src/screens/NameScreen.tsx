import { useState, type FormEvent } from 'react';
import { ensurePainter } from '../data/sync';
import { useStore } from '../store';

export function NameScreen({ userId }: { userId: string }) {
  const setPainter = useStore((s) => s.setPainter);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const go = async (ev?: FormEvent) => {
    ev?.preventDefault();
    const n = name.trim().slice(0, 20);
    if (!n || busy) return;
    setBusy(true); setErr(null);
    try { setPainter(await ensurePainter(userId, n)); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    setBusy(false);
  };

  return (
    <div className="form-screen">
      <form className="form" onSubmit={go} noValidate>
        <div className="brand">FRESCO</div>
        <div className="sub">Paint the walls around you. Everyone here sees it.</div>
        <label className="label" htmlFor="tag-name">Pick your tag (signs your pieces)</label>
        <input
          id="tag-name" className="input input--pink" type="text" autoComplete="nickname" autoCapitalize="characters"
          autoCorrect="off" spellCheck={false} maxLength={20} placeholder="e.g. BANKSY_JR"
          value={name} onChange={(ev) => setName(ev.target.value)} enterKeyHint="go"
        />
        {err && <div className="err" role="alert">{err}</div>}
        <button type="submit" className="btn" disabled={busy || !name.trim()}>{busy ? '…' : 'START PAINTING'}</button>
      </form>
    </div>
  );
}
