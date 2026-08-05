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
  parseTrackingInput,
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

  it('rejects S10-shaped values with an invalid check digit', () => {
    expect(isValidS10TrackingNumber('RA123456785CH')).toBe(true);
    expect(isValidS10TrackingNumber('RA123456789CH')).toBe(false);
    expect(detectCarrier('RA123456789CH')).toBe('unknown');
  });

  it('recognises UPS 1Z numbers', () => {
    expect(detectCarrier('1Z999AA10123456784')).toBe('ups');
  });

  it('recognises DHL waybills and parcel codes', () => {
    expect(detectCarrierMatch('1234567890')).toMatchObject({
      carrier: 'unknown',
      confidence: 'low',
      candidates: ['dhl'],
    });
    expect(detectCarrier('JJD0099999999')).toBe('dhl');
    expect(detectCarrier('JVGL0099999999')).toBe('dhl');
  });

  it('keeps broad FedEx number lengths ambiguous', () => {
    expect(detectCarrierMatch('123456789012')).toMatchObject({
      carrier: 'unknown',
      confidence: 'low',
      candidates: ['fedex'],
    });
    expect(detectCarrierMatch('123456789012345')).toMatchObject({
      carrier: 'unknown',
      confidence: 'low',
      candidates: ['fedex'],
    });
  });

  it('keeps bare 14-digit numbers ambiguous', () => {
    expect(detectCarrierMatch('01234567890123')).toMatchObject({
      carrier: 'unknown',
      confidence: 'low',
      candidates: ['dpd'],
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
    ['quickpac', '440012345612345678'],
    ['planzer', '91346097020038089282'],
    ['aliexpress', 'LP123456789CN'],
    ['sunyou', 'SY12345678901'],
    ['spring-gds', 'LX123456789DE'],
    ['dhl', '1234567890'],
    ['ups', '1Z999AA10123456784'],
    ['fedex', '123456789012'],
    ['dpd', '01234567890123'],
  ] as const)('round-trips a generated %s tracking link', (carrier, trackingNumber) => {
    const link = CARRIERS[carrier].trackingUrl?.(trackingNumber);
    expect(link).toBeDefined();
    expect(parseTrackingInput(`Track it here: ${link}`)).toMatchObject({
      trackingNumber,
      carrier,
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

  it('excludes fallback carriers from the manual selector', () => {
    expect(SELECTABLE_CARRIERS.map((carrier) => carrier.id)).not.toContain('unknown');
    expect(SELECTABLE_CARRIERS.map((carrier) => carrier.id)).not.toContain('intl-post');
    expect(carrierInfo('planzer')).toBe(CARRIERS.planzer);
  });
});
