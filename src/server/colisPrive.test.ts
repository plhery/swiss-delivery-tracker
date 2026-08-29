import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ColisPriveTrackingError,
  ColisPriveTracker,
  colisPriveTrackingUrl,
  normalizeColisPriveCredential,
  parseColisPriveTrackingHtml,
} from './colisPrive';

const PUBLIC_SYNTHETIC_CREDENTIAL = '99112233445575012';

function trackingPage(options: {
  shipment?: string;
  status?: string;
  rows?: Array<[string, string]>;
} = {}): string {
  const shipment = options.shipment ?? '991 122 334 455';
  const status = options.status ?? 'Nous avons tenté de livrer votre colis.';
  const rows = options.rows ?? [
    ['28/08/2026', 'Nous avons tenté de livrer votre colis.'],
    ['28/08/2026', 'Votre colis est en cours de distribution par le livreur'],
    ['26/08/2026', 'Votre colis est arrivé sur notre agence régionale de distribution.'],
    ['25/08/2026', "Votre colis est en cours de préparation par l'expéditeur."],
  ];
  return `<!doctype html>
    <html><body>
      <div class="BandeauInfoColis">
        <div class="divColis"><div class="tdText">${shipment}</div></div>
        <div class="divStatut"><div class="tdText">${status}</div></div>
        <div class="divDesti"><div class="tdText">
          PRIVATE RECIPIENT<br>10 PRIVATE STREET<br>75012 PRIVATE CITY
        </div></div>
      </div>
      <table class="tableHistoriqueColis">
        ${rows.map(([date, description]) => `
          <tr class="bandeauText">
            <td class="tdText" headers="th-date">${date}</td>
            <td class="tdText" headers="th-statut">${description}</td>
          </tr>`).join('')}
      </table>
      <div class="recipient-contact">private@example.test</div>
    </body></html>`;
}

afterEach(() => vi.restoreAllMocks());

describe('Colis Privé combined tracking credential', () => {
  it('accepts only 12 alphanumeric shipment characters followed by a 5-digit postcode', () => {
    expect(normalizeColisPriveCredential(`  ${PUBLIC_SYNTHETIC_CREDENTIAL}  `))
      .toBe(PUBLIC_SYNTHETIC_CREDENTIAL);
    expect(normalizeColisPriveCredential('ab123456789075001')).toBe('AB123456789075001');

    for (const value of [
      '991122334455',
      '9911223344557501',
      '991122334455750123',
      '991122334455ABCDE',
      '9911223344557501É',
      '99112233445575012&admin=true',
      '991 122 334 455 75012',
      '99112233445500000',
      '99112233445596000',
      '99112233445599000',
    ]) {
      expect(() => normalizeColisPriveCredential(value)).toThrow('12-character shipment number');
    }
  });

  it('builds the official detail URL without allowing parameter injection', () => {
    const url = new URL(colisPriveTrackingUrl(PUBLIC_SYNTHETIC_CREDENTIAL));
    expect(url.origin).toBe('https://colisprive.com');
    expect(url.pathname).toBe('/moncolis/pages/DetailColis.aspx');
    expect(url.searchParams.get('numColis')).toBe(PUBLIC_SYNTHETIC_CREDENTIAL);
    expect(url.searchParams.get('lang')).toBe('fr');
    expect([...url.searchParams]).toHaveLength(2);
  });
});

describe('Colis Privé HTML normalization', () => {
  it('verifies the requested shipment and parses status history without retaining recipient data', () => {
    const result = parseColisPriveTrackingHtml(
      trackingPage(),
      PUBLIC_SYNTHETIC_CREDENTIAL,
    );

    expect(result).toMatchObject({
      status: 'exception',
      last_status_text: 'Nous avons tenté de livrer votre colis.',
      last_update: '28/08/2026',
      expected_delivery: null,
      timezone: 'Europe/Paris',
    });
    expect(result.events).toEqual([
      {
        time: '28/08/2026',
        location: '',
        description: 'Nous avons tenté de livrer votre colis.',
        stage: 'failed_attempt',
      },
      {
        time: '28/08/2026',
        location: '',
        description: 'Votre colis est en cours de distribution par le livreur',
        stage: 'out_for_delivery',
      },
      {
        time: '26/08/2026',
        location: '',
        description: 'Votre colis est arrivé sur notre agence régionale de distribution.',
        stage: 'in_transit',
      },
      {
        time: '25/08/2026',
        location: '',
        description: "Votre colis est en cours de préparation par l'expéditeur.",
        stage: 'registered',
      },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('PRIVATE RECIPIENT');
    expect(serialized).not.toContain('PRIVATE STREET');
    expect(serialized).not.toContain('private@example.test');
  });

  it('maps delivered and relay-pickup statuses', () => {
    const delivered = parseColisPriveTrackingHtml(trackingPage({
      status: 'Votre colis a été livré en boîte aux lettres',
      rows: [['29/08/2026', 'Votre colis a été livré en boîte aux lettres']],
    }), PUBLIC_SYNTHETIC_CREDENTIAL);
    expect(delivered.status).toBe('delivered');
    expect(delivered.events).toEqual([expect.objectContaining({ stage: 'delivered' })]);

    const pickup = parseColisPriveTrackingHtml(trackingPage({
      status: 'Votre colis vous attend au relais',
      rows: [['29/08/2026', 'Votre colis vous attend au relais']],
    }), PUBLIC_SYNTHETIC_CREDENTIAL);
    expect(pickup.status).toBe('out_for_delivery');
    expect(pickup.events).toEqual([expect.objectContaining({ stage: 'ready_for_pickup' })]);
  });

  it('rejects mismatched, incomplete, and malformed success pages', () => {
    expect(() => parseColisPriveTrackingHtml(
      trackingPage({ shipment: '123 456 789 012' }),
      PUBLIC_SYNTHETIC_CREDENTIAL,
    )).toThrow('different shipment');
    expect(() => parseColisPriveTrackingHtml(
      '<html><body>Generic home page</body></html>',
      PUBLIC_SYNTHETIC_CREDENTIAL,
    )).toThrow('did not return tracking details');
    expect(() => parseColisPriveTrackingHtml(
      trackingPage({ status: '' }),
      PUBLIC_SYNTHETIC_CREDENTIAL,
    )).toThrow('did not return a shipment status');
  });
});

describe('Colis Privé tracker', () => {
  it('uses a bounded no-redirect request and parses a matching page', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(trackingPage(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }));

    await expect(new ColisPriveTracker(1_000).fetch(PUBLIC_SYNTHETIC_CREDENTIAL))
      .resolves.toMatchObject({ status: 'exception', last_update: '28/08/2026' });

    const requested = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(requested.searchParams.get('numColis')).toBe(PUBLIC_SYNTHETIC_CREDENTIAL);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store', redirect: 'manual' });
  });

  it('surfaces provider redirects and 404 responses as privacy-safe not-found errors', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    fetcher.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: '/moncolis/Default.aspx' },
    }));
    await expect(new ColisPriveTracker().fetch(PUBLIC_SYNTHETIC_CREDENTIAL)).rejects.toMatchObject({
      name: 'ColisPriveTrackingError',
      message: 'Colis Privé could not locate the shipment',
      status: 404,
    });
    expect(new ColisPriveTrackingError()).toMatchObject({ status: 404 });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });

    fetcher.mockResolvedValueOnce(new Response('Not found', { status: 404 }));
    await expect(new ColisPriveTracker().fetch(PUBLIC_SYNTHETIC_CREDENTIAL))
      .rejects.toMatchObject({ status: 404 });
  });
});
