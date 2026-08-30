import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parsePlanzerTrackingHtml,
  PlanzerSharedTracker,
  PlanzerTrackingError,
} from './planzerShared';

const WRONG_SHARED_NUMBER = '9999000000000';
const WRONG_SHARED_URL = 'https://trackandtrace.planzergroup.com/shared/sendungen/'
  + `${WRONG_SHARED_NUMBER}?accessKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

afterEach(() => vi.restoreAllMocks());

describe('Planzer shared no-data response', () => {
  it('maps Planzer\'s explicit no-shipments page to a clean 404', () => {
    expect(() => parsePlanzerTrackingHtml(
      '<html><body><main><p class="lead row-offset-md">Keine Sendungen gefunden.</p></main></body></html>',
      WRONG_SHARED_NUMBER,
    )).toThrow(PlanzerTrackingError);
  });

  it.each([
    '',
    '<html><body><main>T&amp;T Sendungsverfolgung</main></body></html>',
    '<html><body><main>Maintenance</main></body></html>',
  ])('does not misclassify an incomplete provider page as no data', (html) => {
    expect(() => parsePlanzerTrackingHtml(html, WRONG_SHARED_NUMBER))
      .toThrow('Planzer returned an invalid tracking page');
  });

  it('exercises the capability URL path without exposing the access key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '<html><body><main><p class="lead row-offset-md">Keine Sendungen gefunden.</p></main></body></html>',
      { headers: { 'Content-Type': 'text/html' } },
    ));

    await expect(new PlanzerSharedTracker(1_000).fetch(WRONG_SHARED_NUMBER, WRONG_SHARED_URL))
      .rejects.toMatchObject({
        name: 'PlanzerTrackingError',
        status: 404,
        message: 'Planzer could not locate the shipment',
      });
  });
});
