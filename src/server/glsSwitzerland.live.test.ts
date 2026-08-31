import { describe, expect, it } from 'vitest';
import { GLSSwitzerlandTracker } from './glsSwitzerland';

describe('GLS Switzerland live anonymous tracking', () => {
  it('maps Swiss Post\'s retired official GLS example to a clean 404', async () => {
    // Published with fictional “Test Entreprise” data in Swiss Post's GLS guide:
    // https://www.post.ch/-/media/post/gk/dokumente/anleitung-pakete-gls.pdf
    await expect(new GLSSwitzerlandTracker().fetch('993990103198')).rejects.toMatchObject({
      name: 'GLSSwitzerlandTrackingError',
      status: 404,
      message: 'GLS Switzerland could not locate the shipment',
    });
  });

  it('maps the official wrong-number response to a clean 404', async () => {
    await expect(new GLSSwitzerlandTracker().fetch('88888888888')).rejects.toMatchObject({
      name: 'GLSSwitzerlandTrackingError',
      status: 404,
      message: 'GLS Switzerland could not locate the shipment',
    });
  });
});
