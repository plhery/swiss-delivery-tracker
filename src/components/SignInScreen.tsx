import { useState, type FormEvent } from 'react';

export function SignInScreen({
  configured,
  sendCode,
  verifyCode,
}: {
  configured: boolean;
  sendCode: (email: string) => Promise<void>;
  verifyCode: (email: string, code: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestCode(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await sendCode(email.trim().toLowerCase());
      setCodeSent(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not send a sign-in code');
    } finally {
      setWorking(false);
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await verifyCode(email.trim().toLowerCase(), code.replace(/\s/g, ''));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not verify the sign-in code');
    } finally {
      setWorking(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="sign-in-title">
        <div className="auth-card__mark" aria-hidden="true"><span /></div>
        <p className="auth-card__eyebrow">Parcel Post</p>
        <h1 id="sign-in-title">Your deliveries, one code away.</h1>
        {!configured ? (
          <div className="auth-card__configuration" role="alert">
            <strong>Authentication needs configuration.</strong>
            <span>
              Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` when
              building the production app.
            </span>
          </div>
        ) : codeSent ? (
          <form onSubmit={(event) => void submitCode(event)}>
            <p className="auth-card__intro">
              Enter the six-digit code sent to <strong>{email}</strong>.
            </p>
            <label htmlFor="sign-in-code">Sign-in code</label>
            <input
              id="sign-in-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              minLength={6}
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              autoFocus
              required
            />
            {error && <p className="auth-card__error" role="alert">{error}</p>}
            <button className="button button--primary" type="submit" disabled={working}>
              {working ? 'Signing in…' : 'Open my delivery box'}
            </button>
            <button
              className="auth-card__text-button"
              type="button"
              onClick={() => {
                setCodeSent(false);
                setCode('');
                setError(null);
              }}
              disabled={working}
            >
              Use a different email
            </button>
          </form>
        ) : (
          <form onSubmit={(event) => void requestCode(event)}>
            <p className="auth-card__intro">
              No password to remember. We’ll email you a one-time sign-in code.
            </p>
            <label htmlFor="sign-in-email">Email address</label>
            <input
              id="sign-in-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoFocus
              required
            />
            {error && <p className="auth-card__error" role="alert">{error}</p>}
            <button className="button button--primary" type="submit" disabled={working}>
              {working ? 'Sending code…' : 'Email me a code'}
            </button>
          </form>
        )}
        <p className="auth-card__privacy">
          Tracking numbers and delivery history stay private to your account.
        </p>
      </section>
    </main>
  );
}
