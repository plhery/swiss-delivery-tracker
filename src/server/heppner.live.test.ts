import { describe, expect, it } from 'vitest';
import { HeppnerTracker } from './heppner';

describe('Heppner live anonymous tracking', () => {
  it('returns the provider-backed public timeline for a documented public shipment', async () => {
    // Published by the merchant in a verified-customer response:
    // https://www.avis-verifies.com/avis-clients/homifab.com?p=25gst
    await expect(new HeppnerTracker().fetch('25461320', '92410')).resolves.toMatchObject({
      status: 'exception',
      events: expect.arrayContaining([
        expect.objectContaining({ provider_code: 'SOL_REI', stage: 'returned' }),
      ]),
    });
  });

  it('maps an unassigned but validly shaped shipment to a clean 404', async () => {
    await expect(new HeppnerTracker().fetch('00000000', '75001')).rejects.toMatchObject({
      name: 'HeppnerTrackingError',
      status: 404,
      message: 'Heppner could not locate the shipment',
    });
  });
});
