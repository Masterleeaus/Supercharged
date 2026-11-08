import { logger } from './logger';
let restartScheduled = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;

const RESTART_DELAY_MS = 2000;

export function scheduleGracefulRestart(reason: string) {
  if (restartScheduled) {
    logger.info(`[GracefulRestart] Restart already scheduled, coalescing: ${reason}`);
    return;
  }

  restartScheduled = true;
  logger.info(`[GracefulRestart] Server restart scheduled in ${RESTART_DELAY_MS}ms - ${reason}`);

  restartTimer = setTimeout(() => {
    logger.info(`[GracefulRestart] Initiating graceful shutdown - ${reason}`);

    const httpServer = (global as any).__httpServer;
    if (httpServer) {
      httpServer.close(() => {
        logger.info(`[GracefulRestart] HTTP server closed, exiting process`);
        process.exit(0);
      });

      setTimeout(() => {
        logger.warn(`[GracefulRestart] Forced exit after timeout`);
        process.exit(0);
      }, 5000);
    } else {
      process.exit(0);
    }
  }, RESTART_DELAY_MS);
}

export function isRestartScheduled(): boolean {
  return restartScheduled;
}
