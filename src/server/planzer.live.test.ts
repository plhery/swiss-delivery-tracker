import { describe, expect, it } from 'vitest';
import { PlanzerSharedTracker } from './planzerShared';
import { fetchPlanzer } from './upstreamAdapters';

describe('Planzer live anonymous tracking', () => {
  it.each([
    ['Planzer', '12345678901234567890'],
    ['Quickpac', '440000000000000000'],
  ])('maps the %s API response for a wrong number to a clean 404', async (_carrier, number) => {
    await expect(fetchPlanzer(number)).rejects.toMatchObject({
      name: 'UpstreamHttpError',
      status: 404,
      message: 'Planzer tracking returned HTTP 404',
    });
  });

  it('maps an unknown shared shipment/access tuple to a clean 404', async () => {
    const number = '9999000000000';
    const url = 'https://trackandtrace.planzergroup.com/shared/sendungen/'
      + `${number}?accessKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    await expect(new PlanzerSharedTracker().fetch(number, url)).rejects.toMatchObject({
      name: 'PlanzerTrackingError',
      status: 404,
      message: 'Planzer could not locate the shipment',
    });
  });
});
