/**
 * Chatbot module entry point. Port of the Chatbot extension's conversation and generative UI core for Desk.
 *
 * Usage (server/routes.ts, once the company-scope and approvals wiring is ready):
 *   import { registerChatbotModule } from "./modules/chatbot/index.ts";
 *   registerChatbotModule(app, { requireCompanyScope, storage });
 *
 * Storage is injected. Without it, the Drizzle storage is used. The chatbot tables are promoted and
 * defined in shared/schema.ts, so no placeholder remains.
 */
import type { Express, RequestHandler } from "express";
import { authenticateToken } from "../../middleware/auth.ts";
import { CHATBOT_ROUTES, createChatbotRouter } from "./chatbot-routes.ts";
import { createChatbotService, type ChatbotService, type GenerativeUiDeps } from "./chatbot-service.ts";
import { createDrizzleChatbotStorage, type ChatbotStorage } from "./chatbot-storage.ts";

export interface RegisterChatbotOptions {
  /** Storage implementation. Defaults to the Drizzle storage. */
  storage?: ChatbotStorage;
  /** Prebuilt service. Takes precedence over storage. */
  service?: ChatbotService;
  /** Builder catalogue for generative UI replies. Without it, replies are stored as plain text. */
  generativeUi?: GenerativeUiDeps;
  /**
   * Verifies the caller's company scope and sets res.locals.companyId. Required, so the module never
   * mounts without tenancy. Mounted after authentication.
   */
  requireCompanyScope: RequestHandler;
  /** Defaults to authenticateToken from server/middleware/auth.ts. */
  authenticate?: RequestHandler;
  /** Defaults to /api/chatbot. */
  basePath?: string;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface RegisteredChatbotModule {
  service: ChatbotService;
  basePath: string;
  paths: string[];
}

export function registerChatbotModule(
  app: Pick<Express, "use">,
  options: RegisterChatbotOptions,
): RegisteredChatbotModule {
  const basePath = options.basePath ?? "/api/chatbot";
  const service =
    options.service ??
    createChatbotService({
      storage: options.storage ?? createDrizzleChatbotStorage(),
      generativeUi: options.generativeUi,
      now: options.now,
    });
  const authenticate = options.authenticate ?? (authenticateToken as unknown as RequestHandler);

  app.use(basePath, authenticate, options.requireCompanyScope, createChatbotRouter(service));

  return {
    service,
    basePath,
    paths: CHATBOT_ROUTES.map((route) => `${route.method} ${basePath}${route.path}`),
  };
}

export { createChatbotService, ChatbotError } from "./chatbot-service.ts";
export type { ChatbotService, ChatbotServiceDeps, ConversationQuery, Page, UnreadCounts } from "./chatbot-service.ts";
export { createMemoryChatbotStorage, createDrizzleChatbotStorage } from "./chatbot-storage.ts";
export type { ChatbotStorage } from "./chatbot-storage.ts";
export { exportConversation } from "./conversation-export.ts";
export { requireCompanyId } from "./chatbot-scope.ts";
export * from "./generative-ui/index.ts";
