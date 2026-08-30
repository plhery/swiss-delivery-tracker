import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchCainiao,
  fetchPlanzer,
  fetchPostlogistics,
  fetchSpringGds,
  fetchSunYou,
  planzerShipmentNumber,
  UpstreamTrackingError,
} from './upstreamAdapters';

const CAINIAO_WRONG_NUMBER = 'LP00000000000000';
const POSTLOGISTICS_WRONG_NUMBER = '000000000000000000';
const SPRING_WRONG_NUMBER = 'LT000000000NL';
const SUNYOU_WRONG_NUMBER = 'SY00000000000';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function expectPrivacySafeNotFound(
  operation: Promise<unknown>,
  provider: string,
): Promise<void> {
  try {
    await operation;
    throw new Error('Expected the lookup to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(UpstreamTrackingError);
    expect(error).toMatchObject({ name: 'UpstreamTrackingError', status: 404 });
    expect(String(error)).toContain(`${provider} could not locate the shipment`);
    expect(String(error)).not.toContain('Private upstream details');
  }
}

afterEach(() => vi.restoreAllMocks());

describe('Planzer and Quickpac no-data responses', () => {
  it('keeps both direct tracking number formats and surfaces the API 404', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 404 }));
    const cases = [
      ['12345678901234567890', '12345678901234567890'],
      ['440000000000000000', '440000000000000000'],
    ] as const;

    for (const [trackingNumber, shipmentNumber] of cases) {
      expect(planzerShipmentNumber(trackingNumber)).toBe(shipmentNumber);
      await expect(fetchPlanzer(trackingNumber)).rejects.toMatchObject({
        name: 'UpstreamHttpError',
        status: 404,
        message: 'Planzer tracking returned HTTP 404',
      });
    }

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]?.[0]))
      .toContain('/shipments/12345678901234567890/Pak');
    expect(String(fetcher.mock.calls[1]?.[0]))
      .toContain('/shipments/440000000000000000/Pak');
  });

  it('uses only the matching transport position and recognizes the delivered label', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      overallStatus: { text: { english: 'Shipment delivered' } },
      transportPositions: [
        {
          positionNumber: '123456',
          positionEvents: [{
            createdAt: '2026-08-30T12:00:00Z',
            text: { english: 'Shipment delivered' },
          }],
        },
        {
          positionNumber: '999999',
          positionEvents: [{
            createdAt: '2026-08-31T12:00:00Z',
            text: { english: 'Private event from a different shipment' },
          }],
        },
      ],
    }));

    await expect(fetchPlanzer('ref.000123456')).resolves.toMatchObject({
      status: 'delivered',
      last_status_text: 'Shipment delivered',
      events: [{ description: 'Shipment delivered' }],
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/shipments/123456/Pak');
  });

  it('rejects Planzer transport positions belonging to another shipment', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      overallStatus: { text: { english: 'Shipment on the way' } },
      transportPositions: [{ positionNumber: '999999', positionEvents: [] }],
    }));

    await expect(fetchPlanzer('123456')).rejects.toThrow('different shipment');
  });
});

describe('upstream carrier wrong-number handling', () => {
  it('maps Cainiao\'s matching empty module to a privacy-safe 404', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      module: [{
        mailNo: CAINIAO_WRONG_NUMBER,
        mailNoSource: 'EXTERNAL',
        detailList: [],
        privateMessage: 'Private upstream details',
      }],
      success: true,
    }));

    await expectPrivacySafeNotFound(fetchCainiao(CAINIAO_WRONG_NUMBER), 'Cainiao');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const requested = new URL(String(fetcher.mock.calls[0]![0]));
    expect(requested.searchParams.get('mailNos')).toBe(CAINIAO_WRONG_NUMBER);
  });

  it('keeps a matching non-external empty Cainiao shipment pending', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      module: [{
        mailNo: CAINIAO_WRONG_NUMBER,
        mailNoSource: 'INTERNAL',
        detailList: [],
      }],
      success: true,
    }));

    await expect(fetchCainiao(CAINIAO_WRONG_NUMBER)).resolves.toMatchObject({
      status: 'pending',
      last_status_text: '',
      events: [],
    });
  });

  it('maps PostLogistics Data null to a privacy-safe 404', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      Data: null,
      privateMessage: 'Private upstream details',
    }));

    await expectPrivacySafeNotFound(
      fetchPostlogistics(POSTLOGISTICS_WRONG_NUMBER),
      'PostLogistics',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, init] = fetcher.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      Identifier: POSTLOGISTICS_WRONG_NUMBER,
    });
  });

  it('maps Spring GDS\'s explicit barcode-not-found item to a privacy-safe 404', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: 'visitor-token' }))
      .mockResolvedValueOnce(jsonResponse({
        status: 'success',
        data: {
          items: [{
            item: SPRING_WRONG_NUMBER,
            message: 'The shipment barcode was not found. Private upstream details',
            events: [],
          }],
        },
      }));

    await expectPrivacySafeNotFound(fetchSpringGds(SPRING_WRONG_NUMBER), 'Spring GDS');
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [, init] = fetcher.mock.calls[1]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      items: [SPRING_WRONG_NUMBER],
      language_code: 'en',
    });
  });

  it('maps SunYou\'s official not-found status to a privacy-safe 404', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      `searchCallback(${JSON.stringify({
        data: [{
          displayStatus: '0',
          has: true,
          orderNo: SUNYOU_WRONG_NUMBER,
          privateMessage: 'Private upstream details',
        }],
        message: 'success',
        status: 1,
      })})`,
    ));

    await expectPrivacySafeNotFound(fetchSunYou(SUNYOU_WRONG_NUMBER), 'SunYou');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const requested = new URL(String(fetcher.mock.calls[0]![0]));
    expect(requested.searchParams.get('trackNumber')).toBe(SUNYOU_WRONG_NUMBER);
  });

  it('keeps a SunYou outage or challenge page retryable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '<html><title>Service unavailable</title></html>',
    ));

    await expect(fetchSunYou(SUNYOU_WRONG_NUMBER))
      .rejects.toThrow('SunYou returned an invalid tracking response');
  });

  it('rejects responses for a different shipment across all four providers', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');

    fetcher.mockResolvedValueOnce(jsonResponse({
      module: [{ mailNo: 'LP11111111111111', detailList: [] }],
      success: true,
    }));
    await expect(fetchCainiao(CAINIAO_WRONG_NUMBER)).rejects.toThrow('different shipment');

    fetcher.mockResolvedValueOnce(jsonResponse({
      Type: 1,
      Data: [{ Identifier: '999999999999999999', History: [] }],
    }));
    await expect(fetchPostlogistics(POSTLOGISTICS_WRONG_NUMBER))
      .rejects.toThrow('different shipment');

    fetcher
      .mockResolvedValueOnce(jsonResponse({ access_token: 'visitor-token' }))
      .mockResolvedValueOnce(jsonResponse({
        data: { items: [{ item: 'LT111111111NL', events: [] }] },
      }));
    await expect(fetchSpringGds(SPRING_WRONG_NUMBER)).rejects.toThrow('different shipment');

    fetcher.mockResolvedValueOnce(new Response(
      'searchCallback({"data":[{"orderNo":"SY11111111111","has":false}]})',
    ));
    await expect(fetchSunYou(SUNYOU_WRONG_NUMBER)).rejects.toThrow('different shipment');
  });
});

describe('PostLogistics response types and event ordering', () => {
  it('matches and filters barcode lookups with Type 1', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      Type: 1,
      Data: [
        {
          Identifier: ' 00-123.456 ',
          History: [{
            TimeStamp: '2026-08-30T09:00:00Z',
            Status: 'TRN',
            Description: 'Matching shipment in transit',
          }],
        },
        {
          Identifier: '999999',
          History: [{
            TimeStamp: '2026-08-31T09:00:00Z',
            Status: 'DLV',
            Description: 'Different shipment delivered',
          }],
        },
      ],
    }));

    await expect(fetchPostlogistics('00123456')).resolves.toMatchObject({
      status: 'in_transit',
      last_status_text: 'Matching shipment in transit',
      events: [{ description: 'Matching shipment in transit' }],
    });
  });

  it('allows Type 2 references to resolve returned barcodes and selects the latest instant', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      Type: 2,
      Data: [
        {
          Identifier: 'RETURNED-BARCODE-1',
          History: [{
            TimeStamp: '2026-08-31T00:00:00+02:00',
            Status: 'TRN',
            Description: 'Earlier by absolute time',
          }],
        },
        {
          Identifier: 'RETURNED-BARCODE-2',
          History: [{
            TimeStamp: '2026-08-30T23:30:00-02:00',
            Status: 'DLV',
            Description: 'Latest by absolute time',
          }],
        },
      ],
    }));

    await expect(fetchPostlogistics('CUSTOMER-REFERENCE')).resolves.toMatchObject({
      status: 'delivered',
      last_status_text: 'Latest by absolute time',
      last_update: '2026-08-30T23:30:00-02:00',
      events: [
        { description: 'Latest by absolute time' },
        { description: 'Earlier by absolute time' },
      ],
    });
  });

  it('rejects an unsupported response type and a mismatched Type 1 barcode', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        Type: 3,
        Data: [{ Identifier: POSTLOGISTICS_WRONG_NUMBER, History: [] }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        Type: 1,
        Data: [{ Identifier: '999999999999999999', History: [] }],
      }));

    await expect(fetchPostlogistics(POSTLOGISTICS_WRONG_NUMBER))
      .rejects.toThrow('invalid tracking response type');
    await expect(fetchPostlogistics(POSTLOGISTICS_WRONG_NUMBER))
      .rejects.toThrow('different shipment');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not accept a Type 2 response without a resolved barcode', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      Type: 2,
      Data: [{ History: [{ Status: 'DLV', Description: 'Private shipment' }] }],
    }));

    await expect(fetchPostlogistics('CUSTOMER-REFERENCE'))
      .rejects.toThrow('did not return a shipment identifier');
  });
});

describe('official Spring GDS status categories', () => {
  it.each([
    ['Pre-advised', 'pending', 'registered'],
    ['Departed', 'in_transit', 'in_transit'],
    ['Arrived', 'in_transit', 'in_transit'],
    ['Customs', 'in_transit', 'customs'],
    ['Processing', 'in_transit', 'accepted'],
    ['Pick-up point', 'out_for_delivery', 'ready_for_pickup'],
    ['Unsuccesfull', 'exception', 'failed_attempt'],
    ['Undelivered', 'exception', 'failed_attempt'],
  ] as const)('maps %s to %s / %s', async (category, status, stage) => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: 'visitor-token' }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          items: [{
            item: SPRING_WRONG_NUMBER,
            events: [{
              category,
              datetime_local: '2026-08-30T12:00:00Z',
              status_description: `${category} event`,
            }],
          }],
        },
      }));

    await expect(fetchSpringGds(SPRING_WRONG_NUMBER)).resolves.toMatchObject({
      status,
      current_stage: stage,
      events: [{ stage }],
    });
  });
});

describe('official SunYou display statuses', () => {
  it.each([
    ['1', 'in_transit', 'in_transit'],
    ['2', 'out_for_delivery', 'ready_for_pickup'],
    ['3', 'exception', 'failed_attempt'],
    ['4', 'delivered', 'delivered'],
    ['5', 'exception', 'failed_attempt'],
    ['6', 'exception', 'failed_attempt'],
  ] as const)('maps displayStatus %s to %s / %s', async (displayStatus, status, stage) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      `searchCallback(${JSON.stringify({
        data: [{
          displayStatus,
          has: true,
          orderNo: SUNYOU_WRONG_NUMBER,
          result: {
            origin: {
              items: [{ createTime: '2026-08-30T12:00:00Z', content: 'Latest event' }],
            },
          },
        }],
      })})`,
    ));

    await expect(fetchSunYou(SUNYOU_WRONG_NUMBER)).resolves.toMatchObject({
      status,
      current_stage: stage,
      events: [{ stage }],
    });
  });
});
