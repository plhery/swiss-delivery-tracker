import { describe, expect, it } from 'vitest';
import { CChezVousTracker } from './cChezVous';

describe('C Chez Vous live anonymous tracking', () => {
  it('parses the allowlisted fields of a publicly documented historical shipment', async () => {
    // Published by C Chez Vous in a public LinkedIn customer interview. The
    // adapter deliberately omits the recipient and delivery-address fields.
    await expect(new CChezVousTracker().fetch('PRJV50T7DP')).resolves.toMatchObject({
      status: 'pending',
      last_status_text: 'Commande enregistrée',
      expected_delivery: '2024-01-02',
      events: [{ stage: 'registered' }],
    });
  });

  it('maps a validly shaped wrong order to the official clean redirect/404 result', async () => {
    await expect(new CChezVousTracker().fetch('ZZZZZZZZZ0')).rejects.toMatchObject({
      name: 'CChezVousTrackingError',
      message: 'C Chez Vous could not locate the shipment',
      status: 404,
    });
  });
});
