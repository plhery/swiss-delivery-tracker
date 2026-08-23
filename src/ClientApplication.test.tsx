import { describe, expect, it } from 'vitest';
import { shouldUseDemoRepository } from './ClientApplication';

describe('shouldUseDemoRepository', () => {
  it('uses the API by default in production', () => {
    expect(shouldUseDemoRepository('production', undefined)).toBe(false);
    expect(shouldUseDemoRepository('production', 'unexpected')).toBe(false);
  });

  it('uses demo data by default in development', () => {
    expect(shouldUseDemoRepository('development', undefined)).toBe(true);
    expect(shouldUseDemoRepository('development', 'unexpected')).toBe(true);
  });

  it('honors explicit settings in every environment', () => {
    expect(shouldUseDemoRepository('production', ' false ')).toBe(true);
    expect(shouldUseDemoRepository('development', ' TRUE ')).toBe(false);
  });
});
