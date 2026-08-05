export class ApiAuthenticationError extends Error {
  constructor() {
    super('Your sign-in expired. Please sign in again.');
    this.name = 'ApiAuthenticationError';
  }
}

export interface ApiAuth {
  userId: string;
  getAccessToken: (refresh?: boolean) => Promise<string | null>;
  onAuthenticationFailure?: () => Promise<void>;
}

/** Add the current Supabase bearer token and refresh it once after a 401/403. */
export async function authenticatedFetch(
  path: string,
  auth: ApiAuth | undefined,
  init?: RequestInit,
): Promise<Response> {
  async function perform(accessToken: string | null) {
    const headers = new Headers(init?.headers);
    headers.set('X-Requested-With', 'XMLHttpRequest');
    if (init?.body) headers.set('Content-Type', 'application/json');
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    return fetch(path, {
      ...init,
      cache: 'no-store',
      redirect: 'manual',
      headers,
    });
  }

  let accessToken = await auth?.getAccessToken() ?? null;
  let response = await perform(accessToken);
  if (auth && (response.status === 401 || response.status === 403)) {
    accessToken = await auth.getAccessToken(true).catch(() => null);
    if (accessToken) response = await perform(accessToken);
  }
  if (
    response.type === 'opaqueredirect'
    || response.redirected
    || response.status === 401
    || response.status === 403
  ) {
    await auth?.onAuthenticationFailure?.().catch(() => undefined);
    throw new ApiAuthenticationError();
  }
  return response;
}
