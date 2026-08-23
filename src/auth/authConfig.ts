import type { AuthConfig } from './AuthContext';

export interface PublicAuthEnvironment {
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  googleEnabled?: string;
  emailOtpEnabled?: string;
}

export function authConfigFromEnvironment(
  environment: PublicAuthEnvironment,
): AuthConfig | null {
  const rawUrl = environment.supabaseUrl?.trim() ?? '';
  const publishableKey = environment.supabasePublishableKey?.trim() ?? '';
  if (!rawUrl || !publishableKey) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || !url.hostname
    || url.username
    || url.password
    || (url.pathname !== '/' && url.pathname !== '')
    || url.search
    || url.hash
  ) return null;
  return {
    url: url.origin,
    publishableKey,
    googleEnabled: environment.googleEnabled === 'true',
    emailOtpEnabled: environment.emailOtpEnabled !== 'false',
  };
}
