import { describe, expect, it, vi } from 'vitest';
import { enablePwaLiveReload, registerPwaServiceWorker } from './pwaUpdates';

function serviceWorker(controller: object | null) {
  let listener: (() => void) | undefined;
  return {
    source: {
      controller,
      addEventListener: vi.fn((_event: string, next: EventListenerOrEventListenerObject) => {
        listener = next as () => void;
      }),
      removeEventListener: vi.fn(),
    } as unknown as ServiceWorkerContainer,
    changeController: () => listener?.(),
  };
}

describe('enablePwaLiveReload', () => {
  it('reloads once when an existing service worker is replaced', () => {
    const worker = serviceWorker({});
    const reload = vi.fn();
    const cleanup = enablePwaLiveReload(reload, worker.source);

    worker.changeController();
    worker.changeController();

    expect(reload).toHaveBeenCalledTimes(1);
    cleanup();
    expect(worker.source.removeEventListener).toHaveBeenCalledWith(
      'controllerchange',
      expect.any(Function),
    );
  });

  it('does not reload on first installation but reloads the next upgrade', () => {
    const worker = serviceWorker(null);
    const reload = vi.fn();
    enablePwaLiveReload(reload, worker.source);

    worker.changeController();
    expect(reload).not.toHaveBeenCalled();
    worker.changeController();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('is inert when service workers are unsupported', () => {
    const cleanup = enablePwaLiveReload(vi.fn(), null);
    expect(cleanup()).toBeUndefined();
  });
});

describe('registerPwaServiceWorker', () => {
  it('registers the root worker with update caching disabled', async () => {
    const registration = {} as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(registration);

    await expect(registerPwaServiceWorker({ register })).resolves.toBe(registration);
    expect(register).toHaveBeenCalledWith('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });
  });

  it('is inert when service workers are unsupported', async () => {
    await expect(registerPwaServiceWorker(null)).resolves.toBeNull();
  });
});
