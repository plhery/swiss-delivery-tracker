import { pathToFileURL } from 'node:url';

const BOOLEAN_VARIABLES = [
  'NEXT_PUBLIC_AUTH_GOOGLE_ENABLED',
  'NEXT_PUBLIC_AUTH_EMAIL_OTP_ENABLED',
];

function requiredValue(environment, key) {
  const value = environment[key]?.trim() ?? '';
  if (!value) throw new Error(`${key} is required`);
  if (value.length > 16_384) throw new Error(`${key} is unexpectedly large`);
  return value;
}

function publicOrigin(environment) {
  const value = requiredValue(environment, 'NEXT_PUBLIC_SUPABASE_URL');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL must be a valid HTTP(S) origin');
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || !url.hostname
    || url.username
    || url.password
    || (url.pathname !== '/' && url.pathname !== '')
    || url.search
    || url.hash
  ) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL must be a valid HTTP(S) origin');
  }
  return url.origin;
}

function booleanValue(environment, key) {
  const value = requiredValue(environment, key);
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${key} must be either true or false`);
  }
  return value === 'true';
}

/** Validate values that Next.js freezes into a production browser bundle. */
export function validateProductionConfig(environment = process.env) {
  const supabaseUrl = publicOrigin(environment);
  requiredValue(environment, 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  const providers = Object.fromEntries(
    BOOLEAN_VARIABLES.map((key) => [key, booleanValue(environment, key)]),
  );
  if (!Object.values(providers).some(Boolean)) {
    throw new Error('At least one production authentication method must be enabled');
  }
  if (environment.NEXT_PUBLIC_USE_API?.trim() !== 'true') {
    throw new Error('NEXT_PUBLIC_USE_API must be true for a production container');
  }
  return { supabaseUrl, providers };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validateProductionConfig();
    console.log('Production browser configuration is valid.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown configuration error';
    console.error(`Production browser configuration is invalid: ${message}`);
    process.exitCode = 1;
  }
}
