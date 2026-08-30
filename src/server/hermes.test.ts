import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hermesStatus,
  HermesTracker,
  HermesTrackingError,
  parseHermesTrackingResponse,
} from './hermes';

const WRONG_HERMES_NUMBER = '12345678';
const EMPTY_ORDER = {
  body: {
    abstellgenehmigung: null,
    anzeigeSteuerung: null,
    artikeldaten: [],
    auftragsdaten: {
      auftragId: null,
      auftragsart: null,
      lieferdatum: null,
      lieferscheinnummer: WRONG_HERMES_NUMBER,
      statusjourneyDto: null,
    },
    depotdaten: null,
    versenderdaten: null,
  },
  statusCode: '200 OK',
};

afterEach(() => vi.restoreAllMocks());

describe('Hermes no-data response', () => {
  it('rejects the official empty-order placeholder as a privacy-safe 404', () => {
    expect(() => parseHermesTrackingResponse(EMPTY_ORDER, WRONG_HERMES_NUMBER))
      .toThrow(HermesTrackingError);
    try {
      parseHermesTrackingResponse(EMPTY_ORDER, WRONG_HERMES_NUMBER);
    } catch (error) {
      expect(error).toMatchObject({
        name: 'HermesTrackingError',
        status: 404,
        message: 'Hermes could not locate the shipment',
      });
      expect(String(error)).not.toContain(WRONG_HERMES_NUMBER);
    }
  });

  it('does not accept an empty object as a pending shipment', () => {
    expect(() => parseHermesTrackingResponse({}, WRONG_HERMES_NUMBER))
      .toThrow('Hermes returned an invalid tracking response');
  });

  it('rejects a non-empty response for a different shipment', () => {
    const otherShipment = {
      body: {
        auftragsdaten: {
          lieferscheinnummer: '87654321',
          statusjourneyDto: {
            statusdaten: [{
              sendungsstatusId: 20_000,
              sendungsstatus: 'Unterwegs',
              sendungsstatusBuchungszeitpunkt: '2026-08-30T12:00:00+02:00',
            }],
          },
        },
      },
    };
    expect(() => parseHermesTrackingResponse(otherShipment, WRONG_HERMES_NUMBER))
      .toThrow('Hermes returned a different shipment');
  });

  it('normalizes the public Hermes status IDs', () => {
    expect([
      [40, 'pending'],
      [100, 'in_transit'],
      [430, 'out_for_delivery'],
      [700, 'delivered'],
      [702, 'delivered'],
      [742, 'delivered'],
      [318, 'exception'],
    ].map(([statusId]) => hermesStatus(statusId))).toEqual([
      'pending',
      'in_transit',
      'out_for_delivery',
      'delivered',
      'delivered',
      'delivered',
      'exception',
    ]);
  });

  it('parses a sanitized fixture from Hermes\'s public delivered sample', () => {
    const result = parseHermesTrackingResponse({
      body: {
        auftragsdaten: {
          auftragId: 66_508_126,
          auftragsart: 'Lieferung',
          lieferscheinnummer: '62162057330000611',
          statusjourneyDto: {
            auftragstatusdaten: [{
              sendungsstatusId: 700,
              sendungsstatus: 'Deine Sendung wurde erfolgreich zugestellt.',
              sendungsstatusBuchungszeitpunkt: '2026-08-05 12:50',
            }, {
              sendungsstatusId: 790,
              sendungsstatus: null,
              sendungsstatusBuchungszeitpunkt: '2026-08-06 11:36',
            }],
            statusdaten: [{
              sendungsstatusId: 10_864,
              sendungsstatus: 'Ware geliefert.',
              sendungsstatusBuchungszeitpunkt: '2026-08-05 12:50',
            }, {
              sendungsstatusId: 10_900,
              sendungsstatus: 'Ihre Sendung wurde bei der angegebenen Adresse zugestellt.',
              sendungsstatusBuchungszeitpunkt: '2026-08-05 19:21',
            }],
          },
        },
      },
    }, '62162057330000611');

    expect(result).toMatchObject({
      status: 'delivered',
      last_update: '2026-08-05 12:50',
      last_status_text: 'Deine Sendung wurde erfolgreich zugestellt.',
    });
    expect(result.events).toHaveLength(1);
    expect(result.events?.[0]).toMatchObject({ stage: 'delivered' });
    expect(result.events?.some((event) => event.description === 'Tracking update')).toBe(false);
  });

  it('exercises the anonymous API path with a valid-shaped wrong number', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify(EMPTY_ORDER),
      { headers: { 'Content-Type': 'application/json' } },
    ));

    await expect(new HermesTracker(1_000).fetch(WRONG_HERMES_NUMBER))
      .rejects.toBeInstanceOf(HermesTrackingError);
    const request = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(request.origin + request.pathname).toBe('https://myhes.de/api/request/auftragsdaten');
    expect(request.searchParams.get('parcelNumber')).toBe(WRONG_HERMES_NUMBER);
  });
});
