const DEFAULT_MAX_BYTES = 2_000_000;

export class UpstreamHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
  ) {
    super(`${provider} returned HTTP ${status}`);
    this.name = 'UpstreamHttpError';
  }
}

async function cancelQuietly(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // Cancellation is cleanup; it must not hide the response error.
  }
}

export async function fetchBounded(
  url: string | URL,
  init: RequestInit,
  options: {
    provider: string;
    timeoutMs?: number;
    maxBytes?: number;
    redirect?: RequestRedirect;
    fetcher?: typeof fetch;
    allowHttpError?: boolean;
  },
): Promise<{ response: Response; bytes: Uint8Array }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(url, {
      ...init,
      cache: 'no-store',
      redirect: options.redirect ?? 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (error) {
    throw new Error(`${options.provider} is unreachable`, { cause: error });
  }
  if (!response.ok && !options.allowHttpError) {
    await cancelQuietly(response.body);
    throw new UpstreamHttpError(options.provider, response.status);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await cancelQuietly(response.body);
    throw new Error(`${options.provider} returned an unexpectedly large response`);
  }

  if (!response.body) return { response, bytes: new Uint8Array() };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the size error even if the upstream stream rejects cleanup.
        }
        throw new Error(`${options.provider} returned an unexpectedly large response`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { response, bytes };
}

export function decodeText(bytes: Uint8Array, encoding = 'utf-8'): string {
  return new TextDecoder(encoding, { fatal: false }).decode(bytes);
}

export function parseJsonBytes(bytes: Uint8Array, provider: string): unknown {
  try {
    return JSON.parse(decodeText(bytes).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new TypeError(`${provider} returned an invalid tracking response`, { cause: error });
  }
}
