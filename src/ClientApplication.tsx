'use client';

import { useEffect, useMemo } from 'react';
import App from './App';
import { ApiApplication } from './ApiApplication';
import { AuthProvider } from './auth/AuthContext';
import { authConfigFromEnvironment } from './auth/authConfig';
import { I18nProvider } from './i18n';
import { enableAppBadgeClearing } from './lib/pushNotifications';
import { enablePwaLiveReload, registerPwaServiceWorker } from './lib/pwaUpdates';
import { createDemoRepo } from './store/demoRepo';
import { ParcelsProvider } from './store/ParcelsContext';

const useDemo = process.env.NODE_ENV === 'development'
  && process.env.NEXT_PUBLIC_USE_API !== 'true';

const authConfig = authConfigFromEnvironment({
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  googleEnabled: process.env.NEXT_PUBLIC_AUTH_GOOGLE_ENABLED,
  emailOtpEnabled: process.env.NEXT_PUBLIC_AUTH_EMAIL_OTP_ENABLED,
});

export function ClientApplication() {
  const demoRepo = useMemo(
    () => useDemo ? createDemoRepo() : null,
    [],
  );

  useEffect(() => {
    const disableReload = enablePwaLiveReload();
    if (process.env.NODE_ENV === 'production') {
      void registerPwaServiceWorker().catch(() => undefined);
    }
    const disableBadgeClearing = enableAppBadgeClearing();
    return () => {
      disableReload();
      disableBadgeClearing();
    };
  }, []);

  return (
    <I18nProvider>
      {demoRepo ? (
        <ParcelsProvider repo={demoRepo}>
          <App />
        </ParcelsProvider>
      ) : (
        <AuthProvider config={authConfig}>
          <ApiApplication />
        </AuthProvider>
      )}
    </I18nProvider>
  );
}
