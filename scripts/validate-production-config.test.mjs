import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateProductionConfig } from './validate-production-config.mjs';

const validEnvironment = Object.freeze({
  NEXT_PUBLIC_USE_API: 'true',
  NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.example.com',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  NEXT_PUBLIC_AUTH_GOOGLE_ENABLED: 'true',
  NEXT_PUBLIC_AUTH_EMAIL_OTP_ENABLED: 'false',
});

describe('production browser configuration', () => {
  it('accepts a complete API-mode configuration', () => {
    assert.deepEqual(validateProductionConfig(validEnvironment), {
      supabaseUrl: 'https://supabase.example.com',
      providers: {
        NEXT_PUBLIC_AUTH_GOOGLE_ENABLED: true,
        NEXT_PUBLIC_AUTH_EMAIL_OTP_ENABLED: false,
      },
    });
  });

  it('rejects missing or malformed Supabase values without echoing them', () => {
    for (const environment of [
      { ...validEnvironment, NEXT_PUBLIC_SUPABASE_URL: '' },
      { ...validEnvironment, NEXT_PUBLIC_SUPABASE_URL: 'https://user:secret@supabase.example.com' },
      { ...validEnvironment, NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.example.com/rest/v1' },
      { ...validEnvironment, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '' },
    ]) {
      let caught;
      try {
        validateProductionConfig(environment);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof Error);
      const message = caught.message;
      assert.doesNotMatch(message, /user:secret|sb_publishable_test/);
    }
  });

  it('rejects demo mode, invalid flags, and a sign-in screen with no methods', () => {
    assert.throws(
      () => validateProductionConfig({ ...validEnvironment, NEXT_PUBLIC_USE_API: 'false' }),
      /NEXT_PUBLIC_USE_API/,
    );
    assert.throws(
      () => validateProductionConfig({
        ...validEnvironment,
        NEXT_PUBLIC_AUTH_GOOGLE_ENABLED: 'yes',
      }),
      /true or false/,
    );
    assert.throws(
      () => validateProductionConfig({
        ...validEnvironment,
        NEXT_PUBLIC_AUTH_GOOGLE_ENABLED: 'false',
        NEXT_PUBLIC_AUTH_EMAIL_OTP_ENABLED: 'false',
      }),
      /authentication method/,
    );
  });
});
