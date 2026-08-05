import { beforeEach, describe, expect, it } from 'vitest';
import { clearSharedParcelInput, readSharedParcelInput } from './shareTarget';

beforeEach(() => window.history.replaceState({}, '', '/'));

describe('PWA share target', () => {
  it('combines shared URLs and text into an add-parcel input', () => {
    window.history.replaceState(
      {},
      '',
      '/?share-target=1&title=New%20shoes&text=Tracking%20993412345612345678&url=https%3A%2F%2Fservice.post.ch%2Ftrack',
    );

    expect(readSharedParcelInput()).toEqual({
      label: 'New shoes',
      trackingInput: 'https://service.post.ch/track\nTracking 993412345612345678',
    });
  });

  it('ignores ordinary query strings and removes only share parameters', () => {
    window.history.replaceState({}, '', '/?parcel=parcel-1&share-target=1&text=123456');
    clearSharedParcelInput();

    expect(window.location.search).toBe('?parcel=parcel-1');
    expect(readSharedParcelInput()).toBeNull();
  });
});
