import { describe, expect, it } from 'vitest';
import { ColiswebTracker } from './colisweb';

describe('Colisweb live anonymous tracking', () => {
  it('reports the observed valid-shaped wrong-number response without claiming a clean 404', async () => {
    // The official UI currently turns this empty HTTP 500 into its not-found card,
    // but the upstream response itself does not establish a clean 404 condition.
    await expect(new ColiswebTracker().fetch('99999999')).rejects.toMatchObject({
      name: 'ColiswebIndeterminateLookupError',
      message: 'Colisweb returned an empty HTTP 500 for the shipment lookup',
      status: 502,
      upstreamStatus: 500,
    });
  });
});
