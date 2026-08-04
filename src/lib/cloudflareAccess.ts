export const REAUTH_PATH = '/reauth';

export class CloudflareAccessError extends Error {
  constructor() {
    super('Your Cloudflare Access session expired. Sign in again to reconnect your delivery box.');
    this.name = 'CloudflareAccessError';
  }
}

/**
 * Keep expired Access challenges out of the browser cache and ask Cloudflare
 * to answer background requests with 401 instead of a login-page redirect.
 */
export function cloudflareAccessRequest(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('X-Requested-With', 'XMLHttpRequest');

  return {
    ...init,
    cache: 'no-store',
    redirect: 'manual',
    headers,
  };
}

/** API routes never redirect, so a manual redirect is Cloudflare asking for authentication. */
export function throwIfCloudflareAccessRequiresLogin(response: Response): void {
  if (
    response.type === 'opaqueredirect' ||
    response.redirected ||
    response.status === 401 ||
    response.status === 403
  ) {
    throw new CloudflareAccessError();
  }
}
