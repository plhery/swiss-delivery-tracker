import { pathToFileURL } from 'node:url';
import contract from '../../contracts/openapi.json' with { type: 'json' };

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_ATTEMPTS = 2;
const MAX_CONCURRENCY = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface CanaryTarget {
  carrierId: string;
  displayName: string;
  url: string;
}

export interface CanaryResult {
  target: CanaryTarget;
  status: number | null;
  error?: string;
}

export function canaryHealthy(result: CanaryResult): boolean {
  return result.status !== null && result.status < 500;
}

export function automaticCanaryTargets(
  definitions: unknown = contract['x-carriers'],
): CanaryTarget[] {
  if (!isRecord(definitions)) throw new TypeError('Carrier definitions must be an object');
  const targets: CanaryTarget[] = [];
  for (const [carrierId, value] of Object.entries(definitions)) {
    if (!isRecord(value) || !isRecord(value.tracking) || value.tracking.mode !== 'automatic') {
      continue;
    }
    if (typeof value.displayName !== 'string' || typeof value.canaryUrl !== 'string') {
      throw new TypeError(`Automatic carrier ${carrierId} has no canary metadata`);
    }
    let url: URL;
    try {
      url = new URL(value.canaryUrl);
    } catch (error) {
      throw new TypeError(`Automatic carrier ${carrierId} has an unsafe canary URL`, { cause: error });
    }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
      throw new TypeError(`Automatic carrier ${carrierId} has an unsafe canary URL`);
    }
    targets.push({ carrierId, displayName: value.displayName, url: url.toString() });
  }
  return targets;
}

export async function requestCanaryStatus(url: string, timeoutMs: number): Promise<number> {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/json;q=0.8,*/*;q=0.5',
      'User-Agent': 'SwissDeliveryTracker-Canary/1.0',
    },
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  try {
    await response.body?.cancel();
  } catch {
    // The HTTP status is sufficient even if the probe body cannot be cancelled.
  }
  return response.status;
}

export async function probeCanaryTarget(
  target: CanaryTarget,
  options: {
    timeoutMs?: number;
    attempts?: number;
    fetchStatus?: (url: string, timeoutMs: number) => Promise<number>;
  } = {},
): Promise<CanaryResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const fetchStatus = options.fetchStatus ?? requestCanaryStatus;
  if (!Number.isInteger(attempts) || attempts < 1) throw new TypeError('Canary attempts must be positive');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Canary timeout must be positive');
  let status: number | null = null;
  let error: string | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      status = await fetchStatus(target.url, timeoutMs);
      error = undefined;
      if (status < 500) break;
    } catch (caught) {
      status = null;
      error = caught instanceof Error ? caught.name : typeof caught;
    }
  }
  return { target, status, ...(error ? { error } : {}) };
}

export async function runCanaries(
  targets: CanaryTarget[],
  options: Parameters<typeof probeCanaryTarget>[1] = {},
): Promise<CanaryResult[]> {
  const results: CanaryResult[] = new Array(targets.length);
  let cursor = 0;
  const runWorker = async () => {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await probeCanaryTarget(targets[index]!, options);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENCY, targets.length) }, runWorker),
  );
  return results;
}

function optionValue(argv: string[], name: string, fallback: number): number {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

export async function carrierCanaryMain(argv = process.argv.slice(2)): Promise<number> {
  const timeoutMs = optionValue(argv, '--timeout', DEFAULT_TIMEOUT_MS / 1_000) * 1_000;
  const attempts = optionValue(argv, '--attempts', DEFAULT_ATTEMPTS);
  const results = await runCanaries(automaticCanaryTargets(), { timeoutMs, attempts });
  for (const result of results) {
    const hostname = new URL(result.target.url).hostname;
    if (canaryHealthy(result)) {
      console.log(`PASS ${result.target.carrierId} ${hostname} HTTP ${result.status}`);
    } else if (result.status !== null) {
      console.log(`FAIL ${result.target.carrierId} ${hostname} HTTP ${result.status}`);
    } else {
      console.log(`FAIL ${result.target.carrierId} ${hostname} ${result.error ?? 'unreachable'}`);
    }
  }
  const healthy = results.filter(canaryHealthy).length;
  console.log(`${healthy}/${results.length} automatic carrier front doors reachable`);
  return healthy === results.length ? 0 : 1;
}

const executable = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === executable) {
  process.exitCode = await carrierCanaryMain();
}
