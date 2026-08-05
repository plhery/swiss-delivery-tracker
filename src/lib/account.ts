import type {
  ApiAccountExportResponse,
  ApiDeleteAccountRequest,
  ApiOkResponse,
} from '../generated/apiContract';
import { authenticatedFetch, type ApiAuth } from './apiClient';

async function payload<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) {
    throw new Error(body?.error ?? `Account request failed (${response.status})`);
  }
  if (!body) throw new Error('The account service returned an empty response');
  return body;
}

export async function exportAccount(auth: ApiAuth): Promise<ApiAccountExportResponse> {
  return payload<ApiAccountExportResponse>(
    await authenticatedFetch('/api/account/export', auth),
  );
}

export async function deleteAccount(auth: ApiAuth, confirmation: string): Promise<void> {
  const body: ApiDeleteAccountRequest = { confirmation };
  await payload<ApiOkResponse>(
    await authenticatedFetch('/api/account', auth, {
      method: 'DELETE',
      body: JSON.stringify(body),
    }),
  );
}

export function downloadAccountExport(
  accountExport: ApiAccountExportResponse,
  page: Document = document,
  urlApi: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL,
): void {
  const blob = new Blob([`${JSON.stringify(accountExport, null, 2)}\n`], {
    type: 'application/json',
  });
  const url = urlApi.createObjectURL(blob);
  const link = page.createElement('a');
  link.href = url;
  link.download = `swiss-delivery-tracker-export-${accountExport.exportedAt.slice(0, 10)}.json`;
  link.rel = 'noopener';
  link.click();
  urlApi.revokeObjectURL(url);
}
