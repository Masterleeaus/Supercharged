/**
 * WhatsApp (Twilio) inbound route. Factory only: mounts nothing.
 * POST /webhook. The account is our WhatsApp number, read from the form body (To, or From on status callbacks).
 * Off unless CHATBOT_WHATSAPP_CHANNEL_ENABLED is exactly "true": when off, every request answers 404 before any read.
 */
import { Router } from "express";
import type { FlagEnv } from "../../contracts/index.ts";
import { handleInboundPost, webhookBodyParser, type InboundRouterDeps } from "../inbound-router.ts";
import { isWhatsappChannelEnabled } from "./provider.ts";

/** Twilio accepts an empty TwiML response. */
const EMPTY_TWIML = "<Response/>";

export interface WhatsappRouterDeps extends InboundRouterDeps {
  env: FlagEnv;
}

export function createWhatsappWebhookRouter(deps: WhatsappRouterDeps): Router {
  const router = Router({ mergeParams: true });

  router.post("/webhook", webhookBodyParser(), async (req, res) => {
    if (!isWhatsappChannelEnabled(deps.env)) {
      res.status(404).end();
      return;
    }
    await handleInboundPost(deps, "whatsapp", req, res, {
      pathAccountId: null,
      success: () => res.status(200).type("text/xml").send(EMPTY_TWIML),
    });
  });

  return router;
}
