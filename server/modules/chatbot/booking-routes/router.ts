/**
 * Express router for bookings and booking-assistant settings. Port of the Commerce Crew chatbot-booking
 * extension's booking runtime (Appointment model and BookingRuntime) as HTTP. The PHP controller only
 * served an index view, so the CRUD routes here are new and follow the Desk chatbot router's style.
 *
 * Tenancy: the company id comes only from the injected getCompanyId function (default: res.locals.companyId,
 * set by the company-scope middleware). Bodies, queries and params are never read for tenancy, and every
 * schema is strict, so a companyId anywhere in the request is rejected with 400.
 *
 * Off by default. The router answers 404 to every request unless ENABLE_CHATBOT_BOOKING_ROUTES is "true".
 */
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { isCompanyId } from "../../../infrastructure/database/tenant-context.ts";
import {
  BOOKING_ROUTES,
  type BookingService,
  type BookingListQuery,
  type BookingUpdateInput,
  type NewBookingInput,
} from "./contract.ts";
import {
  bookingIdParam,
  cancelBookingBody,
  createBookingBody,
  listBookingsQuery,
  updateAssistantSettingsBody,
  updateBookingBody,
} from "./schemas.ts";

export { BOOKING_ROUTES };

export const BOOKING_ROUTES_FLAG = "ENABLE_CHATBOT_BOOKING_ROUTES";

/** Reads the flag. Anything other than the literal string "true" leaves the routes off. */
export function bookingRoutesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[BOOKING_ROUTES_FLAG] === "true";
}

export interface BookingRouterDeps {
  service: BookingService;
  /** Verifies the caller. Must answer 401 when the caller is not authenticated. */
  authenticate: RequestHandler;
  /**
   * Returns the company id the caller is scoped to. Defaults to res.locals.companyId. Anything that is
   * not a UUID is treated as no scope (403).
   */
  getCompanyId?: (req: Request, res: Response) => unknown;
  /**
   * Role check, shaped like requireRole in server/middleware/auth.ts. Without it every request is refused
   * with 403 (deny by default). The mount always supplies it.
   */
  requireRole?: (...roles: string[]) => RequestHandler;
  /** Environment for the flag. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

const READ_ROLES = ["admin", "manager", "agent"];
const WRITE_ROLES = ["admin", "manager", "agent"];
const SETTINGS_ROLES = ["admin", "manager"];

const defaultGetCompanyId = (_req: Request, res: Response): unknown => res.locals.companyId;
/** Used when no requireRole is supplied: refuses every request after authentication (deny by default). */
const denyAll = (): RequestHandler => (_req, res) => {
  res.status(403).json({ error: "Role check not configured" });
};

/**
 * Builds the settings response. The stored Calendly token is removed from whatever the service returned, and
 * the response reports only whether one is set. Done here, not in the service, so a service that returns the
 * token still cannot send it over HTTP.
 */
function toSettingsResponse(settings: object): Record<string, unknown> {
  const { calendlyAccessToken, calendlyAccessTokenSet, ...rest } = settings as Record<string, unknown>;
  return { ...rest, hasCalendlyToken: Boolean(calendlyAccessToken) || calendlyAccessTokenSet === true };
}

/** Duck-typed rule error: a numeric status in 4xx and a message, as the bookings module throws. */
function ruleError(err: unknown): { status: number; message: string } | null {
  if (typeof err !== "object" || err === null) return null;
  const { status, message } = err as { status?: unknown; message?: unknown };
  if (typeof status !== "number" || status < 400 || status > 499) return null;
  if (typeof message !== "string") return null;
  return { status, message };
}

type ScopedHandler = (req: Request, res: Response, companyId: string) => Promise<void>;

export function createBookingRouter(deps: BookingRouterDeps): Router {
  const router = Router();

  if (!bookingRoutesEnabled(deps.env ?? process.env)) {
    router.use((_req, res) => {
      res.status(404).json({ error: "Not found" });
    });
    return router;
  }

  const { service, authenticate } = deps;
  const getCompanyId = deps.getCompanyId ?? defaultGetCompanyId;
  const roles: (...allowed: string[]) => RequestHandler = deps.requireRole ?? denyAll;
  const jsonBody = express.json({ limit: "16kb" });

  /**
   * Order: authenticate (401), company scope (403), role (403), JSON body, then the handler. The handler
   * runs only after all of those pass. Async rejections are caught here, since Express 4 does not forward them.
   */
  function guard(allowedRoles: string[], handler: ScopedHandler, withBody: boolean): RequestHandler[] {
    const scoped: RequestHandler = (req, res, next: NextFunction) => {
      const companyId = getCompanyId(req, res);
      if (!isCompanyId(companyId)) {
        res.status(403).json({ error: "Company scope required" });
        return;
      }
      handler(req, res, companyId).catch((err: unknown) => {
        const mapped = ruleError(err);
        if (mapped) {
          res.status(mapped.status).json({ error: mapped.message });
          return;
        }
        next(err);
      });
    };
    const chain: RequestHandler[] = [authenticate, roles(...allowedRoles)];
    if (withBody) chain.push(jsonBody);
    chain.push(scoped);
    return chain;
  }

  function parseId(req: Request): string | null {
    const parsed = bookingIdParam.safeParse(req.params.id);
    return parsed.success ? parsed.data : null;
  }

  const invalidId = (res: Response) => {
    res.status(400).json({ error: "Invalid id" });
  };
  const invalidInput = (res: Response, issues: unknown) => {
    res.status(400).json({ error: "Invalid input", issues });
  };

  router.get(
    "/bookings",
    ...guard(READ_ROLES, async (req, res, companyId) => {
      const parsed = listBookingsQuery.safeParse(req.query);
      if (!parsed.success) {
        invalidInput(res, parsed.error.issues);
        return;
      }
      const q = parsed.data;
      const query: BookingListQuery = {
        calendarId: q.calendar_id,
        status: q.status,
        from: q.from,
        to: q.to,
        limit: q.limit ?? 50,
        offset: q.offset ?? 0,
      };
      res.json({ data: await service.listBookings(companyId, query), limit: query.limit, offset: query.offset });
    }, false),
  );

  router.post(
    "/bookings",
    ...guard(WRITE_ROLES, async (req, res, companyId) => {
      const parsed = createBookingBody.safeParse(req.body);
      if (!parsed.success) {
        invalidInput(res, parsed.error.issues);
        return;
      }
      const input: NewBookingInput = parsed.data;
      res.status(201).json(await service.createBooking(companyId, input));
    }, true),
  );

  router.get(
    "/bookings/:id",
    ...guard(READ_ROLES, async (req, res, companyId) => {
      const id = parseId(req);
      if (!id) return invalidId(res);
      const booking = await service.getBooking(companyId, id);
      if (!booking) {
        res.status(404).json({ error: "Booking not found" });
        return;
      }
      res.json(booking);
    }, false),
  );

  router.patch(
    "/bookings/:id",
    ...guard(WRITE_ROLES, async (req, res, companyId) => {
      const id = parseId(req);
      if (!id) return invalidId(res);
      const parsed = updateBookingBody.safeParse(req.body);
      if (!parsed.success) {
        invalidInput(res, parsed.error.issues);
        return;
      }
      const patch: BookingUpdateInput = parsed.data;
      const updated = await service.updateBooking(companyId, id, patch);
      if (!updated) {
        res.status(404).json({ error: "Booking not found" });
        return;
      }
      res.json(updated);
    }, true),
  );

  router.post(
    "/bookings/:id/cancel",
    ...guard(WRITE_ROLES, async (req, res, companyId) => {
      const id = parseId(req);
      if (!id) return invalidId(res);
      const parsed = cancelBookingBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        invalidInput(res, parsed.error.issues);
        return;
      }
      const cancelled = await service.cancelBooking(companyId, id, parsed.data.reason ?? null);
      if (!cancelled) {
        res.status(404).json({ error: "Booking not found" });
        return;
      }
      res.json(cancelled);
    }, true),
  );

  router.get(
    "/booking-settings",
    ...guard(SETTINGS_ROLES, async (_req, res, companyId) => {
      res.json(toSettingsResponse(await service.getAssistantSettings(companyId)));
    }, false),
  );

  router.patch(
    "/booking-settings",
    ...guard(SETTINGS_ROLES, async (req, res, companyId) => {
      const parsed = updateAssistantSettingsBody.safeParse(req.body);
      if (!parsed.success) {
        invalidInput(res, parsed.error.issues);
        return;
      }
      res.json(toSettingsResponse(await service.updateAssistantSettings(companyId, parsed.data)));
    }, true),
  );

  return router;
}
