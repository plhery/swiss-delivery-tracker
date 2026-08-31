import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CiblexTracker,
  CiblexTrackingError,
  ciblexTrackingUrl,
  normalizeCiblexTrackingNumber,
  parseCiblexTrackingHtml,
} from './ciblex';

// Fully synthetic identifier paired with a deterministic provider-shaped HTML
// fixture. Ciblex does not publish a reusable demo shipment number.
const TEST_TRACKING_NUMBER = '12345678901234';

function trackingPage(options: {
  trackingNumber?: string;
  rows?: Array<[string, string, string, string]>;
  privateDetail?: string;
} = {}): string {
  const trackingNumber = options.trackingNumber ?? TEST_TRACKING_NUMBER;
  const rows = options.rows ?? [
    ['30/12/2021', '05:29', 'Colis Livré', ''],
    ['30/12/2021', '05:24', 'Mis en livraison', 'Sausheim 68 (68)'],
    ['30/12/2021', '05:24', 'Colis Contrôle', 'Sausheim 68 (68)'],
    ['28/12/2021', '09:27', 'COMPLEMENT ADRESSE', '10 PRIVATE STREET (75)'],
  ];
  return `<!doctype html><html><body>
    <table class="t_bandeau_detail"><tr><td>&nbsp;SUIVI COLIS : ${trackingNumber}</td></tr></table>
    <table class="private"><tr><td>${options.privateDetail ?? 'PRIVATE CUSTOMER AND ORDER'}</td></tr></table>
    <table border="2" bgcolor="#205AA7" cellpadding="2" cellspacing="2">
      <tr class="t_liste_titre">
        <td>&nbsp;Date&nbsp;</td><td>&nbsp;Heure livraison&nbsp;</td>
        <td>&nbsp;Action&nbsp;</td><td>&nbsp;Lieu&nbsp;</td>
      </tr>
      ${rows.map(([date, time, action, location]) => `<tr class="t_liste_ligne">
        <td>${date}</td><td>${time}</td><td>${action}</td><td>${location}</td>
      </tr>`).join('')}
    </table>
    <script>window.privateEmail = 'private@example.test';</script>
  </body></html>`;
}

function emptyTrackingPage(trackingNumber = TEST_TRACKING_NUMBER): string {
  return trackingPage({ trackingNumber, rows: [] });
}

afterEach(() => vi.restoreAllMocks());

describe('Ciblex anonymous tracking input', () => {
  it('accepts fourteen-digit Ciblex barcodes and builds the official URL', () => {
    expect(normalizeCiblexTrackingNumber('12 3456 7890 1234')).toBe(TEST_TRACKING_NUMBER);
    const url = new URL(ciblexTrackingUrl(TEST_TRACKING_NUMBER));
    expect(url.origin).toBe('https://secure.extranet.ciblex.fr');
    expect(url.pathname).toBe('/extranet/client/corps.php');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      module: 'colis',
      colis: TEST_TRACKING_NUMBER,
    });
  });

  it('rejects unsupported lengths, non-ASCII input, and parameter injection', () => {
    for (const value of [
      '1234567890123',
      '123456789012345',
      '1234567890123A',
      '1234567890123É',
      '12345678901234&module=admin',
    ]) expect(() => normalizeCiblexTrackingNumber(value)).toThrow('exactly 14 digits');
  });
});

describe('Ciblex response normalization', () => {
  it('normalizes a provider-shaped history without retaining unrelated or unsafe fields', () => {
    const result = parseCiblexTrackingHtml(trackingPage(), TEST_TRACKING_NUMBER);

    expect(result).toMatchObject({
      status: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2021-12-30T05:29:00+01:00',
      expected_delivery: null,
      timezone: 'Europe/Paris',
    });
    expect(result.events).toEqual([{
      time: '2021-12-30T05:29:00+01:00',
      location: '',
      description: 'Delivered',
      stage: 'delivered',
    }, {
      time: '2021-12-30T05:24:00+01:00',
      location: 'Sausheim 68 (68)',
      description: 'Out for delivery',
      stage: 'out_for_delivery',
    }, {
      time: '2021-12-30T05:24:00+01:00',
      location: 'Sausheim 68 (68)',
      description: 'Parcel processed at Ciblex facility',
      stage: 'in_transit',
    }, {
      time: '2021-12-28T09:27:00+01:00',
      location: '',
      description: 'Delivery issue',
      stage: 'failed_attempt',
    }]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('PRIVATE CUSTOMER AND ORDER');
    expect(serialized).not.toContain('private@example.test');
    expect(serialized).not.toContain('PRIVATE STREET');
  });

  it('maps pickup, returned, unknown, and accepted events to safe descriptions', () => {
    const result = parseCiblexTrackingHtml(trackingPage({ rows: [
      ['03/05/2022', '09:00', 'Retour expéditeur', 'VITROLLES 13 (13)'],
      ['02/05/2022', '09:00', 'Disponible au relais', 'VITROLLES 13 (13)'],
      ['01/05/2022', '09:00', 'Colis pris en charge', 'VITROLLES 13 (13)'],
      ['30/04/2022', '09:00', 'Statut provider nouveau', 'VITROLLES 13 (13)'],
    ] }), TEST_TRACKING_NUMBER);
    expect(result).toMatchObject({
      status: 'exception',
      events: [
        { description: 'Returned to sender', stage: 'returned' },
        { description: 'Ready for pickup', stage: 'ready_for_pickup' },
        { description: 'Shipment collected', stage: 'accepted' },
        { description: 'Ciblex tracking update', stage: 'in_transit' },
      ],
    });
  });

  it('treats the provider empty-table wrong-number response as a clean 404', () => {
    let error: unknown;
    try {
      parseCiblexTrackingHtml(emptyTrackingPage(), TEST_TRACKING_NUMBER);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CiblexTrackingError);
    expect(error).toMatchObject({
      status: 404,
      message: 'Ciblex could not locate the shipment',
    });
    expect(() => parseCiblexTrackingHtml('', TEST_TRACKING_NUMBER))
      .toThrow('empty tracking response');
  });

  it('rejects mismatched and malformed provider pages', () => {
    expect(() => parseCiblexTrackingHtml(
      trackingPage({ trackingNumber: '99999999999999' }),
      TEST_TRACKING_NUMBER,
    )).toThrow('different shipment');
    expect(() => parseCiblexTrackingHtml('<html>generic page</html>', TEST_TRACKING_NUMBER))
      .toThrow('shipment identifier');
    expect(() => parseCiblexTrackingHtml(
      '<html><p class="f_erreur">CODE BORDEREAU OBLIGATOIRE !</p></html>',
      TEST_TRACKING_NUMBER,
    )).toThrow(CiblexTrackingError);
  });
});

describe('Ciblex tracker', () => {
  it('fetches and parses the bounded anonymous official page', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      trackingPage(),
      { headers: { 'Content-Type': 'text/html; charset=UTF-8' } },
    ));

    await expect(new CiblexTracker(1_000).fetch(TEST_TRACKING_NUMBER))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(ciblexTrackingUrl(TEST_TRACKING_NUMBER));
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store', redirect: 'error' });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('Referer'))
      .toBe('https://ciblex.eu/suivi-colis-express/');
  });

  it('recognizes the live wrong-number shape even though Ciblex returns HTTP 200', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(emptyTrackingPage('12345678901234')));
    await expect(new CiblexTracker(1_000).fetch('12345678901234')).rejects.toMatchObject({
      name: 'CiblexTrackingError',
      status: 404,
      message: 'Ciblex could not locate the shipment',
    });

    fetcher.mockResolvedValueOnce(new Response(''));
    await expect(new CiblexTracker(1_000).fetch('12345678901234'))
      .rejects.toThrow('empty tracking response');
  });
});
