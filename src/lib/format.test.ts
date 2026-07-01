import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, relativeTime } from './format';

const NOW = new Date('2026-07-01T12:00:00.000Z').getTime();

describe('relativeTime', () => {
  it('says "just now" under a minute', () => {
    expect(relativeTime('2026-07-01T11:59:30.000Z', NOW)).toBe('just now');
  });

  it('reports minutes, hours and days', () => {
    expect(relativeTime('2026-07-01T11:45:00.000Z', NOW)).toBe('15 min ago');
    expect(relativeTime('2026-07-01T09:00:00.000Z', NOW)).toBe('3 h ago');
    expect(relativeTime('2026-06-29T12:00:00.000Z', NOW)).toBe('2 d ago');
  });

  it('falls back to a date after a week', () => {
    expect(relativeTime('2026-06-10T12:00:00.000Z', NOW)).toBe(
      formatDate('2026-06-10T12:00:00.000Z'),
    );
  });

  it('returns empty string for invalid input', () => {
    expect(relativeTime('not-a-date', NOW)).toBe('');
  });
});

describe('formatDate / formatDateTime', () => {
  it('uses Swiss dd.mm.yyyy style', () => {
    const iso = new Date(2026, 11, 24, 14, 5).toISOString();
    expect(formatDate(iso)).toBe('24.12.2026');
    expect(formatDateTime(iso)).toBe('24.12.2026, 14:05');
  });

  it('returns empty string for invalid input', () => {
    expect(formatDate('nope')).toBe('');
    expect(formatDateTime('nope')).toBe('');
  });
});
