import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MondialRelayTracker,
  MondialRelayTrackingError,
  mondialRelayTrackingUrl,
  normalizeMondialRelayCredential,
  parseMondialRelayTrackingResponse,
} from './mondialRelay';

// Public fixture provenance:
// - 17185966 is the shipment in Mondial Relay's official Permalinks v2.1 PDF:
//   https://www.mondialrelay.fr/media/123677/permalinks-v211.pdf
// - 76434219 / 59650 are the example values rendered by the official tracking page:
//   https://www.mondialrelay.fr/suivi-de-colis/
// - 887368516605 is the 12-digit ID in an official Belgian tracking permalink:
//   https://www.mondialrelay.be/fr-be/suivi-de-colis?numeroExpedition=88.73685.166.05
// Mondial Relay's official CONNECT guide documents the 8/10/12 digit formats:
//   https://www.mondialrelay.fr/media/124728/fr-documentation-utilisateur-connect-v-12.pdf
// The two France fixtures now return the official no-result response, so successful
// response bodies below are explicitly synthetic schema fixtures. No mailbox or
// recipient-derived identifier is retained in this file.
const OFFICIAL_PDF_SHIPMENT = '17185966';
const OFFICIAL_PAGE_SHIPMENT = '76434219';
const OFFICIAL_PAGE_POSTCODE = '59650';
const OFFICIAL_TWELVE_DIGIT_SHIPMENT = '887368516605';
const SYNTHETIC_TEN_DIGIT_BOUNDARY = '1000000000';
const PUBLIC_CREDENTIAL = `${OFFICIAL_PDF_SHIPMENT}${OFFICIAL_PAGE_POSTCODE}`;
const TRACKING_PAGE = 'https://www.mondialrelay.fr/suivi-de-colis/';
const TEST_TOKEN = 'PUBLIC_TEST_TOKEN_1234567890';

function apiUrl(shipment = OFFICIAL_PDF_SHIPMENT, postcode = OFFICIAL_PAGE_POSTCODE): string {
  const url = new URL('https://www.mondialrelay.fr/api/tracking');
  url.searchParams.set('shipment', shipment);
  url.searchParams.set('postcode', postcode);
  url.searchParams.set('brand', '');
  url.searchParams.set('codePays', 'fr');
  return url.toString();
}

function tokenPage(): string {
  return `<!doctype html><html><body>
    <div id="tracking" token="${TEST_TOKEN}" minLengthNumExpe="4"
      maxLengthNumExpe="16"></div>
  </body></html>`;
}

function syntheticSuccessFixture(shipment = OFFICIAL_PDF_SHIPMENT): Record<string, unknown> {
  return {
    status: [{ state: 'success', message: 'Suivi disponible' }],
    Expedition: {
      Numero: shipment,
      SuiviContextuel: 'Votre colis est disponible dans votre Point Relais®',
      EstimatedDeliveryDate: '2026-08-31T00:00:00',
      Evenements: [
        {
          Date: '2026-08-30T10:30:00',
          Libelle: 'Votre colis est disponible dans votre Point Relais®',
          DetailPointRelais: {
            Adresse: {
              AdresseLigne1: '10 PRIVATE STREET',
              Ville: 'PRIVATE CITY',
              CodePostal: 'PRIVATE POSTCODE',
            },
            Telephone: 'PRIVATE PHONE',
            Email: 'private@example.test',
            Latitude: 'PRIVATE LATITUDE',
            Longitude: 'PRIVATE LONGITUDE',
          },
          Destinataire: 'PRIVATE RECIPIENT',
        },
        {
          Date: '2026-08-29T14:00:00',
          Libelle: "Votre colis est en cours d'acheminement",
          Localisation: 'PRIVATE DEPOT ADDRESS',
        },
      ],
      SuiviParEtapes: {
        Etape1: {
          Numero: 1,
          Libelle: 'Colis enregistré',
          Evenement: { Date: '2026-08-28T08:00:00' },
        },
        Etape4: {
          Numero: 4,
          Libelle: 'Disponible au Point Relais',
          Evenement: { Date: '2026-08-30T10:30:00' },
        },
      },
      DestinataireCodePostal: 'PRIVATE RECIPIENT POSTCODE',
      Replace: {
        parcelshop: {
          address: 'PRIVATE REPLACEMENT ADDRESS',
          email: 'private-replacement@example.test',
        },
      },
    },
  };
}

function numericByteObject(value: string): Record<string, number> {
  return Object.fromEntries(
    [...new TextEncoder().encode(value)].map((byte, index) => [String(index), byte]),
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

afterEach(() => vi.restoreAllMocks());

describe('Mondial Relay tracking input', () => {
  it('accepts documented separate and combined formats and builds a postcode-free permalink', () => {
    expect(normalizeMondialRelayCredential(PUBLIC_CREDENTIAL)).toEqual({
      shipment: OFFICIAL_PDF_SHIPMENT,
      postcode: OFFICIAL_PAGE_POSTCODE,
    });
    expect(normalizeMondialRelayCredential(
      OFFICIAL_PAGE_SHIPMENT,
      OFFICIAL_PAGE_POSTCODE,
    )).toEqual({
      shipment: OFFICIAL_PAGE_SHIPMENT,
      postcode: OFFICIAL_PAGE_POSTCODE,
    });
    expect(normalizeMondialRelayCredential(
      `${SYNTHETIC_TEN_DIGIT_BOUNDARY}${OFFICIAL_PAGE_POSTCODE}`,
    )).toEqual({
      shipment: SYNTHETIC_TEN_DIGIT_BOUNDARY,
      postcode: OFFICIAL_PAGE_POSTCODE,
    });
    expect(normalizeMondialRelayCredential(
      `${OFFICIAL_TWELVE_DIGIT_SHIPMENT}${OFFICIAL_PAGE_POSTCODE}`,
    )).toEqual({
      shipment: OFFICIAL_TWELVE_DIGIT_SHIPMENT,
      postcode: OFFICIAL_PAGE_POSTCODE,
    });
    expect(mondialRelayTrackingUrl(PUBLIC_CREDENTIAL)).toBe(
      `${TRACKING_PAGE}?numeroExpedition=${OFFICIAL_PDF_SHIPMENT}`,
    );
    const publicUrl = new URL(mondialRelayTrackingUrl(PUBLIC_CREDENTIAL));
    expect(publicUrl.searchParams.has('codePostal')).toBe(false);
    expect(publicUrl.searchParams.has('postcode')).toBe(false);
  });

  it('rejects incomplete credentials, invalid postcodes, and parameter injection', () => {
    for (const [shipment, postcode] of [
      [OFFICIAL_PDF_SHIPMENT, ''],
      ['1718596', OFFICIAL_PAGE_POSTCODE],
      ['17185966000', OFFICIAL_PAGE_POSTCODE],
      [OFFICIAL_PDF_SHIPMENT, '00000'],
      [OFFICIAL_PDF_SHIPMENT, '96000'],
      [OFFICIAL_PDF_SHIPMENT, '5965A'],
      [`${PUBLIC_CREDENTIAL}&admin=true`, ''],
      ['1718596É', OFFICIAL_PAGE_POSTCODE],
    ]) {
      expect(() => normalizeMondialRelayCredential(shipment, postcode))
        .toThrow('8-, 10-, or 12-digit shipment number');
    }
  });
});

describe('Mondial Relay response normalization', () => {
  it('verifies identity, maps history, and projects no relay or recipient data', () => {
    const result = parseMondialRelayTrackingResponse(
      syntheticSuccessFixture(),
      PUBLIC_CREDENTIAL,
    );

    expect(result).toMatchObject({
      status: 'out_for_delivery',
      last_status_text: 'Votre colis est disponible dans votre Point Relais®',
      last_update: '2026-08-30T10:30:00+02:00',
      expected_delivery: '2026-08-31',
      timezone: 'Europe/Paris',
      source: 'mondial_relay_public_web',
    });
    expect(result.events).toEqual([
      {
        time: '2026-08-30T10:30:00+02:00',
        location: '',
        description: 'Votre colis est disponible dans votre Point Relais®',
        stage: 'ready_for_pickup',
      },
      {
        time: '2026-08-29T14:00:00+02:00',
        location: '',
        description: "Votre colis est en cours d'acheminement",
        stage: 'in_transit',
      },
    ]);

    const serialized = JSON.stringify(result);
    for (const privateValue of [
      'PRIVATE STREET',
      'PRIVATE CITY',
      'PRIVATE POSTCODE',
      'PRIVATE PHONE',
      'private@example.test',
      'PRIVATE LATITUDE',
      'PRIVATE LONGITUDE',
      'PRIVATE RECIPIENT',
      'PRIVATE DEPOT ADDRESS',
      'PRIVATE REPLACEMENT ADDRESS',
      'private-replacement@example.test',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('keeps terminal statuses distinct and clears estimates for them', () => {
    const delivered = syntheticSuccessFixture();
    const deliveredExpedition = delivered.Expedition as Record<string, unknown>;
    deliveredExpedition.SuiviContextuel = 'Votre colis a été remis au destinataire';
    deliveredExpedition.Evenements = [{
      Date: '2026-08-30T12:00:00',
      Libelle: 'Votre colis a été remis au destinataire',
    }];
    expect(parseMondialRelayTrackingResponse(delivered, PUBLIC_CREDENTIAL)).toMatchObject({
      status: 'delivered',
      expected_delivery: null,
      events: [{ stage: 'delivered' }],
    });

    const returned = syntheticSuccessFixture();
    const returnedExpedition = returned.Expedition as Record<string, unknown>;
    returnedExpedition.SuiviContextuel = "Votre colis est retourné à l'expéditeur";
    returnedExpedition.Evenements = [{
      Date: '2026-08-30T12:00:00',
      Libelle: "Votre colis est retourné à l'expéditeur",
    }];
    expect(parseMondialRelayTrackingResponse(returned, PUBLIC_CREDENTIAL)).toMatchObject({
      status: 'exception',
      expected_delivery: null,
      events: [{ stage: 'returned' }],
    });
  });

  it('strictly accepts and verifies the official public 12-digit form', () => {
    expect(parseMondialRelayTrackingResponse(
      syntheticSuccessFixture(OFFICIAL_TWELVE_DIGIT_SHIPMENT),
      OFFICIAL_TWELVE_DIGIT_SHIPMENT,
      OFFICIAL_PAGE_POSTCODE,
    )).toMatchObject({ status: 'out_for_delivery' });
  });

  it('uses reached official milestones only when contextual history is inconclusive', () => {
    const fixture = syntheticSuccessFixture();
    const expedition = fixture.Expedition as Record<string, unknown>;
    expedition.SuiviContextuel = 'Mise à jour de votre suivi';
    expedition.Evenements = [];

    expect(parseMondialRelayTrackingResponse(fixture, PUBLIC_CREDENTIAL)).toMatchObject({
      status: 'out_for_delivery',
      last_update: null,
      events: [],
    });
  });

  it('fails closed on no-result, incomplete, and mismatched responses', () => {
    expect(() => parseMondialRelayTrackingResponse({
      status: [{
        state: 'warn',
        message: 'Il n’existe pas de colis pour ces critères de recherche',
      }],
    }, PUBLIC_CREDENTIAL)).toThrow(MondialRelayTrackingError);

    expect(() => parseMondialRelayTrackingResponse({ status: [] }, PUBLIC_CREDENTIAL))
      .toThrow('incomplete tracking details');
    expect(() => parseMondialRelayTrackingResponse(
      syntheticSuccessFixture('17185967'),
      PUBLIC_CREDENTIAL,
    )).toThrow('different shipment');

    try {
      parseMondialRelayTrackingResponse({
        status: [{ state: 'warn', message: 'PRIVATE PROVIDER QUERY ECHO' }],
      }, PUBLIC_CREDENTIAL);
      throw new Error('Expected no-result error');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'MondialRelayTrackingError',
        status: 404,
        message: 'Mondial Relay could not locate the shipment',
      });
      expect(String(error)).not.toContain('PRIVATE PROVIDER QUERY ECHO');
    }
  });
});

describe('Mondial Relay web session', () => {
  it('uses a bounded direct session, verification token, and current JSON endpoint', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(tokenPage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(syntheticSuccessFixture()), {
        headers: { 'Content-Type': 'application/json' },
      }));

    await expect(new MondialRelayTracker({
      timeoutMs: 2_000,
      directTimeoutMs: 1_000,
      trawlUrl: '',
    }).fetch(PUBLIC_CREDENTIAL)).resolves.toMatchObject({
      status: 'out_for_delivery',
      tracking_url: mondialRelayTrackingUrl(PUBLIC_CREDENTIAL),
      tracking_source: 'structured-web-response',
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toBe(TRACKING_PAGE);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      cache: 'no-store',
      // fetch-cookie performs its bounded redirect handling with manual requests.
      redirect: 'manual',
    });
    expect(String(fetcher.mock.calls[1]![0])).toBe(apiUrl());
    expect(fetcher.mock.calls[1]![1]).toMatchObject({
      cache: 'no-store',
      redirect: 'manual',
    });
    const apiHeaders = new Headers(fetcher.mock.calls[1]![1]?.headers);
    expect(apiHeaders.get('RequestVerificationToken')).toBe(TEST_TOKEN);
    expect(apiHeaders.get('Referer')).toBe(TRACKING_PAGE);
  });

  it('uses two TRAWL browser-session scrapes when direct access is challenged', async () => {
    const bootstrap = {
      tier: 3,
      statusCode: 200,
      url: TRACKING_PAGE,
      html: '<html><body>Vue replaced the tracking root</body></html>',
      body: numericByteObject(tokenPage()),
    };
    const tracked = {
      tier: 2,
      statusCode: 200,
      url: apiUrl(),
      html: `<html><body><pre>${escapeHtml(
        JSON.stringify(syntheticSuccessFixture()),
      )}</pre></body></html>`,
    };
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('<title>Just a moment...</title>', {
        status: 403,
        headers: { 'CF-Mitigated': 'challenge' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(bootstrap), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(tracked), {
        headers: { 'Content-Type': 'application/json' },
      }));

    await expect(new MondialRelayTracker({
      timeoutMs: 2_000,
      directTimeoutMs: 1_000,
      trawlUrl: 'http://trawl.internal:8191/v1',
    }).fetch(PUBLIC_CREDENTIAL)).resolves.toMatchObject({
      status: 'out_for_delivery',
      tracking_source: 'browser-session-response',
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[1]![0])).toBe('http://trawl.internal:8191/scrape');
    expect(String(fetcher.mock.calls[2]![0])).toBe('http://trawl.internal:8191/scrape');
    const bootstrapRequest = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    expect(bootstrapRequest).toEqual({
      url: TRACKING_PAGE,
      skipHttp: true,
      maxTier: 3,
      maxTimeout: 2_000,
    });
    const trackingRequest = JSON.parse(String(fetcher.mock.calls[2]![1]?.body));
    expect(trackingRequest).toMatchObject({
      url: apiUrl(),
      skipHttp: true,
      maxTier: 3,
      maxTimeout: 2_000,
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: TRACKING_PAGE,
        RequestVerificationToken: TEST_TOKEN,
      },
    });
  });

  it('fails closed when no browser fallback exists or TRAWL changes shipment', async () => {
    const challenge = (): Response => new Response('<title>Just a moment...</title>', {
      status: 403,
      headers: { 'CF-Mitigated': 'challenge' },
    });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(challenge());
    await expect(new MondialRelayTracker({
      timeoutMs: 2_000,
      directTimeoutMs: 1_000,
      trawlUrl: '',
    }).fetch(PUBLIC_CREDENTIAL)).rejects.toThrow('configure FLARESOLVERR_URL');

    fetcher
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tier: 3,
        statusCode: 200,
        url: TRACKING_PAGE,
        body: numericByteObject(tokenPage()),
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tier: 3,
        statusCode: 200,
        url: apiUrl('17185967'),
        body: numericByteObject(JSON.stringify(syntheticSuccessFixture('17185967'))),
      })));
    await expect(new MondialRelayTracker({
      timeoutMs: 2_000,
      directTimeoutMs: 1_000,
      trawlUrl: 'http://trawl.internal:8191/scrape',
    }).fetch(PUBLIC_CREDENTIAL)).rejects.toThrow('different shipment');
  });
});
