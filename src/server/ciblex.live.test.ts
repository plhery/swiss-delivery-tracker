import { describe, expect, it } from 'vitest';
import { CiblexTracker } from './ciblex';

describe('Ciblex live anonymous tracking', () => {
  it('recognizes the official empty-table response without mislabeling an empty 200', async () => {
    let error: unknown;
    try {
      await new CiblexTracker().fetch('12345678901234');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error && error.name === 'CiblexTrackingError') {
      expect(error).toMatchObject({
        status: 404,
        message: 'Ciblex could not locate the shipment',
      });
    } else {
      expect(error).toMatchObject({
        name: 'TypeError',
        message: 'Ciblex returned an empty tracking response',
      });
    }
  });
});
