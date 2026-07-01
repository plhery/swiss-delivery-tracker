import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export function supabaseConfig(): { url: string; anonKey: string } | null {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

let client: SupabaseClient | null = null;

/** Returns a shared Supabase client, or null when env vars are not set. */
export function getSupabase(): SupabaseClient | null {
  if (client) return client;
  const config = supabaseConfig();
  if (!config) return null;
  client = createClient(config.url, config.anonKey);
  return client;
}
