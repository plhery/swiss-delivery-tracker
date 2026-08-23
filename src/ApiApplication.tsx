import { useCallback, useMemo } from 'react';
import App from './App';
import { useAuth } from './auth/AuthContext';
import { SignInScreen } from './components/SignInScreen';
import { deleteAccount, downloadAccountExport, exportAccount } from './lib/account';
import {
  disablePushNotifications,
  unsubscribePushNotificationsLocally,
} from './lib/pushNotifications';
import { browserStorage, clearApiCache, createApiRepo } from './store/apiRepo';
import { ParcelsProvider } from './store/ParcelsContext';
import { useI18n } from './i18n';

export function ApiApplication() {
  const { t } = useI18n();
  const auth = useAuth();
  const signOut = auth.signOut;
  const storage = browserStorage();
  const sessionAuth = useMemo(
    () => auth.user ? {
      userId: auth.user.id,
      getAccessToken: auth.getAccessToken,
    } : undefined,
    [auth.user, auth.getAccessToken],
  );
  const handleSignOut = useCallback(async () => {
    if (sessionAuth) {
      await disablePushNotifications(sessionAuth).catch(() => undefined);
      clearApiCache(storage, sessionAuth.userId);
    }
    await signOut();
  }, [sessionAuth, signOut, storage]);
  const apiAuth = useMemo(
    () => sessionAuth ? {
      ...sessionAuth,
      onAuthenticationFailure: handleSignOut,
    } : undefined,
    [sessionAuth, handleSignOut],
  );
  const handleExport = useCallback(async () => {
    if (!apiAuth) return;
    downloadAccountExport(await exportAccount(apiAuth));
  }, [apiAuth]);
  const handleDelete = useCallback(async (confirmation: string) => {
    if (!apiAuth) return;
    await deleteAccount(apiAuth, confirmation);
    await unsubscribePushNotificationsLocally().catch(() => undefined);
    clearApiCache(storage, apiAuth.userId);
    await signOut();
  }, [apiAuth, signOut, storage]);
  const repo = useMemo(
    () => apiAuth ? createApiRepo(
      30_000,
      1_000,
      storage,
      apiAuth,
    ) : null,
    [apiAuth, storage],
  );
  if (auth.status === 'loading') {
    return <div className="auth-loading" role="status">{t('auth.loading')}</div>;
  }
  if (auth.status === 'unconfigured' || auth.status === 'anonymous') {
    return (
      <SignInScreen
        configured={auth.status !== 'unconfigured'}
        googleEnabled={auth.googleEnabled}
        emailOtpEnabled={auth.emailOtpEnabled}
        signInWithGoogle={auth.signInWithGoogle}
        sendCode={auth.sendCode}
        verifyCode={auth.verifyCode}
      />
    );
  }
  if (!repo) return null;
  return (
    <ParcelsProvider repo={repo}>
      <App
        accountEmail={auth.user?.email ?? 'Account'}
        onSignOut={handleSignOut}
        onExportAccount={handleExport}
        onDeleteAccount={handleDelete}
        apiAuth={apiAuth}
      />
    </ParcelsProvider>
  );
}
