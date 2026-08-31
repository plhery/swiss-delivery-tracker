import { describe, expect, it } from 'vitest';
import { CChezVousTracker } from './cChezVous';

describe('C Chez Vous live anonymous tracking', () => {
  it.each([
    'FGRC45BKLM',
    '4TZKO156790--59600',
  ])('maps the retired official example %s to the clean redirect/404 result', async (number) => {
    // Both examples are printed by C Chez Vous under its official tracking form:
    // https://www.cchezvous.fr/suivi-colis
    await expect(new CChezVousTracker().fetch(number)).rejects.toMatchObject({
      name: 'CChezVousTrackingError',
      message: 'C Chez Vous could not locate the shipment',
      status: 404,
    });
  });
});
