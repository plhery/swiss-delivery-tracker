import { describe, expect, it } from 'vitest';
import { PaackTracker } from './paack';

describe('Paack live anonymous tracking', () => {
  it('maps a validly shaped wrong order and postcode to the official clean redirect result', async () => {
    await expect(new PaackTracker().fetch('00000000', '75001')).rejects.toMatchObject({
      name: 'PaackTrackingError',
      message: 'Paack could not locate the shipment',
      status: 404,
    });
  });
});
