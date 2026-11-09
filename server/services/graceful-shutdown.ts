'use strict';
/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */
import { logger } from '../utils/logger';
import { Server } from 'http';
import { CampaignScheduler } from './campaign-scheduler';
import { stopPhoneBillingCron } from './phone-billing-cron';
import { pool } from '../db';
import { flushAuditLogsOnShutdown } from './audit-log';

/**
 * Graceful Shutdown Service
 * 
 * Handles clean application shutdown by:
 * 1. Stopping background schedulers and cron jobs
 * 2. Closing HTTP server (stop accepting new connections)
 * 3. Draining existing connections
 * 4. Closing database pool
 * 
 * This ensures data integrity and proper resource cleanup.
 */

let isShuttingDown = false;
let httpServer: Server | null = null;

/**
 * Register the HTTP server for graceful shutdown
 */
export function registerServer(server: Server): void {
  httpServer = server;
}

/**
 * Perform graceful shutdown
 * @param signal - The signal that triggered shutdown (SIGTERM, SIGINT, etc.)
 * @param exitCode - Exit code to use (default 0)
 */
export async function gracefulShutdown(signal: string, exitCode: number = 0): Promise<void> {
  if (isShuttingDown) {
    logger.info(`⚠️ [Shutdown] Already shutting down, ignoring ${signal}`);
    return;
  }

  isShuttingDown = true;
  logger.info(`\n🛑 [Shutdown] Received ${signal}, starting graceful shutdown...`);

  const shutdownStart = Date.now();
  const SHUTDOWN_TIMEOUT = 10000; // 10 seconds max

  try {
    // Step 1: Stop accepting new requests
    if (httpServer) {
      logger.info('   [1/4] Closing HTTP server (no new connections)...');
      await new Promise<void>((resolve) => {
        httpServer!.close(() => {
          logger.info('   ✓ HTTP server closed');
          resolve();
        });
        
        // Force close after timeout
        setTimeout(() => {
          logger.warn('   ⚠️ HTTP server close timed out, forcing...');
          resolve();
        }, 5000);
      });
    }

    // Step 2: Stop background schedulers
    logger.info('   [2/4] Stopping background schedulers...');
    CampaignScheduler.stopBackgroundScheduler();
    stopPhoneBillingCron();
    logger.info('   ✓ Schedulers stopped');

    // Step 3: Wait for pending operations (brief delay)
    logger.info('   [3/4] Draining pending operations...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    logger.info('   ✓ Operations drained');

    // Step 4: Close database pool
    logger.info('   [4/4] Closing database connections...');
    await flushAuditLogsOnShutdown(5000);
    try {
      await pool.end();
      logger.info('   ✓ Database pool closed');
    } catch (dbError: any) {
      logger.warn(`   ⚠️ Database close warning: ${dbError.message}`);
    }

    const shutdownDuration = Date.now() - shutdownStart;
    logger.info(`✅ [Shutdown] Graceful shutdown completed in ${shutdownDuration}ms`);
    
    // Signal PM2 that we're ready to die
    process.exit(exitCode);

  } catch (error: any) {
    logger.error(`❌ [Shutdown] Error during graceful shutdown:`, error);
    process.exit(1);
  }
}

/**
 * Setup global error handlers and shutdown signals
 */
export function setupGlobalHandlers(): void {
  // Handle uncaught exceptions
  process.on('uncaughtException', (error: Error) => {
    logger.error('💥 [FATAL] Uncaught Exception:', error.message);
    logger.error(error.stack ?? error.message);
    gracefulShutdown('uncaughtException', 1);
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    logger.error('💥 [FATAL] Unhandled Promise Rejection:', reason);
    if (reason instanceof Error) {
      logger.error(reason.stack ?? reason.message);
    }
    gracefulShutdown('unhandledRejection', 1);
  });

  // Handle termination signals
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // PM2 graceful reload signal
  process.on('SIGUSR2', () => {
    logger.info('📡 [PM2] Received SIGUSR2 (graceful reload)');
    gracefulShutdown('SIGUSR2');
  });

  logger.info('🛡️ [Process] Global error handlers and shutdown signals registered');
}

/**
 * Signal PM2 that the process is ready to receive connections
 * Call this after the server is fully initialized
 */
export function signalReady(): void {
  if (typeof process.send === 'function') {
    process.send('ready');
    logger.info('📡 [PM2] Signaled ready to process manager');
  }
}
