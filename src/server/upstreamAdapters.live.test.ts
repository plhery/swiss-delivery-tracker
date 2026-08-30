import { describe, expect, it } from 'vitest';
import {
  fetchCainiao,
  fetchPostlogistics,
  fetchSpringGds,
  fetchSunYou,
} from './upstreamAdapters';

const CAINIAO_WRONG_NUMBER = 'LP00000000000000';
const POSTLOGISTICS_WRONG_NUMBER = '000000000000000000';
const SPRING_WRONG_NUMBER = 'LT000000000NL';
const SUNYOU_WRONG_NUMBER = 'SY00000000000';

describe('shared upstream adapters live wrong-number handling', () => {
  it('maps Cainiao\'s official empty external result to a clean 404', async () => {
    await expect(fetchCainiao(CAINIAO_WRONG_NUMBER)).rejects.toMatchObject({
      name: 'UpstreamTrackingError',
      status: 404,
      message: 'Cainiao could not locate the shipment',
    });
  });

  it('maps PostLogistics\' official null-data result to a clean 404', async () => {
    await expect(fetchPostlogistics(POSTLOGISTICS_WRONG_NUMBER)).rejects.toMatchObject({
      name: 'UpstreamTrackingError',
      status: 404,
      message: 'PostLogistics could not locate the shipment',
    });
  });

  it('maps Spring GDS\' official barcode-not-found result to a clean 404', async () => {
    await expect(fetchSpringGds(SPRING_WRONG_NUMBER)).rejects.toMatchObject({
      name: 'UpstreamTrackingError',
      status: 404,
      message: 'Spring GDS could not locate the shipment',
    });
  });

  it('maps SunYou\'s official not-found result to a clean 404', async () => {
    await expect(fetchSunYou(SUNYOU_WRONG_NUMBER)).rejects.toMatchObject({
      name: 'UpstreamTrackingError',
      status: 404,
      message: 'SunYou could not locate the shipment',
    });
  });
});
