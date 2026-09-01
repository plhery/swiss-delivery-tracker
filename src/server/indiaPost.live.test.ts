import { describe, expect, it } from 'vitest';
import { IndiaPostTracker } from './indiaPost';

const REAL_PUBLIC_NUMBER = 'JN067614884IN';
const WRONG_VALID_NUMBER = 'RR000000005IN';

describe('India Post live tracking', () => {
  it('returns real tracking history for MySpeedPost\'s public example', async () => {
    const result = await new IndiaPostTracker().fetch(REAL_PUBLIC_NUMBER);

    expect([
      'pending',
      'in_transit',
      'out_for_delivery',
      'delivered',
      'exception',
    ]).toContain(result.status);
    expect(result.last_status_text).toEqual(expect.any(String));
    expect(result.last_update).toEqual(expect.any(String));
    expect(result.events?.length).toBeGreaterThan(0);
  });

  it('maps a valid-shaped synthetic number to a clean 404', async () => {
    await expect(new IndiaPostTracker().fetch(WRONG_VALID_NUMBER)).rejects.toMatchObject({
      name: 'IndiaPostTrackingError',
      status: 404,
      message: 'India Post could not locate the shipment',
    });
  });
});
