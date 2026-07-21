export const REAUTH_PATH = '/reauth';

export class CloudflareAccessError extends Error {
  constructor() {
    super('Your Cloudflare Access session expired. Sign in again to reconnect your delivery box.');
    this.name = 'CloudflareAccessError';
  }
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
