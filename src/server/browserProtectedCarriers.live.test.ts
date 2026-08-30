import { describe, expect, it } from 'vitest';
import { DPDFranceTracker } from './dpdFrance';
import { MondialRelayTracker } from './mondialRelay';
import { UPSTracker } from './ups';

describe('browser-protected carriers live wrong-number handling', () => {
  it('gets a privacy-safe UPS no-result or the recognized browser challenge', async () => {
    const tracker = new UPSTracker({
      timeoutMs: 30_000,
      directTimeoutMs: 20_000,
      trawlUrl: '',
    });
    try {
      const result = await tracker.fetch('1Z0000000000000000');
      expect(result).toMatchObject({
        status: 'unknown',
        events: [],
        last_status_text: expect.stringMatching(/could not locate|not available|invalid/i),
      });
    } catch (error) {
      expect(error).toMatchObject({
        name: 'RangeError',
        message: 'UPS challenged direct tracking; configure FLARESOLVERR_URL for browser fallback',
      });
    }
  });

  it('gets a clean DPD France no-result or the recognized Cloudflare challenge', async () => {
    const tracker = new DPDFranceTracker({
      timeoutMs: 30_000,
      directTimeoutMs: 20_000,
      trawlUrl: '',
    });
    try {
      await tracker.fetch('000000000000');
      throw new Error('Expected DPD France to reject the wrong number');
    } catch (error) {
      if (error instanceof Error && error.name === 'DPDFranceTrackingError') {
        expect(error).toMatchObject({
          status: 404,
          message: 'DPD France could not locate the shipment',
        });
      } else {
        expect(error).toMatchObject({
          name: 'RangeError',
          message: 'DPD France requires a browser challenge solver; configure FLARESOLVERR_URL',
        });
      }
    }
  });

  it('gets a clean Mondial Relay no-result or the recognized browser challenge', async () => {
    const tracker = new MondialRelayTracker({
      timeoutMs: 30_000,
      directTimeoutMs: 20_000,
      trawlUrl: '',
    });
    try {
      await tracker.fetch('00000000', '75001');
      throw new Error('Expected Mondial Relay to reject the wrong number');
    } catch (error) {
      if (error instanceof Error && error.name === 'MondialRelayTrackingError') {
        expect(error).toMatchObject({
          status: 404,
          message: 'Mondial Relay could not locate the shipment',
        });
      } else {
        expect(error).toMatchObject({
          name: 'RangeError',
          message: 'Mondial Relay challenged direct tracking; configure FLARESOLVERR_URL for browser fallback',
        });
      }
    }
  });
});
