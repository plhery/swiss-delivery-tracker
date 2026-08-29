import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GLSFranceTracker,
  glsFranceStatus,
  glsFranceTrackingApiUrl,
  glsFranceTrackingUrl,
  normalizeGLSFranceTrackingNumber,
  parseGLSFranceTrackingResponse,
} from './glsFrance';

const TRACKING_NUMBER = '00AB12CD';
const NUMERIC_TRACKING_NUMBER = '36631000001';

function deliveredFixture() {
  return {
    colis: {
      trackid: TRACKING_NUMBER,
      numeroalphaColis: 1234567890,
      numeroGp: 0,
      statutColis: 'LIV',
      dateTheoriqueLivraison: '2026-08-29 00:00:00.0',
      nomSignataireColis: 'Private Recipient',
      commentairesLivraison: 'Private delivery instruction',
    },
    adresse: {
      raisonSociale: 'Private Company',
      libelle1Adresse: '10 Private Street',
      email: 'private@example.test',
      telephone: '+33000000000',
    },
    evenements: [{
      datereference: '2026-08-28 08:10:00.0',
      statutEvenement: 'CON',
      typeEvenement: 'CON',
      codelieuEvenement: 'FR9900',
      nomSignataire: 'Private Recipient',
      referenceDestinataire: 'private reference',
    }, {
      datereference: '2026-08-29 11:42:00.0',
      statutEvenement: 'LIV',
      typeEvenement: 'INF',
      codelieuEvenement: 'FR0012',
      nomSignataire: 'Private Recipient',
      codeadresseEvenement: 'private address code',
    }],
  };
}

afterEach(() => vi.restoreAllMocks());

describe('GLS France tracking input', () => {
  it('normalizes official identifiers and builds public URLs', () => {
    expect(normalizeGLSFranceTrackingNumber('00ab-12.cd')).toBe(TRACKING_NUMBER);
    expect(normalizeGLSFranceTrackingNumber('36631 000-001')).toBe(NUMERIC_TRACKING_NUMBER);

    expect(glsFranceTrackingUrl(TRACKING_NUMBER))
      .toBe(`https://moncolis.gls-france.com/fr/${TRACKING_NUMBER}`);
    expect(glsFranceTrackingApiUrl(NUMERIC_TRACKING_NUMBER)).toBe(
      `https://public.infra-prod.prod.cloud.fr.gls-group.com/consignee-ws/api/v1/command/public/codes/${NUMERIC_TRACKING_NUMBER}`,
    );
  });

  it('rejects unsupported or unsafe identifiers', () => {
    for (const value of [
      'ABC1234',
      'ABC123456',
      '3663100000A',
      '00AB12/CD',
      '00AB12CÉ',
      '00AB12CD?admin=true',
    ]) {
      expect(() => normalizeGLSFranceTrackingNumber(value)).toThrow('8 letters or digits, or 11 digits');
    }
  });
});

describe('GLS France status mapping', () => {
  it.each([
    [['CON'], 'pending'],
    [['REC', 'EXP', 'PBC', 'DOU'], 'in_transit'],
    [['TRV'], 'out_for_delivery'],
    [['LIV', 'LTV', 'LTL', 'LIL', 'LIT', 'LTT'], 'delivered'],
    [['INC', 'PBP', 'NLI', 'NLK', 'NLP', 'RET', 'PBA', 'SIN'], 'exception'],
    [['LIP', 'LTP', 'LIK', 'LTK', 'PAQ'], 'out_for_delivery'],
  ] as const)('maps %j to %s', (codes, expected) => {
    for (const code of codes) expect(glsFranceStatus(code)).toBe(expected);
  });

  it('does not guess an unknown provider code', () => {
    expect(glsFranceStatus('NEW')).toBe('unknown');
    expect(glsFranceStatus({ code: 'LIV' })).toBe('unknown');
  });
});

describe('GLS France response normalization', () => {
  it('sorts and normalizes safe events without retaining recipient or address data', () => {
    const result = parseGLSFranceTrackingResponse(deliveredFixture(), TRACKING_NUMBER);

    expect(result).toMatchObject({
      status: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2026-08-29T11:42:00+02:00',
      expected_delivery: '2026-08-29',
      timezone: 'Europe/Paris',
    });
    expect(result.events).toEqual([{
      time: '2026-08-29T11:42:00+02:00',
      location: 'FR0012',
      description: 'Delivered',
      stage: 'delivered',
      provider_code: 'LIV',
    }, {
      time: '2026-08-28T08:10:00+02:00',
      location: 'FR9900',
      description: 'Shipment information received',
      stage: 'registered',
      provider_code: 'CON',
    }]);
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      'Private Recipient',
      'Private delivery instruction',
      'Private Company',
      'Private Street',
      'private@example.test',
      'private address code',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('accepts the matching numeric identifier and maps pickup readiness', () => {
    const fixture = deliveredFixture();
    fixture.colis.trackid = '00EF34GH';
    fixture.colis.numeroalphaColis = Number(NUMERIC_TRACKING_NUMBER);
    fixture.colis.statutColis = 'LIK';
    fixture.evenements = [{
      datereference: '2026-08-29 09:15:00.0',
      statutEvenement: 'LIK',
      typeEvenement: 'INF',
      codelieuEvenement: 'FR0042',
      nomSignataire: '',
      referenceDestinataire: '',
    }];

    expect(parseGLSFranceTrackingResponse(fixture, NUMERIC_TRACKING_NUMBER)).toMatchObject({
      status: 'out_for_delivery',
      last_status_text: 'Ready for pickup at GLS Locker',
      events: [{ stage: 'ready_for_pickup', provider_code: 'LIK' }],
    });
  });

  it('rejects malformed responses and responses for another shipment', () => {
    expect(() => parseGLSFranceTrackingResponse([], TRACKING_NUMBER))
      .toThrow('invalid tracking response');
    expect(() => parseGLSFranceTrackingResponse({ colis: { statutColis: 'CON' } }, TRACKING_NUMBER))
      .toThrow('did not return a shipment identifier');

    const fixture = deliveredFixture();
    fixture.colis.trackid = '00EF34GH';
    expect(() => parseGLSFranceTrackingResponse(fixture, TRACKING_NUMBER))
      .toThrow('different shipment');
  });

  it('fetches and parses the bounded public JSON endpoint', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify(deliveredFixture()),
      { headers: { 'Content-Type': 'application/json' } },
    ));

    await expect(new GLSFranceTracker(1_000).fetch(TRACKING_NUMBER)).resolves.toMatchObject({
      status: 'delivered',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [requested, init] = fetcher.mock.calls[0]!;
    expect(String(requested)).toBe(glsFranceTrackingApiUrl(TRACKING_NUMBER));
    expect(init).toMatchObject({
      cache: 'no-store',
      redirect: 'error',
      headers: expect.objectContaining({
        Accept: 'application/json',
        Origin: 'https://moncolis.gls-france.com',
      }),
    });
  });

  it('enforces the adapter response-size limit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', {
      headers: { 'Content-Length': '750001' },
    }));

    await expect(new GLSFranceTracker(1_000).fetch(TRACKING_NUMBER))
      .rejects.toThrow('unexpectedly large response');
  });
});
