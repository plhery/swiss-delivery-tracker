import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GLSSwitzerlandTracker,
  GLSSwitzerlandTrackingError,
  glsSwitzerlandDetailApiUrl,
  glsSwitzerlandOverviewApiUrl,
  glsSwitzerlandStatus,
  glsSwitzerlandTrackingUrl,
  normalizeGLSSwitzerlandPostcode,
  normalizeGLSSwitzerlandTrackingNumber,
  parseGLSSwitzerlandTrackingResponse,
} from './glsSwitzerland';

// Intentional test identifiers from official documentation. Swiss Post's GLS
// guide publishes parcel 993990103198 alongside fictional “Test Entreprise”
// data, while GLS ShipIT publishes YZ8YO11K as a Track ID example:
// https://www.post.ch/-/media/post/gk/dokumente/anleitung-pakete-gls.pdf
// https://gls-shipit.gls-group.eu/webservices/5_0_15/doxygen/WS-REST-API/rest_tracking.html
// The delivered payload below is fully synthetic and exercises only the public
// provider shape; neither official example currently has retained live history.
const OFFICIAL_TEST_TRACK_ID = 'YZ8YO11K';
const OFFICIAL_TEST_PARCEL_NUMBER = '993990103198';
const WRONG_PARCEL_NUMBER = '88888888888';
const FIXED_MILLIS = 1_788_120_000_000;

function deliveredOverviewFixture() {
  return {
    tuStatus: [{
      postalCode: '',
      emailNotificationCard: false,
      tuNo: OFFICIAL_TEST_PARCEL_NUMBER,
      progressBar: {
        level: 100,
        statusBar: [
          { statusText: '', status: 'PREADVICE', imageStatus: 'COMPLETE', imageText: 'Preadvice' },
          { statusText: '', status: 'INTRANSIT', imageStatus: 'COMPLETE', imageText: 'In transit' },
          { statusText: '', status: 'INWAREHOUSE', imageStatus: 'COMPLETE', imageText: 'Final parcel center' },
          { statusText: '', status: 'INDELIVERY', imageStatus: 'COMPLETE', imageText: 'In delivery' },
          {
            statusText: 'The parcel has been delivered.\nFor more information, please see the detailed shipment tracking below.',
            status: 'DELIVERED',
            imageStatus: 'CURRENT',
            imageText: 'Delivered',
          },
        ],
        statusText: 'Delivered',
        retourFlag: false,
        evtNos: ['3.0', '11.0', '2.0', '2.0', '2.0', '0.0', '0.100'],
        colourIndex: 4,
        statusInfo: 'DELIVERED',
      },
      owners: [],
      arrivalTime: { name: 'Delivered on:', value: "19-Jun-2026 at 10:59 o`clock" },
    }],
  };
}

function detailedFixture(parcelNumber = OFFICIAL_TEST_PARCEL_NUMBER) {
  return {
    tuNo: parcelNumber,
    progressBar: {
      statusInfo: 'DELIVERED',
      statusText: 'Delivered',
      statusBar: [{
        status: 'DELIVERED',
        imageStatus: 'CURRENT',
        imageText: 'Delivered',
        statusText: 'The parcel has been delivered.',
      }],
    },
    arrivalTime: { name: 'Delivered on:', value: "19-Jun-2026 at 10:59 o`clock" },
    signature: { name: 'Signature', value: 'Private Recipient' },
    addresses: [{
      type: 'DELIVERY',
      value: {
        name1: 'Private Recipient',
        street1: 'Private Street',
        postalArea: { postalCodeDisplay: '8000', city: 'Private City' },
      },
    }],
    references: [{ type: 'ORDER', name: 'Order', value: 'private-order-reference' }],
    infos: [{ type: 'PHONE', name: 'Phone', value: '+41000000000' }],
    history: [{
      date: '19-Jun-2026',
      time: '10:59',
      evtDscr: 'The parcel has been delivered.',
      evtNo: '0.100',
      address: {
        countryName: 'Switzerland',
        city: 'Zurich',
        street1: 'Private Street',
        postalArea: { postalCodeDisplay: '8000' },
      },
      recipient: 'Private Recipient',
    }, {
      date: '18-Jun-2026',
      time: '08:14',
      evtDscr: 'The parcel has reached the final parcel center.',
      evtNo: '2.0',
      address: { countryName: 'Switzerland', city: 'Zurich' },
    }],
  };
}

afterEach(() => vi.restoreAllMocks());

describe('GLS Switzerland tracking input', () => {
  it('accepts official parcel and Track ID forms and builds public URLs', () => {
    expect(normalizeGLSSwitzerlandTrackingNumber('yz8y-o1.1k')).toBe(OFFICIAL_TEST_TRACK_ID);
    expect(normalizeGLSSwitzerlandTrackingNumber('99 399 010 3198'))
      .toBe(OFFICIAL_TEST_PARCEL_NUMBER);
    expect(normalizeGLSSwitzerlandPostcode(' 8000 ')).toBe('8000');
    expect(normalizeGLSSwitzerlandPostcode(' 0800 ')).toBe('0800');
    expect(glsSwitzerlandTrackingUrl(OFFICIAL_TEST_TRACK_ID)).toBe(
      `https://gls-group.eu/EU/en/parcel-tracking?match=${OFFICIAL_TEST_TRACK_ID}`,
    );

    const overview = new URL(glsSwitzerlandOverviewApiUrl(
      OFFICIAL_TEST_PARCEL_NUMBER,
      FIXED_MILLIS,
    ));
    expect(overview.pathname).toBe('/app/service/open/rest/GROUP/en/rstt029');
    expect(Object.fromEntries(overview.searchParams)).toEqual({
      match: OFFICIAL_TEST_PARCEL_NUMBER,
      type: '',
      caller: 'witt002',
      millis: String(FIXED_MILLIS),
    });

    const detail = new URL(glsSwitzerlandDetailApiUrl(
      OFFICIAL_TEST_PARCEL_NUMBER,
      '8000',
      FIXED_MILLIS,
      'CH01',
    ));
    expect(detail.pathname).toBe(
      `/app/service/open/rest/GROUP/en/rstt028/${OFFICIAL_TEST_PARCEL_NUMBER}`,
    );
    expect(Object.fromEntries(detail.searchParams)).toEqual({
      caller: 'witt002',
      millis: String(FIXED_MILLIS),
      postalCode: '8000',
      tuOwnerCode: 'CH01',
    });
  });

  it('rejects unsafe identifiers and non-Swiss postcodes', () => {
    for (const value of [
      'ABC1234',
      'ABCDEFGH',
      '12345678',
      'ABC123456',
      '1234567890',
      'YZ8YO1/1K',
      'YZ8YO11K?x=1',
    ]) {
      expect(() => normalizeGLSSwitzerlandTrackingNumber(value)).toThrow(
        '8-character Track ID or an 11-to-14-digit parcel number',
      );
    }
    for (const value of ['800', '80000', '80A0', '8000?x=1']) {
      expect(() => normalizeGLSSwitzerlandPostcode(value)).toThrow('4-digit recipient postcode');
    }
  });
});

describe('GLS Switzerland response normalization', () => {
  it('parses a privacy-safe provider-shaped response for official test identifiers', () => {
    for (const identifier of [OFFICIAL_TEST_PARCEL_NUMBER, OFFICIAL_TEST_TRACK_ID]) {
      expect(parseGLSSwitzerlandTrackingResponse(deliveredOverviewFixture(), identifier)).toEqual({
        status: 'delivered',
        current_stage: 'delivered',
        last_status_text: 'The parcel has been delivered. For more information, please see the detailed shipment tracking below.',
        last_update: null,
        expected_delivery: null,
        timezone: 'Europe/Zurich',
        events: [],
      });
    }
  });

  it('normalizes detailed history and excludes recipient, address, and reference data', () => {
    const result = parseGLSSwitzerlandTrackingResponse(
      detailedFixture(),
      OFFICIAL_TEST_PARCEL_NUMBER,
    );
    expect(result).toMatchObject({
      status: 'delivered',
      last_status_text: 'The parcel has been delivered.',
      last_update: '2026-06-19T10:59:00+02:00',
      expected_delivery: null,
      timezone: 'Europe/Zurich',
    });
    expect(result.events).toEqual([{
      time: '2026-06-19T10:59:00+02:00',
      location: 'Switzerland Zurich',
      description: 'The parcel has been delivered.',
      stage: 'delivered',
      provider_code: '0.100',
    }, {
      time: '2026-06-18T08:14:00+02:00',
      location: 'Switzerland Zurich',
      description: 'The parcel has reached the final parcel center.',
      stage: 'in_transit',
      provider_code: '2.0',
    }]);
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      'Private Recipient',
      'Private Street',
      'private-order-reference',
      '+41000000000',
      '8000',
    ]) expect(serialized).not.toContain(privateValue);
  });

  it('rejects malformed, empty, and mismatched responses', () => {
    expect(() => parseGLSSwitzerlandTrackingResponse({}, OFFICIAL_TEST_PARCEL_NUMBER))
      .toThrow('did not return tracking details');
    expect(() => parseGLSSwitzerlandTrackingResponse(
      { tuStatus: [] },
      OFFICIAL_TEST_PARCEL_NUMBER,
    ))
      .toThrow(GLSSwitzerlandTrackingError);
    expect(() => parseGLSSwitzerlandTrackingResponse(
      detailedFixture('993990103199'),
      OFFICIAL_TEST_PARCEL_NUMBER,
    )).toThrow('different shipment');
  });

  it.each([
    ['PREADVICE', 'pending'],
    ['INTRANSIT', 'in_transit'],
    ['INDELIVERY', 'out_for_delivery'],
    ['DELIVERED', 'delivered'],
    ['NOTDELIVERED', 'exception'],
    ['NEW', 'unknown'],
  ] as const)('maps %s to %s', (providerStatus, expected) => {
    expect(glsSwitzerlandStatus(providerStatus)).toBe(expected);
  });
});

describe('GLS Switzerland tracker', () => {
  it('uses the anonymous overview and postcode-gated detail requests', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(deliveredOverviewFixture()), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(detailedFixture()), {
        headers: { 'Content-Type': 'application/json' },
      }));

    await expect(new GLSSwitzerlandTracker(1_000, () => FIXED_MILLIS)
      .fetch(OFFICIAL_TEST_PARCEL_NUMBER, '8000')).resolves.toMatchObject({
      status: 'delivered',
      events: [{ stage: 'delivered' }, { stage: 'in_transit' }],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      glsSwitzerlandOverviewApiUrl(OFFICIAL_TEST_PARCEL_NUMBER, FIXED_MILLIS),
    );
    expect(String(fetcher.mock.calls[1]?.[0])).toBe(
      glsSwitzerlandDetailApiUrl(OFFICIAL_TEST_PARCEL_NUMBER, '8000', FIXED_MILLIS),
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      cache: 'no-store',
      redirect: 'error',
      headers: expect.objectContaining({ Accept: 'application/json' }),
    });
  });

  it('maps the provider wrong-number response to a clean not-found error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      lastError: 'E206',
      exceptionText: 'Unfortunately there are no results.<br>Please check your entry.',
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(new GLSSwitzerlandTracker(1_000, () => FIXED_MILLIS)
      .fetch(WRONG_PARCEL_NUMBER)).rejects.toMatchObject({
      name: 'GLSSwitzerlandTrackingError',
      message: 'GLS Switzerland could not locate the shipment',
      status: 404,
    });
  });

});
