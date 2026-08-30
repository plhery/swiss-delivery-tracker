import { describe, expect, it } from 'vitest';
import { DPDTracker } from './dpd';

describe('DPD Switzerland live guest tracking', () => {
  it('recognizes a wrong number or the current browser challenge fallback', async () => {
    let error: unknown;
    try {
      await new DPDTracker().fetch('00000000000000', '8000');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error && error.name === 'DPDTrackingError') {
      expect(error).toMatchObject({
        status: 404,
        message: 'DPD could not locate the shipment',
      });
    } else {
      expect(error).toMatchObject({
        name: 'RangeError',
        message: expect.stringContaining('browser challenge solver'),
      });
    }
  });
});
