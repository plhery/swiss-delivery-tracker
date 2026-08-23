import { NextRequest, NextResponse } from 'next/server';
import { publicSupabaseOrigin } from './src/server/runtime';

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDevelopment = process.env.NODE_ENV === 'development';
  const supabaseOrigin = publicSupabaseOrigin();
  const connectSources = ["'self'", ...(supabaseOrigin ? [supabaseOrigin] : [])].join(' ');
  const contentSecurityPolicy = `
    default-src 'self';
    base-uri 'none';
    connect-src ${connectSources};
    font-src 'self';
    form-action 'self';
    frame-ancestors 'none';
    img-src 'self' blob: data:;
    manifest-src 'self';
    object-src 'none';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ''};
    style-src 'self' 'unsafe-inline';
    style-src-attr 'unsafe-inline';
    style-src-elem 'self' ${isDevelopment ? "'unsafe-inline'" : `'nonce-${nonce}'`};
    worker-src 'self';
  `.replace(/\s{2,}/g, ' ').trim();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', contentSecurityPolicy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', contentSecurityPolicy);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|health|_next/static|_next/image|icons|sw\\.js|push-sw\\.js|og\\.png|favicon\\.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
