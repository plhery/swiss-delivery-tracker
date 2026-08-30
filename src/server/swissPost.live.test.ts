import { describe, expect, it } from 'vitest';
import { SwissPostTracker } from './swissPost';

describe('Swiss Post live anonymous tracking', () => {
  it('maps the official empty result for a valid-shaped wrong number to a clean 404', async () => {
    await expect(new SwissPostTracker().fetch('989999999999999999')).rejects.toMatchObject({
      name: 'SwissPostTrackingError',
      status: 404,
      message: 'Swiss Post could not locate the shipment',
    });
  });
});
