import type { Express, RequestHandler } from "express";
import { db } from "../../db";
import { requireRole } from "../../middleware/auth";
import { registerChatbotModule } from "../../modules/chatbot/index.ts";
import { mountChatbotModule, WIRING_FLAGS } from "../../modules/chatbot/wiring/mount.ts";
import { resolveAgentStaffIdentity } from "../../modules/chatbot/agent-routes/staff-identity.ts";
import { CONTRACT_FLAGS, readFlag } from "../../modules/chatbot/contracts/flags.ts";
import { createSecretBox } from "../../modules/chatbot/secrets/secret-box.ts";
import { createChatbotReplyStack } from "../../modules/chatbot/wiring/reply-stack.ts";
import { startChatbotWorkersFromEnv } from "../../modules/chatbot/workers/boot.ts";
import { captureChatbotWebhookRawBody } from "../../middleware/raw-body.ts";
import { registerApprovalModule } from "../../modules/approvals/index.ts";
import { requireCompanyScope } from "../../middleware/company-scope";
import type { RouteContext } from "./shared";

const unavailableWidgetMessages = {
  send: async () => {
    throw new Error("chatbot widget reply stack is not available");
  },
};
const unavailableReceipt = async () => {
  throw new Error("chatbot channel reply stack is not available");
};

export function registerChatbotWiringRoutes(app: Express, deps: { routeContext: RouteContext }): void {
  const { routeContext } = deps;

  // Channel webhooks need the raw bytes. Only POST channel webhook paths are touched; other paths pass through.
  // Mounted before the core chatbot route so it runs ahead of the core auth on those paths.
  app.use(captureChatbotWebhookRawBody());
  // Chatbot wiring (channels, admin, commerce). Mounted BEFORE the core registerChatbotModule call below, so a matched
  // route answers before the core /api/chatbot authenticate runs (provider webhooks carry no session). Each surface
  // keeps its own authenticate and requireCompanyScope. Flags are read inside mountChatbotModule; with flags off it mounts nothing new.
  // The secret box is built only when a surface that stores secrets is on. createSecretBox throws when CHATBOT_SECRET_KEY
  // is missing, so with those flags off a deployment without the key still starts.
  // The outbound webhook dispatcher also stores secrets (signing keys), so its flag counts here too.
  const chatbotSecretsOn = [WIRING_FLAGS.BOOKINGS, WIRING_FLAGS.WIDGET, WIRING_FLAGS.CHANNELS, CONTRACT_FLAGS.OUTBOUND_WEBHOOKS_ENABLED].some((flag) =>
    readFlag(flag, process.env),
  );
  const chatbotSecretBox = chatbotSecretsOn ? createSecretBox({ env: process.env }) : undefined;
  // The reply stack is built only when a surface that uses it is on, so flags-off startup is unchanged.
  const replyOn = readFlag(WIRING_FLAGS.WIDGET, process.env) || readFlag(WIRING_FLAGS.CHANNELS, process.env);
  const replyStack = replyOn && chatbotSecretBox
    ? createChatbotReplyStack({ db, env: process.env, secretBox: chatbotSecretBox })
    : undefined;
  mountChatbotModule(app, {
    db,
    env: process.env,
    authenticate: routeContext.authenticateHybrid as unknown as import('express').RequestHandler,
    requireCompanyScope: requireCompanyScope(),
    requireRole: (...roles: string[]) => requireRole(...roles) as unknown as import('express').RequestHandler,
    // Agent surface: identity comes from req.user, which authenticateHybrid sets from a verified token. Company and role
    // come from that user only, never from headers or body. A user with no company gets 403, no identity gets 401.
    agentAuthenticate: resolveAgentStaffIdentity,
    secretBox: chatbotSecretBox,
    // Widget and channel replies come from the reply stack over the Desk db. Without a secret box the stack cannot be
    // built; mountChatbotModule then refuses to mount those surfaces when their flags are on, so the fallback below is
    // only reached when the surfaces are off.
    widget: {
      messages: replyStack?.widget ?? unavailableWidgetMessages,
      assetBaseUrl: process.env.CHATBOT_WIDGET_ASSET_BASE_URL ?? "",
    },
    channels: { onReceipt: replyStack?.channels.onReceipt ?? unavailableReceipt },
  });
  // Chatbot background workers. Off unless CHATBOT_WORKERS_ENABLED is exactly "true"; then only the services whose own
  // flag is on are built and passed in (see workers/boot.ts). Voice-call limits are not built: no production provider.
  startChatbotWorkersFromEnv({ db, env: process.env, secretBox: chatbotSecretBox });
  // Chatbot module (port of the Clean-Hub Chatbot extension). Authenticated, company-scoped.
  // Tables are DRAFT (migrations/DRAFT_chatbot.sql); requests fail until the draft is applied.
  // A request that matches no route mounted above falls through to this core route unchanged.
  registerChatbotModule(app, { requireCompanyScope: requireCompanyScope(), authenticate: routeContext.authenticateHybrid as unknown as import('express').RequestHandler });
  registerApprovalModule(app); // /api/approvals: authenticateToken, then requireCompanyScope()
}
