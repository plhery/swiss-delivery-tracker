import { describe, expect, it } from 'vitest';
import {
  detectCarrier,
  formatTrackingNumber,
  normalizeTrackingNumber,
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
  it('recognises Swiss Post 18-digit barcodes, with or without dots', () => {
    expect(detectCarrier('99.34.123456.12345678')).toBe('swiss-post');
    expect(detectCarrier('993412345612345678')).toBe('swiss-post');
    expect(detectCarrier('98.11.223344.55667788')).toBe('swiss-post');
  });

  it('recognises S10 registered mail ending in CH as Swiss Post', () => {
    expect(detectCarrier('RA123456789CH')).toBe('swiss-post');
    expect(detectCarrier('ra123456789ch')).toBe('swiss-post');
  });

  it('routes other S10 codes to international post', () => {
    expect(detectCarrier('LX123456789DE')).toBe('intl-post');
    expect(detectCarrier('CN987654321US')).toBe('intl-post');
  });

  it('recognises UPS 1Z numbers', () => {
    expect(detectCarrier('1Z999AA10123456784')).toBe('ups');
  });

  it('recognises DHL waybills and parcel codes', () => {
    expect(detectCarrier('1234567890')).toBe('dhl');
    expect(detectCarrier('JJD0099999999')).toBe('dhl');
    expect(detectCarrier('JVGL0099999999')).toBe('dhl');
  });

  it('recognises FedEx 12- and 15-digit numbers', () => {
    expect(detectCarrier('123456789012')).toBe('fedex');
    expect(detectCarrier('123456789012345')).toBe('fedex');
  });

  it('recognises DPD 14-digit numbers', () => {
    expect(detectCarrier('01234567890123')).toBe('dpd');
  });

  it('falls back to unknown', () => {
    expect(detectCarrier('')).toBe('unknown');
    expect(detectCarrier('hello')).toBe('unknown');
    expect(detectCarrier('123')).toBe('unknown');
  });
});

describe('formatTrackingNumber', () => {
  it('formats Swiss Post barcodes with dots', () => {
    expect(formatTrackingNumber('993412345612345678')).toBe(
      '99.34.123456.12345678',
    );
  });

  it('leaves other numbers as-is (normalised)', () => {
    expect(formatTrackingNumber('ra123456789ch')).toBe('RA123456789CH');
    expect(formatTrackingNumber('1Z999AA10123456784')).toBe('1Z999AA10123456784');
  });
});
