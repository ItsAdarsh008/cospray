import { useState, type FormEvent } from 'react';
import { hasBackend, supabase } from '../lib/supabase';

/**
 * Fallback only. Scanning the QR signs people in anonymously; this form appears when that fails
 * (anonymous sign-ins disabled on the project, or the server is unreachable).
 *
 * Email + password, one button. "Sign in" tries to sign in; if the account doesn't exist it
 * creates it and signs in. If the project has "Confirm email" on, sign-up returns no session
 * and we tell the user to tap the link in their inbox and press the button again.
 */
export function AuthScreen({ note }: { note?: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const go = async (ev?: FormEvent) => {
    ev?.preventDefault();
    if (busy) return;
    const e = email.trim().toLowerCase();
    if (!e || password.length < 6) { setMsg('Enter your email and a password (6+ characters).'); return; }
    if (!hasBackend) { setMsg('No backend configured — set VITE_SUPABASE_URL and VITE_SUPABASE_KEY.'); return; }
    setBusy(true); setMsg(null);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: e, password });
      if (!error) return; // onAuthStateChange takes over
      // GoTrue returns stable codes; older servers only the message text
      if (error.code === 'email_not_confirmed' || /not confirmed/i.test(error.message)) { setMsg('Confirm the link we emailed you, then tap Sign in again.'); return; }
      if (error.code !== 'invalid_credentials' && !/invalid login/i.test(error.message)) { setMsg(error.message); return; }
      const { data, error: e2 } = await supabase.auth.signUp({ email: e, password });
      if (e2) { setMsg(e2.message); return; }
      // with "Confirm email" on, GoTrue answers a sign-up for an existing address with a stub user
      // (no identities) instead of an error — that was a wrong password, not a new account
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) { setMsg('That email already has an account — check your password.'); return; }
      if (!data.session) setMsg('Account created — confirm the link we emailed you, then tap Sign in again.');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Network error');
    } finally { setBusy(false); }
  };

  return (
    <div className="form-screen">
      <form className="form" onSubmit={go} noValidate>
        <div className="brand">FRESCO</div>
        <div className="sub">r/place, but graffiti in the real world.</div>
        {note && <div className="hint">Could not start a guest session ({note}). Sign in instead.</div>}
        <label className="label" htmlFor="auth-email">Email</label>
        <input
          id="auth-email" className="input" type="email" inputMode="email" autoComplete="email"
          autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="you@uwaterloo.ca"
          value={email} onChange={(ev) => setEmail(ev.target.value)} enterKeyHint="next"
        />
        <label className="label" htmlFor="auth-password">Password</label>
        <input
          id="auth-password" className="input" type="password" autoComplete="current-password" placeholder="••••••"
          value={password} onChange={(ev) => setPassword(ev.target.value)} enterKeyHint="go"
        />
        {msg && <div className="msg" role="alert">{msg}</div>}
        <button type="submit" className="btn" disabled={busy}>{busy ? '…' : 'SIGN IN'}</button>
        <div className="hint">No account yet? Same button — it creates one.</div>
      </form>
    </div>
  );
}
