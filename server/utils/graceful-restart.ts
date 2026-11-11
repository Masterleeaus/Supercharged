import { logger } from './logger';
import { gracefulShutdown } from '../services/graceful-shutdown';

let restartScheduled = false;
const RESTART_DELAY_MS = 2000;

/**
 * Coalesce plugin configuration changes into one restart.
 *
 * The registered HTTP server, background schedulers, audit queue and database
 * pool are owned by graceful-shutdown.ts. Never bypass it by reading an
 * unrelated global server reference or invoking an immediate process exit.
 *
 * An external process manager must be configured to start the service again;
 * shutdown alone does not guarantee automatic recovery.
 */
export function scheduleGracefulRestart(reason: string): void {
  if (restartScheduled) {
    logger.info(`[GracefulRestart] Restart already scheduled, coalescing: ${reason}`);
    return;
  }

  restartScheduled = true;
  logger.info(`[GracefulRestart] Graceful shutdown scheduled in ${RESTART_DELAY_MS}ms - ${reason}`);

  setTimeout(() => {
    logger.info(`[GracefulRestart] Initiating registered shutdown path - ${reason}`);
    void gracefulShutdown('plugin-restart');
  }, RESTART_DELAY_MS);
}

export function isRestartScheduled(): boolean {
  return restartScheduled;
}
