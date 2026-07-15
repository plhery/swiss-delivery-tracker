type ServiceWorkerReloadSource = Pick<
  ServiceWorkerContainer,
  'controller' | 'addEventListener' | 'removeEventListener'
>;

/** Reload an already-controlled PWA as soon as a replacement worker takes over. */
export function enablePwaLiveReload(
  reload: () => void = () => window.location.reload(),
  serviceWorker: ServiceWorkerReloadSource | null =
    'serviceWorker' in navigator ? navigator.serviceWorker : null,
): () => void {
  if (!serviceWorker) return () => undefined;

  let hasController = Boolean(serviceWorker.controller);
  let isReloading = false;

  const handleControllerChange = () => {
    // The first controller change is installation, not an upgrade. Reloading
    // here would make a first-time visitor refresh immediately after opening.
    if (!hasController) {
      hasController = true;
      return;
    }
    if (isReloading) return;
    isReloading = true;
    reload();
  };

  serviceWorker.addEventListener('controllerchange', handleControllerChange);
  return () => serviceWorker.removeEventListener('controllerchange', handleControllerChange);
}
