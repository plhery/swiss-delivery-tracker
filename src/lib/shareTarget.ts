export interface SharedParcelInput {
  label: string;
  trackingInput: string;
}

const SHARE_MARKER = 'share-target';

export async function readSharedParcelInput(
  location: Location = window.location,
): Promise<SharedParcelInput | null> {
  const params = new URLSearchParams(location.search);
  if (params.get(SHARE_MARKER) !== '1') return null;
  try {
    const response = await fetch('/share-target/draft', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object') return null;
    const draft = value as Partial<SharedParcelInput>;
    if (typeof draft.label !== 'string' || typeof draft.trackingInput !== 'string') return null;
    const trackingInput = draft.trackingInput.trim().slice(0, 10_000);
    return trackingInput ? { label: draft.label.trim().slice(0, 80), trackingInput } : null;
  } catch {
    return null;
  }
}

export function clearSharedParcelInput(location: Location = window.location): void {
  const url = new URL(location.href);
  if (url.searchParams.get(SHARE_MARKER) !== '1') return;
  url.searchParams.delete(SHARE_MARKER);
  window.history.replaceState(
    window.history.state,
    '',
    `${url.pathname}${url.search}${url.hash}`,
  );
}
