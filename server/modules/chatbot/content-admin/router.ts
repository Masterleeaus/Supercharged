/**
 * Express router for canned responses, knowledge-base articles, contacts (read only) and the analytics read view.
 * Mounted under /api/chatbot by the caller. Not mounted anywhere yet (see DECISIONS.md).
 *
 * Paths (relative to /api/chatbot):
 *   GET|POST     /content/canned-responses
 *   GET|PATCH|DELETE /content/canned-responses/:id
 *   GET|POST     /content/knowledge-base-articles
 *   GET|PATCH|DELETE /content/knowledge-base-articles/:id
 *   GET          /content/contacts, /content/contacts/:id
 *   GET          /content/analytics?from&to&chatbotId&groupBy&metrics
 *
 * Tenancy: the company id comes only from getCompanyId (default res.locals.companyId, set by company-scope
 * middleware). Bodies, queries and params are never read for tenancy. A row from another company answers 404,
 * the same as a missing row, and a delete of another company's row removes nothing.
 *
 * Answers 501 { error: "not_implemented" } for contacts or analytics when the port is not injected, so the screen
 * can show a pending state. Off by default: every request answers 404 unless ENABLE_CHATBOT_CONTENT_ADMIN_ROUTES is "true".
 */
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { isCompanyId } from "../../../infrastructure/database/tenant-context.ts";
import { readFlag, type FlagEnv } from "../contracts/flags.ts";
import type { AnalyticsQuery } from "../contracts/runtime.ts";
import {
  analyticsQuerySchema,
  articleCreateSchema,
  articleUpdateSchema,
  cannedCreateSchema,
  cannedUpdateSchema,
  contentIdParam,
} from "./schemas.ts";
import type { ContactReader, ContentAdminStorage, ContentAnalyticsPort } from "./types.ts";

export const CONTENT_ADMIN_ROUTES_FLAG = "ENABLE_CHATBOT_CONTENT_ADMIN_ROUTES";

/** Same role sets as the builder: reads for admin, manager and agent. Articles are written by admin and manager. */
const READ_ROLES = ["admin", "manager", "agent"];
const CANNED_WRITE_ROLES = ["admin", "manager", "agent"];
const ARTICLE_WRITE_ROLES = ["admin", "manager"];
const ANALYTICS_ROLES = ["admin", "manager"];

export interface ContentAdminRouterDeps {
  storage: ContentAdminStorage;
  /** Optional. Without it, /content/contacts answers 501. */
  contacts?: ContactReader;
  /** Optional. Without it, /content/analytics answers 501. Injected from the ops analytics public API. */
  analytics?: ContentAnalyticsPort;
  authenticate: RequestHandler;
  /** Shaped like requireRole in server/middleware/auth.ts. Without it every request is refused (deny by default). */
  requireRole?: (...roles: string[]) => RequestHandler;
  getCompanyId?: (req: Request, res: Response) => unknown;
  /** Author id for new rows, for display only. Defaults to res.locals.userId. */
  getUserId?: (req: Request, res: Response) => string | null;
  now?: () => Date;
  env?: FlagEnv;
}

const defaultGetCompanyId = (_req: Request, res: Response): unknown => res.locals.companyId;
const defaultGetUserId = (_req: Request, res: Response): string | null => {
  const id = res.locals.userId;
  return typeof id === "string" && id.length > 0 ? id : null;
};
const denyAll = (): RequestHandler => (_req, res) => {
  res.status(403).json({ error: "Role check not configured" });
};

type ScopedHandler = (req: Request, res: Response, companyId: string) => Promise<void>;

export function createContentAdminRouter(deps: ContentAdminRouterDeps): Router {
  const router = Router();

  if (!readFlag(CONTENT_ADMIN_ROUTES_FLAG, deps.env ?? process.env)) {
    router.use((_req: Request, res: Response) => {
      res.status(404).json({ error: "Not found" });
    });
    return router;
  }

  const { storage } = deps;
  const getCompanyId = deps.getCompanyId ?? defaultGetCompanyId;
  const getUserId = deps.getUserId ?? defaultGetUserId;
  const roles: (...allowed: string[]) => RequestHandler = deps.requireRole ?? denyAll;
  const now = deps.now ?? (() => new Date());
  const jsonBody = express.json({ limit: "256kb" });

  /** Order: authenticate (401), company scope (403), role (403), JSON body when asked for, then the handler. */
  function guard(allowedRoles: string[], handler: ScopedHandler, withBody: boolean): RequestHandler[] {
    const scoped: RequestHandler = (req, res, next: NextFunction) => {
      const companyId = getCompanyId(req, res);
      if (!isCompanyId(companyId)) {
        res.status(403).json({ error: "Company scope required" });
        return;
      }
      handler(req, res, companyId).catch((err: unknown) => next(err));
    };
    const chain: RequestHandler[] = [deps.authenticate, roles(...allowedRoles)];
    if (withBody) chain.push(jsonBody);
    chain.push(scoped);
    return chain;
  }

  const invalidInput = (res: Response, issues: unknown) => {
    res.status(400).json({ error: "Invalid input", issues });
  };
  const parseId = (req: Request, res: Response): string | null => {
    const parsed = contentIdParam.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid id" });
      return null;
    }
    return parsed.data;
  };
  const notFound = (res: Response, what: string) => {
    res.status(404).json({ error: `${what} not found` });
  };
  const notImplemented = (res: Response, reason: string) => {
    res.status(501).json({ error: "not_implemented", reason });
  };

  // ---- canned responses ----

  router.get(
    "/content/canned-responses",
    ...guard(READ_ROLES, async (_req, res, companyId) => {
      res.json(await storage.listCannedResponses(companyId));
    }, false),
  );

  router.post(
    "/content/canned-responses",
    ...guard(CANNED_WRITE_ROLES, async (req, res, companyId) => {
      const parsed = cannedCreateSchema.safeParse(req.body);
      if (!parsed.success) return invalidInput(res, parsed.error.issues);
      const row = await storage.insertCannedResponse(companyId, parsed.data, getUserId(req, res), now());
      res.status(201).json(row);
    }, true),
  );

  router.get(
    "/content/canned-responses/:id",
    ...guard(READ_ROLES, async (req, res, companyId) => {
      const id = parseId(req, res);
      if (!id) return;
      const row = await storage.findCannedResponse(companyId, id);
      if (!row) return notFound(res, "Canned response");
      res.json(row);
    }, false),
  );

  router.patch(
    "/content/canned-responses/:id",
    ...guard(CANNED_WRITE_ROLES, async (req, res, companyId) => {
      const id = parseId(req, res);
      if (!id) return;
      const parsed = cannedUpdateSchema.safeParse(req.body);
      if (!parsed.success) return invalidInput(res, parsed.error.issues);
      const row = await storage.updateCannedResponse(companyId, id, parsed.data, now());
      if (!row) return notFound(res, "Canned response");
      res.json(row);
    }, true),
  );

  router.delete(
    "/content/canned-responses/:id",
    ...guard(CANNED_WRITE_ROLES, async (req, res, companyId) => {
      const id = parseId(req, res);
      if (!id) return;
      const removed = await storage.deleteCannedResponse(companyId, id);
      if (!removed) return notFound(res, "Canned response");
      res.status(204).end();
    }, false),
  );

  // ---- knowledge-base articles ----

  router.get(
    "/content/knowledge-base-articles",
    ...guard(READ_ROLES, async (_req, res, companyId) => {
      res.json(await storage.listArticles(companyId));
    }, false),
  );

  router.post(
    "/content/knowledge-base-articles",
    ...guard(ARTICLE_WRITE_ROLES, async (req, res, companyId) => {
      const parsed = articleCreateSchema.safeParse(req.body);
      if (!parsed.success) return invalidInput(res, parsed.error.issues);
      const chatbotIds = await linkableChatbots(companyId, parsed.data.chatbotIds, res);
      if (!chatbotIds) return;
      const row = await storage.insertArticle(companyId, { ...parsed.data, chatbotIds }, getUserId(req, res), now());
      res.status(201).json(row);
    }, true),
  );

  router.get(
    "/content/knowledge-base-articles/:id",
    ...guard(READ_ROLES, async (req, res, companyId) => {
      const id = parseId(req, res);
      if (!id) return;
      const row = await storage.findArticle(companyId, id);
      if (!row) return notFound(res, "Article");
      res.json(row);
    }, false),
  );

  router.patch(
    "/content/knowledge-base-articles/:id",
    ...guard(ARTICLE_WRITE_ROLES, async (req, res, companyId) => {
      const id = parseId(req, res);
      if (!id) return;
      const parsed = articleUpdateSchema.safeParse(req.body);
      if (!parsed.success) return invalidInput(res, parsed.error.issues);
      let patch = parsed.data;
      if (patch.chatbotIds) {
        const chatbotIds = await linkableChatbots(companyId, patch.chatbotIds, res);
        if (!chatbotIds) return;
        patch = { ...patch, chatbotIds };
      }
      const row = await storage.updateArticle(companyId, id, patch, now());
      if (!row) return notFound(res, "Article");
      res.json(row);
    }, true),
  );

  router.delete(
    "/content/knowledge-base-articles/:id",
    ...guard(ARTICLE_WRITE_ROLES, async (req, res, companyId) => {
      const id = parseId(req, res);
      if (!id) return;
      const removed = await storage.deleteArticle(companyId, id);
      if (!removed) return notFound(res, "Article");
      res.status(204).end();
    }, false),
  );

  /** Refuses the whole write when any chatbot id is not in this company. Returns null after answering 400. */
  async function linkableChatbots(companyId: string, requested: string[], res: Response): Promise<string[] | null> {
    if (requested.length === 0) return [];
    const own = new Set(await storage.filterOwnChatbotIds(companyId, requested));
    const foreign = requested.filter((id) => !own.has(id));
    if (foreign.length > 0) {
      invalidInput(res, [{ code: "custom", path: ["chatbotIds"], message: "unknown chatbot for this company" }]);
      return null;
    }
    return requested;
  }

  // ---- contacts (read only) ----

  router.get(
    "/content/contacts",
    ...guard(READ_ROLES, async (_req, res, companyId) => {
      if (!deps.contacts) return notImplemented(res, "contacts reader is not injected");
      res.json(await deps.contacts.listContacts(companyId));
    }, false),
  );

  router.get(
    "/content/contacts/:id",
    ...guard(READ_ROLES, async (req, res, companyId) => {
      const id = parseId(req, res);
      if (!id) return;
      if (!deps.contacts) return notImplemented(res, "contacts reader is not injected");
      const row = await deps.contacts.findContact(companyId, id);
      if (!row) return notFound(res, "Contact");
      res.json(row);
    }, false),
  );

  // ---- analytics (read only, from the ops port) ----

  router.get(
    "/content/analytics",
    ...guard(ANALYTICS_ROLES, async (req, res, companyId) => {
      const parsed = analyticsQuerySchema.safeParse(req.query);
      if (!parsed.success) return invalidInput(res, parsed.error.issues);
      if (!deps.analytics) return notImplemented(res, "analytics port is not mounted");
      const q = parsed.data;
      const query: AnalyticsQuery = {
        metrics: q.metrics,
        from: new Date(`${q.from}T00:00:00.000Z`),
        to: new Date(`${q.to}T23:59:59.999Z`),
        groupBy: q.groupBy ?? null,
        ...(q.chatbotId ? { chatbotId: q.chatbotId } : {}),
      };
      const rows = await deps.analytics.run(companyId, query);
      res.json({ from: q.from, to: q.to, groupBy: query.groupBy, rows });
    }, false),
  );

  return router;
}
