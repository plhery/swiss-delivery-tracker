import { startBackgroundServices } from './src/server/background';

// Invalid server-side credentials are a deployment failure. Let initialization
// fail so an orchestrator cannot mark a process healthy while tracking and
// notification work is silently disabled.
startBackgroundServices();
