import { describe, expect, it } from 'vitest';
import { authConfigFromEnvironment } from './authConfig';

function environment(values: Record<string, string> = {}): ImportMetaEnv {
  return {
    BASE_URL: '/',
    MODE: 'test',
    DEV: true,
    PROD: false,
    SSR: false,
    ...values,
  };
}

describe('authConfigFromEnvironment', () => {
  it('requires both public Supabase values', () => {
    expect(authConfigFromEnvironment(environment())).toBeNull();
    expect(authConfigFromEnvironment(environment({
      VITE_SUPABASE_URL: 'https://project.supabase.co',
    }))).toBeNull();
  });

  it('returns trimmed browser-safe configuration', () => {
    expect(authConfigFromEnvironment(environment({
      VITE_SUPABASE_URL: ' https://project.supabase.co ',
      VITE_SUPABASE_PUBLISHABLE_KEY: ' publishable-key ',
    }))).toEqual({
      url: 'https://project.supabase.co',
      publishableKey: 'publishable-key',
      googleEnabled: false,
      emailOtpEnabled: true,
    });
  });

  it('selects public sign-in methods from explicit build flags', () => {
    expect(authConfigFromEnvironment(environment({
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
      VITE_AUTH_GOOGLE_ENABLED: 'true',
      VITE_AUTH_EMAIL_OTP_ENABLED: 'false',
    }))).toMatchObject({ googleEnabled: true, emailOtpEnabled: false });
  });
});
