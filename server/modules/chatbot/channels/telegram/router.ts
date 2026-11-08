/**
 * Telegram inbound route. Factory only: mounts nothing.
 * POST /webhook/:accountId. A Telegram update does not name its bot, so the bot id comes from the path. The route
 * sets the account header from the path (overwriting any header the caller sent), and verification still uses that
 * bot's own secret token, so a forged path or header fails.
 */
import { Router } from "express";
import { handleInboundPost, webhookBodyParser, type InboundRouterDeps } from "../inbound-router.ts";
import { TELEGRAM_ACCOUNT_HEADER } from "./provider.ts";

export function createTelegramWebhookRouter(deps: InboundRouterDeps): Router {
  const router = Router({ mergeParams: true });

  router.post("/webhook/:accountId", webhookBodyParser(), async (req, res) => {
    const accountId = req.params.accountId;
    await handleInboundPost(deps, "telegram", req, res, {
      pathAccountId: accountId,
      extraHeaders: { [TELEGRAM_ACCOUNT_HEADER]: accountId },
      success: () => res.status(200).json({ ok: true }),
    });
  });

  return router;
}
