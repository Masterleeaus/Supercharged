/*
 * Express handler factory for the realtime stream. Not mounted here: the integration pass adds the route.
 *
 * The auth context comes only from resolveAuth(req), the injected function that reads the verified session.
 * This handler never reads req.url, req.query or req.params, so a query string cannot pick a company or a staff id.
 */
import { randomUUID } from "node:crypto";
import { isCompanyId } from "../../../infrastructure/database/tenant-context.ts";
import type { SseHub, SseSubscriber } from "./hub.ts";
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_RETRY_MS,
  MAX_SCOPE_ID_LENGTH,
  SYSTEM_SCHEDULER,
  formatSseFrame,
  type RealtimeAuth,
  type RealtimeRequest,
  type RealtimeResponse,
  type Scheduler,
  type SubscriberScope,
} from "./types.ts";

export interface SseStreamHandlerOptions {
  hub: SseHub;
  /** Reads the verified session and returns who is connecting, or null to refuse. Never reads the URL. */
  resolveAuth: (req: RealtimeRequest) => RealtimeAuth | null | Promise<RealtimeAuth | null>;
  heartbeatMs?: number;
  scheduler?: Scheduler;
  maxBufferedBytes?: number;
  newId?: () => string;
}

export type SseStreamHandler = (req: RealtimeRequest, res: RealtimeResponse) => Promise<void>;

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SCOPE_ID_LENGTH;
}

function validAuth(auth: unknown): auth is RealtimeAuth {
  if (!auth || typeof auth !== "object") return false;
  const candidate = auth as Partial<RealtimeAuth> & Record<string, unknown>;
  if (!isCompanyId(candidate.companyId)) return false;
  if (candidate.kind === "staff") return validIdentifier(candidate.staffId);
  if (candidate.kind === "customer") {
    return validIdentifier(candidate.conversationId) && (candidate.customerId === null || validIdentifier(candidate.customerId));
  }
  return false;
}

function scopeOf(auth: RealtimeAuth): SubscriberScope {
  if (auth.kind === "staff") return { kind: "staff", staffId: auth.staffId };
  return { kind: "customer", conversationId: auth.conversationId, customerId: auth.customerId };
}

function refuse(res: RealtimeResponse): void {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "unauthorized" }));
}

export function createSseStreamHandler(options: SseStreamHandlerOptions): SseStreamHandler {
  const { hub, resolveAuth } = options;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const scheduler = options.scheduler ?? SYSTEM_SCHEDULER;
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const newId = options.newId ?? (() => randomUUID());

  if (!Number.isInteger(heartbeatMs) || heartbeatMs <= 0) {
    throw new RangeError("heartbeatMs must be a positive integer");
  }

  return async function handleSseStream(req, res) {
    let auth: RealtimeAuth | null = null;
    try {
      auth = await resolveAuth(req);
    } catch {
      auth = null;
    }
    if (res.destroyed || res.writableEnded) return;
    if (!validAuth(auth)) {
      refuse(res);
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let heartbeat: unknown = null;
    let release: () => void = () => {};

    const subscriber: SseSubscriber = {
      id: newId(),
      companyId: auth.companyId,
      scope: scopeOf(auth),
      write(chunk) {
        if (res.destroyed || res.writableEnded) return false;
        if (res.writableLength > maxBufferedBytes) return false;
        res.write(chunk);
        return true;
      },
      end() {
        if (heartbeat !== null) {
          scheduler.clearInterval(heartbeat);
          heartbeat = null;
        }
        if (!res.writableEnded && !res.destroyed) res.end();
      },
    };

    release = hub.register(subscriber);
    // Only the response's close event is used. Request close can fire early on a GET in newer Node versions.
    res.on("close", () => release());

    heartbeat = scheduler.setInterval(() => {
      if (!subscriber.write(": heartbeat\n\n")) release();
    }, heartbeatMs);

    if (!subscriber.write(`retry: ${DEFAULT_RETRY_MS}\n\n` + formatSseFrame("ready", { kind: auth.kind }))) {
      release();
      return;
    }
    if (res.destroyed) release();
  };
}
