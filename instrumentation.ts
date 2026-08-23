export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    await import('./instrumentation-node');
  } catch (error) {
    const errorType = error instanceof Error ? error.name : typeof error;
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'server_startup_failed',
      error_type: errorType,
    }));
    // Next logs rejected instrumentation hooks but may leave its listener alive.
    // A partially initialized delivery worker must never pass container startup.
    process.exit(1);
  }
}
