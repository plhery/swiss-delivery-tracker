import type { AuthConfig } from './AuthContext';

export function authConfigFromEnvironment(environment: ImportMetaEnv): AuthConfig | null {
  const url = environment.VITE_SUPABASE_URL?.trim() ?? '';
  const publishableKey = environment.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';
  return url && publishableKey ? { url, publishableKey } : null;
}
