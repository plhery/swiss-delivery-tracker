import { useState, type FormEvent } from 'react';

export function SignInScreen({
  configured,
  googleEnabled = false,
  emailOtpEnabled = true,
  signInWithGoogle,
  sendCode,
  verifyCode,
}: {
  configured: boolean;
  googleEnabled?: boolean;
  emailOtpEnabled?: boolean;
  signInWithGoogle?: () => Promise<void>;
  sendCode: (email: string) => Promise<void>;
  verifyCode: (email: string, code: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startGoogleSignIn() {
    if (working || !signInWithGoogle) return;
    setWorking(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not start Google sign-in');
      setWorking(false);
    }
  }

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
        <p className="auth-card__eyebrow">Swiss Delivery Tracker</p>
        <h1 id="sign-in-title">
          Sign in to start tracking your Post.CH, UPS, DHL, ... packages!
        </h1>
        {!configured ? (
          <div className="auth-card__configuration" role="alert">
            <strong>Authentication needs configuration.</strong>
            <span>
              Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` when
              building the production app.
            </span>
          </div>
        ) : codeSent && emailOtpEnabled ? (
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
          <div className="auth-card__methods">
            {googleEnabled && signInWithGoogle && (
              <button
                className="button auth-card__google"
                type="button"
                disabled={working}
                onClick={() => void startGoogleSignIn()}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path fill="#4285f4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.6h3.2c1.9-1.8 3-4.4 3-7.5Z" />
                  <path fill="#34a853" d="M12 22c2.7 0 5-.9 6.6-2.3l-3.2-2.6c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.2H3.1v2.7A10 10 0 0 0 12 22Z" />
                  <path fill="#fbbc05" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.4H3.1a10 10 0 0 0 0 9.2l3.3-2.7Z" />
                  <path fill="#ea4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.8A9.7 9.7 0 0 0 3.1 7.4l3.3 2.7c.8-2.4 3-4.2 5.6-4.2Z" />
                </svg>
                {working ? 'Opening Google…' : 'Continue with Google'}
              </button>
            )}
            {googleEnabled && emailOtpEnabled && (
              <div className="auth-card__divider"><span>or</span></div>
            )}
            {emailOtpEnabled && (
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
                  autoFocus={!googleEnabled}
                  required
                />
                {error && <p className="auth-card__error" role="alert">{error}</p>}
                <button className="button button--primary" type="submit" disabled={working}>
                  {working ? 'Sending code…' : 'Email me a code'}
                </button>
              </form>
            )}
            {!emailOtpEnabled && error && (
              <p className="auth-card__error" role="alert">{error}</p>
            )}
          </div>
        )}
        <p className="auth-card__privacy">
          Tracking numbers and delivery history stay private to your account.{' '}
          <a href="/privacy.html">Read the privacy notice.</a>
        </p>
      </section>
    </main>
  );
}
