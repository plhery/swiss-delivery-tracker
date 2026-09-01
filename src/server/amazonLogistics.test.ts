import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AmazonLogisticsTracker,
  AmazonLogisticsTrackingError,
  amazonLogisticsStatus,
  amazonLogisticsTrackingApiUrl,
  amazonLogisticsTrackingUrl,
  normalizeAmazonLogisticsTrackingNumber,
  parseAmazonLogisticsTrackingResponse,
} from './amazonLogistics';

const TRACKING_NUMBER = 'FR1234567890';

function deliveredFixture() {
  return {
    shipmentProfileType: 'OUTBOUND_PROFILE',
    progressTracker: JSON.stringify({
      progressMeter: { milestoneList: [] },
      errors: [],
      summary: {
        status: 'Delivered',
        metadata: {
          trackingStatus: { stringValue: 'DELIVERED' },
          expectedDeliveryDate: { date: 'Aug 11, 2026, 6:00:00 PM' },
          deliveryDate: { date: 'Aug 11, 2026, 4:31:56 PM' },
          shipperName: { stringValue: 'PRIVATE MERCHANT' },
        },
        containerStatusTags: ['DELIVERED'],
      },
      expectedDeliveryDate: 'Aug 11, 2026, 6:00:00 PM',
      trackerSource: 'SWA',
    }),
    eventHistory: JSON.stringify({
      trackerSource: 'SWA',
      eventHistory: [{
        eventCode: 'CreationConfirmed',
        statusSummary: { localisedStringId: 'swa_rex_detail_creation_confirmed' },
        eventTime: 'Aug 7, 2026, 11:51:15 PM',
        location: {},
      }, {
        eventCode: 'Departed',
        statusSummary: { localisedStringId: 'swa_rex_detail_departed' },
        eventTime: 'Aug 10, 2026, 10:10:16 PM',
        location: {
          city: 'Paris',
          stateProvince: 'Île-de-France',
          countryCode: 'FR',
          postalCode: 'PRIVATE POSTCODE',
          addressLine1: 'PRIVATE STREET',
        },
      }, {
        eventCode: 'Delivered',
        statusSummary: { localisedStringId: 'swa_rex_detail_delivered' },
        eventTime: 'Aug 11, 2026, 4:31:56 PM',
        location: {},
        recipientName: 'PRIVATE RECIPIENT',
      }, {
        // Exact duplicates are discarded before the result is persisted.
        eventCode: 'Delivered',
        statusSummary: { localisedStringId: 'swa_rex_detail_delivered' },
        eventTime: 'Aug 11, 2026, 4:31:56 PM',
        location: {},
      }],
    }),
    addresses: JSON.stringify({
      destination: {
        recipientName: 'PRIVATE RECIPIENT',
        addressLine1: 'PRIVATE STREET',
        postalCode: 'PRIVATE POSTCODE',
      },
    }),
    recipientDetails: JSON.stringify({ email: 'private@example.test' }),
    proofOfDeliveryImage: 'PRIVATE DELIVERY IMAGE',
  };
}

function notFoundFixture() {
  return {
    progressTracker: JSON.stringify({
      progressMeter: null,
      errors: [{
        errorCode: 'TRACKING_ID_NOT_FOUND',
        errorMessage: 'INVALID TRACKING_ID',
      }],
      summary: { status: null, metadata: {} },
      expectedDeliveryDate: null,
      trackerSource: 'UNKNOWN',
    }),
    eventHistory: null,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('Amazon Shipping France input', () => {
  it('normalizes the documented FR plus ten-digit format and builds official URLs', () => {
    expect(normalizeAmazonLogisticsTrackingNumber(' fr12 3456-7890 '))
      .toBe(TRACKING_NUMBER);
    expect(amazonLogisticsTrackingUrl(TRACKING_NUMBER))
      .toBe(`https://track.amazon.fr/tracking/${TRACKING_NUMBER}`);
    expect(amazonLogisticsTrackingApiUrl(TRACKING_NUMBER))
      .toBe(`https://track.amazon.fr/api/tracker/${TRACKING_NUMBER}`);
  });

  it('rejects malformed and injectable identifiers', () => {
    for (const value of [
      'FR123456789',
      'FR12345678901',
      'DE1234567890',
      'FR123456789A',
      'FR1234567890?admin=true',
      'FR123456789É',
    ]) expect(() => normalizeAmazonLogisticsTrackingNumber(value)).toThrow('FR followed by 10 digits');
  });
});

describe('Amazon Shipping France status normalization', () => {
  it.each([
    ['CREATION_CONFIRMED', 'pending'],
    ['PICKUP_DONE', 'in_transit'],
    ['IN_TRANSIT', 'in_transit'],
    ['OUT_FOR_DELIVERY', 'out_for_delivery'],
    ['HOLD_FOR_PICKUP', 'out_for_delivery'],
    ['DELIVERED', 'delivered'],
    ['DELAYED_AND_EDD_UPDATED', 'in_transit'],
    ['DELIVERY_ATTEMPTED', 'exception'],
    ['UNDELIVERABLE_DAMAGED', 'exception'],
    ['RETURNED_TO_SENDER', 'exception'],
    ['NEW_PROVIDER_STATUS', 'unknown'],
  ] as const)('maps %s to %s', (value, expected) => {
    expect(amazonLogisticsStatus(value)).toBe(expected);
  });
});

describe('Amazon Shipping France response normalization', () => {
  it('sorts safe events and discards recipient, street, postcode, merchant, and proof fields', () => {
    const result = parseAmazonLogisticsTrackingResponse(deliveredFixture());

    expect(result).toEqual({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2026-08-11T16:31:56+02:00',
      expected_delivery: '2026-08-11',
      timezone: 'Europe/Paris',
      events: [{
        time: '2026-08-11T16:31:56+02:00',
        description: 'Delivered',
        stage: 'delivered',
        provider_code: 'Delivered',
      }, {
        time: '2026-08-10T22:10:16+02:00',
        location: 'Paris, Île-de-France, FR',
        description: 'Departed facility',
        stage: 'in_transit',
        provider_code: 'Departed',
      }, {
        time: '2026-08-07T23:51:15+02:00',
        description: 'Shipment information received',
        stage: 'registered',
        provider_code: 'CreationConfirmed',
      }],
    });
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      'PRIVATE RECIPIENT',
      'PRIVATE STREET',
      'PRIVATE POSTCODE',
      'PRIVATE MERCHANT',
      'private@example.test',
      'PRIVATE DELIVERY IMAGE',
    ]) expect(serialized).not.toContain(privateValue);
  });

  it('uses event history when the summary status is absent', () => {
    const fixture = deliveredFixture();
    fixture.progressTracker = JSON.stringify({
      summary: { status: null, metadata: {} },
      expectedDeliveryDate: null,
      trackerSource: 'SWA',
    });

    expect(parseAmazonLogisticsTrackingResponse(fixture)).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Delivered',
    });
  });

  it('maps Amazon\'s HTTP 200 not-found payload to a clean 404 error', () => {
    expect(() => parseAmazonLogisticsTrackingResponse(notFoundFixture()))
      .toThrow(AmazonLogisticsTrackingError);
    try {
      parseAmazonLogisticsTrackingResponse(notFoundFixture());
    } catch (error) {
      expect(error).toMatchObject({
        name: 'AmazonLogisticsTrackingError',
        status: 404,
        message: 'Amazon Shipping could not locate the shipment',
      });
    }
  });

  it('rejects malformed and status-free responses instead of inventing a state', () => {
    expect(() => parseAmazonLogisticsTrackingResponse([]))
      .toThrow('invalid tracking response');
    expect(() => parseAmazonLogisticsTrackingResponse({ progressTracker: '{' }))
      .toThrow('invalid progress tracker');
    expect(() => parseAmazonLogisticsTrackingResponse({
      progressTracker: JSON.stringify({ summary: { status: null, metadata: {} } }),
      eventHistory: null,
    })).toThrow('incomplete tracking details');
  });
});

describe('Amazon Shipping France tracker', () => {
  it('fetches the bounded public JSON endpoint with the matching public-page referer', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify(deliveredFixture()),
      { headers: { 'Content-Type': 'application/json' } },
    ));

    await expect(new AmazonLogisticsTracker(1_000).fetch(TRACKING_NUMBER))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(amazonLogisticsTrackingApiUrl(TRACKING_NUMBER));
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      cache: 'no-store',
      redirect: 'error',
      headers: expect.objectContaining({
        Accept: 'application/json',
        Referer: amazonLogisticsTrackingUrl(TRACKING_NUMBER),
      }),
    });
  });

  it('exercises a valid-shaped wrong number through the real adapter path', async () => {
    const wrongNumber = 'FR0000000000';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify(notFoundFixture()),
      { headers: { 'Content-Type': 'application/json' } },
    ));

    await expect(new AmazonLogisticsTracker(1_000).fetch(wrongNumber))
      .rejects.toMatchObject({
        name: 'AmazonLogisticsTrackingError',
        status: 404,
      });
  });

  it('enforces the response-size limit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', {
      headers: { 'Content-Length': '2000001' },
    }));

    await expect(new AmazonLogisticsTracker(1_000).fetch(TRACKING_NUMBER))
      .rejects.toThrow('unexpectedly large response');
  });
});
