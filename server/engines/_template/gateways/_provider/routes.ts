/**
 * __PROVIDER_PASCAL__ routes.
 *
 * Mounted only when the engine flag is "true". The guard runs before any route
 * or registry call, so a disabled engine exposes nothing.
 */

import express from 'express';
import type { Request, Response, Router, RequestHandler } from 'express';
import { isEngineEnabled, PROVIDER_ID, ENGINE_FLAG } from '../../config';
import { registerGateway } from '../../registry';
import { create__PROVIDER_PASCAL__Adapter } from './service';
import { logger } from '../../../../utils/logger.ts';

const BASE = '/api/__ENGINE_NAME__/__PROVIDER_NAME__';
const CURRENCY_RE = /^[A-Z]{3}$/;

function flattenHeaders(raw: Request['headers']): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = Array.isArray(value) ? value.join(',') : value;
  }
  return out;
}

export function registerProviderRoutes(
  router: Router,
  requireAuth: RequestHandler,
  requireAdmin: RequestHandler
): void {
  if (!isEngineEnabled()) {
    return;
  }

  const adapter = create__PROVIDER_PASCAL__Adapter();
  registerGateway(adapter);

  // Admin status. Confirms the provider is mounted; does not expose secrets.
  router.get(`${BASE}/status`, requireAdmin, (_req: Request, res: Response) => {
    res.json({ provider: PROVIDER_ID, enabled: true, flag: ENGINE_FLAG });
  });

  // Create a payment or session. Requires a login and an Idempotency-Key header.
  router.post(`${BASE}/create`, requireAuth, express.json({ limit: '16kb' }), async (req: any, res: Response) => {
    try {
      const { amount, currency, metadata } = req.body ?? {};
      const idempotencyKey = req.get('Idempotency-Key');
      if (
        !Number.isInteger(amount) ||
        amount <= 0 ||
        typeof currency !== 'string' ||
        !CURRENCY_RE.test(currency) ||
        typeof idempotencyKey !== 'string' ||
        idempotencyKey.length === 0
      ) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const result = await adapter.create({
        idempotencyKey,
        userId: String(req.userId),
        amount,
        currency,
        metadata,
      });
      res.status(result.ok ? 200 : 502).json(result);
    } catch (error) {
      logger.error(`[${PROVIDER_ID}] create failed`, error);
      res.status(500).json({ error: 'create_failed' });
    }
  });

  // Provider webhook. Needs the raw body for signature checks, so it skips JSON parsing.
  router.post(
    `${BASE}/webhook`,
    express.raw({ type: '*/*', limit: '1mb' }),
    async (req: Request, res: Response) => {
      try {
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const result = await adapter.handleWebhook({ headers: flattenHeaders(req.headers), rawBody });
        if (result.error === 'invalid_signature') {
          res.status(401).json({ received: false });
          return;
        }
        if (result.error === 'invalid_json') {
          res.status(400).json({ received: false });
          return;
        }
        res.status(200).json({ received: true });
      } catch (error) {
        logger.error(`[${PROVIDER_ID}] webhook failed`, error);
        res.status(500).json({ received: false });
      }
    }
  );
}
