import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiAuth } from './apiClient';
import { deleteAccount, downloadAccountExport, exportAccount } from './account';

const accountExport = {
  exportedAt: '2026-08-05T12:00:00Z',
  account: {
    id: '10000000-0000-0000-0000-000000000001',
    email: 'owner@example.test',
  },
  packages: [],
};

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    type: 'basic',
    redirected: false,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const auth: ApiAuth = {
  userId: '10000000-0000-0000-0000-000000000001',
  getAccessToken: vi.fn().mockResolvedValue('signed-token'),
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('account privacy actions', () => {
  it('exports and permanently deletes through the authenticated API', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(accountExport))
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    await expect(exportAccount(auth)).resolves.toEqual(accountExport);
    await expect(deleteAccount(auth, 'owner@example.test')).resolves.toBeUndefined();

    const exportHeaders = new Headers(fetch.mock.calls[0][1]?.headers);
    expect(exportHeaders.get('Authorization')).toBe('Bearer signed-token');
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/account',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ confirmation: 'owner@example.test' }),
      }),
    );
  });

  it('downloads a dated JSON file and revokes its temporary URL', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const urlApi = {
      createObjectURL: vi.fn().mockReturnValue('blob:account-export'),
      revokeObjectURL: vi.fn(),
    };

    downloadAccountExport(accountExport, document, urlApi);

    expect(click).toHaveBeenCalledOnce();
    expect(urlApi.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:account-export');
  });

  it('surfaces safe account API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response({ error: 'Confirmation required' }, false, 400)),
    );
    await expect(deleteAccount(auth, 'wrong@example.test')).rejects.toThrow(
      'Confirmation required',
    );
  });
});
