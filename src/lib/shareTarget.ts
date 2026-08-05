export interface SharedParcelInput {
  label: string;
  trackingInput: string;
}

const SHARE_MARKER = 'share-target';
const SHARE_PARAMS = [SHARE_MARKER, 'title', 'text', 'url'] as const;

export function readSharedParcelInput(location: Location = window.location): SharedParcelInput | null {
  const params = new URLSearchParams(location.search);
  if (params.get(SHARE_MARKER) !== '1') return null;

  const title = (params.get('title') ?? '').trim().slice(0, 80);
  const parts = [params.get('url'), params.get('text')]
    .map((value) => value?.trim() ?? '')
    .filter((value, index, values) => value && values.indexOf(value) === index);
  const trackingInput = parts.join('\n').slice(0, 10_000);
  return trackingInput ? { label: title, trackingInput } : null;
}

export function clearSharedParcelInput(location: Location = window.location): void {
  const url = new URL(location.href);
  if (url.searchParams.get(SHARE_MARKER) !== '1') return;
  for (const parameter of SHARE_PARAMS) url.searchParams.delete(parameter);
  window.history.replaceState(
    window.history.state,
    '',
    `${url.pathname}${url.search}${url.hash}`,
  );
}
