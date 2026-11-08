/**
 * DEPRECATED (2026-11-09): superseded by wiring/mount.ts (mountChatbotModule), which routes.ts calls.
 * Nothing in production imports this file or mountChatbotSlices. It is kept only because
 * tests/modules/chatbot-integration-mount.test.mjs still imports it. Do not add new callers.
 */
/**
 * Single place that mounts the chatbot slice routers. Each router has its own flag, and each flag is OFF by default.
 *
 * Rules:
 * - A router whose flag is off is not mounted at all. Its paths fall through to Express's default 404.
 * - A router whose flag is on, but whose dependency was not supplied, throws at mount time. It never falls back to
 *   the in-memory storage or service, because that would lose data in a live process.
 * - The mount builds the adapters itself: the bookings adapter (booking-routes), and the inbox-to-agent adapter
 *   (agent-routes). The caller supplies the slice services and storages, not the adapted shapes.
 * - The agent plan gate is passed through. With no hasHumanAgents, the agent router refuses every reply (403).
 *   The report says so, so the owner can see it.
 * - Nothing here changes the chatbot core routes (registerChatbotModule in ../index.ts).
 *
 * Flags (exact values, as each slice reads them):
 *   ENABLE_CHATBOT_BOOKING_ROUTES   "true"  booking-routes/router.ts
 *   ENABLE_CHATBOT_BUILDER_ROUTES   "true"  builder-routes/builder-router.ts
 *   DESK_CHATBOT_AGENT_ROUTES       "true"  agent-routes/flags.ts
 * The slices without an HTTP router (bookings, cart, customers, fulfilment, inbox, orders) are not mounted here.
 * Their own flags are listed in INTEGRATION.md.
 */
import type { Express, RequestHandler, Router } from "express";
import { BOOKING_ROUTES_FLAG, bookingRoutesEnabled, createBookingRouter } from "../booking-routes/router.ts";
import { createBookingRoutesService, type BookingsAdapterStorage } from "../booking-routes/bookings-adapter.ts";
import type { BookingService as SliceBookingService } from "../bookings/booking-service.ts";
import { BUILDER_ROUTES_FLAG, builderRoutesEnabled, createBuilderRouter } from "../builder-routes/builder-router.ts";
import type { BuilderStorage } from "../builder-routes/builder-storage.ts";
import { AGENT_ROUTES_FLAG, isAgentRoutesEnabled } from "../agent-routes/flags.ts";
import { createAgentRouter } from "../agent-routes/agent-router.ts";
import type { AuthenticateFn, HasHumanAgentsFn } from "../agent-routes/agent-handlers.ts";
import type { CustomerDelivery } from "../agent-routes/contracts.ts";
import { createInboxAgentServices, type AgentConversationStore } from "../agent-routes/drizzle-services.ts";
import type { InboxService } from "../inbox/index.ts";

export type EnvLike = Readonly<Record<string, string | undefined>>;

export interface ChatbotSliceMountOptions {
  app: Pick<Express, "use">;
  /** Base path for the chatbot API. Defaults to /api/chatbot, the same base as registerChatbotModule. */
  basePath?: string;
  /** Environment for the flags. Defaults to process.env. */
  env?: EnvLike;

  /** Real authentication (authenticateToken in server/middleware/auth.ts, or the hybrid one used by routes.ts). */
  authenticate: RequestHandler;
  /** Real role check (requireRole in server/middleware/auth.ts). Required: without it both routers refuse every request. */
  requireRole: (...roles: string[]) => RequestHandler;
  /** Sets res.locals.companyId from the verified user (requireCompanyScope in server/middleware/company-scope.ts). */
  requireCompanyScope: RequestHandler;

  /** Needed when ENABLE_CHATBOT_BOOKING_ROUTES is "true". The mount wraps these in the bookings adapter. */
  bookings?: {
    /** The bookings slice service, from createBookingService. */
    service: SliceBookingService;
    /** Drizzle or memory storage that the bookings slice service and the adapter both use. */
    storage: BookingsAdapterStorage;
  };
  /** Needed when ENABLE_CHATBOT_BUILDER_ROUTES is "true". */
  builder?: {
    storage: BuilderStorage;
    /**
     * Demo mode, from the caller (PHP: Helper::appIsNotDemo). Outside demo mode a save needs instructions.
     * Defaults to false, the stricter rule.
     */
    demoMode?: boolean;
  };
  /**
   * Needed when DESK_CHATBOT_AGENT_ROUTES is "true". The mount builds the inbox-to-agent adapter from the inbox
   * service and the agent store. The agent router resolves identity itself, so no express auth is put in front of it.
   */
  agent?: {
    /** The inbox slice service. It must be created with enabled: true, or every call answers 503. */
    inbox: Pick<InboxService, "query" | "handoffToHuman" | "handBackToAi" | "setTicketStatus">;
    /** Message store. createDrizzleAgentStore() in production. */
    store: AgentConversationStore;
    authenticate: AuthenticateFn;
    /**
     * Plan gate. Returns true only when the company's plan has human agents. Replies are refused unless it
     * returns exactly true. Leaving it out refuses every reply, and the report says so.
     */
    hasHumanAgents?: HasHumanAgentsFn;
    delivery?: CustomerDelivery;
    onError?: (err: unknown) => void;
    /** Mount point under basePath. Defaults to "/agent", so the routes are /api/chatbot/agent/inbox and so on. */
    mountPath?: string;
  };
}

export interface ChatbotSliceMountReport {
  /** Each slice that was mounted, with the path it was mounted at. */
  mounted: { slice: "booking-routes" | "builder-routes" | "agent-routes"; path: string }[];
  /** Each slice whose flag was off, so it was not mounted. */
  skipped: { slice: "booking-routes" | "builder-routes" | "agent-routes"; flag: string }[];
  /** True when the agent router was mounted with a plan gate. False means every agent reply is refused. Null when not mounted. */
  agentPlanGate: boolean | null;
}

const DEFAULT_BASE = "/api/chatbot";

export function mountChatbotSlices(options: ChatbotSliceMountOptions): ChatbotSliceMountReport {
  const env: EnvLike = options.env ?? process.env;
  const basePath = options.basePath ?? DEFAULT_BASE;
  const report: ChatbotSliceMountReport = { mounted: [], skipped: [], agentPlanGate: null };

  // Booking routes. The router checks the flag too, so a mount with the flag off would still answer 404.
  if (!bookingRoutesEnabled(env)) {
    report.skipped.push({ slice: "booking-routes", flag: BOOKING_ROUTES_FLAG });
  } else {
    if (!options.bookings) {
      throw new Error(`${BOOKING_ROUTES_FLAG} is "true" but no BookingService was supplied. Refusing to mount.`);
    }
    const service = createBookingRoutesService({
      service: options.bookings.service,
      storage: options.bookings.storage,
    });
    const router: Router = createBookingRouter({
      service,
      authenticate: options.authenticate,
      requireRole: options.requireRole,
      env,
    });
    options.app.use(basePath, options.authenticate, options.requireCompanyScope, router);
    report.mounted.push({ slice: "booking-routes", path: basePath });
  }

  // Builder routes. Off by default in the router too.
  if (!builderRoutesEnabled(env)) {
    report.skipped.push({ slice: "builder-routes", flag: BUILDER_ROUTES_FLAG });
  } else {
    if (!options.builder) {
      throw new Error(`${BUILDER_ROUTES_FLAG} is "true" but no BuilderStorage was supplied. Refusing to mount.`);
    }
    const router: Router = createBuilderRouter({
      storage: options.builder.storage,
      authenticate: options.authenticate,
      requireRole: options.requireRole,
      demoMode: options.builder.demoMode ?? false,
      env,
    });
    options.app.use(basePath, options.authenticate, options.requireCompanyScope, router);
    report.mounted.push({ slice: "builder-routes", path: basePath });
  }

  // Agent routes. The router resolves identity itself, so no express auth is put in front of it.
  if (!isAgentRoutesEnabled(env)) {
    report.skipped.push({ slice: "agent-routes", flag: AGENT_ROUTES_FLAG });
  } else {
    if (!options.agent) {
      throw new Error(`${AGENT_ROUTES_FLAG} is "true" but no agent inbox or store was supplied. Refusing to mount.`);
    }
    const services = createInboxAgentServices({ inbox: options.agent.inbox, store: options.agent.store });
    const mountPath = `${basePath}${options.agent.mountPath ?? "/agent"}`;
    const router: Router = createAgentRouter({
      inbox: services.inbox,
      conversations: services.conversations,
      authenticate: options.agent.authenticate,
      delivery: options.agent.delivery,
      hasHumanAgents: options.agent.hasHumanAgents,
      onError: options.agent.onError,
      enabled: true,
    });
    options.app.use(mountPath, router);
    report.mounted.push({ slice: "agent-routes", path: mountPath });
    report.agentPlanGate = typeof options.agent.hasHumanAgents === "function";
  }

  return report;
}
