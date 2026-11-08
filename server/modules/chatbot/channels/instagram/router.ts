/**
 * Instagram inbound route. Factory only: mounts nothing.
 * GET /webhook/:accountId answers the subscription challenge (framework answerChallenge, verify token from credentials).
 * POST /webhook/:accountId takes events, signed with X-Hub-Signature-256 over the app secret. The account is the
 * instagram_id, which must equal :accountId.
 */
import { Router } from "express";
import { handleChallengeGet, handleInboundPost, webhookBodyParser, type InboundRouterDeps } from "../inbound-router.ts";

export function createInstagramWebhookRouter(deps: InboundRouterDeps): Router {
  const router = Router({ mergeParams: true });

  router.get("/webhook/:accountId", async (req, res) => {
    await handleChallengeGet(deps, "instagram", req, res, req.params.accountId);
  });

  router.post("/webhook/:accountId", webhookBodyParser(), async (req, res) => {
    await handleInboundPost(deps, "instagram", req, res, {
      pathAccountId: req.params.accountId,
      success: () => res.status(200).type("text/plain").send("EVENT_RECEIVED"),
    });
  });

  return router;
}
