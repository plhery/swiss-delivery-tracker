import { describe, expect, it } from 'vitest';
import { HeppnerTracker } from './heppner';

describe('Heppner live anonymous tracking', () => {
  it('maps an unassigned but validly shaped shipment to a clean 404', async () => {
    await expect(new HeppnerTracker().fetch('00000000', '75001')).rejects.toMatchObject({
      name: 'HeppnerTrackingError',
      status: 404,
      message: 'Heppner could not locate the shipment',
    });
  });
});
