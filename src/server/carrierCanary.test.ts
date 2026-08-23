import { describe, expect, it, vi } from 'vitest';
import {
  automaticCanaryTargets,
  canaryHealthy,
  probeCanaryTarget,
  runCanaries,
  type CanaryTarget,
} from './carrierCanary';

describe('carrier front-door canaries', () => {
  const target: CanaryTarget = {
    carrierId: 'carrier',
    displayName: 'Carrier',
    url: 'https://carrier.example/public/',
  };

  it('selects only automatic carriers with privacy-safe public URLs', () => {
    expect(automaticCanaryTargets({
      automatic: {
        displayName: 'Automatic',
        tracking: { mode: 'automatic' },
        canaryUrl: 'https://carrier.example/public/',
      },
      manual: { displayName: 'Manual', tracking: { mode: 'link-only' } },
    })).toEqual([{
      carrierId: 'automatic',
      displayName: 'Automatic',
      url: 'https://carrier.example/public/',
    }]);
    for (const url of [
      'https://carrier.example/?tracking=secret',
      'https://user:password@carrier.example/',
      'http://carrier.example/',
    ]) {
      expect(() => automaticCanaryTargets({
        carrier: {
          displayName: 'Carrier',
          tracking: { mode: 'automatic' },
          canaryUrl: url,
        },
      })).toThrow('unsafe');
    }
  });

  it('retries server failures and accepts challenge responses as reachable', async () => {
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce(503)
      .mockResolvedValueOnce(403);
    const result = await probeCanaryTarget(target, { attempts: 2, fetchStatus });
    expect(canaryHealthy(result)).toBe(true);
    expect(result.status).toBe(403);
  });

  it('caps concurrency while preserving target order', async () => {
    const targets = Array.from({ length: 10 }, (_, index) => ({
      ...target,
      carrierId: `carrier-${index}`,
    }));
    let active = 0;
    let maximum = 0;
    const fetchStatus = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return 204;
    };
    const results = await runCanaries(targets, { attempts: 1, fetchStatus });
    expect(results.map((result) => result.target.carrierId))
      .toEqual(targets.map((item) => item.carrierId));
    expect(maximum).toBeLessThanOrEqual(6);
  });
});
