import { describe, expect, it } from 'vitest';
import contract from '../../contracts/openapi.json';

describe('postcode API contract', () => {
  it('accepts supported raw request formats and rejects malformed separators', () => {
    const pattern = new RegExp(
      contract.components.schemas.CreatePackageRequest.properties.dpdPostcode.pattern,
    );
    for (const value of ['8000', '75001', '75 001', 'SW1A 1AA', '4445-027']) {
      expect(pattern.test(value), value).toBe(true);
    }
    for (const value of ['ABC', '12--345', '12 - 345', '75001_']) {
      expect(pattern.test(value), value).toBe(false);
    }
  });

  it('documents the canonical uppercase, whitespace-free response format', () => {
    const pattern = new RegExp(
      contract.components.schemas.PackageRow.properties.dpd_postcode.pattern,
    );
    for (const value of ['8000', '75001', 'SW1A1AA', '4445-027']) {
      expect(pattern.test(value), value).toBe(true);
    }
    for (const value of ['SW1A 1AA', 'abc1', '12--345']) {
      expect(pattern.test(value), value).toBe(false);
    }
  });
});
