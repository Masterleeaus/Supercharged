/**
 * Express handler factories for the public widget. Thin: each handler builds a WidgetRequest (with the client
 * address from proxy.ts), calls the framework-free handler, and writes the result.
 *
 * Mounts nothing. The owner mounts these after integration, and decides the paths and the body parser for the
 * public routes. Types are structural, so this file does not import express.
 */
import type { WidgetHandlers, WidgetRequest, WidgetResponse } from "./handlers.ts";
import { resolveClientIp, type TrustedProxy } from "./proxy.ts";
import { formatSseMessage, SSE_HEARTBEAT, SSE_HEARTBEAT_MS, SSE_OPEN } from "./stream.ts";

export interface ExpressRequestLike {
  params: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  body?: unknown;
  socket?: { remoteAddress?: string | undefined };
}

export interface ExpressResponseLike {
  status(code: number): unknown;
  set(headers: Record<string, string>): unknown;
  json(body: unknown): unknown;
  end(): unknown;
  write(chunk: string): boolean;
  on(event: "close", listener: () => void): unknown;
}

export type ExpressWidgetHandler = (req: ExpressRequestLike, res: ExpressResponseLike) => Promise<void>;

export interface WidgetExpressOptions {
  handlers: WidgetHandlers;
  /** Parsed from WIDGET_TRUSTED_PROXIES (see parseTrustedProxies). Empty means no forwarded header is ever read. */
  trustedProxies: readonly TrustedProxy[];
  heartbeatMs?: number;
}

export interface WidgetExpressRoutes {
  config: ExpressWidgetHandler;
  session: ExpressWidgetHandler;
  message: ExpressWidgetHandler;
  check: ExpressWidgetHandler;
  messages: ExpressWidgetHandler;
  stream: ExpressWidgetHandler;
  preflight: ExpressWidgetHandler;
}

/** Copies headers into single values. A repeated header keeps its first value. */
function flatten(headers: ExpressRequestLike["headers"]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

export function toWidgetRequest(req: ExpressRequestLike, trustedProxies: readonly TrustedProxy[]): WidgetRequest {
  const ip = resolveClientIp({
    remoteAddress: req.socket?.remoteAddress,
    forwardedFor: req.headers["x-forwarded-for"],
    trustedProxies,
  });
  return {
    params: { publicId: req.params.publicId },
    headers: flatten(req.headers),
    body: req.body,
    query: req.query,
    // A peer with no readable address shares one bucket. That is a refusal path, not a bypass.
    ip: ip ?? "unknown",
  };
}

function send(res: ExpressResponseLike, result: WidgetResponse): void {
  res.status(result.status);
  res.set(result.headers);
  if (result.body === undefined) {
    res.end();
    return;
  }
  res.json(result.body);
}

export function createWidgetExpressHandlers(options: WidgetExpressOptions): WidgetExpressRoutes {
  const { handlers, trustedProxies } = options;
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;

  const wrap =
    (run: (request: WidgetRequest) => Promise<WidgetResponse>): ExpressWidgetHandler =>
    async (req, res) => {
      send(res, await run(toWidgetRequest(req, trustedProxies)));
    };

  return {
    config: wrap((r) => handlers.getConfig(r)),
    session: wrap((r) => handlers.createSession(r)),
    message: wrap((r) => handlers.sendMessage(r)),
    check: wrap((r) => handlers.checkToken(r)),
    messages: wrap((r) => handlers.listMessages(r)),
    preflight: wrap((r) => handlers.preflight(r)),

    async stream(req, res) {
      const result = await handlers.openStream(toWidgetRequest(req, trustedProxies));
      if (result.status !== 200 || !result.stream) {
        send(res, result);
        return;
      }
      const { stream, ...rest } = result;
      res.status(200);
      res.set({ ...rest.headers, "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(SSE_OPEN);

      const unsubscribe = handlers.subscribe(stream.scope, (message) => {
        try {
          res.write(formatSseMessage(message));
        } catch {
          // A closed socket is handled by the close listener.
        }
      });
      const timer = setInterval(() => {
        try {
          res.write(SSE_HEARTBEAT);
        } catch {
          // Ignored, see above.
        }
      }, heartbeatMs);
      let closed = false;
      res.on("close", () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        unsubscribe();
      });
    },
  };
}
