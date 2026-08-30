import { afterEach, describe, expect, it, vi } from 'vitest';
import { DachserTracker, DachserTrackingError } from './dachser';

const WRONG_DACHSER_NUMBER = '12345678';
const WRONG_DACHSER_URL = 'https://customeriberia.dachser.com/customerarea/'
  + 'utilidades/seguimiento-publico/detalle?numeroUnico=12345678'
  + '&hash=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

afterEach(() => vi.restoreAllMocks());

describe('Dachser no-data response', () => {
  it('maps the public endpoint null-result signature to a privacy-safe 404', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      timestamp: 1_788_126_095_368,
      status: 500,
      code: 'ERR_APP_500',
      message: 'Cannot invoke resultadoDetExp.getExpedicionDetalle() because resultadoDetExp is null',
      path: '/api/utilidades/seguimiento-publico/detalle',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(new DachserTracker(1_000).fetch(WRONG_DACHSER_NUMBER, WRONG_DACHSER_URL))
      .rejects.toBeInstanceOf(DachserTrackingError);
    const request = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(request.pathname).toBe('/api/utilidades/seguimiento-publico/detalle');
    expect(request.searchParams.get('numeroUnico')).toBe(WRONG_DACHSER_NUMBER);
  });

  it('does not misclassify unrelated upstream failures as no data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      code: 'ERR_APP_500',
      message: 'Database unavailable',
    }), { status: 500 }));

    await expect(new DachserTracker(1_000).fetch(WRONG_DACHSER_NUMBER, WRONG_DACHSER_URL))
      .rejects.toMatchObject({
        name: 'UpstreamHttpError',
        status: 500,
        message: 'Dachser tracking returned HTTP 500',
      });
  });

  it('keeps Dachser\'s current generic null-message 500 indeterminate', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      code: 'ERR_APP_500',
      message: null,
      path: '/api/utilidades/seguimiento-publico/detalle',
    }), { status: 500 }));

    await expect(new DachserTracker(1_000).fetch(WRONG_DACHSER_NUMBER, WRONG_DACHSER_URL))
      .rejects.toMatchObject({
        name: 'UpstreamHttpError',
        status: 500,
        message: 'Dachser tracking returned HTTP 500',
      });
  });
});
