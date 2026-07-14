import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Session, SupabaseClient, User } from '@supabase/supabase-js';

type AuthMode = 'sign-in' | 'sign-up';

export function AuthGate({
  supabase,
  children,
}: {
  supabase: SupabaseClient;
  children: (accountControl: ReactNode) => ReactNode;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (active) {
        setSession(data.session);
        setLoading(false);
      }
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [supabase]);

  if (loading) return <AuthLoading />;
  if (!session) return <AuthScreen supabase={supabase} />;

  return children(<AccountControl supabase={supabase} user={session.user} />);
}

function AuthLoading() {
  return (
    <main className="auth-screen">
      <div className="auth-card auth-card--centered">Loading your deliveries…</div>
    </main>
  );
}

function AuthScreen({ supabase }: { supabase: SupabaseClient }) {
  const [mode, setMode] = useState<AuthMode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result =
      mode === 'sign-in'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    if (result.error) {
      setError(result.error.message);
      setBusy(false);
      return;
    }
    if (!result.data.session) {
      setError('The account was created but still needs confirmation.');
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-card__emoji" aria-hidden="true">📦</div>
        <h1>My Deliveries</h1>
        <p>
          {mode === 'sign-in'
            ? 'Sign in to see the same parcels on every device.'
            : 'Create one durable account for your deliveries.'}
        </p>
        <label className="field">
          <span className="field__label">Email</span>
          <input
            className="field__input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label className="field">
          <span className="field__label">Password</span>
          <input
            className="field__input"
            type="password"
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error && <p className="sheet__error" role="alert">{error}</p>}
        <button className="button button--primary" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
        </button>
        <button
          className="auth-card__switch"
          type="button"
          onClick={() => {
            setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
            setError(null);
          }}
        >
          {mode === 'sign-in' ? 'Create an account' : 'I already have an account'}
        </button>
      </form>
    </main>
  );
}

function AccountControl({ supabase, user }: { supabase: SupabaseClient; user: User }) {
  const [open, setOpen] = useState(false);
  const anonymous = user.is_anonymous === true;

  return (
    <>
      <button
        type="button"
        className={`account-button${anonymous ? ' account-button--warning' : ''}`}
        aria-label={anonymous ? 'Protect this account' : 'Account'}
        onClick={() => setOpen(true)}
      >
        {anonymous ? 'Protect' : '👤'}
      </button>
      {open && (
        <AccountSheet
          supabase={supabase}
          user={user}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function AccountSheet({
  supabase,
  user,
  onClose,
}: {
  supabase: SupabaseClient;
  user: User;
  onClose: () => void;
}) {
  const anonymous = user.is_anonymous === true;
  const [email, setEmail] = useState(user.email ?? '');
  const [password, setPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function protectAccount(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const emailResult = await supabase.auth.updateUser({ email });
    if (emailResult.error) {
      setError(emailResult.error.message);
      setBusy(false);
      return;
    }
    const passwordResult = await supabase.auth.updateUser({ password });
    if (passwordResult.error) {
      setError(passwordResult.error.message);
      setBusy(false);
      return;
    }
    await supabase.auth.refreshSession();
    setMessage('Account protected. Use this email and password on your other devices.');
    setBusy(false);
  }

  async function recoverLegacy(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('claim_legacy_packages', {
      recovery_code: recoveryCode,
    });
    if (rpcError) {
      setError(rpcError.message);
      setBusy(false);
      return;
    }
    setMessage(`${Number(data) || 0} existing deliver${Number(data) === 1 ? 'y' : 'ies'} recovered.`);
    setRecoveryCode('');
    setBusy(false);
    window.setTimeout(() => window.location.reload(), 700);
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Account" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__grabber" aria-hidden="true" />
        <h2 className="sheet__title">{anonymous ? 'Protect your deliveries' : 'Your account'}</h2>
        {anonymous ? (
          <form className="sheet__form" onSubmit={protectAccount}>
            <p className="sheet__copy">
              This device still uses a temporary account. Add a login before browser storage is lost.
            </p>
            <label className="field">
              <span className="field__label">Email</span>
              <input className="field__input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label className="field">
              <span className="field__label">Password</span>
              <input className="field__input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
            </label>
            <button className="button button--primary" type="submit" disabled={busy}>Protect account</button>
          </form>
        ) : (
          <>
            <p className="sheet__copy">Signed in as {user.email}</p>
            <form className="sheet__form" onSubmit={recoverLegacy}>
              <label className="field">
                <span className="field__label">Recovery code for older deliveries</span>
                <input className="field__input" value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} autoCapitalize="characters" />
              </label>
              <button className="button button--secondary" type="submit" disabled={!recoveryCode || busy}>Recover</button>
            </form>
            <button className="button button--danger account-sheet__signout" type="button" onClick={() => void supabase.auth.signOut()}>
              Sign out
            </button>
          </>
        )}
        {message && <p className="sheet__success" role="status">{message}</p>}
        {error && <p className="sheet__error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
