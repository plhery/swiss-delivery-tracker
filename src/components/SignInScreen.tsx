import { useState, type FormEvent } from 'react';
import { LanguageControl, useI18n } from '../i18n';

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
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [emailExpanded, setEmailExpanded] = useState(!googleEnabled);
  const [working, setWorking] = useState<'google' | 'email' | 'code' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const emailVisible = emailOtpEnabled && (!googleEnabled || emailExpanded);

  async function startGoogleSignIn() {
    if (working || !signInWithGoogle) return;
    setWorking('google');
    setError(null);
    try {
      await signInWithGoogle();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('auth.googleFailed'));
      setWorking(null);
    }
  }

  async function requestCode(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking('email');
    setError(null);
    try {
      await sendCode(email.trim().toLowerCase());
      setCodeSent(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('auth.sendFailed'));
    } finally {
      setWorking(null);
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking('code');
    setError(null);
    try {
      await verifyCode(email.trim().toLowerCase(), code.replace(/\s/g, ''));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('auth.verifyFailed'));
    } finally {
      setWorking(null);
    }
  }

  return (
    <main className="auth-screen">
      <div className="auth-shell">
        <header className="auth-header">
          <div className="auth-header__brand">
            <svg className="auth-header__mark" aria-hidden="true" viewBox="0 0 24 24">
              <path d="M12 22V12" />
              <path d="m16 17 2 2 4-4" />
              <path d="M21 11.127V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l1.32-.753" />
              <path d="M3.29 7 12 12l8.71-5" />
              <path d="m7.5 4.27 8.997 5.148" />
            </svg>
            <div>
              <p>{t('app.eyebrow')}</p>
              <strong>{t('app.title')}</strong>
            </div>
          </div>
          <LanguageControl className="language-control--auth" />
        </header>

        <section className="auth-flow" aria-labelledby="sign-in-title">
          <div className="auth-flow__heading">
            <h1 id="sign-in-title">{t('auth.title')}</h1>
            <p>{t('auth.subtitle')}</p>
          </div>
        {!configured ? (
          <div className="auth-flow__configuration" role="alert">
            <strong>{t('auth.configTitle')}</strong>
            <span>
              Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` when
              building the production app.
            </span>
          </div>
        ) : codeSent && emailOtpEnabled ? (
          <form className="auth-flow__form auth-flow__form--code" onSubmit={(event) => void submitCode(event)}>
            <p className="auth-flow__intro">
              {t('auth.codeIntro', { email })}
            </p>
            <label htmlFor="sign-in-code">{t('auth.code')}</label>
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
            {error && <p className="auth-flow__error" role="alert">{error}</p>}
            <button className="button button--primary" type="submit" disabled={Boolean(working)}>
              {working === 'code' ? t('auth.signingIn') : t('auth.openBox')}
            </button>
            <button
              className="auth-flow__text-button"
              type="button"
              onClick={() => {
                setCodeSent(false);
                setCode('');
                setError(null);
              }}
              disabled={Boolean(working)}
            >
              {t('auth.differentEmail')}
            </button>
          </form>
        ) : (
          <div className="auth-flow__methods">
            {googleEnabled && signInWithGoogle && (
              <button
                className="button button--primary auth-flow__google"
                type="button"
                disabled={Boolean(working)}
                onClick={() => void startGoogleSignIn()}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path fill="#4285f4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.6h3.2c1.9-1.8 3-4.4 3-7.5Z" />
                  <path fill="#34a853" d="M12 22c2.7 0 5-.9 6.6-2.3l-3.2-2.6c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.2H3.1v2.7A10 10 0 0 0 12 22Z" />
                  <path fill="#fbbc05" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.4H3.1a10 10 0 0 0 0 9.2l3.3-2.7Z" />
                  <path fill="#ea4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.8A9.7 9.7 0 0 0 3.1 7.4l3.3 2.7c.8-2.4 3-4.2 5.6-4.2Z" />
                </svg>
                {working === 'google' ? t('auth.googleOpening') : t('auth.google')}
              </button>
            )}
            {googleEnabled && emailOtpEnabled && !emailVisible && (
              <button
                className="button button--secondary auth-flow__email-option"
                type="button"
                disabled={Boolean(working)}
                onClick={() => {
                  setError(null);
                  setEmailExpanded(true);
                }}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="m4 7 8 6 8-6" />
                </svg>
                {t('auth.emailOption')}
              </button>
            )}
            {googleEnabled && emailVisible && (
              <div className="auth-flow__divider"><span>{t('auth.or')}</span></div>
            )}
            {emailVisible && (
              <form className="auth-flow__form auth-flow__form--email" onSubmit={(event) => void requestCode(event)}>
                <p className="auth-flow__intro">
                  {t('auth.emailIntro')}
                </p>
                <label htmlFor="sign-in-email">{t('auth.email')}</label>
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
                <button className="button button--primary" type="submit" disabled={Boolean(working)}>
                  {working === 'email' ? t('auth.sending') : t('auth.send')}
                </button>
              </form>
            )}
            {error && <p className="auth-flow__error" role="alert">{error}</p>}
          </div>
        )}
          <div className="auth-flow__privacy">
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <rect x="5" y="10" width="14" height="11" rx="2" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </svg>
            <p>
              {t('auth.privacy')}{' '}
              <a href="/privacy.html">{t('auth.readPrivacy')}</a>
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
