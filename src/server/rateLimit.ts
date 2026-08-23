export type Clock = () => number;

/** In-memory sliding-window limiter for a single self-hosted Next.js process. */
export class RateLimiter {
  readonly #requests = new Map<string, number[]>();

  constructor(
    readonly maxKeys = 4_096,
    readonly clock: Clock = () => performance.now() / 1_000,
  ) {
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new RangeError('maxKeys must be a positive integer');
    }
  }

  retryAfter(key: string, options: { limit: number; window: number }): number {
    const { limit, window } = options;
    if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(window) || window <= 0) {
      throw new RangeError('Rate limits require a positive count and window');
    }

    const now = this.clock();
    const cutoff = now - window;
    const requests = this.#requests.get(key) ?? [];
    let firstActive = 0;
    while (firstActive < requests.length && requests[firstActive]! <= cutoff) {
      firstActive += 1;
    }
    if (firstActive > 0) requests.splice(0, firstActive);
    this.#requests.set(key, requests);

    if (requests.length >= limit) {
      return Math.max(1, Math.ceil(requests[0]! + window - now));
    }

    requests.push(now);
    if (this.#requests.size > this.maxKeys) this.#prune(cutoff, key);
    return 0;
  }

  #prune(cutoff: number, keep: string): void {
    for (const [key, requests] of this.#requests) {
      if (key === keep) continue;
      let firstActive = 0;
      while (firstActive < requests.length && requests[firstActive]! <= cutoff) {
        firstActive += 1;
      }
      if (firstActive > 0) requests.splice(0, firstActive);
      if (requests.length === 0) this.#requests.delete(key);
      if (this.#requests.size <= this.maxKeys) return;
    }

    for (const key of this.#requests.keys()) {
      if (key !== keep) this.#requests.delete(key);
      if (this.#requests.size <= this.maxKeys) return;
    }
  }
}
