import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HeppnerTracker,
  HeppnerTrackingError,
  heppnerDetailUrl,
  heppnerSearchUrl,
  heppnerTrackingPageUrl,
  normalizeHeppnerCredential,
  normalizeHeppnerTrackingNumber,
  parseHeppnerCapability,
  parseHeppnerTrackingResponse,
} from './heppner';

// Fully synthetic provider-shaped values. Live tests deliberately use only a
// wrong-number canary because Heppner does not publish a reusable demo shipment.
const TEST_TRACKING_NUMBER = '23456789';
const TEST_POSTCODE = '75001';
const TEST_CAPABILITY = 'MjM0NTY3ODkmNzUwMDEmRlI=';

function trackingPayload(receipt: string | number = TEST_TRACKING_NUMBER): unknown {
  return [{
    receipt,
    sender_name: 'PRIVATE SENDER',
    customer_name: 'PRIVATE RECIPIENT',
    reference_one: 'PRIVATE ORDER REFERENCE',
    contents: [{ description: 'PRIVATE MERCHANDISE' }],
    pickup_code: 'PRIVATE PICKUP CODE',
    events: [{
      event: 'SOL_REI',
      code: 'SOL_REI',
      step: 'MARCHANDISE_RETOURNEE',
      state: 'EXPE_EN_COURS',
      event_date: '2026-07-01T13:21:00.000+00:00',
      agency_location: 'PRIVATE ADDRESS',
      appointment_key: 'PRIVATE APPOINTMENT TOKEN',
    }, {
      event: 'RST_PRE',
      code: 'RST_PRE',
      step: 'EN_ATTENTE_INSTRUCTIONS',
      state: 'EN_ATTENTE_INSTRUCTIONS',
      event_date: '2026-07-01T10:55:00.000+00:00',
      appointment_key: 'PRIVATE APPOINTMENT TOKEN',
    }, {
      event: 'MLV_RCA',
      code: 'MLV_RCA',
      step: 'LIVRAISON',
      state: 'EXPE_EN_COURS',
      event_date: '2026-06-30T06:03:00.000+00:00',
    }, {
      event: 'PCH_CFM',
      code: 'PCH_CFM',
      step: 'PRISE_EN_CHARGE',
      state: 'EXPE_EN_COURS',
      event_date: '2026-06-26T11:18:00.000+00:00',
    }, {
      event: 'EXP_CFM',
      code: 'EXP_CFM',
      step: 'ACHEMINEMENT',
      state: 'EXPE_EN_COURS',
      event_date: '2026-06-26T00:06:00.000+00:00',
    }],
  }];
}

afterEach(() => vi.restoreAllMocks());

describe('Heppner anonymous tracking input', () => {
  it('normalizes the current eight-digit form and infers France or Switzerland from postcode length', () => {
    expect(normalizeHeppnerTrackingNumber('23 456 789')).toBe(TEST_TRACKING_NUMBER);
    expect(normalizeHeppnerCredential(TEST_TRACKING_NUMBER, TEST_POSTCODE)).toEqual({
      trackingNumber: TEST_TRACKING_NUMBER,
      postcode: TEST_POSTCODE,
      countryCode: 'FR',
    });
    expect(normalizeHeppnerCredential(TEST_TRACKING_NUMBER, '1201')).toEqual({
      trackingNumber: TEST_TRACKING_NUMBER,
      postcode: '1201',
      countryCode: 'CH',
    });
  });

  it('rejects unsupported identifiers, postcodes, and parameter injection', () => {
    for (const value of ['2345678', '234567890', '2345-6789', '2345678A', '23456789&admin=true']) {
      expect(() => normalizeHeppnerTrackingNumber(value)).toThrow('exactly 8 digits');
    }
    for (const postcode of ['750', '750010', '75A01', '75001&countryCode=CH']) {
      expect(() => normalizeHeppnerCredential(TEST_TRACKING_NUMBER, postcode))
        .toThrow('delivery postcode');
    }
  });

  it('constructs the exact official search URL and verifies the returned capability', () => {
    const search = new URL(heppnerSearchUrl(TEST_TRACKING_NUMBER, TEST_POSTCODE));
    expect(search.origin).toBe('https://myportal.heppner-group.com');
    expect(search.pathname).toBe('/api/recipient/search/expedition');
    expect(Object.fromEntries(search.searchParams)).toEqual({
      zipCode: TEST_POSTCODE,
      receipt: TEST_TRACKING_NUMBER,
      countryCode: 'FR',
    });
    expect(parseHeppnerCapability(
      ` ${TEST_CAPABILITY}\n`,
      TEST_TRACKING_NUMBER,
      TEST_POSTCODE,
    )).toBe(TEST_CAPABILITY);
    expect(heppnerDetailUrl(TEST_CAPABILITY)).toBe(
      `https://myportal.heppner-group.com/api/recipient/search/detailexpedition?expedition=${encodeURIComponent(TEST_CAPABILITY)}`,
    );
    expect(heppnerTrackingPageUrl(TEST_CAPABILITY)).toBe(
      `https://myportal.heppner-group.com/tracking/${encodeURIComponent(TEST_CAPABILITY)}`,
    );
  });

  it('rejects capabilities for another shipment or malformed base64', () => {
    const wrong = Buffer.from('99999999&75001&FR').toString('base64');
    expect(() => parseHeppnerCapability(wrong, TEST_TRACKING_NUMBER, TEST_POSTCODE))
      .toThrow('different shipment');
    expect(() => parseHeppnerCapability('not-a-capability', TEST_TRACKING_NUMBER, TEST_POSTCODE))
      .toThrow('invalid tracking capability');
  });
});

describe('Heppner response normalization', () => {
  it('parses a provider-shaped timeline and excludes shipment parties and credentials', () => {
    const result = parseHeppnerTrackingResponse(trackingPayload(), TEST_TRACKING_NUMBER);

    expect(result).toMatchObject({
      status: 'exception',
      last_status_text: 'Returned to sender',
      last_update: '2026-07-01T13:21:00Z',
      expected_delivery: null,
      timezone: 'Europe/Paris',
    });
    expect(result.events).toEqual([{
      time: '2026-07-01T13:21:00Z',
      location: '',
      description: 'Returned to sender',
      stage: 'returned',
      provider_code: 'SOL_REI',
    }, {
      time: '2026-07-01T10:55:00Z',
      location: '',
      description: 'Delivery instructions required',
      stage: 'failed_attempt',
      provider_code: 'RST_PRE',
    }, {
      time: '2026-06-30T06:03:00Z',
      location: '',
      description: 'Out for delivery',
      stage: 'out_for_delivery',
      provider_code: 'MLV_RCA',
    }, {
      time: '2026-06-26T11:18:00Z',
      location: '',
      description: 'Shipment collected',
      stage: 'accepted',
      provider_code: 'PCH_CFM',
    }, {
      time: '2026-06-26T00:06:00Z',
      location: '',
      description: 'In transit',
      stage: 'in_transit',
      provider_code: 'EXP_CFM',
    }]);
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      'PRIVATE SENDER',
      'PRIVATE RECIPIENT',
      'PRIVATE ORDER REFERENCE',
      'PRIVATE MERCHANDISE',
      'PRIVATE PICKUP CODE',
      'PRIVATE ADDRESS',
      'PRIVATE APPOINTMENT TOKEN',
    ]) expect(serialized).not.toContain(privateValue);
  });

  it('rejects empty, malformed, mismatched, and incomplete payloads', () => {
    expect(() => parseHeppnerTrackingResponse([], TEST_TRACKING_NUMBER))
      .toThrow(HeppnerTrackingError);
    expect(() => parseHeppnerTrackingResponse({}, TEST_TRACKING_NUMBER))
      .toThrow('invalid tracking response');
    expect(() => parseHeppnerTrackingResponse(trackingPayload('99999999'), TEST_TRACKING_NUMBER))
      .toThrow('different shipment');
    expect(() => parseHeppnerTrackingResponse([{
      receipt: TEST_TRACKING_NUMBER,
      events: [],
    }], TEST_TRACKING_NUMBER)).toThrow('tracking history');
  });
});

describe('Heppner tracker', () => {
  it('performs the bounded official search then detail requests', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    fetcher.mockResolvedValueOnce(new Response(TEST_CAPABILITY, {
      headers: { 'Content-Type': 'text/plain' },
    }));
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(trackingPayload()), {
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(new HeppnerTracker(1_000).fetch(TEST_TRACKING_NUMBER, TEST_POSTCODE))
      .resolves.toMatchObject({ status: 'exception' });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      heppnerSearchUrl(TEST_TRACKING_NUMBER, TEST_POSTCODE),
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store', redirect: 'error' });
    expect(String(fetcher.mock.calls[1]?.[0])).toBe(heppnerDetailUrl(TEST_CAPABILITY));
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('Referer'))
      .toBe(heppnerTrackingPageUrl(TEST_CAPABILITY));
  });

  it('turns the official wrong-number response into a clean privacy-safe 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'NOT_FOUND: PRIVATE INTERNAL PROVIDER DETAIL',
      { status: 404 },
    ));

    let error: unknown;
    try {
      await new HeppnerTracker(1_000).fetch('00000000', '75001');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HeppnerTrackingError);
    expect(error).toMatchObject({
      status: 404,
      message: 'Heppner could not locate the shipment',
    });
    expect(JSON.stringify(error)).not.toContain('PRIVATE INTERNAL PROVIDER DETAIL');
  });
});
