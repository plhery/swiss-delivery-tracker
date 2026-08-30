import { describe, expect, it } from 'vitest';
import { GLSFranceTracker } from './glsFrance';

describe('GLS France live public tracking', () => {
  it('preserves the official 404 for a valid-shaped wrong number', async () => {
    await expect(new GLSFranceTracker().fetch('00ZZ00Z0')).rejects.toMatchObject({
      name: 'UpstreamHttpError',
      provider: 'GLS France tracking',
      status: 404,
    });
  });
});
