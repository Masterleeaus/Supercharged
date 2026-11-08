/**
 * Route logic for the public widget endpoints, kept free of Express so it runs under node:test.
 * The Express adapter (owner's step, after integration) maps these handlers onto routes and supplies the client IP.
 *
 * Endpoints (paths are set by the adapter; these are the logical names):
 *   GET     config    public config for one chatbot. Only WidgetPublicConfig fields.
 *   POST    session   issues a "chat" embed token for the request's Origin and the visitor id in the body.
 *   POST    message   sends one visitor message. Needs a valid embed token in the Authorization header.
 *   GET     check     answers whether the embed token in Authorization is valid. Returns expiry and scope only.
 *   GET     messages  replies after a cursor, for the polling fallback. Needs a valid embed token.
 *   GET     stream    opens the server-sent event stream of new replies. Needs a valid embed token.
 *   OPTIONS preflight CORS answer. Allows only trusted origins.
 *
 * Every endpoint returns 404 when CHATBOT_WIDGET_ENABLED is not exactly "true". Refusals use generic bodies,
 * so a caller cannot tell a missing chatbot from an untrusted origin.
 *
 * Rate limits run in two layers. The per-process limiter (limits) runs before any storage lookup, as before.
 * The shared limiter (shared) runs once the tenant is known, so its buckets are per company and shared by
 * every process that uses the same store.
 */
import { CONTRACT_FLAGS, readFlag as contractReadFlag } from "../contracts/index.ts";
import type {
  EmbedTokenClaims,
  EmbedTokenIssuer,
  EmbedTokenVerifier,
  FlagEnv,
  ReadFlag,
  WidgetPublicConfig,
} from "../contracts/index.ts";
import { toWidgetPublicConfig, isWidgetPublicId, type WidgetChatbotRecord } from "./config.ts";
import { EmbedTokenIssueError } from "./embed-token.ts";
import { isTrustedOrigin, normaliseOrigin } from "./origin.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { SharedRateLimiter } from "./rate-limit-store.ts";
import { readFeedCursor, type WidgetFeedMessage, type WidgetFeedScope, type WidgetMessageFeed } from "./stream.ts";

/** Lifetime of a session token. The widget asks for a new one when it expires. */
export const WIDGET_SESSION_TTL_SECONDS = 900;
export const WIDGET_MESSAGE_MAX_LENGTH = 2000;
export const WIDGET_FEED_PAGE_LIMIT = 50;
const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export interface WidgetChatbotReader {
  /** Resolves a public id to its chatbot config. Returns null when none exists. */
  findByPublicId(publicId: string): Promise<WidgetChatbotRecord | null>;
}

export interface WidgetMessageInput {
  companyId: string;
  chatbotPublicId: string;
  visitorId: string;
  text: string;
}

export interface WidgetMessagePort {
  /** Hands the visitor's message to the conversation runtime. Returns the assistant reply. */
  send(input: WidgetMessageInput): Promise<{ id: string; text: string }>;
}

export interface WidgetHandlerDeps {
  env: FlagEnv;
  readFlag?: ReadFlag;
  chatbots: WidgetChatbotReader;
  verifier: EmbedTokenVerifier;
  issuer: EmbedTokenIssuer;
  messages: WidgetMessagePort;
  /** Message feed for polling and the stream. Without it, both endpoints answer 404 and the widget keeps retrying its send only. */
  feed?: WidgetMessageFeed;
  /** Per-process limiters, run before any storage lookup. */
  limits: { config: RateLimiter; session: RateLimiter; message: RateLimiter; feed?: RateLimiter };
  /** Shared limiters, run after the tenant is known. Optional: without them only the per-process limits apply. */
  shared?: { config: SharedRateLimiter; session: SharedRateLimiter; message: SharedRateLimiter; feed: SharedRateLimiter };
  /** Base URL for widget assets. Comes from server configuration. */
  assetBaseUrl: string;
  now?: () => Date;
}

export interface WidgetRequest {
  params: { publicId?: string };
  headers: Readonly<Record<string, string | undefined>>;
  body?: unknown;
  /** Parsed query string. Only the "after" cursor is read. */
  query?: Readonly<Record<string, unknown>>;
  /** Client address as the adapter resolved it (see proxy.ts). Used only for rate limiting. */
  ip: string;
}

export interface WidgetResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  /** Set only on a stream open. The Express adapter subscribes with it and never sends it to the browser. */
  stream?: { scope: WidgetFeedScope };
}

export interface WidgetHandlers {
  enabled(): boolean;
  getConfig(req: WidgetRequest): Promise<WidgetResponse>;
  createSession(req: WidgetRequest): Promise<WidgetResponse>;
  sendMessage(req: WidgetRequest): Promise<WidgetResponse>;
  checkToken(req: WidgetRequest): Promise<WidgetResponse>;
  listMessages(req: WidgetRequest): Promise<WidgetResponse>;
  openStream(req: WidgetRequest): Promise<WidgetResponse>;
  /** Subscribes to new feed messages for a verified scope. Returns the unsubscribe function. */
  subscribe(scope: WidgetFeedScope, listener: (message: WidgetFeedMessage) => void): () => void;
  preflight(req: WidgetRequest): Promise<WidgetResponse>;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

function error(status: number, code: string, extra: Record<string, string> = {}): WidgetResponse {
  return { status, headers: { ...NO_STORE, ...extra }, body: { error: code } };
}

/** CORS headers for one request. Only a trusted origin is echoed back. Never "*". */
function corsFor(origin: string | undefined, allowed: readonly string[]): Record<string, string> {
  const normalised = normaliseOrigin(origin);
  if (normalised === null || !isTrustedOrigin(normalised, allowed)) return { Vary: "Origin" };
  return { "Access-Control-Allow-Origin": normalised, Vary: "Origin" };
}

function header(req: WidgetRequest, name: string): string | undefined {
  const value = req.headers[name] ?? req.headers[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

function readVisitorId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const v = (body as Record<string, unknown>).visitorId;
  return typeof v === "string" && VISITOR_ID_PATTERN.test(v) ? v : null;
}

function readText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = (body as Record<string, unknown>).text;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length === 0 || text.length > WIDGET_MESSAGE_MAX_LENGTH) return null;
  return text;
}

type Verified = { ok: true; claims: EmbedTokenClaims } | { ok: false; response: WidgetResponse };

export function createWidgetHandlers(deps: WidgetHandlerDeps): WidgetHandlers {
  const readFlagFn = deps.readFlag ?? contractReadFlag;
  const now = deps.now ?? (() => new Date());
  const enabled = (): boolean => readFlagFn(CONTRACT_FLAGS.WIDGET_ENABLED, deps.env);
  const NOT_FOUND = error(404, "not_found");
  const TOO_MANY = (retryAfter: number) => error(429, "rate_limited", { "Retry-After": String(retryAfter) });

  /** Looks up the chatbot for a public id. Returns null for a malformed or unknown id. */
  async function lookup(publicId: string | undefined): Promise<WidgetChatbotRecord | null> {
    if (!isWidgetPublicId(publicId)) return null;
    return deps.chatbots.findByPublicId(publicId);
  }

  /** Shared limit for one company. Returns a 429 response when refused, or null when the request may go on. */
  async function sharedGate(
    limiter: SharedRateLimiter | undefined,
    companyId: string,
    key: string,
  ): Promise<WidgetResponse | null> {
    if (!limiter) return null;
    const decision = await limiter.take(companyId, key);
    return decision.allowed ? null : TOO_MANY(decision.retryAfterSeconds);
  }

  /** Verifies the Bearer embed token for one chatbot, with the request's Origin, for the chat scope. */
  async function verifyBearer(req: WidgetRequest, publicId: string, cors: Record<string, string>): Promise<Verified> {
    const origin = header(req, "origin");
    const auth = header(req, "authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const verified = await deps.verifier.verify(token, origin ?? "", "chat", Math.floor(now().getTime() / 1000));
    if (!verified.ok) {
      const status = verified.reason === "origin_mismatch" || verified.reason === "scope_denied" ? 403 : 401;
      return { ok: false, response: error(status, "unauthorised", cors) };
    }
    if (verified.claims.chatbotPublicId !== publicId) return { ok: false, response: error(401, "unauthorised", cors) };
    return { ok: true, claims: verified.claims };
  }

  return {
    enabled,

    async getConfig(req) {
      if (!enabled()) return NOT_FOUND;
      const publicId = req.params.publicId;
      if (!isWidgetPublicId(publicId)) return NOT_FOUND;
      const decision = await deps.limits.config.take(`config:${req.ip}:${publicId}`);
      if (!decision.allowed) return TOO_MANY(decision.retryAfterSeconds);

      const record = await lookup(publicId);
      if (!record) return NOT_FOUND;
      const cors = corsFor(header(req, "origin"), record.allowedOrigins);
      if (!isTrustedOrigin(header(req, "origin"), record.allowedOrigins)) {
        return error(403, "origin_not_trusted", cors);
      }
      const limited = await sharedGate(deps.shared?.config, record.companyId, `config:${req.ip}:${publicId}`);
      if (limited) return limited;
      const body: WidgetPublicConfig = toWidgetPublicConfig(record, deps.assetBaseUrl);
      return { status: 200, headers: { ...cors, "Cache-Control": "private, max-age=60" }, body };
    },

    async createSession(req) {
      if (!enabled()) return NOT_FOUND;
      const publicId = req.params.publicId;
      if (!isWidgetPublicId(publicId)) return NOT_FOUND;
      const decision = await deps.limits.session.take(`session:${req.ip}:${publicId}`);
      if (!decision.allowed) return TOO_MANY(decision.retryAfterSeconds);

      const record = await lookup(publicId);
      if (!record) return NOT_FOUND;
      const origin = header(req, "origin");
      const cors = corsFor(origin, record.allowedOrigins);
      if (!isTrustedOrigin(origin, record.allowedOrigins)) return error(403, "origin_not_trusted", cors);
      const limited = await sharedGate(deps.shared?.session, record.companyId, `session:${req.ip}:${publicId}`);
      if (limited) return limited;
      const visitorId = readVisitorId(req.body);
      if (visitorId === null) return error(400, "invalid_visitor", cors);

      try {
        const token = await deps.issuer.issue(
          { companyId: record.companyId, chatbotPublicId: publicId, visitorId, origin: origin ?? "", scope: ["chat"] },
          WIDGET_SESSION_TTL_SECONDS,
        );
        const expiresAt = Math.floor(now().getTime() / 1000) + WIDGET_SESSION_TTL_SECONDS;
        return { status: 200, headers: { ...NO_STORE, ...cors }, body: { token, expiresAt, scope: ["chat"] } };
      } catch (err) {
        if (err instanceof EmbedTokenIssueError && err.code === "origin_not_trusted") return error(403, "origin_not_trusted", cors);
        return error(503, "unavailable", cors);
      }
    },

    async sendMessage(req) {
      if (!enabled()) return NOT_FOUND;
      const publicId = req.params.publicId;
      if (!isWidgetPublicId(publicId)) return NOT_FOUND;
      const decision = await deps.limits.message.take(`message:${req.ip}:${publicId}`);
      if (!decision.allowed) return TOO_MANY(decision.retryAfterSeconds);

      const origin = header(req, "origin");
      // An origin that is missing or not on the chatbot's trusted list is refused before the body is read.
      const verified = await verifyBearer(req, publicId, corsFor(origin, []));
      if (!verified.ok) return verified.response;
      const { claims } = verified;
      // The verifier has checked the origin against the trusted list, so the claim's origin is safe to echo.
      const cors = { "Access-Control-Allow-Origin": claims.origin, Vary: "Origin" };
      const limited = await sharedGate(deps.shared?.message, claims.companyId, `message:${req.ip}:${publicId}`);
      if (limited) return { ...limited, headers: { ...limited.headers, ...cors } };

      const text = readText(req.body);
      if (text === null) return error(400, "invalid_message", cors);

      try {
        const reply = await deps.messages.send({
          companyId: claims.companyId,
          chatbotPublicId: claims.chatbotPublicId,
          visitorId: claims.visitorId,
          text,
        });
        return { status: 200, headers: { ...NO_STORE, ...cors }, body: { message: { id: reply.id, role: "assistant", text: reply.text } } };
      } catch {
        return error(503, "unavailable", cors);
      }
    },

    async checkToken(req) {
      if (!enabled()) return NOT_FOUND;
      const publicId = req.params.publicId;
      if (!isWidgetPublicId(publicId)) return NOT_FOUND;
      const origin = header(req, "origin");
      const verified = await verifyBearer(req, publicId, corsFor(origin, []));
      if (!verified.ok) return error(401, "unauthorised", corsFor(origin, []));
      // Expiry and scope only. The claims (company, visitor) are not returned.
      return {
        status: 200,
        headers: { ...NO_STORE, "Access-Control-Allow-Origin": verified.claims.origin, Vary: "Origin" },
        body: { valid: true, expiresAt: verified.claims.expiresAt, scope: ["chat"] },
      };
    },

    async listMessages(req) {
      if (!enabled()) return NOT_FOUND;
      const publicId = req.params.publicId;
      if (!deps.feed || !isWidgetPublicId(publicId)) return NOT_FOUND;
      const origin = header(req, "origin");
      const verified = await verifyBearer(req, publicId, corsFor(origin, []));
      if (!verified.ok) return verified.response;
      const { claims } = verified;
      const cors = { "Access-Control-Allow-Origin": claims.origin, Vary: "Origin" };
      const limiter = deps.limits.feed ?? deps.limits.message;
      const decision = await limiter.take(`feed:${req.ip}:${publicId}`);
      if (!decision.allowed) return { ...TOO_MANY(decision.retryAfterSeconds), headers: { ...NO_STORE, ...cors, "Retry-After": String(decision.retryAfterSeconds) } };
      const limited = await sharedGate(deps.shared?.feed, claims.companyId, `feed:${req.ip}:${publicId}`);
      if (limited) return { ...limited, headers: { ...limited.headers, ...cors } };

      const cursor = readFeedCursor((req.query ?? {}).after);
      if (cursor === "invalid") return error(400, "invalid_cursor", cors);
      const scope: WidgetFeedScope = { companyId: claims.companyId, chatbotPublicId: claims.chatbotPublicId, visitorId: claims.visitorId };
      const messages = await deps.feed.listAfter(scope, cursor, WIDGET_FEED_PAGE_LIMIT);
      return { status: 200, headers: { ...NO_STORE, ...cors }, body: { messages } };
    },

    async openStream(req) {
      if (!enabled()) return NOT_FOUND;
      const publicId = req.params.publicId;
      if (!deps.feed || !isWidgetPublicId(publicId)) return NOT_FOUND;
      const origin = header(req, "origin");
      const verified = await verifyBearer(req, publicId, corsFor(origin, []));
      if (!verified.ok) return verified.response;
      const { claims } = verified;
      const cors = { "Access-Control-Allow-Origin": claims.origin, Vary: "Origin" };
      const limited = await sharedGate(deps.shared?.feed, claims.companyId, `stream:${req.ip}:${publicId}`);
      if (limited) return { ...limited, headers: { ...limited.headers, ...cors } };
      const scope: WidgetFeedScope = { companyId: claims.companyId, chatbotPublicId: claims.chatbotPublicId, visitorId: claims.visitorId };
      return {
        status: 200,
        headers: { ...NO_STORE, ...cors, "Content-Type": "text/event-stream" },
        stream: { scope },
      };
    },

    subscribe(scope, listener) {
      if (!deps.feed) return () => undefined;
      return deps.feed.subscribe(scope, listener);
    },

    async preflight(req) {
      if (!enabled()) return NOT_FOUND;
      const publicId = req.params.publicId;
      const record = await lookup(publicId);
      const origin = header(req, "origin");
      if (!record || !isTrustedOrigin(origin, record.allowedOrigins)) {
        return { status: 403, headers: { Vary: "Origin" } };
      }
      return {
        status: 204,
        headers: {
          ...corsFor(origin, record.allowedOrigins),
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "600",
        },
      };
    },
  };
}
