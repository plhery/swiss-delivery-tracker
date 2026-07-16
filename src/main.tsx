import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { enableAppBadgeClearing } from './lib/pushNotifications';
import { enablePwaLiveReload } from './lib/pwaUpdates';
import { createApiRepo } from './store/apiRepo';
import { createDemoRepo } from './store/demoRepo';
import { ParcelsProvider } from './store/ParcelsContext';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
const useDemo = import.meta.env.DEV && import.meta.env.VITE_USE_API !== 'true';
const repo = useDemo ? createDemoRepo() : createApiRepo();

enablePwaLiveReload();
enableAppBadgeClearing();

root.render(
  <StrictMode>
    <ParcelsProvider repo={repo}>
      <App />
    </ParcelsProvider>
  </StrictMode>,
);
