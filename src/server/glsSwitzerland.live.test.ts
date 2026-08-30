import { describe, expect, it } from 'vitest';
import { GLSSwitzerlandTracker } from './glsSwitzerland';

describe('GLS Switzerland live anonymous tracking', () => {
  it('maps the official wrong-number response to a clean 404', async () => {
    await expect(new GLSSwitzerlandTracker().fetch('88888888888')).rejects.toMatchObject({
      name: 'GLSSwitzerlandTrackingError',
      status: 404,
      message: 'GLS Switzerland could not locate the shipment',
    });
  });
});
