import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DPDFranceChallengeError,
  DPDFranceTracker,
  DPDFranceTrackingError,
  dpdFranceTrackingUrl,
  normalizeDPDFranceTrackingNumber,
  parseDPDFranceTrackingHtml,
} from './dpdFrance';

// Publicly posted by a merchant in a 2026 customer-service response:
// https://fr.trustpilot.com/review/furnicher.com?page=6
// The fixture keeps only the public shipment timeline; no mailbox or recipient
// data is used. The return number is exposed with its outbound leg on DPD's
// indexed public trace page:
// https://trace.dpd.fr/trace-particuliers/10654000122441
const PUBLIC_TRACKING_NUMBER = '250803383035673';
const PUBLIC_RETURN_NUMBER = '10658000986984';

function publicDeliveredFixture(trackingNumber = PUBLIC_TRACKING_NUMBER): string {
  return `<!doctype html><html><body>
    <div id="iconsAller">
      <span class="infosTitle parcelNumberAller">Votre colis ${trackingNumber}</span>
    </div>
    <div id="infos1">
      <ul class="tableInfosAR"><li><strong>N° colis</strong></li><li class="tdInfos">${trackingNumber}</li></ul>
      <ul class="tableInfosAR"><li><strong>Numéro de référence interne</strong></li><li class="tdInfos">private-order-reference</li></ul>
      <ul class="tableInfosAR"><li><strong>Livré le</strong></li><li class="tdInfos">23/01/2026</li></ul>
    </div>
    <table id="tableTrace">
      <tr class="tabTraceColisAller" data-sort="1770886237">
        <td>12/02/2026</td><td>09:50</td>
        <td>Nous avons reçu une réclamation : une enquête est ouverte</td>
        <td>Agence DPD de La Crau (283)</td>
      </tr>
      <tr class="tabTraceColisAller" data-sort="1769168750">
        <td>23/01/2026</td><td>12:45</td><td>Votre colis est livré</td><td>Livré au destinataire</td>
      </tr>
      <tr class="tabTraceColisAller" data-sort="1769153494">
        <td>23/01/2026</td><td>08:31</td><td>Votre colis est en cours de livraison</td>
        <td>Agence DPD de La Crau (283)</td>
      </tr>
      <tr class="tabTraceColisAller" data-sort="1769094990">
        <td>22/01/2026</td><td>16:16</td><td>Votre colis est arrivé en France</td>
        <td>Centre de tri DPD de Le Coudray (175)</td>
      </tr>
      <tr class="tabTraceColisRetour"><td>24/01/2026</td><td>08:00</td><td>Private return event</td><td></td></tr>
    </table>
    <div id="agence">19 Private Street</div>
    <div id="preuveliv">Signed by Private Recipient, private@example.test</div>
  </body></html>`;
}

afterEach(() => vi.restoreAllMocks());

describe('DPD France tracking input', () => {
  it('accepts the official 12-to-15-digit formats and builds the public URL', () => {
    expect(normalizeDPDFranceTrackingNumber('1059 4002 3786 11')).toBe('10594002378611');
    expect(normalizeDPDFranceTrackingNumber('250.803.383.035.673')).toBe(PUBLIC_TRACKING_NUMBER);
    expect(normalizeDPDFranceTrackingNumber('012345678901')).toBe('012345678901');
    expect(dpdFranceTrackingUrl(PUBLIC_TRACKING_NUMBER))
      .toBe(`https://trace.dpd.fr/fr/trace/${PUBLIC_TRACKING_NUMBER}`);
  });

  it('rejects unsafe or non-France identifiers', () => {
    for (const value of [
      '25080338303',
      '2508033830356730',
      '350803383035673',
      '25080338303567A',
      '250803383035673?admin=true',
    ]) {
      expect(() => normalizeDPDFranceTrackingNumber(value)).toThrow('12 to 15 digits');
    }
  });
});

describe('DPD France rendered tracking', () => {
  it('parses a real public shipment fixture and excludes private page sections', () => {
    const result = parseDPDFranceTrackingHtml(publicDeliveredFixture(), PUBLIC_TRACKING_NUMBER);

    expect(result).toMatchObject({
      status: 'exception',
      last_status_text: 'Nous avons reçu une réclamation : une enquête est ouverte',
      last_update: '2026-02-12T09:50:00+01:00',
      expected_delivery: null,
      timezone: 'Europe/Paris',
    });
    expect(result.events).toEqual([
      {
        time: '2026-02-12T09:50:00+01:00',
        location: 'Agence DPD de La Crau (283)',
        description: 'Nous avons reçu une réclamation : une enquête est ouverte',
        stage: 'failed_attempt',
      },
      {
        time: '2026-01-23T12:45:00+01:00',
        location: 'Livré au destinataire',
        description: 'Votre colis est livré',
        stage: 'delivered',
      },
      {
        time: '2026-01-23T08:31:00+01:00',
        location: 'Agence DPD de La Crau (283)',
        description: 'Votre colis est en cours de livraison',
        stage: 'out_for_delivery',
      },
      {
        time: '2026-01-22T16:16:00+01:00',
        location: 'Centre de tri DPD de Le Coudray (175)',
        description: 'Votre colis est arrivé en France',
        stage: 'in_transit',
      },
    ]);
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      'private-order-reference',
      'Private return event',
      'Private Street',
      'Private Recipient',
      'private@example.test',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('rejects browser challenges, unknown shipments, and mismatched responses', () => {
    expect(() => parseDPDFranceTrackingHtml(
      '<title>Just a moment...</title><p>Performing security verification</p>',
      PUBLIC_TRACKING_NUMBER,
    )).toThrow(DPDFranceChallengeError);
    expect(() => parseDPDFranceTrackingHtml(
      '<p>Nous ne sommes pas en mesure de retrouver le numéro de colis recherché.</p>',
      PUBLIC_TRACKING_NUMBER,
    )).toThrow(DPDFranceTrackingError);
    expect(() => parseDPDFranceTrackingHtml(
      publicDeliveredFixture('250803383035649'),
      PUBLIC_TRACKING_NUMBER,
    )).toThrow('different shipment');
  });

  it('selects the requested return leg without mixing outbound events', () => {
    const html = `<!doctype html><html><body>
      <span class="parcelNumberAller">Votre colis 10654000122441</span>
      <span class="parcelNumberRetour">Votre colis ${PUBLIC_RETURN_NUMBER}</span>
      <div id="infos1"><ul class="tableInfosAR"><li><strong>N° colis</strong></li><li class="tdInfos">10654000122441</li></ul></div>
      <div id="infos2"><ul class="tableInfosAR"><li><strong>N° colis</strong></li><li class="tdInfos">${PUBLIC_RETURN_NUMBER}</li></ul></div>
      <table id="tableTrace">
        <tr class="tabTraceColisAller"><td>18/11/2024</td><td>12:20</td><td>Votre colis est livré</td><td>Outbound location</td></tr>
        <tr class="tabTraceColisRetour"><td>19/11/2024</td><td>09:01</td><td>Votre colis est en transit dans notre réseau</td><td>Return location</td></tr>
      </table>
    </body></html>`;

    expect(parseDPDFranceTrackingHtml(html, PUBLIC_RETURN_NUMBER)).toMatchObject({
      status: 'in_transit',
      events: [{ location: 'Return location', stage: 'in_transit' }],
    });
    expect(JSON.stringify(parseDPDFranceTrackingHtml(html, PUBLIC_RETURN_NUMBER)))
      .not.toContain('Outbound location');
  });

  it('uses direct HTTP when Cloudflare permits it', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      publicDeliveredFixture(),
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    ));

    await expect(new DPDFranceTracker({ timeoutMs: 2_000 }).fetch(PUBLIC_TRACKING_NUMBER))
      .resolves.toMatchObject({
        status: 'exception',
        tracking_url: dpdFranceTrackingUrl(PUBLIC_TRACKING_NUMBER),
        tracking_source: 'rendered-page',
      });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(dpdFranceTrackingUrl(PUBLIC_TRACKING_NUMBER));
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      cache: 'no-store',
      redirect: 'follow',
    });
  });

  it('falls back to the same TRAWL scrape protocol used for UPS', async () => {
    const challenge = new Response('<title>Just a moment...</title>', {
      status: 403,
      headers: { 'CF-Mitigated': 'challenge' },
    });
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(challenge)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tier: 3,
        statusCode: 200,
        html: publicDeliveredFixture(),
        cookies: [],
      }), { headers: { 'Content-Type': 'application/json' } }));

    await expect(new DPDFranceTracker({
      timeoutMs: 2_000,
      trawlUrl: 'http://trawl.internal:8191/v1',
    }).fetch(PUBLIC_TRACKING_NUMBER)).resolves.toMatchObject({ status: 'exception' });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toBe('http://trawl.internal:8191/scrape');
    const trawlRequest = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    expect(trawlRequest).toEqual({
      url: dpdFranceTrackingUrl(PUBLIC_TRACKING_NUMBER),
      skipHttp: true,
      maxTier: 3,
      maxTimeout: 2_000,
    });
  });

  it('surfaces an actionable error when no browser solver is configured', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '<title>Just a moment...</title>',
      { status: 403, headers: { 'CF-Mitigated': 'challenge' } },
    ));

    await expect(new DPDFranceTracker({ timeoutMs: 2_000, trawlUrl: '' })
      .fetch(PUBLIC_TRACKING_NUMBER)).rejects.toThrow('configure FLARESOLVERR_URL');
  });
});
