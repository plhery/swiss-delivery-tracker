import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyIndiaPostEvent,
  IndiaPostChallengeError,
  IndiaPostTracker,
  IndiaPostTrackingError,
  indiaPostTrackingUrl,
  normalizeIndiaPostTrackingNumber,
  parseIndiaPostTrackingHtml,
} from './indiaPost';

const REAL_PUBLIC_NUMBER = 'JN067614884IN';
const WRONG_VALID_NUMBER = 'RR000000005IN';
const CSRF_TOKEN = 'fixtureCsrfToken0123456789012345';

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function componentSnapshot(trackingNumber: string, status: string): string {
  return JSON.stringify({
    data: {
      consignment_number: trackingNumber,
      status: [status, { class: 'App\\Enums\\ConsignmentFormStatus', s: 'enm' }],
    },
    memo: { name: 'track-consignment' },
    checksum: 'unit-test-checksum',
  });
}

function trackingHistoryHtml(
  trackingNumber = REAL_PUBLIC_NUMBER,
  events: Array<Record<string, unknown>> = [{
    tracked_at: '2026-09-01T11:25:04.000000Z',
    event: 'Item Delivered',
    event_type: 'ItemDelivered',
    office: 'Maker SO',
    pincode: '841215',
    remarks: 'Received by private recipient',
    recipient_address: 'must never survive normalization',
    pincode_info: { contact_number: '+91 private' },
  }, {
    tracked_at: '2026-09-01T02:34:51.000000Z',
    event: 'Item Booked',
    event_type: 'ItemBooked',
    office: 'Dadar BPC',
    pincode: '400014',
    remarks: '',
  }],
): string {
  const request = JSON.stringify({
    id: 'public-request',
    tracking_status: 'Completed',
    tracking_events: events,
  });
  return `
    <div>
      <input id="consignment_search" value="${trackingNumber}">
      <div tracking-request="${escapeAttribute(request)}"></div>
    </div>
  `;
}

function pageHtml(
  trackingNumber: string,
  status: string,
  content = '',
): string {
  return `
    <html><head><meta name="csrf-token" content="${CSRF_TOKEN}"></head><body>
      <div wire:snapshot="${escapeAttribute(componentSnapshot(trackingNumber, status))}"></div>
      ${content}
    </body></html>
  `;
}

function livewireResponse(
  trackingNumber: string,
  status: string,
  effects: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({
    components: [{ snapshot: componentSnapshot(trackingNumber, status), effects }],
  }), { headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.restoreAllMocks());

describe('India Post tracking input', () => {
  it('accepts only valid India-issued S10 identifiers and builds the scraper URL', () => {
    expect(normalizeIndiaPostTrackingNumber('jn 067.614-884 in')).toBe(REAL_PUBLIC_NUMBER);
    const url = new URL(indiaPostTrackingUrl(REAL_PUBLIC_NUMBER));
    expect(url.origin).toBe('https://myspeedpost.com');
    expect(url.pathname).toBe('/track');
    expect(url.searchParams.get('n')).toBe(REAL_PUBLIC_NUMBER);
    expect(url.searchParams.get('sync')).toBe('true');

    for (const value of [
      'JN067614885IN',
      'JN067614884FR',
      'JN067614884IN&admin=true',
      '123',
    ]) {
      expect(() => normalizeIndiaPostTrackingNumber(value)).toThrow('valid 13-character S10');
    }
  });
});

describe('India Post response normalization', () => {
  it('sorts real-format events, maps stages, and excludes private response fields', () => {
    const result = parseIndiaPostTrackingHtml(
      trackingHistoryHtml(REAL_PUBLIC_NUMBER, [
        {
          tracked_at: '2026-09-01T02:34:51.000000Z',
          event: 'Item Booked',
          event_type: 'ItemBooked',
          office: 'Dadar BPC',
          pincode: '400014',
        },
        {
          tracked_at: '2026-09-01T11:25:04.000000Z',
          event: 'Item Delivered',
          event_type: 'ItemDelivered',
          office: 'Maker SO',
          pincode: '841215',
          remarks: 'Received by private recipient',
          recipient_address: 'must never survive normalization',
          pincode_info: { contact_number: '+91 private' },
        },
      ]),
      REAL_PUBLIC_NUMBER,
    );

    expect(result).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Item Delivered',
      expected_delivery: null,
      timezone: 'Asia/Kolkata',
    });
    expect(result.events).toHaveLength(2);
    expect(result.events?.[0]).toMatchObject({
      location: 'Maker SO 841215',
      description: 'Item Delivered',
      stage: 'delivered',
      provider_code: 'ItemDelivered',
    });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('recipient_address');
    expect(JSON.stringify(result)).not.toContain('pincode_info');
  });

  it('distinguishes accepted, transit, delivery, failure, and return events', () => {
    expect(classifyIndiaPostEvent('ItemBooked')).toEqual({
      status: 'pending',
      stage: 'accepted',
    });
    expect(classifyIndiaPostEvent('ItemDispatched')).toEqual({
      status: 'in_transit',
      stage: 'in_transit',
    });
    expect(classifyIndiaPostEvent('OutForDelivery')).toEqual({
      status: 'out_for_delivery',
      stage: 'out_for_delivery',
    });
    expect(classifyIndiaPostEvent('DeliveryAttempted')).toEqual({
      status: 'exception',
      stage: 'failed_attempt',
    });
    expect(classifyIndiaPostEvent('ReturnToSender')).toEqual({
      status: 'exception',
      stage: 'returned',
    });
  });

  it('rejects a response belonging to another consignment', () => {
    expect(() => parseIndiaPostTrackingHtml(
      trackingHistoryHtml('RR000000005IN'),
      REAL_PUBLIC_NUMBER,
    )).toThrow('different shipment');
  });
});

describe('India Post Livewire session', () => {
  it('uses a completed cached response without unnecessary polling', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      pageHtml(REAL_PUBLIC_NUMBER, 'Completed', trackingHistoryHtml()),
    ));

    await expect(new IndiaPostTracker({ fetcher }).fetch(REAL_PUBLIC_NUMBER))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('submits and polls a new valid-shaped wrong number into a clean 404', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(pageHtml(WRONG_VALID_NUMBER, 'New')))
      .mockResolvedValueOnce(livewireResponse(WRONG_VALID_NUMBER, 'Processing'))
      .mockResolvedValueOnce(livewireResponse(WRONG_VALID_NUMBER, 'Completed', {
        dispatches: [{
          name: 'consignment_not_found',
          params: { consignment_number: WRONG_VALID_NUMBER },
        }],
        html: trackingHistoryHtml(WRONG_VALID_NUMBER),
      }));

    await expect(new IndiaPostTracker({
      fetcher,
      pollIntervalMs: 0,
      maxPollAttempts: 2,
    }).fetch(WRONG_VALID_NUMBER)).rejects.toBeInstanceOf(IndiaPostTrackingError);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/track?');
    expect(String(fetcher.mock.calls[1]?.[0])).toBe('https://myspeedpost.com/livewire/update');
    expect(String(fetcher.mock.calls[2]?.[0])).toBe('https://myspeedpost.com/livewire/update');

    const submitted = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(submitted.components[0].calls.map((call: { method: string }) => call.method))
      .toEqual(['__dispatch', 'submit']);
    const polled = JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body));
    expect(polled.components[0].calls).toEqual([{
      path: '',
      method: 'fetchStatus',
      params: [],
    }]);
  });

  it('keeps Cloudflare and malformed pages retryable instead of reporting not found', async () => {
    const challenged = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      '<title>Just a moment...</title>',
      { status: 403, headers: { 'CF-Mitigated': 'challenge' } },
    ));
    await expect(new IndiaPostTracker({ fetcher: challenged }).fetch(REAL_PUBLIC_NUMBER))
      .rejects.toBeInstanceOf(IndiaPostChallengeError);

    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>maintenance</html>'));
    await expect(new IndiaPostTracker({ fetcher: malformed }).fetch(REAL_PUBLIC_NUMBER))
      .rejects.toThrow('tracking component');
  });
});
