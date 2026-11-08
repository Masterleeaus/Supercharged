/**
 * Express router for the chatbot builder wizard (endpoint-map.md section 1, rows 3 to 7). Mounted under
 * /api/chatbot by the caller. Not mounted anywhere yet: see DECISIONS.md.
 *
 * Tenancy: the company id comes only from the injected getCompanyId (default res.locals.companyId, set by the
 * company-scope middleware). Bodies, queries and params are never read for tenancy, and every body schema is
 * strict, so a companyId anywhere in a request is rejected with 400.
 *
 * External work answers 501 with { error: "not_implemented", reason }. Avatar upload and chatbot image upload
 * need a multipart parser and a file store that Desk does not have, so they do not fake success.
 *
 * Off by default. Every request answers 404 unless ENABLE_CHATBOT_BUILDER_ROUTES is "true".
 */
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { isCompanyId } from "../../../infrastructure/database/tenant-context.ts";
import { builderIdParam, builderPatchSchema, saveIssues, splitPatch, toBuilderSnapshot } from "./builder-schemas.ts";
import type { BuilderStorage } from "./builder-storage.ts";

export const BUILDER_ROUTES_FLAG = "ENABLE_CHATBOT_BUILDER_ROUTES";

/** Paths relative to the module base path (/api/chatbot). Order matters: /builder/avatars before /builder/:id. */
export const BUILDER_ROUTES: readonly { method: "GET" | "PATCH" | "POST"; path: string }[] = [
  { method: "GET", path: "/builder/avatars" },
  { method: "POST", path: "/builder/avatars" },
  { method: "GET", path: "/builder/:id" },
  { method: "PATCH", path: "/builder/:id" },
  { method: "POST", path: "/builder/:id/uploads" },
];

/** Reads the flag. Anything other than the literal string "true" leaves the routes off. */
export function builderRoutesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[BUILDER_ROUTES_FLAG] === "true";
}

export interface BuilderRouterDeps {
  storage: BuilderStorage;
  /** Verifies the caller. Must answer 401 when the caller is not authenticated. */
  authenticate: RequestHandler;
  /**
   * Role check, shaped like requireRole in server/middleware/auth.ts. Without it every request is refused
   * with 403 (deny by default). The mount always supplies it.
   */
  requireRole?: (...roles: string[]) => RequestHandler;
  /** Returns the company id the caller is scoped to. Defaults to res.locals.companyId. */
  getCompanyId?: (req: Request, res: Response) => unknown;
  /** Clock for updated timestamps. Defaults to the system clock. */
  now?: () => Date;
  /** Environment for the flag. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /**
   * Demo mode, injected by the caller (PHP: Helper::appIsNotDemo). Outside demo mode a save needs instructions.
   * Defaults to false, so the stricter rule applies unless the caller says otherwise.
   */
  demoMode?: boolean;
}

/** Same role sets as the chatbot routes: reads for admin, manager and agent; configuration for admin and manager. */
const READ_ROLES = ["admin", "manager", "agent"];
const CONFIG_ROLES = ["admin", "manager"];

const defaultGetCompanyId = (_req: Request, res: Response): unknown => res.locals.companyId;
/** Used when no requireRole is supplied: refuses every request after authentication (deny by default). */
const denyAll = (): RequestHandler => (_req, res) => {
  res.status(403).json({ error: "Role check not configured" });
};

type ScopedHandler = (req: Request, res: Response, companyId: string) => Promise<void>;

export function createBuilderRouter(deps: BuilderRouterDeps): Router {
  const router = Router();

  if (!builderRoutesEnabled(deps.env ?? process.env)) {
    router.use((_req, res) => {
      res.status(404).json({ error: "Not found" });
    });
    return router;
  }

  const { storage, authenticate } = deps;
  const getCompanyId = deps.getCompanyId ?? defaultGetCompanyId;
  const roles: (...allowed: string[]) => RequestHandler = deps.requireRole ?? denyAll;
  const now = deps.now ?? (() => new Date());
  const demoMode = deps.demoMode ?? false;
  // Sized for the contract maxima: 20000 instructions, 20 prompts of 1000, up to 4 bytes per character.
  const jsonBody = express.json({ limit: "256kb" });

  /**
   * Order: authenticate (401), company scope (403), role (403), JSON body when asked for, then the handler.
   * Async rejections are caught here, since Express 4 does not forward them.
   */
  function guard(allowedRoles: string[], handler: ScopedHandler, withBody: boolean): RequestHandler[] {
    const scoped: RequestHandler = (req, res, next: NextFunction) => {
      const companyId = getCompanyId(req, res);
      if (!isCompanyId(companyId)) {
        res.status(403).json({ error: "Company scope required" });
        return;
      }
      handler(req, res, companyId).catch((err: unknown) => next(err));
    };
    const chain: RequestHandler[] = [authenticate, roles(...allowedRoles)];
    if (withBody) chain.push(jsonBody);
    chain.push(scoped);
    return chain;
  }

  const parseId = (req: Request): string | null => {
    const parsed = builderIdParam.safeParse(req.params.id);
    return parsed.success ? parsed.data : null;
  };
  const invalidId = (res: Response) => {
    res.status(400).json({ error: "Invalid id" });
  };
  const invalidInput = (res: Response, issues: unknown) => {
    res.status(400).json({ error: "Invalid input", issues });
  };
  const notFound = (res: Response) => {
    res.status(404).json({ error: "Chatbot not found" });
  };
  const notImplemented = (res: Response, reason: string) => {
    res.status(501).json({ error: "not_implemented", reason });
  };

  router.get(
    "/builder/avatars",
    ...guard(READ_ROLES, async (_req, res, companyId) => {
      const avatars = await storage.listChatbotAvatars(companyId);
      res.json(avatars.map(({ id, path, url }) => ({ id, path, url })));
    }, false),
  );

  router.post(
    "/builder/avatars",
    ...guard(CONFIG_ROLES, async (_req, res) => {
      notImplemented(
        res,
        "avatar upload needs a multipart parser and a file store (saveBuilderFile); neither is configured in Desk",
      );
    }, false),
  );

  router.get(
    "/builder/:id",
    ...guard(READ_ROLES, async (req, res, companyId) => {
      const id = parseId(req);
      if (!id) return invalidId(res);
      const state = await storage.findBuilderState(companyId, id);
      if (!state) return notFound(res);
      res.json(toBuilderSnapshot(state));
    }, false),
  );

  router.patch(
    "/builder/:id",
    ...guard(CONFIG_ROLES, async (req, res, companyId) => {
      const id = parseId(req);
      if (!id) return invalidId(res);
      const parsed = builderPatchSchema(companyId).safeParse(req.body);
      if (!parsed.success) return invalidInput(res, parsed.error.issues);

      // An avatar must be a preset or one of this company's uploads. A path from another company is rejected.
      const avatar = parsed.data.customize?.avatar;
      if (typeof avatar === "string") {
        const known = await storage.listChatbotAvatars(companyId);
        if (!known.some((item) => item.path === avatar)) {
          return invalidInput(res, [
            { code: "custom", path: ["customize", "avatar"], message: "must be a preset or an avatar of this company" },
          ]);
        }
      }

      // Save rule (PHP ChatbotStoreRequest): the state this patch leaves behind must have welcome and bubble
      // messages, and instructions outside demo mode. The stored state is read first, so the check sees the
      // merged result. The request itself stays partial.
      const current = await storage.findBuilderState(companyId, id);
      if (!current) return notFound(res);
      const issues = saveIssues(
        {
          welcomeMessage: current.chatbot.welcomeMessage,
          instructions: current.chatbot.instructions,
          settings: current.settings,
        },
        parsed.data,
        { demoMode },
      );
      if (issues.length > 0) return invalidInput(res, issues);

      const { chatbot, settings } = splitPatch(parsed.data);
      const hasChanges = Object.keys(chatbot).length > 0 || Object.keys(settings).length > 0;
      const state = hasChanges ? await storage.updateBuilderState(companyId, id, { chatbot, settings }, now()) : current;
      if (!state) return notFound(res);
      res.json(toBuilderSnapshot(state));
    }, true),
  );

  router.post(
    "/builder/:id/uploads",
    ...guard(CONFIG_ROLES, async (req, res, companyId) => {
      const id = parseId(req);
      if (!id) return invalidId(res);
      // Ownership is checked before the 501, so a cross-company id gets the same 404 as any other route.
      const state = await storage.findBuilderState(companyId, id);
      if (!state) return notFound(res);
      notImplemented(
        res,
        "chatbot image upload needs a multipart parser (kind and file checks) and a file store (saveBuilderFile); neither is configured in Desk",
      );
    }, false),
  );

  return router;
}
