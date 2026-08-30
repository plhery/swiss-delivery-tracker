import { describe, expect, it } from 'vitest';
import { SwissPostCargoTracker } from './swissPostCargo';

describe('Swiss Post Cargo live anonymous tracking', () => {
  it('maps the official null-data response for a wrong number to a clean 404', async () => {
    await expect(new SwissPostCargoTracker().fetch('000000000000000')).rejects.toMatchObject({
      name: 'SwissPostCargoTrackingError',
      status: 404,
      message: 'Swiss Post Cargo could not locate the shipment',
    });
  });
});
