import { createHash } from 'node:crypto';
import { SupabaseUserClient } from './supabase';
import { authConfiguration } from './runtime';
import { isRecord } from './types';

const INTERACTIVE_AUTH_METHODS = new Set([
  'magiclink',
  'oauth',
  'otp',
  'password',
  'sso/saml',
  'totp',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SupabaseUser {
  id: string;
  email: string | null;
  authenticatedAt: Date | null;
  sessionId: string | null;
}

export class SupabaseAuthError extends Error {
  constructor(message = 'Supabase access token is invalid', options?: ErrorOptions) {
    super(message, options);
    this.name = 'SupabaseAuthError';
  }
}

export class SupabaseAuthenticator {
  readonly #cache = new Map<string, { expiresAt: number; user: SupabaseUser }>();

  constructor(
    readonly url: string,
    readonly publishableKey: string,
    readonly options: {
      timeoutMs?: number;
      cacheMs?: number;
      clock?: () => number;
    } = {},
  ) {
    if (!url.trim() || !publishableKey.trim()) {
      throw new TypeError('Supabase Auth requires a URL and publishable key');
    }
  }

  async validate(token: string | null | undefined, useCache = true): Promise<SupabaseUser> {
    if (!token || token.length > 16_384) {
      throw new SupabaseAuthError('Supabase access token is missing or invalid');
    }
    const fingerprint = createHash('sha256').update(token).digest('hex');
    const now = (this.options.clock ?? Date.now)();
    if (useCache) {
      const cached = this.#cache.get(fingerprint);
      if (cached && cached.expiresAt > now) return cached.user;
    }

    let response: Response;
    try {
      response = await fetch(`${this.url}/auth/v1/user`, {
        headers: {
          Accept: 'application/json',
          apikey: this.publishableKey,
          Authorization: `Bearer ${token}`,
        },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
    } catch (error) {
      throw new SupabaseAuthError(undefined, { cause: error });
    }
    if (!response.ok) throw new SupabaseAuthError();

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new SupabaseAuthError('Supabase returned an invalid user', { cause: error });
    }
    if (!isRecord(payload) || typeof payload.id !== 'string' || !UUID.test(payload.id)) {
      throw new SupabaseAuthError('Supabase returned an invalid user');
    }
    if (payload.is_anonymous === true) {
      throw new SupabaseAuthError('Anonymous Supabase users are not accepted');
    }

    const claims = sessionClaims(token, payload.id);
    const user: SupabaseUser = {
      id: payload.id.toLowerCase(),
      email: typeof payload.email === 'string' ? payload.email : null,
      authenticatedAt: claims.authenticatedAt,
      sessionId: claims.sessionId,
    };

    if (this.#cache.size >= 256) {
      for (const [key, value] of this.#cache) {
        if (value.expiresAt <= now) this.#cache.delete(key);
      }
      if (this.#cache.size >= 256) {
        this.#cache.delete(this.#cache.keys().next().value as string);
      }
    }
    this.#cache.set(fingerprint, {
      expiresAt: now + Math.max(0, this.options.cacheMs ?? 60_000),
      user,
    });
    return user;
  }

  userClient(token: string): SupabaseUserClient {
    return new SupabaseUserClient(this.url, this.publishableKey, token);
  }
}

function sessionClaims(
  token: string,
  userId: string,
): { authenticatedAt: Date | null; sessionId: string | null } {
  const parts = token.split('.');
  if (parts.length !== 3) return { authenticatedAt: null, sessionId: null };
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    return { authenticatedAt: null, sessionId: null };
  }
  if (!isRecord(claims) || claims.sub !== userId) {
    return { authenticatedAt: null, sessionId: null };
  }
  const sessionId = typeof claims.session_id === 'string' && UUID.test(claims.session_id)
    ? claims.session_id.toLowerCase()
    : null;
  let authenticatedAt: Date | null = null;
  if (Array.isArray(claims.amr)) {
    for (const entry of claims.amr) {
      if (
        !isRecord(entry)
        || typeof entry.method !== 'string'
        || !INTERACTIVE_AUTH_METHODS.has(entry.method)
        || typeof entry.timestamp !== 'number'
        || !Number.isFinite(entry.timestamp)
      ) continue;
      const candidate = new Date(entry.timestamp * 1_000);
      if (
        Number.isFinite(candidate.getTime())
        && (authenticatedAt === null || candidate > authenticatedAt)
      ) authenticatedAt = candidate;
    }
  }
  return { authenticatedAt, sessionId };
}

interface AuthRuntime {
  signature: string;
  authenticator: SupabaseAuthenticator;
}

const globalAuth = globalThis as typeof globalThis & {
  __deliveryAuthRuntime?: AuthRuntime;
};

export function authenticator(): SupabaseAuthenticator | null {
  const configuration = authConfiguration();
  if (!configuration) return null;
  const signature = `${configuration.url}\u0000${configuration.publishableKey}`;
  if (globalAuth.__deliveryAuthRuntime?.signature !== signature) {
    globalAuth.__deliveryAuthRuntime = {
      signature,
      authenticator: new SupabaseAuthenticator(
        configuration.url,
        configuration.publishableKey,
      ),
    };
  }
  return globalAuth.__deliveryAuthRuntime.authenticator;
}
