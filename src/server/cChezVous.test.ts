import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CChezVousTracker,
  CChezVousTrackingError,
  cChezVousTrackingUrl,
  normalizeCChezVousCredential,
  parseCChezVousTrackingHtml,
} from './cChezVous';

// Publicly posted by C Chez Vous in a LinkedIn customer interview. The captured
// response below is deliberately sanitized and no live call runs in this suite.
const PUBLIC_REAL_NUMBER = 'PRJV50T7DP';

function trackingPage(overrides: Record<string, unknown> = {}): string {
  const payload = {
    package_number: PUBLIC_REAL_NUMBER,
    shop_name: 'PRIVATE SHOP',
    parcels: [{
      parcelStep: 4,
      date: '2024-01-02T07:00:00.000000Z',
      dateMessage: 'Entre 08h00 et 13h00',
      parcel_number: 'PRIVATE INTERNAL PARCEL',
      mail: 'private@example.test',
      mobile: '+33 PRIVATE PHONE',
      pickupName: 'PRIVATE RECIPIENT',
      address: '10 PRIVATE STREET',
      reference: 'PRIVATE ARTICLE',
      articles: [{ name: 'PRIVATE ARTICLE' }],
    }],
    eDealer: { address: 'PRIVATE DEALER ADDRESS' },
    ...overrides,
  };
  const encoded = JSON.stringify(payload).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  return `<!doctype html><html><body>
    <h1>Votre commande : <span class="title--tertiary">${payload.package_number}</span></h1>
    <tracking :tracking-results="${encoded}"></tracking>
  </body></html>`;
}

afterEach(() => vi.restoreAllMocks());

describe('C Chez Vous combined tracking credential', () => {
  it('accepts order IDs and restores the official --postcode composite form', () => {
    expect(normalizeCChezVousCredential(` ${PUBLIC_REAL_NUMBER.toLowerCase()} `))
      .toBe(PUBLIC_REAL_NUMBER);
    expect(normalizeCChezVousCredential('4TZKO156790--59600')).toBe('4TZKO156790--59600');
    // The shared package normalizer removes punctuation before carrier dispatch.
    expect(normalizeCChezVousCredential('4TZKO15679059600')).toBe('4TZKO156790--59600');

    for (const value of [
      'SHORT',
      'ABCDEFGHIJ',
      'PRJV50T7DP--59600',
      '4TZKO156790--96000',
      '4TZKO156790--ABCDE',
      '4TZKO156790--5960',
      'PRJV50T7DP?admin=true',
      'PRJV50T7DÉ',
    ]) expect(() => normalizeCChezVousCredential(value)).toThrow();
  });

  it('builds the official path without allowing path or query injection', () => {
    expect(cChezVousTrackingUrl(PUBLIC_REAL_NUMBER))
      .toBe(`https://www.cchezvous.fr/suivi-colis/${PUBLIC_REAL_NUMBER}`);
    expect(cChezVousTrackingUrl('4TZKO15679059600'))
      .toBe('https://www.cchezvous.fr/suivi-colis/4TZKO156790--59600');
  });
});

describe('C Chez Vous response normalization', () => {
  it('parses a sanitized real provider shape and excludes all recipient and merchant fields', () => {
    const result = parseCChezVousTrackingHtml(trackingPage(), PUBLIC_REAL_NUMBER);

    expect(result).toEqual({
      status: 'out_for_delivery',
      current_stage: 'out_for_delivery',
      last_status_text: 'Commande en livraison',
      last_update: null,
      expected_delivery: '2024-01-02',
      timezone: 'Europe/Paris',
      events: [{ description: 'Commande en livraison', stage: 'out_for_delivery' }],
    });
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      'PRIVATE SHOP',
      'PRIVATE INTERNAL PARCEL',
      'private@example.test',
      'PRIVATE PHONE',
      'PRIVATE RECIPIENT',
      'PRIVATE STREET',
      'PRIVATE ARTICLE',
      'PRIVATE DEALER ADDRESS',
    ]) expect(serialized).not.toContain(privateValue);
  });

  it('uses the least-advanced parcel and does not retain a fulfilled expected date', () => {
    const result = parseCChezVousTrackingHtml(trackingPage({
      parcels: [
        { parcelStep: 5, date: '2024-01-02T07:00:00Z' },
        { parcelStep: 3, date: '2024-01-03T07:00:00Z' },
      ],
    }), PUBLIC_REAL_NUMBER);
    expect(result).toMatchObject({
      status: 'in_transit',
      expected_delivery: '2024-01-03',
      events: [{ stage: 'in_transit' }],
    });

    const delivered = parseCChezVousTrackingHtml(trackingPage({
      parcels: [{ parcelStep: 5, date: '2024-01-02T07:00:00Z' }],
    }), PUBLIC_REAL_NUMBER);
    expect(delivered).toMatchObject({ status: 'delivered', expected_delivery: null });
  });

  it('rejects mismatched, not-found, and malformed pages', () => {
    expect(() => parseCChezVousTrackingHtml(
      trackingPage({ package_number: 'ZZZZZZZZZ0' }),
      PUBLIC_REAL_NUMBER,
    )).toThrow('different shipment');
    expect(() => parseCChezVousTrackingHtml(
      '<div class="alert">La commande est introuvable</div>',
      PUBLIC_REAL_NUMBER,
    )).toThrow(CChezVousTrackingError);
    expect(() => parseCChezVousTrackingHtml(
      '<html><body>Generic tracking page</body></html>',
      PUBLIC_REAL_NUMBER,
    )).toThrow('did not return tracking details');
  });
});

describe('C Chez Vous tracker', () => {
  it('uses a bounded direct request and parses a matching page', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(trackingPage()));

    await expect(new CChezVousTracker(1_000).fetch(PUBLIC_REAL_NUMBER))
      .resolves.toMatchObject({ status: 'out_for_delivery' });
    expect(fetcher.mock.calls[0]?.[0]).toBe(cChezVousTrackingUrl(PUBLIC_REAL_NUMBER));
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      cache: 'no-store',
      redirect: 'manual',
    });
  });

  it('maps the official wrong-number redirect and a 404 to a clean not-found error', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    fetcher.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: '/suivi-colis' },
    }));
    await expect(new CChezVousTracker().fetch('ZZZZZZZZZ0')).rejects.toMatchObject({
      name: 'CChezVousTrackingError',
      message: 'C Chez Vous could not locate the shipment',
      status: 404,
    });

    fetcher.mockResolvedValueOnce(new Response('Not found', { status: 404 }));
    await expect(new CChezVousTracker().fetch('ZZZZZZZZZ0'))
      .rejects.toMatchObject({ status: 404 });
  });
});
