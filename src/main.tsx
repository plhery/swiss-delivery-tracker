import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { getSupabase } from './lib/supabase';
import { createDemoRepo } from './store/demoRepo';
import { ParcelsProvider } from './store/ParcelsContext';
import { createSupabaseRepo } from './store/supabaseRepo';
import './styles.css';

const supabase = getSupabase();
const repo = supabase ? createSupabaseRepo(supabase) : createDemoRepo();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ParcelsProvider repo={repo}>
      <App />
    </ParcelsProvider>
  </StrictMode>,
);
