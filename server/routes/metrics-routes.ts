import express, { type Router, type Request, type Response } from 'express';
import { getDefaultMetrics, type MetricsRecorder } from '../services/metrics';
import { createMetricsAccessGuard, type MetricsAccessOptions } from '../middleware/metrics';

export interface MetricsRouterOptions extends MetricsAccessOptions {
  recorder?: MetricsRecorder;
}

/**
 * GET /metrics, Prometheus text exposition.
 * Protected by METRICS_TOKEN (bearer) and/or an admin check. Returns 404 when neither is configured.
 */
export function createMetricsRouter(options: MetricsRouterOptions = {}): Router {
  const recorder = options.recorder ?? getDefaultMetrics();
  const router = express.Router();

  router.get(
    '/metrics',
    createMetricsAccessGuard({
      metricsToken: options.metricsToken ?? process.env.METRICS_TOKEN,
      adminAuth: options.adminAuth,
    }),
    async (_req: Request, res: Response) => {
      try {
        const body = await recorder.render();
        res.setHeader('Content-Type', recorder.contentType());
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).send(body);
      } catch {
        res.status(500).end();
      }
    },
  );

  return router;
}
