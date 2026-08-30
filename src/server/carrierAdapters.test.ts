import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DPDAPIError,
  DPDChallengeError,
  DPDTracker,
  DPDTrackingError,
  dpdTrackingUrl,
  parseDPDTrackingApi,
  parseDPDTrackingHtml,
} from './dpd';
import {
  parseUPSTrackingHtml,
  parseUPSTrackingResponse,
  upsTrackingUrl,
} from './ups';

const DPD_NUMBER = '06086514587082';
const UPS_NUMBER = '1Z999AA10123456784';

afterEach(() => vi.restoreAllMocks());

describe('DPD tracking normalization', () => {
  it('normalizes the guest API, delivery window, duplicates, and postcode result', () => {
    const result = parseDPDTrackingApi({
      parcelNumber: DPD_NUMBER,
      status: { description: 'PARCEL_OUT_FOR_DELIVERY' },
      deliveryDate: '2026-07-15T00:00:00',
      deliveryTimeFrom: '09:00:00',
      deliveryTimeTo: '12:00:00',
      isPredictiveDate: true,
      parcelEvents: [
        {
          date: '2026-07-15',
          time: '11:28:00',
          city: 'Zürich',
          countryCode: 'CH',
          eventType: 'PARCEL_OUT_FOR_DELIVERY',
        },
        {
          date: '2026-07-15',
          time: '11:28:00',
          city: 'Zürich',
          countryCode: 'CH',
          eventType: 'PARCEL_OUT_FOR_DELIVERY',
        },
      ],
    }, DPD_NUMBER, true);

    expect(result.status).toBe('out_for_delivery');
    expect(result.expected_delivery).toBe('2026-07-15 09:00–12:00');
    expect(result.events).toHaveLength(1);
    expect(result.events?.[0]).toMatchObject({
      location: 'Zürich, CH',
      description: 'Parcel out for delivery',
    });
    expect(result.dpd_postcode_verified).toBe(true);
  });

  it('rejects invalid and unrelated API responses', () => {
    expect(() => parseDPDTrackingApi([], DPD_NUMBER)).toThrow(DPDAPIError);
    expect(() => parseDPDTrackingApi({ parcelNumber: '00000000000000' }, DPD_NUMBER))
      .toThrow('requested parcel');
  });

  it('parses the rendered timeline and detects browser challenges', () => {
    const result = parseDPDTrackingHtml(`
      <html><body>
        <div>${DPD_NUMBER}</div>
        <li class="content-item-track">
          <span class="entry-date">15.07.2026</span>
          <span class="entry-time">11:28</span>
          <span class="place-track">Zürich</span>
          <span class="entry-body">Parcel handed to DPD</span>
        </li>
      </body></html>
    `, DPD_NUMBER);

    expect(result.status).toBe('in_transit');
    expect(result.last_update).toBe('2026-07-15T11:28:00+02:00');
    expect(() => parseDPDTrackingHtml('<title>Just a moment...</title>', DPD_NUMBER))
      .toThrow(DPDChallengeError);
    expect(() => parseDPDTrackingHtml('<body>Another parcel</body>', DPD_NUMBER))
      .toThrow('requested parcel');
  });

  it('builds an encoded tracking URL without leaking the postcode', () => {
    const url = new URL(dpdTrackingUrl(DPD_NUMBER, 'de'));
    expect(url.searchParams.get('parcelNumber')).toBe(DPD_NUMBER);
    expect(url.searchParams.get('lang')).toBe('de');
    expect(url.searchParams.has('postcode')).toBe(false);
  });

  it('falls back to the rendered page when the guest API returns malformed JSON', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    fetcher.mockResolvedValueOnce(new Response('<html>maintenance</html>'));
    fetcher.mockResolvedValueOnce(new Response(`
      <html><body>
        <div>${DPD_NUMBER}</div>
        <li class="content-item-track">
          <span class="entry-date">15.07.2026</span>
          <span class="entry-time">11:28</span>
          <span class="entry-body">Parcel handed to DPD</span>
        </li>
      </body></html>
    `));

    const result = await new DPDTracker({ timeoutMs: 1_000 }).fetch(DPD_NUMBER);

    expect(result).toMatchObject({
      status: 'in_transit',
      tracking_url: expect.stringContaining(DPD_NUMBER),
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('maps a guest API 404 for a valid-shaped wrong number without invoking the web fallback', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        fid: 'unit-test-fid',
        authToken: { token: 'installation-token', expiresIn: '604800s' },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        entries: { basic_dpd_token: 'dW5pdDp0ZXN0' },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'unit-test-access-token',
        expires_in: 3600,
      })))
      .mockResolvedValueOnce(new Response('', { status: 404 }));

    await expect(new DPDTracker({ timeoutMs: 1_000 }).fetch('00000000000000', '8000'))
      .rejects.toBeInstanceOf(DPDTrackingError);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(String(fetcher.mock.calls[3]?.[0])).toContain('/v10/parcels/details/00000000000000');
  });

  it('does not misclassify an authentication-stage 404 as a missing parcel', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(`
        <html><body>
          <div>${DPD_NUMBER}</div>
          <li class="content-item-track">
            <span class="entry-date">15.07.2026</span>
            <span class="entry-time">11:28</span>
            <span class="entry-body">Parcel handed to DPD</span>
          </li>
        </body></html>
      `));

    await expect(new DPDTracker({ timeoutMs: 1_000 }).fetch(DPD_NUMBER))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('firebaseinstallations.googleapis.com');
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('dpdgroup.com/ch/mydpd/my-parcels/track');
  });
});

describe('UPS tracking normalization', () => {
  interface UPSFixtureDetail {
    trackingNumber: string;
    packageStatus: string;
    progressBarType: string;
    currentMilestone: { name: string };
    scheduledDeliveryDateDetail: { monthCMSKey: string; dayNum: string } | null;
    shipmentProgressActivities: Array<Record<string, string>>;
    errorCode?: string;
    errorText?: string;
  }

  function apiPayload(progress = 'Delivered'): {
    statusCode: string;
    statusText: string;
    trackDetails: UPSFixtureDetail[];
  } {
    return {
      statusCode: '200',
      statusText: 'Successful',
      trackDetails: [{
        trackingNumber: UPS_NUMBER,
        packageStatus: progress,
        progressBarType: progress.replaceAll(' ', ''),
        currentMilestone: { name: progress },
        scheduledDeliveryDateDetail: null,
        shipmentProgressActivities: [{
          date: '08/04/2026',
          time: '2:38 P.M.',
          location: 'ZUERICH, CH',
          activityScan: 'Delivered',
          gmtDate: '20260804',
          gmtTime: '12:38:28',
          gmtOffset: '+02:00',
        }],
      }],
    };
  }

  it('parses structured activity history and provider errors', () => {
    const result = parseUPSTrackingResponse(apiPayload(), UPS_NUMBER);
    expect(result).toMatchObject({
      status: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2026-08-04T12:38:28+00:00',
    });

    const unavailable = apiPayload();
    unavailable.trackDetails[0]!.errorCode = '250002';
    unavailable.trackDetails[0]!.errorText = 'Tracking information is not available';
    expect(parseUPSTrackingResponse(unavailable, UPS_NUMBER)).toMatchObject({
      status: 'unknown',
      events: [],
    });
    expect(() => parseUPSTrackingResponse({ statusCode: '500', statusText: 'Unavailable' }, UPS_NUMBER))
      .toThrow('Unavailable');
  });

  it('rolls an ETA into the next year only after the seven-day grace period', () => {
    const payload = apiPayload('InTransit');
    payload.trackDetails[0]!.scheduledDeliveryDateDetail = {
      monthCMSKey: 'cms.stapp.jan',
      dayNum: '2',
    };
    expect(parseUPSTrackingResponse(payload, UPS_NUMBER, new Date('2026-12-20T00:00:00Z'))
      .expected_delivery).toBe('2027-01-02');
  });

  it('parses the rendered fallback and verifies the requested number', () => {
    const html = `
      <html><head><meta name="stapp-tracknum" content="${UPS_NUMBER}"></head>
      <body>
        <span id="stApp_nameKey">Delivered <span>check_circle</span></span>
        <p id="stApp_deliveredToAddress">ZUERICH CH</p>
      </body></html>
    `;
    expect(parseUPSTrackingHtml(html, UPS_NUMBER)).toMatchObject({
      status: 'delivered',
      last_status_text: 'Delivered',
      events: [{ location: 'ZUERICH CH' }],
    });
    expect(() => parseUPSTrackingHtml('<body>another parcel</body>', UPS_NUMBER))
      .toThrow('requested parcel');
  });

  it('builds the canonical UPS web URL', () => {
    const url = new URL(upsTrackingUrl(UPS_NUMBER));
    expect(url.searchParams.get('tracknum')).toBe(UPS_NUMBER);
    expect(url.searchParams.get('requester')).toBe('ST/trackdetails');
  });
});
