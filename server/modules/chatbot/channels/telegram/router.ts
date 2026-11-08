/**
 * Telegram inbound route. Factory only: mounts nothing.
 * POST /webhook/:accountId. A Telegram update does not name its bot, so the bot id comes from the path. The route
 * sets the account header from the path (overwriting any header the caller sent), and verification still uses that
 * bot's own secret token, so a forged path or header fails.
 */
import { Router, type RequestHandler } from "express";
import { CONTRACT_FLAGS, readFlag, type FlagEnv } from "../../contracts/flags.ts";
import { handleInboundPost, webhookBodyParser, type InboundRouterDeps } from "../inbound-router.ts";
import { TELEGRAM_ACCOUNT_HEADER } from "./provider.ts";

export interface TelegramWebhookRouterDeps extends InboundRouterDeps {
  /**
   * When passed, the route answers 404 unless CHATBOT_TELEGRAM_CHANNEL_ENABLED is exactly "true". wiring/mount.ts always
   * passes it. Without it (direct use, tests) the route is not gated by this flag.
   */
  env?: FlagEnv;
}

export function createTelegramWebhookRouter(deps: TelegramWebhookRouterDeps): Router {
  const router = Router({ mergeParams: true });

  router.post("/webhook/:accountId", telegramFlagGate(deps.env), webhookBodyParser(), async (req, res) => {
    const accountId = req.params.accountId;
    await handleInboundPost(deps, "telegram", req, res, {
      pathAccountId: accountId,
      extraHeaders: { [TELEGRAM_ACCOUNT_HEADER]: accountId },
      success: () => res.status(200).json({ ok: true }),
    });
  });

  return router;
}

/** Answers 404 before any body is read when the Telegram kill switch is not exactly "true". */
function telegramFlagGate(env: FlagEnv | undefined): RequestHandler {
  return (_req, res, next) => {
    if (env !== undefined && !readFlag(CONTRACT_FLAGS.TELEGRAM_CHANNEL, env)) {
      res.status(404).end();
      return;
    }
    next();
  };
}
