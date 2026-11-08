/**
 * __ENGINE_PASCAL__ Engine v__ENGINE_VERSION__
 *
 * A provider group. Each provider lives in gateways/<provider>/ with the same four files:
 * index.ts, handlers.ts, service.ts, routes.ts.
 *
 * Disabled by default. Routes mount only when TITAN_ENGINE___ENGINE_ENV___ENABLED is "true".
 */

import type { Router, RequestHandler } from 'express';
import { isEngineEnabled } from './config';
import { registerProviderRoutes } from './gateways/_provider/routes';

export * from './types';
export { ENGINE_FLAG, ENGINE_NAME, ENGINE_VERSION, PROVIDER_ID, isEngineEnabled } from './config';
export { auditEngineEvent } from './audit';
export { verifyWebhookSignature, hmacSha256Hex, safeEqual } from './webhook-helper';
export { registerGateway, getGateway, listGateways } from './registry';

/**
 * Mounts this engine's routes. Same shape as registerKycRoutes.
 * Returns without touching the router when the engine flag is not "true".
 */
export function register__ENGINE_PASCAL__Engine(
  router: Router,
  requireAuth: RequestHandler,
  requireAdmin: RequestHandler
): void {
  if (!isEngineEnabled()) {
    return;
  }
  registerProviderRoutes(router, requireAuth, requireAdmin);
}
