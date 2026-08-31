import type { Instrumentation } from 'next';

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  let observability: typeof import('./src/server/observability') | null = null;
  try {
    observability = await import('./src/server/observability');
    observability.initObservability();
    await import('./instrumentation-node');
  } catch (error) {
    if (observability) {
      observability.logOperationalEvent('server_startup_failed', {
        error_type: observability.errorType(error),
      }, 'error');
      observability.captureOperationalError(error, {
        component: 'server',
        operation: 'startup',
      });
      await observability.flushObservability();
    } else {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'server_startup_failed',
        error_type: error instanceof Error ? error.name : typeof error,
      }));
    }
    // Next logs rejected instrumentation hooks but may leave its listener alive.
    // A partially initialized delivery worker must never pass container startup.
    process.exit(1);
  }
}

export const onRequestError: Instrumentation.onRequestError = async (
  error,
  _request,
  context,
) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const observability = await import('./src/server/observability');
  observability.captureOperationalError(error, {
    component: 'next-server',
    operation: 'request_error',
    route: context.routePath,
    routeType: context.routeType,
  });
  await observability.flushObservability(500);
};
