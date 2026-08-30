import { describe, expect, it } from 'vitest';
import { DachserTracker } from './dachser';

describe('Dachser live public tracking', () => {
  it('recognizes the response for a wrong capability tuple without accepting a shipment', async () => {
    const trackingNumber = '12345678';
    const trackingUrl = 'https://customeriberia.dachser.com/customerarea/'
      + 'utilidades/seguimiento-publico/detalle?numeroUnico=12345678'
      + '&hash=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    try {
      await new DachserTracker().fetch(trackingNumber, trackingUrl);
      throw new Error('Dachser unexpectedly accepted a wrong shipment/access tuple');
    } catch (error) {
      expect([
        'DachserTrackingError',
        'UpstreamHttpError',
      ]).toContain((error as Error).name);
      expect(error).toMatchObject({
        status: expect.any(Number),
      });
      expect([404, 500]).toContain((error as { status: number }).status);
    }
  });
});
