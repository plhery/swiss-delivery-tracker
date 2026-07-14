import { afterEach, describe, expect, it, vi } from 'vitest';
import { uid } from './uid';

describe('uid', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses crypto.randomUUID when available', () => {
    const randomUUID = vi.fn().mockReturnValue('uuid-1');
    vi.stubGlobal('crypto', { randomUUID });
    expect(uid()).toBe('uuid-1');
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it('falls back to a time-and-random identifier', () => {
    vi.stubGlobal('crypto', undefined);
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(uid()).toMatch(/^id-rs-/);
  });
});
