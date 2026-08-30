import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ColiswebIndeterminateLookupError,
  ColiswebTracker,
  ColiswebTrackingError,
  coliswebRequestBody,
  coliswebTrackingUrl,
  normalizeColiswebTrackingNumber,
  parseColiswebTrackingResponse,
} from './colisweb';

// 10000000 is Colisweb's own documented UI example, not a real shipment.
const OFFICIAL_SYNTHETIC_NUMBER = '10000000';

function successPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    searchValue: OFFICIAL_SYNTHETIC_NUMBER,
    step: 'delivered',
    haveReschedule: false,
    deliveryConfirmationDate: '2026-08-27T08:00:00+02:00',
    pickedUpDate: '2026-08-28T11:30:00+02:00',
    deliveredDate: '2026-08-29T14:15:00+02:00',
    startsAt: '2026-08-29T13:00:00+02:00',
    endsAt: '2026-08-29T15:00:00+02:00',
    clientName: 'PRIVATE RETAILER',
    recipient: { name: 'PRIVATE RECIPIENT', address: '10 PRIVATE STREET' },
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('Colisweb anonymous search request', () => {
  it('accepts the official digits-only format and rejects injection', () => {
    expect(normalizeColiswebTrackingNumber(' 1000 0000 ')).toBe(OFFICIAL_SYNTHETIC_NUMBER);
    for (const value of [
      '1234567',
      '1234567A',
      '10000000&admin=true',
      '1000-0000',
      '1'.repeat(33),
    ]) expect(() => normalizeColiswebTrackingNumber(value)).toThrow('at least 8 digits');
  });

  it('exposes the official endpoint and exact provider body', () => {
    expect(coliswebTrackingUrl()).toBe('https://www.colisweb.com/api/search');
    expect(coliswebRequestBody(OFFICIAL_SYNTHETIC_NUMBER)).toBe('{"value":"10000000"}');
  });
});

describe('Colisweb response normalization', () => {
  it('parses the provider response shape and retains only coarse shipment milestones', () => {
    const result = parseColiswebTrackingResponse(successPayload(), OFFICIAL_SYNTHETIC_NUMBER);

    expect(result).toMatchObject({
      status: 'delivered',
      last_status_text: 'Livraison effectuée',
      last_update: '2026-08-29T14:15:00+02:00',
      expected_delivery: null,
      timezone: 'Europe/Paris',
    });
    expect(result.events).toEqual([
      {
        time: '2026-08-29T14:15:00+02:00',
        description: 'Livraison effectuée',
        stage: 'delivered',
      },
      {
        time: '2026-08-28T11:30:00+02:00',
        description: 'Colis pris en charge',
        stage: 'in_transit',
      },
      {
        time: '2026-08-27T08:00:00+02:00',
        description: 'Livraison confirmée',
        stage: 'registered',
      },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('PRIVATE RETAILER');
    expect(serialized).not.toContain('PRIVATE RECIPIENT');
    expect(serialized).not.toContain('PRIVATE STREET');
  });

  it('maps current failure, return, and pending states conservatively', () => {
    const failure = parseColiswebTrackingResponse(successPayload({
      step: 'non_deliverable',
      deliveredDate: null,
    }), OFFICIAL_SYNTHETIC_NUMBER);
    expect(failure).toMatchObject({
      status: 'exception',
      last_status_text: 'Incident de livraison',
      expected_delivery: null,
    });
    expect(failure.events?.[0]).toMatchObject({ stage: 'failed_attempt' });
    expect(parseColiswebTrackingResponse(successPayload({
      step: 'deliveryReturned',
      deliveredDate: null,
    }), OFFICIAL_SYNTHETIC_NUMBER)).toMatchObject({ status: 'exception' });
    expect(parseColiswebTrackingResponse(successPayload({
      step: 'confirmed',
      deliveredDate: null,
    }), OFFICIAL_SYNTHETIC_NUMBER)).toMatchObject({
      status: 'pending',
      expected_delivery: '2026-08-29',
    });
  });

  it('rejects mismatched or malformed success payloads and maps explicit not-found safely', () => {
    expect(() => parseColiswebTrackingResponse(
      successPayload({ searchValue: '99999999' }),
      OFFICIAL_SYNTHETIC_NUMBER,
    )).toThrow('different shipment');
    expect(() => parseColiswebTrackingResponse({}, OFFICIAL_SYNTHETIC_NUMBER))
      .toThrow('incomplete tracking details');
    expect(() => parseColiswebTrackingResponse({
      error: 'Shipment not found with private provider details',
    }, OFFICIAL_SYNTHETIC_NUMBER)).toThrow(ColiswebTrackingError);
  });
});

describe('Colisweb tracker', () => {
  it('sends the bounded official POST request and parses success', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify(successPayload()),
      { headers: { 'Content-Type': 'application/json' } },
    ));

    await expect(new ColiswebTracker(1_000).fetch(OFFICIAL_SYNTHETIC_NUMBER))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls[0]?.[0]).toBe(coliswebTrackingUrl());
    const init = fetcher.mock.calls[0]?.[1];
    expect(init).toMatchObject({
      method: 'POST',
      body: coliswebRequestBody(OFFICIAL_SYNTHETIC_NUMBER),
      cache: 'no-store',
      redirect: 'error',
    });
    const headers = new Headers(init?.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Origin')).toBe('https://www.colisweb.com');
  });

  it('keeps the observed empty-500 wrong-number response distinct from a clean 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));

    await expect(new ColiswebTracker().fetch('99999999')).rejects.toMatchObject({
      name: 'ColiswebIndeterminateLookupError',
      message: 'Colisweb returned an empty HTTP 500 for the shipment lookup',
      status: 502,
      upstreamStatus: 500,
    });
    expect(new ColiswebIndeterminateLookupError()).not.toBeInstanceOf(ColiswebTrackingError);
  });

  it('maps an explicit provider 404 to a privacy-safe tracking error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private details', { status: 404 }));
    await expect(new ColiswebTracker().fetch('99999999')).rejects.toMatchObject({
      name: 'ColiswebTrackingError',
      message: 'Colisweb could not locate the shipment',
      status: 404,
    });
  });
});
