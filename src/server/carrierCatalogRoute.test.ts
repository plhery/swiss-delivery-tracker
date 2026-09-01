import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../app/api/carriers/route';

afterEach(() => vi.restoreAllMocks());

describe('public carrier catalog route', () => {
  it('serves every carrier with a reusable content fingerprint', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const context = { params: Promise.resolve({}) };
    const response = await GET(
      new NextRequest('https://delivery.example/api/carriers'),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('max-age=300');
    expect(response.headers.get('cache-control')).not.toContain('no-store');
    const etag = response.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const body = await response.json() as {
      version: string;
      'x-carriers': Record<string, { displayName: string }>;
    };
    expect(body.version).toBe(`sha256-${etag?.slice(1, -1)}`);
    expect(body['x-carriers']['amazon-logistics']?.displayName).toBe('Amazon Shipping');
    expect(body['x-carriers'].unknown).toBeDefined();

    const cached = await GET(
      new NextRequest('https://delivery.example/api/carriers', {
        headers: { 'If-None-Match': `W/${etag}` },
      }),
      context,
    );
    expect(cached.status).toBe(304);
    expect(cached.headers.get('etag')).toBe(etag);
    await expect(cached.text()).resolves.toBe('');
  });
});
