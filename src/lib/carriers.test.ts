import { describe, expect, it } from 'vitest';
import {
  CARRIERS,
  SELECTABLE_CARRIERS,
  carrierInfo,
  carrierRequirements,
  detectCarrier,
  detectCarrierMatch,
  formatTrackingNumber,
  isPlanzerSharedTrackingNumber,
  isValidS10TrackingNumber,
  normalizeTrackingNumber,
  parcelTrackingLinks,
  parseTrackingInput,
  supportsSwissPostHandoff,
  tracksAutomatically,
} from './carriers';

describe('normalizeTrackingNumber', () => {
  it('uppercases and strips spaces, dots and dashes', () => {
    expect(normalizeTrackingNumber('99.34.123456.12345678')).toBe(
      '993412345612345678',
    );
    expect(normalizeTrackingNumber(' ra 123 456-789 ch ')).toBe('RA123456789CH');
  });
});

describe('supportsSwissPostHandoff', () => {
  it('requires a valid Swiss-issued tracked-letter S10 identifier', () => {
    expect(supportsSwissPostHandoff('LW230226618CH')).toBe(true);
    expect(supportsSwissPostHandoff('LW230226619CH')).toBe(false);
    expect(supportsSwissPostHandoff('RR230226618CH')).toBe(false);
  });

  it('orders Cainiao first until Swiss Post becomes the active source', () => {
    const waiting = parcelTrackingLinks({
      carrier: 'swiss-post',
      trackingNumber: 'LW230226618CH',
      trackingSource: 'aliexpress',
      swissPostReady: false,
    });
    expect(waiting.map(({ carrier, role }) => [carrier.id, role])).toEqual([
      ['aliexpress', 'active'],
      ['swiss-post', 'waiting'],
    ]);

    const active = parcelTrackingLinks({
      carrier: 'swiss-post',
      trackingNumber: 'LW230226618CH',
      trackingSource: 'swiss-post',
      swissPostReady: true,
    });
    expect(active.map(({ carrier, role }) => [carrier.id, role])).toEqual([
      ['swiss-post', 'active'],
      ['aliexpress', 'history'],
    ]);
  });

  it('opens Swiss Post links in the selected app language', () => {
    const [link] = parcelTrackingLinks({
      carrier: 'swiss-post',
      trackingNumber: '993412345612345678',
      trackingUrl: 'https://service.post.ch/ekp-web/ui/entry/search/993412345612345678?lang=de',
    }, 'fr');

    expect(link.url).toBe(
      'https://service.post.ch/ekp-web/ui/entry/search/993412345612345678?lang=fr',
    );
  });
});

describe('detectCarrier', () => {
  it('recognises Planzer 20-digit delivery numbers', () => {
    expect(detectCarrier('91346097020038089282')).toBe('planzer');
    expect(detectCarrier('91346 09702 00380 89282')).toBe('planzer');
  });

  it('recognises Planzer shared-link shipment numbers', () => {
    expect(detectCarrier('999.90.03316119')).toBe('planzer');
    expect(detectCarrier('9999003316119')).toBe('planzer');
    expect(isPlanzerSharedTrackingNumber('999.90.03316119')).toBe(true);
    expect(isPlanzerSharedTrackingNumber('91346097020038089282')).toBe(false);
  });

  it('recognises Swiss Post 18-digit barcodes, with or without dots', () => {
    expect(detectCarrier('99.34.123456.12345678')).toBe('swiss-post');
    expect(detectCarrier('993412345612345678')).toBe('swiss-post');
    expect(detectCarrier('98.11.223344.55667788')).toBe('swiss-post');
  });

  it('recognises Quickpac 18-digit barcodes starting with 44', () => {
    expect(detectCarrier('44.00.123456.12345678')).toBe('quickpac');
    expect(detectCarrier('440012345612345678')).toBe('quickpac');
  });

  it('recognises S10 registered mail ending in CH as Swiss Post', () => {
    expect(detectCarrier('RA123456785CH')).toBe('swiss-post');
    expect(detectCarrier('ra123456785ch')).toBe('swiss-post');
  });

  it('routes other S10 codes to international post', () => {
    expect(detectCarrier('LX123456785DE')).toBe('intl-post');
    expect(detectCarrier('CN987654326US')).toBe('intl-post');
  });

  it('recognises valid India-issued S10 identifiers as India Post', () => {
    expect(detectCarrier('JN067614884IN')).toBe('india-post');
    expect(detectCarrier('jn 067.614-884 in')).toBe('india-post');
    expect(detectCarrier('JN067614885IN')).toBe('unknown');
  });

  it('recognises French postal and Chronopost identifiers', () => {
    expect(detectCarrier('8G12345678901')).toBe('la-poste');
    expect(detectCarrier('RA123456785FR')).toBe('la-poste');
    expect(detectCarrier('12345678901234Q')).toBe('chronopost');
    expect(detectCarrier('XU123456785FR')).toBe('chronopost');
    expect(detectCarrier('XW123456785TS')).toBe('chronopost');
    expect(detectCarrier('PZ123456785JF')).toBe('chronopost');
  });

  it('keeps ambiguous GLS France and combined Colis Privé shapes low-confidence', () => {
    expect(detectCarrier('00AB12CD')).toBe('gls-fr');
    expect(detectCarrierMatch('AB12CD34')).toMatchObject({
      carrier: 'unknown',
      confidence: 'low',
      candidates: ['gls-ch', 'gls-fr'],
    });
    expect(detectCarrierMatch('36631000001')).toMatchObject({
      carrier: 'unknown',
      confidence: 'low',
      candidates: ['gls-ch', 'gls-fr'],
    });
    expect(detectCarrierMatch('99112233445575012')).toMatchObject({
      carrier: 'unknown',
      confidence: 'low',
      candidates: ['colis-prive'],
    });
    expect(detectCarrierMatch('99112233445500000')).toMatchObject({
      carrier: 'unknown',
      confidence: 'none',
      candidates: [],
    });
    expect(detectCarrier('00123456')).toBe('unknown');
    expect(detectCarrier('DELIVERY')).toBe('unknown');
    expect(detectCarrier('1G123GEODIS0')).toBe('geodis');
  });

  it('recognises distinctive deep French carrier identifiers without guessing broad numbers', () => {
    expect(detectCarrier('250123456789012')).toBe('dpd-fr');
    expect(detectCarrier('CC200000000401')).toBe('relais-colis');
    expect(detectCarrierMatch('10594002378611')).toMatchObject({
      carrier: 'unknown',
      confidence: 'low',
      candidates: ['gls-ch', 'dpd', 'dpd-fr', 'ciblex'],
    });
    expect(detectCarrierMatch('76434219')).toMatchObject({
      carrier: 'unknown',
      confidence: 'low',
      candidates: ['mondial-relay', 'heppner'],
    });
    expect(detectCarrier('FGRC45BKLM')).toBe('c-chez-vous');
    expect(detectCarrier('ASE12345678')).toBe('asendia');
  });

  it('rejects S10-shaped values with an invalid check digit', () => {
    expect(isValidS10TrackingNumber('RA123456785CH')).toBe(true);
    expect(isValidS10TrackingNumber('RA123456789CH')).toBe(false);
    expect(detectCarrier('RA123456789CH')).toBe('unknown');
  });

  it('recognises UPS 1Z numbers', () => {
    expect(detectCarrier('1Z999AA10123456784')).toBe('ups');
  });

  it('recognises Amazon Shipping France identifiers', () => {
    expect(detectCarrier('FR1234567890')).toBe('amazon-logistics');
    expect(detectCarrier('fr 1234-567890')).toBe('amazon-logistics');
  });

  it('recognises DHL waybills and parcel codes', () => {
    expect(detectCarrierMatch('1234567890')).toMatchObject({
      carrier: 'unknown',
      confidence: 'low',
      candidates: ['dhl', 'mondial-relay'],
    });
    expect(detectCarrier('JJD0099999999')).toBe('dhl');
    expect(detectCarrier('JVGL0099999999')).toBe('dhl');
  });

  it('keeps broad FedEx number lengths ambiguous', () => {
    expect(detectCarrierMatch('123456789012')).toMatchObject({
      carrier: 'unknown',
      confidence: 'low',
      candidates: ['fedex', 'gls-ch', 'dpd-fr', 'mondial-relay'],
    });
    expect(detectCarrierMatch('123456789012345')).toMatchObject({
      carrier: 'unknown',
      confidence: 'low',
      candidates: ['fedex', 'dpd-fr'],
    });
  });

  it('keeps bare 14-digit numbers ambiguous', () => {
    expect(detectCarrierMatch('01234567890123')).toMatchObject({
      carrier: 'unknown',
      confidence: 'low',
      candidates: ['gls-ch', 'dpd', 'dpd-fr', 'ciblex'],
    });
  });

  it('falls back to unknown', () => {
    expect(detectCarrier('')).toBe('unknown');
    expect(detectCarrier('hello')).toBe('unknown');
    expect(detectCarrier('123')).toBe('unknown');
  });
});

describe('formatTrackingNumber', () => {
  it('formats Swiss Post and Quickpac barcodes with dots', () => {
    expect(formatTrackingNumber('993412345612345678')).toBe(
      '99.34.123456.12345678',
    );
    expect(formatTrackingNumber('440012345612345678')).toBe(
      '44.00.123456.12345678',
    );
  });

  it('leaves other numbers as-is (normalised)', () => {
    expect(formatTrackingNumber('ra123456789ch')).toBe('RA123456789CH');
    expect(formatTrackingNumber('1Z999AA10123456784')).toBe('1Z999AA10123456784');
  });

  it('formats Planzer shared-link numbers with their original separators', () => {
    expect(formatTrackingNumber('9999003316119')).toBe('999.90.03316119');
  });
});

describe('parseTrackingInput', () => {
  it.each([
    ['swiss-post', '993412345612345678'],
    ['swiss-post-cargo', '1234ABC789'],
    ['quickpac', '440012345612345678'],
    ['planzer', '91346097020038089282'],
    ['aliexpress', 'LP123456789CN'],
    ['sunyou', 'SY12345678901'],
    ['spring-gds', 'LX123456789DE'],
    ['dhl', '1234567890'],
    ['ups', '1Z999AA10123456784'],
    ['amazon-logistics', 'FR1234567890'],
    ['fedex', '123456789012'],
    ['gls-ch', '993990103198'],
    ['dpd', '01234567890123'],
    ['dpd-fr', '250123456789012'],
    ['la-poste', '8G12345678901'],
    ['chronopost', '12345678901234Q'],
    ['gls-fr', '00AB12CD'],
    ['colis-prive', '99112233445575012'],
    ['geodis', '1G123GEODIS0'],
    ['colisweb', '87654321'],
    ['c-chez-vous', 'FGRC45BKLM'],
    ['ciblex', '12345678901234'],
    ['paack', 'PAACK12345'],
    ['asendia', 'ASE12345678'],
  ] as const)('round-trips a generated %s tracking link', (carrier, trackingNumber) => {
    const link = CARRIERS[carrier].trackingUrl?.(trackingNumber);
    expect(link).toBeDefined();
    expect(parseTrackingInput(`Track it here: ${link}`)).toMatchObject({
      trackingNumber,
      carrier,
      source: 'link',
    });
  });

  it('builds usable links for C Chez Vous compact credentials and Paack', () => {
    expect(CARRIERS['c-chez-vous'].trackingUrl?.('4TZKO15679059600')).toBe(
      'https://www.cchezvous.fr/suivi-colis/4TZKO156790--59600',
    );
    expect(CARRIERS.paack.trackingUrl?.('PAACK12345')).toBe(
      'https://mydeliveries.paack.app/tracking?tracking_number=PAACK12345',
    );
  });

  it('trusts a broad GLS identifier only when it comes from the official domain', () => {
    expect(parseTrackingInput('https://moncolis.gls-france.com/fr/AB12CD34')).toMatchObject({
      trackingNumber: 'AB12CD34',
      carrier: 'gls-fr',
      confidence: 'high',
      candidates: ['gls-fr'],
      source: 'link',
    });
  });

  it('trusts deep French identifiers embedded in their official carrier links', () => {
    expect(parseTrackingInput(
      'https://www.mondialrelay.fr/suivi-de-colis/?shipment=76434219',
    )).toMatchObject({
      trackingNumber: '76434219',
      carrier: 'mondial-relay',
      confidence: 'high',
      source: 'link',
    });
    expect(parseTrackingInput(
      'https://www.relaiscolis.com/colis/suivre?trackingNumber=CC200000000401',
    )).toMatchObject({
      trackingNumber: 'CC200000000401',
      carrier: 'relais-colis',
      confidence: 'high',
      source: 'link',
    });
  });

  it('captures a complete Planzer shared capability link', () => {
    const link =
      'https://trackandtrace.planzergroup.com/shared/sendungen/999.90.03316119?accessKey=abcdefghijklmnopqrstuvwxyzABCDEFGH';

    expect(parseTrackingInput(`Your delivery: ${link}.`)).toMatchObject({
      trackingNumber: '999.90.03316119',
      carrier: 'planzer',
      trackingUrl: link,
      source: 'link',
    });
  });

  it('uses the number shape to distinguish Quickpac on Planzer links', () => {
    expect(parseTrackingInput(
      'https://tracking.app.planzer.ch/delivery/info?deliveryNumber=440012345612345678',
    )).toMatchObject({
      trackingNumber: '440012345612345678',
      carrier: 'quickpac',
      confidence: 'high',
      source: 'link',
    });
  });

  it('captures a complete Dachser capability link', () => {
    const link =
      'https://customeriberia.dachser.com/customerarea/utilidades/seguimiento-publico/detalle?cliente=generico&numeroUnico=9010000001234&fecha=20260513&clave=TESTKEY9';

    expect(parseTrackingInput(`Your delivery: ${link}.`)).toMatchObject({
      trackingNumber: '9010000001234',
      carrier: 'dachser',
      confidence: 'high',
      trackingUrl: link,
      source: 'link',
    });
  });

  it('does not retain capability URLs from lookalike domains', () => {
    const result = parseTrackingInput(
      'https://trackandtrace.planzergroup.com.evil.test/shared/sendungen/999.90.03316119?accessKey=secret',
    );

    expect(result.trackingNumber).toBe('999.90.03316119');
    expect(result.carrier).toBe('planzer');
    expect(result.trackingUrl).toBeUndefined();
  });

  it('finds recognised numbers in pasted shipping text', () => {
    expect(
      parseTrackingInput('Your order is on its way. UPS tracking number: 1Z999AA10123456784.'),
    ).toMatchObject({
      trackingNumber: '1Z999AA10123456784',
      carrier: 'ups',
      source: 'text',
    });
  });

  it('extracts an unknown-format number following a tracking label', () => {
    expect(parseTrackingInput('Shipment tracking: ABC123XYZ')).toMatchObject({
      trackingNumber: 'ABC123XYZ',
      carrier: 'unknown',
      source: 'text',
    });
  });

  it('keeps plain manual numbers and rejects prose without a number', () => {
    expect(parseTrackingInput('ambiguous-123')).toMatchObject({
      trackingNumber: 'ambiguous-123',
      carrier: 'unknown',
      source: 'number',
    });
    expect(parseTrackingInput('Where is my parcel?')).toMatchObject({
      trackingNumber: '',
      carrier: 'unknown',
      source: 'none',
    });
    expect(parseTrackingInput('hello there')).toMatchObject({
      trackingNumber: '',
      carrier: 'unknown',
      source: 'none',
    });
  });
});

describe('carrier metadata', () => {
  it('links Swiss Post deliveries to the Post tracking service', () => {
    expect(CARRIERS['swiss-post'].trackingUrl?.('996013175411004730')).toBe(
      'https://service.post.ch/ekp-web/ui/entry/search/996013175411004730',
    );
  });

  it('links Planzer deliveries to the current tracking app', () => {
    expect(CARRIERS.planzer.trackingUrl?.('91346097020038089282')).toBe(
      'https://tracking.app.planzer.ch/delivery/info?deliveryNumber=91346097020038089282',
    );
  });

  it('links Quickpac deliveries to the current Planzer tracking app', () => {
    expect(CARRIERS.quickpac.trackingUrl?.('440012345612345678')).toBe(
      'https://tracking.app.planzer.ch/delivery/info?deliveryNumber=440012345612345678',
    );
  });

  it('links DPD deliveries to myDPD Switzerland', () => {
    expect(CARRIERS.dpd.trackingUrl?.('06086514587082')).toBe(
      'https://www.dpdgroup.com/ch/mydpd/my-parcels/incoming?parcelNumber=06086514587082',
    );
    expect(tracksAutomatically('dpd')).toBe(true);
  });

  it('tracks UPS deliveries automatically with browser fallback', () => {
    expect(tracksAutomatically('ups')).toBe(true);
    expect(CARRIERS.ups.trackingUrl?.('1Z999AA10123456784')).toBe(
      'https://www.ups.com/track?tracknum=1Z999AA10123456784',
    );
  });

  it('tracks Dachser capability links automatically', () => {
    expect(tracksAutomatically('dachser')).toBe(true);
    expect(carrierRequirements('dachser', '9010000001234')).toMatchObject([
      {
        field: 'trackingUrl',
        label: 'Dachser tracking URL',
        type: 'url',
      },
    ]);
  });

  it('builds encoded tracking links for every linked carrier', () => {
    const linked = Object.values(CARRIERS).filter((carrier) => carrier.trackingUrl);
    expect(linked.length).toBeGreaterThan(0);
    for (const carrier of linked) {
      expect(carrier.trackingUrl?.('AB 12/3')).toContain('AB%2012%2F3');
    }
  });

  it('exposes every French carrier while excluding fallback-only carriers', () => {
    const selectable = SELECTABLE_CARRIERS.map((carrier) => carrier.id);
    expect(selectable).not.toContain('unknown');
    expect(selectable).not.toContain('intl-post');
    expect(selectable).toContain('india-post');
    expect(selectable).toEqual(expect.arrayContaining([
      'dpd-fr',
      'mondial-relay',
      'relais-colis',
      'la-poste',
      'chronopost',
      'gls-fr',
      'colis-prive',
      'geodis',
    ]));
    expect(tracksAutomatically('la-poste')).toBe(true);
    expect(tracksAutomatically('chronopost')).toBe(true);
    expect(tracksAutomatically('gls-fr')).toBe(true);
    expect(tracksAutomatically('colis-prive')).toBe(true);
    expect(tracksAutomatically('geodis')).toBe(true);
    expect(tracksAutomatically('dpd-fr')).toBe(true);
    expect(tracksAutomatically('mondial-relay')).toBe(true);
    expect(tracksAutomatically('relais-colis')).toBe(true);
    expect(tracksAutomatically('india-post')).toBe(true);
    expect(carrierInfo('planzer')).toBe(CARRIERS.planzer);
  });
});
