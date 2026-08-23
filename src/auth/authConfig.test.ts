import { describe, expect, it } from 'vitest';
import { authConfigFromEnvironment } from './authConfig';

const environment = (values: Record<string, string> = {}) => values;

describe('authConfigFromEnvironment', () => {
  it('requires both public Supabase values', () => {
    expect(authConfigFromEnvironment(environment())).toBeNull();
    expect(authConfigFromEnvironment(environment({
      supabaseUrl: 'https://project.supabase.co',
    }))).toBeNull();
  });

  it('returns trimmed browser-safe configuration', () => {
    expect(authConfigFromEnvironment(environment({
      supabaseUrl: ' https://project.supabase.co ',
      supabasePublishableKey: ' publishable-key ',
    }))).toEqual({
      url: 'https://project.supabase.co',
      publishableKey: 'publishable-key',
      googleEnabled: false,
      emailOtpEnabled: true,
    });
  });

  it('rejects malformed and credential-bearing Supabase origins', () => {
    for (const supabaseUrl of [
      'not-a-url',
      'ftp://project.supabase.co',
      'https://user:password@project.supabase.co',
      'https://project.supabase.co/rest/v1',
      'https://project.supabase.co?token=private',
    ]) {
      expect(authConfigFromEnvironment(environment({
        supabaseUrl,
        supabasePublishableKey: 'publishable-key',
      }))).toBeNull();
    }
  });

  it('selects public sign-in methods from explicit build flags', () => {
    expect(authConfigFromEnvironment(environment({
      supabaseUrl: 'https://project.supabase.co',
      supabasePublishableKey: 'publishable-key',
      googleEnabled: 'true',
      emailOtpEnabled: 'false',
    }))).toMatchObject({ googleEnabled: true, emailOtpEnabled: false });
  });
});
