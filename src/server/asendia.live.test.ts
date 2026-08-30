import { describe, expect, it } from 'vitest';
import { AsendiaTracker } from './asendia';

describe('Asendia live public tracking protocol', () => {
  it('reports the official Turnstile challenge instead of claiming a wrong-number lookup', async () => {
    const deliberatelyInvalidToken = `0.${'a'.repeat(64)}.${'b'.repeat(64)}`;
    await expect(new AsendiaTracker({
      turnstileTokenProvider: () => deliberatelyInvalidToken,
    }).fetch('ASE00000000')).rejects.toMatchObject({
      name: 'AsendiaChallengeError',
      status: 503,
      message: 'Asendia rejected the Cloudflare Turnstile token',
    });
  });
});
