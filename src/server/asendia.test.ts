import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AsendiaChallengeError,
  AsendiaTracker,
  AsendiaTrackingError,
  asendiaConfigApiUrl,
  asendiaEnvironmentUrl,
  asendiaHitToken,
  asendiaTrackingApiUrl,
  asendiaTrackingUrl,
  normalizeAsendiaTrackingNumber,
  parseAsendiaPublicHitKey,
  parseAsendiaTrackingResponse,
} from './asendia';

// Official Asendia documentation examples include ASE12345678 and S10 parcel
// identifiers such as LF092919653FR:
// https://send.asendia.com/es/tracking/
// https://www.asendia.dk/hubfs/Asendia%20Benelux%20onboarding%20docs/Asendia%20Sync%20-%20User%20Guide%201.pdf
const TRACKING_NUMBER = 'LF092919653FR';
const WRONG_TRACKING_NUMBER = 'ASE00000000';
// Public browser value captured only to make the official checksum algorithm deterministic.
const PUBLIC_HIT_KEY = '931c3f2dc020270300657b964e83679f8b2dd84301730a1c5ac21f33cf4a5618'; // gitleaks:allow
const TURNSTILE_TOKEN = `0.${'a'.repeat(64)}.${'b'.repeat(64)}`;
const FIXED_DATE = new Date('2026-08-30T12:00:00Z');

function environmentScript(): string {
  return `window.__ENV = ${JSON.stringify({
    NEXT_PUBLIC_NODE_ENV: 'production',
    NEXT_PUBLIC_BRANDED_HIT_KEY: PUBLIC_HIT_KEY,
  })};`;
}

function configFixture() {
  return {
    summary: 'Branded url found.',
    data: {
      id: 1,
      cname_url: 'track.asendia.com',
      brand_id: [{ brand_name: 'All', customer_id: '*' }],
      subsidiary: 1,
      subsidiary_name: 'Asendia HQ',
      verification_methods: {
        postal_code: true,
        last_name_match: true,
        first_name_match: true,
      },
      is_enabled: true,
    },
    context_code: 1000,
  };
}

// Provider-shaped fields are taken from Asendia's current official tracking
// bundle. The fixture is deterministic and deliberately includes private fields
// to prove that the adapter never returns them.
function deliveredFixture(trackingNumber = TRACKING_NUMBER) {
  return {
    summary: 'Parcel found.',
    context_code: 1000,
    data: [{
      tracking_id: trackingNumber,
      upper_tracking_id: trackingNumber,
      status: 'Delivered',
      origin_country_name: 'France',
      destination_country_name: 'Switzerland',
      shipment_date: '2026-08-25',
      delivery_date: '2026-08-29',
      order_id: 'private-order-reference',
      recipient_name: 'Private Recipient',
      recipient_address: '10 Private Street, 8000 Private City',
      recipient_email: 'private@example.test',
      events: [{
        eventDateTime: '29/08/2026 11:42',
        eventRate: 6,
        harmonizedCode: 'DELIVERED',
        harmonizedEvent: 'Delivered',
        eventDesc: 'Delivered to Private Recipient',
        scanningLocation: 'Zurich, CH',
        recipient_name: 'Private Recipient',
      }, {
        eventDateTime: '28/08/2026 07:18',
        eventRate: 4,
        harmonizedCode: 'ARRIVED_DESTINATION',
        harmonizedEvent: 'Arrived at destination',
        eventDesc: 'Arrived at destination',
        scanningLocation: 'Zurich, CH',
      }, {
        eventDateTime: '25/08/2026 16:03',
        eventRate: 1,
        harmonizedCode: 'INFO_RECEIVED',
        harmonizedEvent: 'Information received',
        eventDesc: 'Shipment information received',
        scanningLocation: 'Paris, FR',
      }],
    }],
  };
}

afterEach(() => vi.restoreAllMocks());

describe('Asendia tracking input and public protocol', () => {
  it('accepts documented identifier families and builds official URLs', () => {
    expect(normalizeAsendiaTrackingNumber('lf09 2919-653fr')).toBe(TRACKING_NUMBER);
    expect(normalizeAsendiaTrackingNumber('ASE12345678')).toBe('ASE12345678');
    expect(normalizeAsendiaTrackingNumber('123456789012345678901234567890'))
      .toBe('123456789012345678901234567890');
    expect(asendiaTrackingUrl(TRACKING_NUMBER))
      .toBe(`https://track.asendia.com/track/${TRACKING_NUMBER}`);
    expect(asendiaTrackingApiUrl())
      .toBe('https://track.asendia.com/api/1.0/branded-url/branded-parcel-search?sort=shipment_date');
    expect(asendiaConfigApiUrl()).toContain('/api/1.0/branded-url/get-config-data/');
    expect(asendiaEnvironmentUrl()).toBe('https://track.asendia.com/__env.js');
  });

  it('rejects unsafe identifiers', () => {
    for (const value of [
      'ABC1234',
      'ABCDEFGH',
      'LF092919653FR?admin=true',
      'LF092919653/FR',
      'LF092919653FÉ',
      '1'.repeat(41),
    ]) expect(() => normalizeAsendiaTrackingNumber(value)).toThrow('8 to 40 ASCII');
  });

  it('reads the public frontend checksum key and reproduces its daily token', () => {
    expect(parseAsendiaPublicHitKey(environmentScript())).toBe(PUBLIC_HIT_KEY);
    expect(asendiaHitToken(WRONG_TRACKING_NUMBER, '2026-08-30', PUBLIC_HIT_KEY))
      .toBe('550a419b8b7a4955233a9937704f4ff67f7658508d59f95e711bb9cedc803450');
    expect(() => parseAsendiaPublicHitKey('window.__ENV = {};'))
      .toThrow('valid request checksum key');
  });
});

describe('Asendia response normalization', () => {
  it('parses and sorts current official event fields without retaining private shipment data', () => {
    const result = parseAsendiaTrackingResponse(deliveredFixture(), TRACKING_NUMBER);
    expect(result).toMatchObject({
      status: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2026-08-29T11:42:00+02:00',
      expected_delivery: null,
      timezone: 'Europe/Zurich',
    });
    expect(result.events).toEqual([{
      time: '2026-08-29T11:42:00+02:00',
      location: 'Zurich, CH',
      description: 'Delivered',
      stage: 'delivered',
      provider_code: 'DELIVERED',
    }, {
      time: '2026-08-28T07:18:00+02:00',
      location: 'Zurich, CH',
      description: 'Arrived at destination',
      stage: 'in_transit',
      provider_code: 'ARRIVED_DESTINATION',
    }, {
      time: '2026-08-25T16:03:00+02:00',
      location: 'Paris, FR',
      description: 'Information received',
      stage: 'registered',
      provider_code: 'INFO_RECEIVED',
    }]);
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      'Private Recipient',
      'Private Street',
      'private-order-reference',
      'private@example.test',
      '8000 Private City',
    ]) expect(serialized).not.toContain(privateValue);
  });

  it('rejects a wrong number, a mismatched response, and malformed data', () => {
    expect(() => parseAsendiaTrackingResponse({ data: [] }, WRONG_TRACKING_NUMBER))
      .toThrow(AsendiaTrackingError);
    expect(() => parseAsendiaTrackingResponse(deliveredFixture('LF092919654FR'), TRACKING_NUMBER))
      .toThrow('different shipment');
    expect(() => parseAsendiaTrackingResponse([], TRACKING_NUMBER))
      .toThrow('invalid tracking response');
  });

  it('classifies not-delivered wording before the delivered substring', () => {
    const fixture = deliveredFixture();
    fixture.data[0]!.status = 'Not delivered';
    fixture.data[0]!.events = [{
      eventDateTime: '29/08/2026 11:42',
      eventRate: 5,
      harmonizedCode: 'NOT_DELIVERED',
      harmonizedEvent: 'Not delivered',
      eventDesc: 'Not delivered',
      scanningLocation: 'Zurich, CH',
    }];
    expect(parseAsendiaTrackingResponse(fixture, TRACKING_NUMBER)).toMatchObject({
      status: 'exception',
      events: [{ stage: 'failed_attempt' }],
    });
  });
});

describe('Asendia tracker', () => {
  it('uses the live frontend configuration and constructs the structured search request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === asendiaEnvironmentUrl()) return new Response(environmentScript());
      if (url === asendiaConfigApiUrl()) return new Response(JSON.stringify(configFixture()));
      if (url === asendiaTrackingApiUrl()) {
        expect(init).toMatchObject({
          method: 'POST',
          cache: 'no-store',
          redirect: 'error',
          headers: expect.objectContaining({
            'x-tenant-id': 'track.asendia.com',
            'X-Hit-Token': asendiaHitToken(TRACKING_NUMBER, '2026-08-30', PUBLIC_HIT_KEY),
          }),
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          ids: [TRACKING_NUMBER],
          id: 1,
          subsidiary: ['Asendia HQ'],
          subsidiary_id: [1],
          brand_id: '*',
          turnstile_token: TURNSTILE_TOKEN,
        });
        return new Response(JSON.stringify(deliveredFixture()));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(new AsendiaTracker({
      timeoutMs: 1_000,
      now: () => FIXED_DATE,
      turnstileTokenProvider: () => TURNSTILE_TOKEN,
    }).fetch(TRACKING_NUMBER)).resolves.toMatchObject({
      status: 'delivered',
      tracking_url: asendiaTrackingUrl(TRACKING_NUMBER),
      tracking_source: 'structured-web-response',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('fails closed before network access when no fresh Turnstile token is available', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(new AsendiaTracker({ turnstileTokenProvider: () => '' })
      .fetch(TRACKING_NUMBER)).rejects.toThrow(AsendiaChallengeError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes the official Turnstile rejection without leaking its response', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === asendiaEnvironmentUrl()) return new Response(environmentScript());
      if (url === asendiaConfigApiUrl()) return new Response(JSON.stringify(configFixture()));
      return new Response(JSON.stringify({
        summary: 'Turnstile token is required.',
        data: null,
        context_code: 1100,
      }), { status: 400 });
    });
    await expect(new AsendiaTracker({
      turnstileTokenProvider: () => TURNSTILE_TOKEN,
    }).fetch(WRONG_TRACKING_NUMBER)).rejects.toMatchObject({
      name: 'AsendiaChallengeError',
      message: 'Asendia rejected the Cloudflare Turnstile token',
      status: 503,
    });
  });

  it('recognizes the current forbidden response for an invalid Turnstile token', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === asendiaEnvironmentUrl()) return new Response(environmentScript());
      if (url === asendiaConfigApiUrl()) return new Response(JSON.stringify(configFixture()));
      return new Response(JSON.stringify({ summary: 'Forbidden.', data: null }), { status: 403 });
    });
    await expect(new AsendiaTracker({
      turnstileTokenProvider: () => TURNSTILE_TOKEN,
    }).fetch(WRONG_TRACKING_NUMBER)).rejects.toMatchObject({
      name: 'AsendiaChallengeError',
      message: 'Asendia rejected the Cloudflare Turnstile token',
      status: 503,
    });
  });

  it('maps an authenticated empty search result to a clean wrong-number error', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === asendiaEnvironmentUrl()) return new Response(environmentScript());
      if (url === asendiaConfigApiUrl()) return new Response(JSON.stringify(configFixture()));
      return new Response(JSON.stringify({ summary: 'No parcels found.', data: [], context_code: 1000 }));
    });
    await expect(new AsendiaTracker({
      turnstileTokenProvider: () => TURNSTILE_TOKEN,
    }).fetch(WRONG_TRACKING_NUMBER)).rejects.toMatchObject({
      name: 'AsendiaTrackingError',
      message: 'Asendia could not locate the shipment',
      status: 404,
    });
  });

});
