import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AuthGate } from './auth/AuthGate';
import { getSupabase } from './lib/supabase';
import { createDemoRepo } from './store/demoRepo';
import { ParcelsProvider } from './store/ParcelsContext';
import { createSupabaseRepo } from './store/supabaseRepo';
import './styles.css';

const supabase = getSupabase();
const root = createRoot(document.getElementById('root')!);

if (supabase) {
  const repo = createSupabaseRepo(supabase);
  root.render(
    <StrictMode>
      <AuthGate supabase={supabase}>
        {(accountControl) => (
          <ParcelsProvider repo={repo}>
            <App accountControl={accountControl} />
          </ParcelsProvider>
        )}
      </AuthGate>
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <ParcelsProvider repo={createDemoRepo()}>
        <App />
      </ParcelsProvider>
    </StrictMode>,
  );
}
