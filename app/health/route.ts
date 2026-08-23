import { apiRoute, json, noContent } from '../../src/server/api';
import { deliveryServiceConfigured } from '../../src/server/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute(async () => {
  const ok = deliveryServiceConfigured();
  return json({ ok }, ok ? 200 : 503);
}, { authenticated: false, loadService: false });

export const HEAD = apiRoute(async () => {
  const ok = deliveryServiceConfigured();
  return noContent(ok ? 200 : 503);
}, { authenticated: false, loadService: false });
