/**
 * HTTP routes for the chatbot module. Mounted by registerChatbotModule() in index.ts.
 *
 * Tenancy: the company id is read only from res.locals.companyId, which requireCompanyScope sets from the
 * verified session. Request bodies, queries and params are never read for tenancy, and the body schemas are
 * strict, so a body that carries companyId is rejected with 400.
 *
 * Routes stay thin: validate with zod, call the service, map the result to HTTP.
 */
import { Router, type NextFunction, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { requireRole, type AuthRequest } from "../../middleware/auth.ts";
import { ChatbotError, type ChatbotService, type ConversationQuery } from "./chatbot-service.ts";
import { SUPPORTED_SURFACES } from "./generative-ui/spec-normaliser.ts";

export interface ChatbotRouteDef {
  method: "GET" | "POST" | "PATCH";
  path: string;
}

/** Mounted paths relative to the module base path. Kept next to the router so they stay in sync. */
export const CHATBOT_ROUTES: readonly ChatbotRouteDef[] = [
  { method: "GET", path: "/chatbots" },
  { method: "POST", path: "/chatbots" },
  { method: "GET", path: "/chatbots/:id" },
  { method: "PATCH", path: "/chatbots/:id" },
  { method: "GET", path: "/conversations" },
  { method: "POST", path: "/conversations" },
  { method: "GET", path: "/conversations/:id" },
  { method: "PATCH", path: "/conversations/:id" },
  { method: "POST", path: "/conversations/:id/messages" },
  { method: "POST", path: "/conversations/:id/read" },
  { method: "GET", path: "/conversations/:id/export" },
  { method: "GET", path: "/unread-counts" },
];

const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const idParam = z.string().regex(ID_PATTERN);

export const createChatbotBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    language: z.string().min(2).max(10).optional(),
    welcomeMessage: z.string().max(2000).nullable().optional(),
    instructions: z.string().max(20000).nullable().optional(),
    generativeUiEnabled: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strict();

export const updateChatbotBody = createChatbotBody.partial().strict();

export const createConversationBody = z
  .object({
    chatbotId: idParam,
    sessionId: z.string().min(1).max(128),
    channel: z.string().min(1).max(32).optional(),
  })
  .strict();

export const postMessageBody = z
  .object({
    role: z.enum(["user", "assistant"]),
    message: z.string().min(1).max(10000),
    surface: z.enum(SUPPORTED_SURFACES).optional(),
  })
  .strict();

export const updateConversationBody = z
  .object({
    ticketStatus: z.enum(["new", "closed"]).optional(),
    pinned: z.boolean().optional(),
    connectAgent: z.boolean().optional(),
  })
  .strict();

export const listConversationsQuery = z.object({
  chatbot_id: z.string().max(64).optional(),
  chatbot_channel: z.string().max(32).optional(),
  agentFilter: z.enum(["ai", "human"]).optional(),
  status: z.enum(["new", "closed", "all"]).optional(),
  unread: z.enum(["true", "false"]).optional(),
  start_date: z.string().regex(DATE_PATTERN).optional(),
  end_date: z.string().regex(DATE_PATTERN).optional(),
  search: z.string().max(200).optional(),
  sort: z.enum(["newest", "oldest"]).optional(),
  page: z.coerce.number().int().min(1).max(100000).optional(),
  per_page: z.coerce.number().int().min(1).max(100).optional(),
});

export const exportQuery = z.object({
  format: z.enum(["txt", "csv", "json", "pdf"]).optional(),
});

/** Company id from the verified scope only. */
function scopedCompanyId(res: Response): string | null {
  const value: unknown = res.locals.companyId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

type ScopedHandler = (req: AuthRequest, res: Response, companyId: string) => Promise<void>;

/**
 * Resolves the company scope, runs the handler and maps errors. Express 4 does not forward async
 * rejections, so the wrapper catches them. ChatbotError becomes its HTTP status; anything else goes to next().
 */
function scoped(handler: ScopedHandler): RequestHandler {
  return (req, res, next: NextFunction) => {
    const companyId = scopedCompanyId(res);
    if (!companyId) {
      res.status(403).json({ error: "Company scope not resolved" });
      return;
    }
    handler(req as AuthRequest, res, companyId).catch((err: unknown) => {
      if (err instanceof ChatbotError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      next(err);
    });
  };
}

/** Parses a route id. Returns null for anything outside the id pattern. */
function parseIdParam(req: AuthRequest): string | null {
  const parsed = idParam.safeParse(req.params.id);
  return parsed.success ? parsed.data : null;
}

export function createChatbotRouter(service: ChatbotService): Router {
  const router = Router();
  const readRoles = requireRole("admin", "manager", "agent");
  const configRoles = requireRole("admin", "manager");
  const conversationRoles = requireRole("admin", "agent");

  router.get(
    "/chatbots",
    readRoles,
    scoped(async (_req, res, companyId) => {
      res.json(await service.listChatbots(companyId));
    }),
  );

  router.post(
    "/chatbots",
    configRoles,
    scoped(async (req, res, companyId) => {
      const parsed = createChatbotBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
        return;
      }
      res.status(201).json(await service.createChatbot(companyId, parsed.data));
    }),
  );

  router.get(
    "/chatbots/:id",
    readRoles,
    scoped(async (req, res, companyId) => {
      const id = parseIdParam(req);
      if (!id) {
        res.status(400).json({ error: "Invalid id" });
        return;
      }
      res.json(await service.getChatbot(companyId, id));
    }),
  );

  router.patch(
    "/chatbots/:id",
    configRoles,
    scoped(async (req, res, companyId) => {
      const id = parseIdParam(req);
      if (!id) {
        res.status(400).json({ error: "Invalid id" });
        return;
      }
      const parsed = updateChatbotBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
        return;
      }
      res.json(await service.updateChatbot(companyId, id, parsed.data));
    }),
  );

  router.get(
    "/conversations",
    readRoles,
    scoped(async (req, res, companyId) => {
      const parsed = listConversationsQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
        return;
      }
      const q = parsed.data;
      const query: ConversationQuery = {
        chatbotId: q.chatbot_id,
        channel: q.chatbot_channel,
        handler: q.agentFilter,
        ticketStatus: q.status,
        unreadOnly: q.unread === "true",
        startDate: q.start_date,
        endDate: q.end_date,
        search: q.search,
        sort: q.sort,
        page: q.page,
        perPage: q.per_page,
      };
      res.json(await service.listConversations(companyId, query));
    }),
  );

  router.post(
    "/conversations",
    conversationRoles,
    scoped(async (req, res, companyId) => {
      const parsed = createConversationBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
        return;
      }
      res.status(201).json(await service.startConversation(companyId, parsed.data));
    }),
  );

  router.get(
    "/conversations/:id",
    readRoles,
    scoped(async (req, res, companyId) => {
      const id = parseIdParam(req);
      if (!id) {
        res.status(400).json({ error: "Invalid id" });
        return;
      }
      res.json(await service.getConversation(companyId, id));
    }),
  );

  router.patch(
    "/conversations/:id",
    conversationRoles,
    scoped(async (req, res, companyId) => {
      const id = parseIdParam(req);
      if (!id) {
        res.status(400).json({ error: "Invalid id" });
        return;
      }
      const parsed = updateConversationBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
        return;
      }
      res.json(await service.updateConversationState(companyId, id, parsed.data));
    }),
  );

  router.post(
    "/conversations/:id/messages",
    conversationRoles,
    scoped(async (req, res, companyId) => {
      const id = parseIdParam(req);
      if (!id) {
        res.status(400).json({ error: "Invalid id" });
        return;
      }
      const parsed = postMessageBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
        return;
      }
      if (parsed.data.role === "assistant") {
        res.status(201).json(await service.recordAssistantReply(companyId, id, parsed.data.message, parsed.data.surface));
        return;
      }
      res.status(201).json(await service.recordUserMessage(companyId, id, parsed.data.message));
    }),
  );

  router.post(
    "/conversations/:id/read",
    conversationRoles,
    scoped(async (req, res, companyId) => {
      const id = parseIdParam(req);
      if (!id) {
        res.status(400).json({ error: "Invalid id" });
        return;
      }
      res.json({ updated: await service.markConversationRead(companyId, id) });
    }),
  );

  router.get(
    "/conversations/:id/export",
    readRoles,
    scoped(async (req, res, companyId) => {
      const id = parseIdParam(req);
      if (!id) {
        res.status(400).json({ error: "Invalid id" });
        return;
      }
      const parsed = exportQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
        return;
      }
      const file = await service.exportConversation(companyId, id, parsed.data.format ?? "txt");
      res.setHeader("Content-Type", file.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${file.fileName}"`);
      res.send(file.body);
    }),
  );

  router.get(
    "/unread-counts",
    readRoles,
    scoped(async (_req, res, companyId) => {
      res.json(await service.unreadCounts(companyId));
    }),
  );

  return router;
}
