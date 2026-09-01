import { createHash } from 'node:crypto';
import contract from '../../../contracts/openapi.json';
import { apiRoute, json } from '../../../src/server/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const carriers = contract['x-carriers'];
const digest = createHash('sha256').update(JSON.stringify(carriers)).digest('hex');
const etag = `"${digest}"`;
const cacheHeaders = {
  'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400',
  ETag: etag,
};

function matchesETag(value: string | null): boolean {
  return value?.split(',').some((candidate) => {
    const normalized = candidate.trim();
    return normalized === '*' || normalized === etag || normalized === `W/${etag}`;
  }) ?? false;
}

export const GET = apiRoute(
  async ({ request }) => {
    if (matchesETag(request.headers.get('if-none-match'))) {
      return new Response(null, { status: 304, headers: cacheHeaders });
    }
    return json({
      version: `sha256-${digest}`,
      'x-carriers': carriers,
    }, 200, cacheHeaders);
  },
  { authenticated: false, loadService: false },
);
