import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ApiApplication } from './ApiApplication';
import { AuthProvider } from './auth/AuthContext';
import { authConfigFromEnvironment } from './auth/authConfig';
import { enableAppBadgeClearing } from './lib/pushNotifications';
import { enablePwaLiveReload } from './lib/pwaUpdates';
import { createDemoRepo } from './store/demoRepo';
import { ParcelsProvider } from './store/ParcelsContext';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
const useDemo = import.meta.env.DEV && import.meta.env.VITE_USE_API !== 'true';
const authConfig = authConfigFromEnvironment(import.meta.env);

enablePwaLiveReload();
enableAppBadgeClearing();

root.render(
  <StrictMode>
    {useDemo ? (
      <ParcelsProvider repo={createDemoRepo()}>
        <App />
      </ParcelsProvider>
    ) : (
      <AuthProvider config={authConfig}>
        <ApiApplication />
      </AuthProvider>
    )}
  </StrictMode>,
);
