/**
 * Composition root for the chatbot module's HTTP surfaces. One call builds every router from injected dependencies,
 * and the Express layer only mounts them. Nothing here changes the factories it calls, and nothing here touches the
 * core /api/chatbot routes (those stay in server/routes.ts).
 *
 * Rules:
 * - Each surface is OFF unless its flag is exactly "true" (readFlag). Off means nothing is mounted for it.
 * - A surface whose flag is on but whose required dependency was not supplied throws at mount time. It never falls
 *   back to in-memory storage, because that would lose data in a live process.
 * - Each router still checks its own legacy flag. This mount has already decided, so it passes a copy of env with
 *   that legacy flag set to "true". The new CHATBOT_* flag is therefore the only switch for these surfaces.
 * - Fail closed where a dependency is optional: no agent identity resolver means every agent call answers 401; no
 *   requireRole means the routers refuse every request. hasHumanAgents defaults to the active-agent rule in
 *   has-human-agents.ts (the company needs an active user with the agent role). Pass a function to override it.
 * - DEMO_MODE is read here (exactly "true") and reported on result.voiceCall for the voice-call service, which this
 *   mount does not construct.
 *
 * Surfaces and prefixes:
 *   CHATBOT_BUILDER_ENABLED    -> /api/chatbot/builder            builder-routes
 *   CHATBOT_AGENT_ENABLED      -> /api/chatbot/agent              agent-routes
 *   CHATBOT_BOOKINGS_ENABLED   -> /api/chatbot/bookings           booking-routes
 *   CHATBOT_CONTENT_ENABLED    -> /api/chatbot/content            content-admin
 *   CHATBOT_WIDGET_ENABLED     -> /api/public/chatbot/widget      widget (public, no authenticate)
 *   CHATBOT_CHANNELS_ENABLED   -> /api/chatbot/channels/:companyId/<kind>
 *                                                                 channel webhooks (raw-body parsing is per route)
 *
 * Channel webhook paths (POST). The company comes from the URL, because webhooks are unauthenticated:
 *   whatsapp            /api/chatbot/channels/:companyId/whatsapp/webhook
 *   telegram            /api/chatbot/channels/:companyId/telegram/webhook/:accountId
 *   messenger           /api/chatbot/channels/:companyId/messenger/webhook/:accountId
 *   instagram           /api/chatbot/channels/:companyId/instagram/webhook/:accountId
 * The company id is a path segment only. Each channel router reads it through mergeParams and checks it is a UUID
 * (a bad id answers 404). It is never read from the body.
 */
import { Router, type Express, type RequestHandler } from "express";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { readFlag, type FlagEnv } from "../contracts/flags.ts";
import type { SecretBox } from "../contracts/secrets.ts";

// Builder
import { BUILDER_ROUTES_FLAG, createBuilderRouter } from "../builder-routes/builder-router.ts";
import { DrizzleBuilderStorage } from "../builder-routes/builder-storage.ts";

// Bookings
import { BOOKING_ROUTES_FLAG, createBookingRouter } from "../booking-routes/router.ts";
import { createBookingRoutesService } from "../booking-routes/bookings-adapter.ts";
import { createBookingService } from "../bookings/booking-service.ts";
import { createDrizzleBookingStorage } from "../bookings/drizzle-booking-storage.ts";

// Agent
import { createAgentRouter } from "../agent-routes/agent-router.ts";
import { createInboxAgentServices, createDrizzleAgentStore } from "../agent-routes/drizzle-services.ts";
import type { AuthenticateFn, HasHumanAgentsFn } from "../agent-routes/agent-handlers.ts";
import { createInboxService } from "../inbox/inbox-service.ts";
import { createDrizzleInboxStorage } from "../inbox/drizzle-storage.ts";
import {
  createDrizzleActiveAgentLookup,
  createHasHumanAgents,
} from "./has-human-agents.ts";

// Content
import { CONTENT_ADMIN_ROUTES_FLAG, createContentAdminRouter } from "../content-admin/router.ts";
import { createDrizzleContentAdminStorage } from "../content-admin/drizzle-storage.ts";

// Widget
import { createWidgetHandlers, type WidgetMessagePort } from "../widget/handlers.ts";
import { createWidgetExpressHandlers } from "../widget/express.ts";
import { createFixedWindowLimiter, type RateLimitPolicy } from "../widget/rate-limit.ts";
import {
  createDrizzleRateLimitStore,
  createSharedRateLimiter,
  type SharedRateLimitPolicy,
} from "../widget/rate-limit-store.ts";
import { createEmbedTokenIssuer, createEmbedTokenVerifier } from "../widget/embed-token.ts";
import { DrizzleWidgetStorage } from "../widget/storage.ts";
import { parseTrustedProxies } from "../widget/proxy.ts";

// Channels
import { createChannelRegistry, type ChannelRegistry } from "../channels/framework.ts";
import { createChannelCredentialSource } from "../channels/credentials.ts";
import { createDrizzleChannelAccountStorage } from "../channels/drizzle-storage.ts";
import { consoleInboundLogger, type InboundLogger, type InboundRouterDeps } from "../channels/inbound-router.ts";
import { createTelegramWebhookRouter } from "../channels/telegram/router.ts";
import { createWhatsappWebhookRouter } from "../channels/whatsapp/router.ts";
import { createMessengerWebhookRouter } from "../channels/messenger/router.ts";
import { createInstagramWebhookRouter } from "../channels/instagram/router.ts";

/** Flags owned by this mount. Read here, not in the factories. */
export const WIRING_FLAGS = {
  BUILDER: "CHATBOT_BUILDER_ENABLED",
  AGENT: "CHATBOT_AGENT_ENABLED",
  BOOKINGS: "CHATBOT_BOOKINGS_ENABLED",
  CONTENT: "CHATBOT_CONTENT_ENABLED",
  WIDGET: "CHATBOT_WIDGET_ENABLED",
  CHANNELS: "CHATBOT_CHANNELS_ENABLED",
} as const;

export const WIRING_PREFIXES = {
  builder: "/api/chatbot/builder",
  agent: "/api/chatbot/agent",
  bookings: "/api/chatbot/bookings",
  content: "/api/chatbot/content",
  widget: "/api/public/chatbot/widget",
  channels: "/api/chatbot/channels",
} as const;

export type ChannelRouterKind = "telegram" | "whatsapp" | "messenger" | "instagram";

/** Path segment that carries the company id for channel webhooks. Read by the routers as req.params.companyId. */
export const CHANNEL_COMPANY_SEGMENT = ":companyId";

/** Widget limits per endpoint: a fixed window of 60 seconds. Chosen here, not by the widget handlers. */
export const WIDGET_RATE_POLICIES: Readonly<Record<"config" | "session" | "message" | "feed", RateLimitPolicy & SharedRateLimitPolicy>> = {
  config: { limit: 120, windowMs: 60_000 },
  session: { limit: 30, windowMs: 60_000 },
  message: { limit: 20, windowMs: 60_000 },
  feed: { limit: 120, windowMs: 60_000 },
};

/** Structural type of the Desk db handle. Storage factories accept it through their own db types. */
export type ChatbotWiringDb = NodePgDatabase<any>;

export interface ChatbotWiringDeps {
  /** Desk database handle (db in server/db.ts). Every storage is bound to it. */
  db: ChatbotWiringDb;
  /** Environment for every flag. Pass process.env in production. */
  env: Record<string, string | undefined>;
  /** Verifies the caller for the authenticated surfaces (builder, bookings, content). Answers 401 when unauthenticated. */
  authenticate: RequestHandler;
  /** Sets res.locals.companyId from the verified user (requireCompanyScope middleware). */
  requireCompanyScope: RequestHandler;
  /** Role check, shaped like requireRole in server/middleware/auth.ts. Optional: without it the routers refuse every request. */
  requireRole?: (...roles: string[]) => RequestHandler;
  /**
   * Resolves the staff caller for the agent surface. The agent router does its own identity check, so this is not
   * express middleware. Optional: without it every agent call answers 401.
   */
  agentAuthenticate?: AuthenticateFn;
  /**
   * Plan gate for staff replies. Optional: when omitted, the active-agent rule (createHasHumanAgents over the Desk db)
   * is used. Must return exactly true to allow.
   */
  hasHumanAgents?: HasHumanAgentsFn;
  /** Daily demo seconds cap for voice calls. Only read when DEMO_MODE is "true". Reported on result.voiceCall. */
  demoSecondsLimit?: number;
  /**
   * The single chatbot SecretBox (contracts/secrets.ts). Required when CHATBOT_BOOKINGS_ENABLED, CHATBOT_WIDGET_ENABLED
   * or CHATBOT_CHANNELS_ENABLED is "true". Built by the caller from the secrets module.
   */
  secretBox?: SecretBox;
  /** Required when CHATBOT_WIDGET_ENABLED is "true". */
  widget?: {
    /** Hands a visitor message to the conversation runtime and returns the reply. */
    messages: WidgetMessagePort;
    /** Base URL for widget assets. Comes from server configuration. */
    assetBaseUrl: string;
  };
  /** Required when CHATBOT_CHANNELS_ENABLED is "true". */
  channels?: {
    /** Stores parsed webhook events. Called only after the signature check passes. */
    onReceipt: InboundRouterDeps["onReceipt"];
    /** Channel providers. Defaults to an empty registry, which rejects every webhook. */
    registry?: ChannelRegistry;
    /** Logs the empty-registry warning at mount time and onReceipt failures. Defaults to a JSON console logger. */
    logger?: InboundLogger;
  };
  /** Outbound HTTP for channel providers. Reserved: providers are built by the caller for now. */
  fetch?: typeof fetch;
  /** Clock for timestamps and rate-limit windows. Defaults to the system clock. */
  clock?: () => Date;
}

export interface ChatbotWiringResult {
  /** Each prefix that was mounted, in mount order. Empty when every flag is off. */
  mounted: string[];
  /** The routers that were built. Keys are set only for surfaces that were mounted. */
  routers: {
    builder?: Router;
    agent?: Router;
    bookings?: Router;
    content?: Router;
    widget?: Router;
    channels?: Partial<Record<ChannelRouterKind, Router>>;
  };
  /**
   * Options for the voice-call service (voice-call/service.ts). Always present, because DEMO_MODE is an env value
   * and not a surface flag. The caller that builds the service passes these through.
   */
  voiceCall: {
    demoMode: boolean;
    demoSecondsLimit?: number;
  };
}

/**
 * The plan gate for staff replies: the injected override when one is supplied, otherwise the active-agent rule over
 * the Desk db. Lookup errors are reported through onError (event name only) and fail closed.
 */
export function resolveHasHumanAgents(deps: Pick<ChatbotWiringDeps, "db" | "hasHumanAgents">): HasHumanAgentsFn {
  if (deps.hasHumanAgents) return deps.hasHumanAgents;
  return createHasHumanAgents({
    lookup: createDrizzleActiveAgentLookup(deps.db),
    onError: () => {
      console.error("chatbot.agent.has_human_agents_lookup_failed");
    },
  });
}

/** Passed to every router that still reads its own legacy flag: this mount has already decided, so that flag is set. */
function withLegacyFlag(env: FlagEnv, legacyFlag: string): FlagEnv {
  return { ...env, [legacyFlag]: "true" };
}

const denyAgentIdentity: AuthenticateFn = () => null;

function requireDep<T>(value: T | undefined, flag: string, name: string): T {
  if (value === undefined || value === null) {
    throw new Error(`${flag} is "true" but no ${name} was supplied. Refusing to mount.`);
  }
  return value;
}

export function mountChatbotModule(app: Pick<Express, "use">, deps: ChatbotWiringDeps): ChatbotWiringResult {
  const env: FlagEnv = deps.env;
  const clock = deps.clock ?? (() => new Date());
  const nowMs = () => clock().getTime();
  const result: ChatbotWiringResult = {
    mounted: [],
    routers: {},
    voiceCall: { demoMode: env.DEMO_MODE === "true", demoSecondsLimit: deps.demoSecondsLimit },
  };

  const mountAt = (prefix: string, handlers: RequestHandler[]): void => {
    app.use(prefix, ...(handlers as Parameters<Express["use"]>[1][]));
    result.mounted.push(prefix);
  };

  // Builder: authenticated, company-scoped, role-checked inside the router.
  if (readFlag(WIRING_FLAGS.BUILDER, env)) {
    const router = createBuilderRouter({
      storage: new DrizzleBuilderStorage(deps.db),
      authenticate: deps.authenticate,
      requireRole: deps.requireRole,
      now: clock,
      env: withLegacyFlag(env, BUILDER_ROUTES_FLAG),
      demoMode: false,
    });
    result.routers.builder = router;
    mountAt(WIRING_PREFIXES.builder, [deps.authenticate, deps.requireCompanyScope, router]);
  }

  // Agent: the router resolves identity itself, so no express auth is put in front of it.
  if (readFlag(WIRING_FLAGS.AGENT, env)) {
    const inbox = createInboxService({ storage: createDrizzleInboxStorage(deps.db), enabled: true, now: clock });
    const services = createInboxAgentServices({ inbox, store: createDrizzleAgentStore(deps.db) });
    const router = createAgentRouter({
      inbox: services.inbox,
      conversations: services.conversations,
      authenticate: deps.agentAuthenticate ?? denyAgentIdentity,
      hasHumanAgents: resolveHasHumanAgents(deps),
      enabled: true,
    });
    result.routers.agent = router;
    mountAt(WIRING_PREFIXES.agent, [router]);
  }

  // Bookings: needs the chatbot SecretBox for stored calendar credentials.
  if (readFlag(WIRING_FLAGS.BOOKINGS, env)) {
    const secretBox = requireDep(deps.secretBox, WIRING_FLAGS.BOOKINGS, "secretBox");
    const storage = createDrizzleBookingStorage({ db: deps.db, secretBox, now: clock });
    const service = createBookingService({ storage, now: clock, enabled: true });
    const router = createBookingRouter({
      service: createBookingRoutesService({ service, storage }),
      authenticate: deps.authenticate,
      requireRole: deps.requireRole,
      env: withLegacyFlag(env, BOOKING_ROUTES_FLAG),
    });
    result.routers.bookings = router;
    mountAt(WIRING_PREFIXES.bookings, [deps.authenticate, deps.requireCompanyScope, router]);
  }

  // Content admin: authenticated and role-checked inside the router. Contacts and analytics are not wired here,
  // so those two endpoints answer 501 (the router's own behaviour when the port is absent).
  if (readFlag(WIRING_FLAGS.CONTENT, env)) {
    const router = createContentAdminRouter({
      storage: createDrizzleContentAdminStorage(deps.db),
      authenticate: deps.authenticate,
      requireRole: deps.requireRole,
      now: clock,
      env: withLegacyFlag(env, CONTENT_ADMIN_ROUTES_FLAG),
    });
    result.routers.content = router;
    mountAt(WIRING_PREFIXES.content, [deps.authenticate, deps.requireCompanyScope, router]);
  }

  // Widget: public. No authenticate. Visitors are identified by the embed token the widget verifies.
  if (readFlag(WIRING_FLAGS.WIDGET, env)) {
    const secretBox = requireDep(deps.secretBox, WIRING_FLAGS.WIDGET, "secretBox");
    const widget = requireDep(deps.widget, WIRING_FLAGS.WIDGET, "widget messages port");
    const storage = new DrizzleWidgetStorage(deps.db, secretBox);
    const sharedStore = createDrizzleRateLimitStore(deps.db);
    const handlers = createWidgetHandlers({
      env: env as FlagEnv,
      chatbots: storage,
      verifier: createEmbedTokenVerifier({ keys: storage, trust: storage }),
      issuer: createEmbedTokenIssuer({ keys: storage, trust: storage }, clock),
      messages: widget.messages,
      limits: {
        config: createFixedWindowLimiter(WIDGET_RATE_POLICIES.config, nowMs),
        session: createFixedWindowLimiter(WIDGET_RATE_POLICIES.session, nowMs),
        message: createFixedWindowLimiter(WIDGET_RATE_POLICIES.message, nowMs),
        feed: createFixedWindowLimiter(WIDGET_RATE_POLICIES.feed, nowMs),
      },
      shared: {
        config: createSharedRateLimiter(sharedStore, WIDGET_RATE_POLICIES.config, nowMs),
        session: createSharedRateLimiter(sharedStore, WIDGET_RATE_POLICIES.session, nowMs),
        message: createSharedRateLimiter(sharedStore, WIDGET_RATE_POLICIES.message, nowMs),
        feed: createSharedRateLimiter(sharedStore, WIDGET_RATE_POLICIES.feed, nowMs),
      },
      assetBaseUrl: widget.assetBaseUrl,
      now: clock,
    });
    const routes = createWidgetExpressHandlers({
      handlers,
      trustedProxies: parseTrustedProxies(env.WIDGET_TRUSTED_PROXIES).proxies,
    });
    const router = Router();
    router.get("/:publicId/config", routes.config);
    router.post("/:publicId/session", routes.session);
    router.post("/:publicId/message", routes.message);
    router.get("/:publicId/check", routes.check);
    router.get("/:publicId/messages", routes.messages);
    router.get("/:publicId/stream", routes.stream);
    router.options("/:publicId/:action", routes.preflight);
    result.routers.widget = router;
    mountAt(WIRING_PREFIXES.widget, [router]);
  }

  // Channel webhooks: each kind's existing router, under /api/chatbot/channels/:companyId/<kind>. The routers use
  // mergeParams, so req.params.companyId reaches companyIdFrom. Raw-body parsing is route-level inside each router
  // (webhookBodyParser). Do not add a global JSON parser here.
  if (readFlag(WIRING_FLAGS.CHANNELS, env)) {
    const secretBox = requireDep(deps.secretBox, WIRING_FLAGS.CHANNELS, "secretBox");
    const channels = requireDep(deps.channels, WIRING_FLAGS.CHANNELS, "channels onReceipt");
    const logger = channels.logger ?? consoleInboundLogger();
    const registry = channels.registry ?? createChannelRegistry();
    if (registry.kinds().length === 0) {
      // Every webhook answers 403 until a provider is registered. Logged once here, not per request.
      logger.warn("chatbot.channels.registry_empty", { flag: WIRING_FLAGS.CHANNELS });
    }
    const inbound: InboundRouterDeps = {
      registry,
      credentials: createChannelCredentialSource({
        storage: createDrizzleChannelAccountStorage(deps.db, clock),
        secretBox,
      }),
      onReceipt: channels.onReceipt,
      logger,
    };
    const built: Record<ChannelRouterKind, Router> = {
      telegram: createTelegramWebhookRouter(inbound),
      whatsapp: createWhatsappWebhookRouter({ ...inbound, env: env as FlagEnv }),
      messenger: createMessengerWebhookRouter(inbound),
      instagram: createInstagramWebhookRouter(inbound),
    };
    result.routers.channels = built;
    for (const kind of Object.keys(built) as ChannelRouterKind[]) {
      mountAt(`${WIRING_PREFIXES.channels}/${CHANNEL_COMPANY_SEGMENT}/${kind}`, [built[kind]]);
    }
  }

  return result;
}
