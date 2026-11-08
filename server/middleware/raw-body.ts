/**
 * Raw body capture for chatbot channel webhooks.
 *
 * Channel webhooks verify a provider signature over the exact bytes received, so the body must be
 * kept as a Buffer. This middleware acts only on the POST webhook paths that the wiring mount serves
 * (see CHATBOT_WEBHOOK_PATH below), with an optional trailing slash and the query string ignored.
 * Every other path calls next() without reading the body, so the global JSON and urlencoded parsers
 * behave exactly as before.
 *
 * For a matching request whose body is still unread, the stream is read into a Buffer (bounded by
 * WEBHOOK_RAW_BODY_LIMIT_BYTES) and stored on req.rawBody. The same bytes are then exposed as UTF-8
 * text on req.body and req._body is set, the way body-parser marks a parsed body. Without that, the
 * route-level express.text in each channel router would read the already-ended stream and fail. The
 * routers keep receiving the string they receive today. If an earlier parser already consumed the
 * body, the buffer that parser stored (req.rawBody, from the verify hook) is left as it is.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Webhook paths served by the channel routers after wiring/mount.ts mounts each kind at
 * /api/chatbot/channels/:companyId/<kind> (POST; GET challenges are not matched):
 *   whatsapp            /api/chatbot/channels/:companyId/whatsapp/webhook
 *   telegram            /api/chatbot/channels/:companyId/telegram/webhook/:accountId
 *   messenger           /api/chatbot/channels/:companyId/messenger/webhook/:accountId
 *   instagram           /api/chatbot/channels/:companyId/instagram/webhook/:accountId
 * The company segment is any single path segment here; the routers reject a non-UUID company id with 404.
 * Only these four kinds are matched, so an unknown kind or a path without the company segment passes through.
 */
export const CHATBOT_WEBHOOK_KINDS = ["telegram", "whatsapp", "messenger", "instagram"] as const;

// The "i" flag makes the fixed segments case-insensitive, as Express routing is by default.
// Company and account segments are "[^/]+", so their case is kept as received.
export const CHATBOT_WEBHOOK_PATH =
  /^\/api\/chatbot\/channels\/[^/]+\/(?:telegram|messenger|instagram)\/webhook\/[^/]+\/?$|^\/api\/chatbot\/channels\/[^/]+\/whatsapp\/webhook\/?$/i;

export const WEBHOOK_RAW_BODY_LIMIT_BYTES = 1024 * 1024;

/** True for the chatbot channel webhook path. Query strings are ignored. */
export function isChatbotWebhookPath(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split("?")[0] ?? "";
  return CHATBOT_WEBHOOK_PATH.test(path);
}

function tooLargeError(): Error & { status?: number; type?: string } {
  const err = new Error("request entity too large") as Error & { status?: number; type?: string };
  err.status = 413;
  err.type = "entity.too.large";
  return err;
}

export function captureChatbotWebhookRawBody(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "POST" || !isChatbotWebhookPath(req.originalUrl ?? req.url)) {
      return next();
    }

    // An earlier parser has already read the stream. Keep whatever it captured.
    // The global express.json (1 MB default limit) runs first, so enforce the webhook cap on that buffer here.
    const consumed = (req as Request & { _body?: boolean })._body === true || req.readableEnded === true;
    if (consumed) {
      const captured = (req as Request & { rawBody?: unknown }).rawBody;
      if (Buffer.isBuffer(captured) && captured.length > WEBHOOK_RAW_BODY_LIMIT_BYTES) {
        return next(tooLargeError());
      }
      return next();
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;

    const fail = (err: Error & { status?: number }) => {
      if (finished) return;
      finished = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.resume();
      next(err);
    };

    const onData = (chunk: Buffer | string) => {
      if (finished) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > WEBHOOK_RAW_BODY_LIMIT_BYTES) {
        fail(tooLargeError());
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      if (finished) return;
      finished = true;
      const raw = Buffer.concat(chunks, size);
      const target = req as Request & { rawBody?: unknown; body?: unknown; _body?: boolean };
      target.rawBody = raw;
      target.body = raw.toString("utf8");
      target._body = true;
      next();
    };

    const onError = (err: Error) => fail(err);

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.resume();
  };
}
