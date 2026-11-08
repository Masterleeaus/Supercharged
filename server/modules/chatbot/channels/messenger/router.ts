/**
 * Messenger inbound route. Factory only: mounts nothing.
 * GET /webhook/:accountId answers Meta's subscription challenge (framework answerChallenge). Anything but a correct
 * subscribe request with the account's verify token answers 403.
 * POST /webhook/:accountId takes events. Each POST is checked against X-Hub-Signature-256 with the app secret.
 * The page id in the body must equal :accountId, or the request is refused.
 */
import { Router } from "express";
import { handleChallengeGet, handleInboundPost, webhookBodyParser, type InboundRouterDeps } from "../inbound-router.ts";

export function createMessengerWebhookRouter(deps: InboundRouterDeps): Router {
  const router = Router({ mergeParams: true });

  router.get("/webhook/:accountId", async (req, res) => {
    await handleChallengeGet(deps, "messenger", req, res, req.params.accountId);
  });

  router.post("/webhook/:accountId", webhookBodyParser(), async (req, res) => {
    await handleInboundPost(deps, "messenger", req, res, {
      pathAccountId: req.params.accountId,
      success: () => res.status(200).type("text/plain").send("EVENT_RECEIVED"),
    });
  });

  return router;
}
