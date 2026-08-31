import { describe, expect, it } from 'vitest';
import { SwissPostCargoTracker } from './swissPostCargo';

describe('Swiss Post Cargo live anonymous tracking', () => {
  it('resolves the shipment number published by Swiss Post Cargo as its own example', async () => {
    // The official Hugger/Swiss Post Cargo tracking form labels 12345678 as
    // “z.B.” (for example): https://portal-de1.swisspost-cargo.com/Track
    await expect(new SwissPostCargoTracker().fetch('12345678')).resolves.toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: expect.stringMatching(/delivered/i),
      expected_delivery: null,
      timezone: 'Europe/Zurich',
      events: expect.arrayContaining([
        expect.objectContaining({ stage: 'delivered' }),
      ]),
    });
  });

  it('maps the official null-data response for a wrong number to a clean 404', async () => {
    await expect(new SwissPostCargoTracker().fetch('CODEXINVALID20260831')).rejects.toMatchObject({
      name: 'SwissPostCargoTrackingError',
      status: 404,
      message: 'Swiss Post Cargo could not locate the shipment',
    });
  });
});
