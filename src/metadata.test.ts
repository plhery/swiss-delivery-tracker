import { describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers({
    host: 'delivery.example.test',
    'x-forwarded-proto': 'https',
  })),
}));

import { metadata as layoutMetadata } from '../app/layout';
import manifest from '../app/manifest';
import { generateMetadata } from '../app/page';

const TITLE = 'French & Swiss Parcel Tracking | Delivery Tracker';
const DESCRIPTION =
  'Private parcel tracking across France and Switzerland for French, Swiss, and international carriers.';

describe('public product metadata', () => {
  it('positions the site and installed PWA for France and Switzerland', () => {
    expect(layoutMetadata).toMatchObject({
      applicationName: 'Delivery Tracker',
      title: TITLE,
      description: DESCRIPTION,
    });
    expect(manifest()).toMatchObject({
      name: 'Delivery Tracker',
      short_name: 'Delivery Tracker',
      description: DESCRIPTION,
    });
  });

  it('uses the same positioning in canonical and social metadata', async () => {
    const metadata = await generateMetadata();
    expect(metadata).toMatchObject({
      metadataBase: new URL('https://delivery.example.test/'),
      title: TITLE,
      description: DESCRIPTION,
      alternates: { canonical: 'https://delivery.example.test/' },
      openGraph: {
        siteName: 'Delivery Tracker',
        title: TITLE,
        description: DESCRIPTION,
      },
      twitter: {
        title: TITLE,
        description: DESCRIPTION,
      },
    });
  });
});
