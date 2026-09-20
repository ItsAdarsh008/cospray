import { useEffect } from 'react';
import { PALETTE, type Cap, type SprayOption } from '../config';
import { useStore } from '../store';
import { supabase } from '../lib/supabase';

// the cover-cropped preview shows ~36° across a phone's short edge; wider values for tablets / desktop webcams
const HFOV_OPTIONS = [28, 32, 36, 42, 48, 52, 58, 66];
const CAPS: Cap[] = ['fat', 'skinny'];

/** Bottom sheet modal. Web port of ../../src/screens/SettingsScreen.tsx (no volume / AR-plane options on the web). */
export function SettingsScreen() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const painter = useStore((s) => s.painter);
  const setShake = useStore((s) => s.setShake);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;

  const upd = (key: 'optionA' | 'optionB', patch: Partial<SprayOption>) => setSettings({ [key]: { ...settings[key], ...patch } });
  const signOut = async () => {
    setOpen(false);
    // App's session effect clears the persisted painter once the session is gone. Clearing it here
    // first flashes the tag prompt, and if the revoke request fails (offline) it would strand a
    // still-signed-in user on that prompt, where entering a new tag renames their painter.
    const { error } = await supabase.auth.signOut().catch((e: unknown) => ({ error: e }));
    if (error) window.alert('Could not sign out — check your connection and try again.');
  };

  return (
    <>
      <div className="sheet-backdrop" onClick={() => setOpen(false)} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="sheet-head">
          <div className="h1">SETTINGS</div>
          <button type="button" className="sheet-close" onClick={() => setOpen(false)}>Done</button>
        </div>

        {(['optionA', 'optionB'] as const).map((key) => (
          <section key={key} className="section">
            <div className="section-label">{key === 'optionA' ? 'HOLD A  →  option A' : 'HOLD B  →  option B'}</div>
            <div className="row" role="radiogroup" aria-label={`${key} colour`}>
              {PALETTE.map((c) => (
                <button
                  key={c} type="button" role="radio" aria-checked={settings[key].color === c} aria-label={c}
                  className={`swatch${settings[key].color === c ? ' on' : ''}`} style={{ backgroundColor: c }}
                  onClick={() => upd(key, { color: c })}
                />
              ))}
            </div>
            <div className="row" role="radiogroup" aria-label={`${key} cap`}>
              {CAPS.map((cap) => (
                <button key={cap} type="button" role="radio" aria-checked={settings[key].cap === cap} className={`pill${settings[key].cap === cap ? ' on' : ''}`} onClick={() => upd(key, { cap })}>
                  {cap} cap
                </button>
              ))}
            </div>
          </section>
        ))}

        <Row label="Paint anywhere (bypass Waterloo Region geofence)" value={settings.geofenceBypass} onChange={(v) => setSettings({ geofenceBypass: v })} />
        <Row label="Sound" value={settings.sound} onChange={(v) => setSettings({ sound: v })} />
        <Row label="Haptics (vibration, where the browser supports it)" value={settings.haptics} onChange={(v) => setSettings({ haptics: v })} />

        <section className="section" style={{ marginTop: 20 }}>
          <div className="section-label">AR SCALE (camera FOV, degrees): {settings.hfov}</div>
          <div className="row" role="radiogroup" aria-label="Camera field of view">
            {HFOV_OPTIONS.map((v) => (
              <button key={v} type="button" role="radio" aria-checked={settings.hfov === v} className={`pill${settings.hfov === v ? ' on' : ''}`} onClick={() => setSettings({ hfov: v })}>
                {v}
              </button>
            ))}
          </div>
        </section>

        <section className="section">
          <div className="section-label">DEBUG</div>
          <div className="row">
            <button type="button" className="pill" onClick={() => setShake(1)}>fill can</button>
            <button type="button" className="pill" onClick={signOut}>sign out ({painter?.name ?? '—'})</button>
          </div>
        </section>
      </div>
    </>
  );
}

function Row({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className="switch-row" role="switch" aria-checked={value} onClick={() => onChange(!value)}>
      <span>{label}</span>
      <span className={`switch${value ? ' on' : ''}`} aria-hidden />
    </button>
  );
}
