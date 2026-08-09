import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSharedParcelInput, readSharedParcelInput } from './shareTarget';

beforeEach(() => window.history.replaceState({}, '', '/'));
afterEach(() => vi.unstubAllGlobals());

describe('PWA share target', () => {
  it('reads a one-time service-worker draft without putting private content in the URL', async () => {
    window.history.replaceState({}, '', '/?share-target=1');
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      label: 'New shoes',
      trackingInput: 'https://service.post.ch/track\nTracking 993412345612345678',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);

    await expect(readSharedParcelInput()).resolves.toEqual({
      label: 'New shoes',
      trackingInput: 'https://service.post.ch/track\nTracking 993412345612345678',
    });
    expect(fetch).toHaveBeenCalledWith('/share-target/draft', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    expect(window.location.href).not.toContain('993412345612345678');
  });

  it('ignores ordinary query strings and removes only the share marker', async () => {
    window.history.replaceState({}, '', '/?parcel=parcel-1&share-target=1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    clearSharedParcelInput();

    expect(window.location.search).toBe('?parcel=parcel-1');
    await expect(readSharedParcelInput()).resolves.toBeNull();
  });
});
