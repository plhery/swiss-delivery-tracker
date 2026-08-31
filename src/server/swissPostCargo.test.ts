import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeSwissPostCargoTrackingNumber,
  parseSwissPostCargoResponse,
  SwissPostCargoTracker,
  SwissPostCargoTrackingError,
  swissPostCargoTrackingUrl,
} from './swissPostCargo';

afterEach(() => vi.restoreAllMocks());

describe('Swiss Post Cargo tracking', () => {
  it('normalizes public barcodes and builds the official result URL', () => {
    expect(normalizeSwissPostCargoTrackingNumber(' 12.34-abc789 ')).toBe('1234ABC789');
    expect(swissPostCargoTrackingUrl('12.34-abc789'))
      .toBe('https://apv.swisspost-cargo.com/public/trackandtrace/1234ABC789');
    expect(() => normalizeSwissPostCargoTrackingNumber('letters-only')).toThrow('barcode or reference');
  });

  it('maps only public history fields and rejects a different barcode', () => {
    const payload = {
      Type: 1,
      Data: [{
        Identifier: '1234ABC789',
        Consignee: { Name: 'Private recipient', Address: 'Secret street' },
        History: [
          {
            Id: 2,
            TimeStamp: '2026-08-30T12:30:00+02:00',
            City: 'Zürich',
            Status: 'DLV',
            Description: 'Delivered',
            FullDescription: 'Private operational detail',
          },
          {
            Id: 1,
            TimeStamp: '2026-08-29T07:15:00+02:00',
            City: 'Dintikon',
            Status: 'RFS',
            Description: 'Shipment accepted',
          },
        ],
      }],
    };
    expect(parseSwissPostCargoResponse(payload, '1234ABC789')).toEqual({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2026-08-30T12:30:00+02:00',
      expected_delivery: null,
      timezone: 'Europe/Zurich',
      events: [
        {
          time: '2026-08-30T12:30:00+02:00',
          location: 'Zürich',
          description: 'Delivered',
          stage: 'delivered',
          provider_code: 'DLV',
        },
        {
          time: '2026-08-29T07:15:00+02:00',
          location: 'Dintikon',
          description: 'Shipment accepted',
          stage: 'accepted',
          provider_code: 'RFS',
        },
      ],
      tracking_url: 'https://apv.swisspost-cargo.com/public/trackandtrace/1234ABC789',
    });
    expect(() => parseSwissPostCargoResponse({
      ...payload,
      Data: [{ ...payload.Data[0], Identifier: '9876OTHER1' }],
    }, '1234ABC789')).toThrow('different shipment');
    expect(() => parseSwissPostCargoResponse({
      ...payload,
      Type: 1,
      Data: [{ ...payload.Data[0], Identifier: undefined }],
    }, '1234ABC789')).toThrow('no shipment identifier');
    expect(() => parseSwissPostCargoResponse({ ...payload, Type: 3 }, '1234ABC789'))
      .toThrow('invalid tracking response type');
    expect(() => parseSwissPostCargoResponse({ Data: payload.Data }, '1234ABC789'))
      .toThrow('invalid tracking response type');
  });

  it('turns the official null-data response into a clean unannounced error', () => {
    expect(() => parseSwissPostCargoResponse({ Data: null }, 'CODEXINVALID20260831'))
      .toThrow(SwissPostCargoTrackingError);
    try {
      parseSwissPostCargoResponse({ Data: null }, 'CODEXINVALID20260831');
    } catch (error) {
      expect(error).toMatchObject({ status: 404 });
    }
  });

  it('classifies negative delivery wording before the delivered substring', () => {
    expect(parseSwissPostCargoResponse({
      Type: 1,
      Data: [{
        Identifier: '1234ABC789',
        History: [{
          TimeStamp: '2026-08-30T12:30:00+02:00',
          Status: 'ERR',
          Description: 'Not delivered',
        }],
      }],
    }, '1234ABC789')).toMatchObject({
      status: 'exception',
      events: [{ stage: 'failed_attempt' }],
    });
  });

  it('posts the identifier to the anonymous bounded endpoint', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      Type: 1,
      Data: [{
        Identifier: '1234ABC789',
        History: [{
          TimeStamp: '2026-08-30T12:30:00+02:00',
          City: 'Zürich',
          Status: 'DLV',
          Description: 'Delivered',
        }],
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(new SwissPostCargoTracker(2_000).fetch('1234ABC789'))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledWith(
      'https://eosapi.swisspost-cargo.com/api/trackandtrace/public',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ Identifier: '1234ABC789' }),
      }),
    );
  });
});
