import { useMemo } from 'react';
import App from './App';
import { useAuth } from './auth/AuthContext';
import { SignInScreen } from './components/SignInScreen';
import { createApiRepo } from './store/apiRepo';
import { ParcelsProvider } from './store/ParcelsContext';

export function ApiApplication() {
  const auth = useAuth();
  const repo = useMemo(() => createApiRepo(), []);
  if (auth.status === 'loading') {
    return <div className="auth-loading" role="status">Opening your secure delivery box…</div>;
  }
  if (auth.status === 'unconfigured' || auth.status === 'anonymous') {
    return (
      <SignInScreen
        configured={auth.status !== 'unconfigured'}
        sendCode={auth.sendCode}
        verifyCode={auth.verifyCode}
      />
    );
  }
  return (
    <ParcelsProvider repo={repo}>
      <App accountEmail={auth.user?.email ?? 'Account'} onSignOut={auth.signOut} />
    </ParcelsProvider>
  );
}
