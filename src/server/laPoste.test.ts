import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LaPosteTracker,
  laPosteTrackingApiUrl,
  laPosteTrackingUrl,
  normalizeLaPosteTrackingNumber,
  parseLaPosteTrackingResponse,
} from './laPoste';

const TRACKING_NUMBER = 'AB12345678901';

function deliveredFixture() {
  return [{
    lang: 'fr',
    returnCode: 0,
    returnMessage: 'OK',
    shipment: {
      idShip: TRACKING_NUMBER,
      product: 'colissimo',
      isFinal: true,
      deliveryDate: '2026-01-08T11:14:50+01:00',
      estimDate: '2026-01-09T18:00:00+01:00',
      timeline: [{
        id: 2,
        shortLabel: 'Distribué',
        date: '2026-01-08T11:14:50+01:00',
        status: true,
        code: 'DELIV',
      }],
      event: [{
        group: 'ACHNAT',
        code: 'TR1',
        label: 'Votre colis est en transit',
        date: '2026-01-07T10:42:00+01:00',
        country: 'FR',
        order: 4,
      }, {
        group: 'DESBAL',
        code: 'DI1',
        label: 'Colis livré au destinataire',
        date: '2026-01-08T11:14:50+01:00',
        country: 'FR',
        order: 5,
        recipientAddress: 'must never survive normalization',
      }],
      recipient: { address: 'must never survive normalization' },
    },
  }];
}

afterEach(() => vi.restoreAllMocks());

describe('La Poste tracking input', () => {
  it('normalizes domestic and UPU identifiers and builds official URLs', () => {
    expect(normalizeLaPosteTrackingNumber('ab 123.456-78901')).toBe(TRACKING_NUMBER);
    expect(normalizeLaPosteTrackingNumber('RA123456785FR')).toBe('RA123456785FR');
    expect(normalizeLaPosteTrackingNumber('12345678901234q')).toBe('12345678901234Q');

    const page = new URL(laPosteTrackingUrl(TRACKING_NUMBER));
    expect(page.origin).toBe('https://www.laposte.fr');
    expect(page.searchParams.get('code')).toBe(TRACKING_NUMBER);
    const api = new URL(laPosteTrackingApiUrl(TRACKING_NUMBER));
    expect(api.pathname).toBe(`/ssu/sun/back/suivi-unifie/${TRACKING_NUMBER}`);
    expect(api.searchParams.get('lang')).toBe('fr');
  });

  it('rejects unsupported and unsafe identifiers', () => {
    for (const value of [
      '123',
      'AB1234567890',
      'ABCDEFGHIJKLMNO',
      'AB12345678901&lang=en',
      'AB1234567890É',
      'ABCDEFGHIJKLMN1',
    ]) {
      expect(() => laPosteTrackingUrl(value)).toThrow('13- or 15-character');
    }
  });
});

describe('La Poste response normalization', () => {
  it('sorts events, maps the official group, and excludes response PII', () => {
    const result = parseLaPosteTrackingResponse(deliveredFixture(), TRACKING_NUMBER);

    expect(result).toMatchObject({
      status: 'delivered',
      last_status_text: 'Colis livré au destinataire',
      last_update: '2026-01-08T11:14:50+01:00',
      expected_delivery: null,
      timezone: 'Europe/Paris',
    });
    expect(result.events).toEqual([
      {
        time: '2026-01-08T11:14:50+01:00',
        location: 'FR',
        description: 'Colis livré au destinataire',
        stage: 'delivered',
        provider_code: 'DESBAL/DI1',
      },
      {
        time: '2026-01-07T10:42:00+01:00',
        location: 'FR',
        description: 'Votre colis est en transit',
        stage: 'in_transit',
        provider_code: 'ACHNAT/TR1',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('must never survive');
  });

  it('uses timeline data when an announced parcel has no event history', () => {
    const fixture = deliveredFixture();
    fixture[0]!.shipment.isFinal = false;
    fixture[0]!.shipment.event = [];
    fixture[0]!.shipment.timeline = [{
      id: 1,
      shortLabel: 'Information reçue, colis préparé',
      date: '2026-01-02T17:54:00+01:00',
      status: true,
      code: 'ACCEPT',
    }];

    expect(parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER)).toMatchObject({
      status: 'pending',
      last_update: '2026-01-02T17:54:00+01:00',
      events: [],
    });
  });

  it('normalizes Chronopost shipments returned by the same unified API', () => {
    const chronopostNumber = 'PZ123456785JF';
    const fixture = deliveredFixture();
    fixture[0]!.shipment.idShip = chronopostNumber;
    fixture[0]!.shipment.product = 'chronopost';
    fixture[0]!.shipment.event = [{
      group: '',
      code: 'DI1',
      label: 'Livraison effectuée',
      date: '2026-08-13T09:55:00+02:00',
      country: '',
      order: 100,
      recipientAddress: 'must never survive normalization',
    }];

    const result = parseLaPosteTrackingResponse(fixture, chronopostNumber);
    expect(result).toMatchObject({
      status: 'delivered',
      last_status_text: 'Livraison effectuée',
      events: [{ provider_code: 'DI1', stage: 'delivered' }],
    });
    expect(JSON.stringify(result)).not.toContain('must never survive');
  });

  it('uses return semantics rather than treating every final event as delivered', () => {
    const fixture = deliveredFixture();
    fixture[0]!.shipment.event = [{
      group: '',
      code: 'DI2',
      label: 'Colis mis à disposition du vendeur suite à un retour',
      date: '2026-08-14T10:00:00+02:00',
      country: 'FR',
      order: 101,
      recipientAddress: '',
    }];

    expect(parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER)).toMatchObject({
      status: 'exception',
      events: [{ stage: 'returned', provider_code: 'DI2' }],
    });
  });

  it('lets explicit incidents override codes and recognizes pickup readiness', () => {
    const fixture = deliveredFixture();
    fixture[0]!.shipment.isFinal = false;
    fixture[0]!.shipment.event = [{
      group: '',
      code: 'DR1',
      label: 'Incident : livraison impossible',
      date: '2026-08-14T10:00:00+02:00',
      country: 'FR',
      order: 101,
      recipientAddress: '',
    }];
    expect(parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER)).toMatchObject({
      status: 'exception',
      events: [{ stage: 'failed_attempt' }],
    });

    fixture[0]!.shipment.event = [{
      group: 'DISMAD',
      code: 'AG1',
      label: 'Votre colis est disponible au point de retrait',
      date: '2026-08-14T11:00:00+02:00',
      country: 'FR',
      order: 102,
      recipientAddress: '',
    }];
    expect(parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER)).toMatchObject({
      status: 'out_for_delivery',
      events: [{ stage: 'ready_for_pickup' }],
    });
  });

  it('does not confuse a delivery driver or a future delivery with delivery', () => {
    const fixture = deliveredFixture();
    fixture[0]!.shipment.isFinal = false;
    fixture[0]!.shipment.event = [{
      group: '',
      code: '',
      label: 'En cours de livraison par le livreur',
      date: '2026-08-14T11:00:00+02:00',
      country: 'FR',
      order: 102,
      recipientAddress: '',
    }];
    expect(parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER)).toMatchObject({
      status: 'out_for_delivery',
      events: [{ stage: 'out_for_delivery' }],
    });

    fixture[0]!.shipment.event[0]!.label = 'Votre colis va être livré prochainement';
    expect(parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER)).toMatchObject({
      status: 'in_transit',
      events: [{ stage: 'in_transit' }],
    });
  });

  it('rejects provider errors and responses for another parcel', () => {
    let providerError: unknown;
    try {
      parseLaPosteTrackingResponse([{
      returnCode: 104,
      returnMessage: 'Unknown shipment',
      }], TRACKING_NUMBER);
    } catch (error) {
      providerError = error;
    }
    expect(providerError).toMatchObject({
      message: 'La Poste could not locate the shipment',
      status: 404,
    });
    expect(String(providerError)).not.toContain('Unknown shipment');

    const fixture = deliveredFixture();
    fixture[0]!.shipment.idShip = 'ZZ12345678901';
    expect(() => parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER))
      .toThrow('different shipment');
  });

  it('rejects null provider codes and impossible calendar dates', () => {
    const nullCode = deliveredFixture();
    nullCode[0]!.returnCode = null as unknown as number;
    expect(() => parseLaPosteTrackingResponse(nullCode, TRACKING_NUMBER))
      .toThrow('tracking is unavailable');

    const invalidDates = deliveredFixture();
    invalidDates[0]!.shipment.isFinal = false;
    invalidDates[0]!.shipment.estimDate = '2026-02-30T18:00:00+01:00';
    invalidDates[0]!.shipment.event[1]!.date = '2026-02-30T11:14:50+01:00';
    const result = parseLaPosteTrackingResponse(invalidDates, TRACKING_NUMBER);
    expect(result.expected_delivery).toBeNull();
    expect(result.events?.[0]?.time).toBe('');
  });

  it('fetches the bounded official endpoint', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify(deliveredFixture()),
      { headers: { 'Content-Type': 'application/json' } },
    ));

    await expect(new LaPosteTracker(1_000).fetch(TRACKING_NUMBER)).resolves.toMatchObject({
      status: 'delivered',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [requested, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(requested)).searchParams.get('lang')).toBe('fr');
    expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' });
  });
});
