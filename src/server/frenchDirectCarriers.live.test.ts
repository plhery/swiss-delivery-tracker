import { describe, expect, it } from 'vitest';
import { ColisPriveTracker } from './colisPrive';
import { GeodisTracker } from './geodis';
import { LaPosteTracker } from './laPoste';
import { RelaisColisTracker } from './relaisColis';

describe('French direct carriers live wrong-number handling', () => {
  it('maps Relais Colis no data to a clean 404', async () => {
    await expect(new RelaisColisTracker().fetch('0000000000')).rejects.toMatchObject({
      name: 'RelaisColisTrackingError',
      status: 404,
      message: 'Relais Colis could not locate the shipment',
    });
  });

  it.each([
    ['La Poste', 'RA000000005FR'],
    ['Chronopost', 'XY000000005FR'],
  ])('gets a privacy-safe %s no-result or the recognized edge challenge', async (_carrier, number) => {
    let caught: unknown;
    try {
      await new LaPosteTracker().fetch(number);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error && caught.name === 'LaPosteTrackingError') {
      expect(caught).toMatchObject({
        status: 404,
        code: 104,
        message: 'La Poste could not locate the shipment',
      });
    } else {
      expect(caught).toMatchObject({
        name: 'UpstreamHttpError',
        provider: 'La Poste tracking',
      });
      const status = (caught as { status?: unknown }).status;
      expect([403, 404]).toContain(status);
      expect((caught as Error).message).toBe(`La Poste tracking returned HTTP ${status}`);
    }
  });

  it('maps Colis Prive no data to a clean 404 without exposing the postcode credential', async () => {
    await expect(new ColisPriveTracker().fetch('00000000000075001')).rejects.toMatchObject({
      name: 'ColisPriveTrackingError',
      status: 404,
      message: 'Colis Privé could not locate the shipment',
    });
  });

  it('maps GEODIS no data to a clean 404', async () => {
    await expect(new GeodisTracker().fetch('1G0000000000')).rejects.toMatchObject({
      name: 'GeodisTrackingError',
      status: 404,
      message: 'GEODIS could not locate the shipment',
    });
  });
});
