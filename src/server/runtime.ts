import 'server-only';

import { SupabaseServiceClient } from './supabase';

interface ServiceRuntime {
  signature: string;
  client: SupabaseServiceClient;
}

const globalRuntime = globalThis as typeof globalThis & {
  __deliveryServiceRuntime?: ServiceRuntime;
};

function validHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol)
      || !url.hostname
      || url.username
      || url.password
      || (url.pathname !== '/' && url.pathname !== '')
      || url.search
      || url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function publicSupabaseOrigin(): string | null {
  const value = process.env.SUPABASE_PUBLIC_URL?.trim()
    || process.env.SUPABASE_URL?.trim()
    || '';
  return validHttpOrigin(value);
}

export function authConfiguration(): { url: string; publishableKey: string } | null {
  const url = process.env.SUPABASE_URL?.trim() ?? '';
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim()
    || process.env.SUPABASE_ANON_KEY?.trim()
    || '';
  if (!url && !publishableKey) return null;
  const origin = validHttpOrigin(url);
  if (!origin || !publishableKey) {
    throw new Error('SUPABASE_URL and a Supabase publishable key are required');
  }
  return { url: origin, publishableKey };
}

export function serviceClient(): SupabaseServiceClient | null {
  const url = process.env.SUPABASE_URL?.trim() ?? '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '';
  if (!url && !serviceRoleKey) return null;
  const origin = validHttpOrigin(url);
  if (!origin || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  const signature = `${origin}\u0000${serviceRoleKey}`;
  if (globalRuntime.__deliveryServiceRuntime?.signature !== signature) {
    globalRuntime.__deliveryServiceRuntime = {
      signature,
      client: new SupabaseServiceClient(origin, serviceRoleKey),
    };
  }
  return globalRuntime.__deliveryServiceRuntime.client;
}

export function deliveryServiceConfigured(): boolean {
  try {
    return serviceClient() !== null;
  } catch {
    return false;
  }
}
