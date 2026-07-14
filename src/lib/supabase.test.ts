import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ kind: 'supabase-client' })),
}));

describe('Supabase configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.mocked(createClient).mockClear();
  });

  it('returns null when either browser variable is absent', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    const { getSupabase, supabaseConfig } = await import('./supabase');
    expect(supabaseConfig()).toBeNull();
    expect(getSupabase()).toBeNull();
  });

  it('creates and reuses one configured client', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.example.test');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
    const { getSupabase, supabaseConfig } = await import('./supabase');

    expect(supabaseConfig()).toEqual({
      url: 'https://supabase.example.test',
      anonKey: 'anon-key',
    });
    const first = getSupabase();
    expect(getSupabase()).toBe(first);
    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith('https://supabase.example.test', 'anon-key');
  });
});
