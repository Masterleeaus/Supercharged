/**
 * Shared inbound plumbing for the channel webhook routers. Each channel router is a factory that takes injected
 * dependencies and returns an express.Router. Nothing here mounts anything on an app.
 *
 * Mount point (set by the wiring owner): /api/chatbot/channels/:companyId/<kind>, with mergeParams on the router.
 * The company id comes from the path and is checked as a UUID. A bad id answers 404 with no body.
 *
 * Body: signatures are computed over the exact bytes, which are read from req.rawBody (a Buffer). Each POST route
 * runs express.text (route-level), which also stores req.rawBody. A global JSON or urlencoded parser ahead of these
 * routes sets req.body to an object, so req.body is never used for verification.
 *
 * Answers: a rejected request answers 403 with no body. The reason is never sent back. A parsed request is handed to
 * onReceipt, and only then answered 200. A throw from onReceipt answers 500, so the platform retries the delivery.
 */
import express, { type Request, type Response } from "express";
import type { ChannelKind, RawWebhook } from "../contracts/index.ts";
import { isCompanyId } from "../../../infrastructure/database/tenant-context.ts";
import { receiveWebhook, answerChallenge, type ChannelRegistry, type WebhookReceipt } from "./framework.ts";
import type { ChannelCredentialSource } from "../contracts/index.ts";

export const WEBHOOK_BODY_LIMIT = "1mb";

export type AcceptedWebhook = Extract<WebhookReceipt, { ok: true }>;

export interface InboundLogger {
  warn(event: string, fields: Record<string, unknown>): void;
  error(event: string, fields: Record<string, unknown>): void;
}

/** One JSON line per event on the console. Fields are ids, counts and error names or codes only. */
export function consoleInboundLogger(): InboundLogger {
  const write = (level: string, event: string, fields: Record<string, unknown>) =>
    console.log(JSON.stringify({ level, event, ...fields }));
  return {
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

export interface InboundRouterDeps {
  registry: ChannelRegistry;
  credentials: ChannelCredentialSource;
  /** Stores the parsed events for the company. Called only after the signature check has passed. */
  onReceipt: (companyId: string, receipt: AcceptedWebhook) => Promise<void>;
  /** Optional. Defaults to consoleInboundLogger(). Only error names and codes are ever logged. */
  logger?: InboundLogger;
}

/** Error name and a string code, never the message: a storage or provider message can carry a secret. */
function errorFields(error: unknown): Record<string, unknown> {
  const name = error instanceof Error ? error.name : "NonError";
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length <= 64 ? { errorName: name, errorCode: code } : { errorName: name };
}

/**
 * Reads the request body as the exact received text, whatever the content type. The verify hook keeps the same bytes
 * on req.rawBody, so the pipeline has the Buffer even when this parser is the one that read the stream.
 */
export function webhookBodyParser() {
  return express.text({
    type: () => true,
    limit: WEBHOOK_BODY_LIMIT,
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  });
}

/**
 * The exact received bytes, from req.rawBody. Global parsers (JSON, urlencoded) and raw-body.ts all store this Buffer,
 * so it is present whatever parsed req.body. Returns null when no bytes were captured.
 */
export function rawBodyOf(req: Request): Buffer | null {
  const raw = (req as Request & { rawBody?: unknown }).rawBody;
  return Buffer.isBuffer(raw) ? raw : null;
}

/** Lower-cased header map. Repeated headers are joined with a comma. */
export function headersOf(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") out[name.toLowerCase()] = value;
    else if (Array.isArray(value) && value.length > 0) out[name.toLowerCase()] = value.join(", ");
  }
  return out;
}

/** The query as plain strings. Repeated keys keep their first value. */
export function queryOf(req: Request): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value) && typeof value[0] === "string") out[key] = value[0];
  }
  return out;
}

export function companyIdFrom(req: Request): string | null {
  const value = req.params.companyId;
  return isCompanyId(value) ? value : null;
}

/** Shared POST pipeline. pathAccountId, when given, must equal the account the payload names. */
export async function handleInboundPost(
  deps: InboundRouterDeps,
  kind: ChannelKind,
  req: Request,
  res: Response,
  options: { pathAccountId: string | null; extraHeaders?: Record<string, string>; success: () => void },
): Promise<void> {
  const companyId = companyIdFrom(req);
  if (!companyId) {
    res.status(404).end();
    return;
  }
  // Verify over the exact bytes (req.rawBody), never over req.body: a global JSON or urlencoded parser replaces req.body
  // with an object before these routes run.
  const bytes = rawBodyOf(req);
  if (bytes === null) {
    res.status(403).end();
    return;
  }
  const raw: RawWebhook = {
    headers: { ...headersOf(req), ...(options.extraHeaders ?? {}) },
    rawBody: bytes.toString("utf8"),
    receivedAt: new Date(),
  };
  const receipt = await receiveWebhook({ registry: deps.registry, credentials: deps.credentials }, companyId, kind, raw);
  if (!receipt.ok) {
    res.status(403).end();
    return;
  }
  if (options.pathAccountId !== null && receipt.accountId !== options.pathAccountId) {
    res.status(403).end();
    return;
  }
  try {
    await deps.onReceipt(companyId, receipt);
  } catch (error) {
    (deps.logger ?? consoleInboundLogger()).error("chatbot.channels.on_receipt_failed", {
      kind,
      companyId,
      ...errorFields(error),
    });
    res.status(500).end();
    return;
  }
  options.success();
}

/** Shared GET pipeline for platforms that verify the callback URL with a challenge. */
export async function handleChallengeGet(
  deps: InboundRouterDeps,
  kind: ChannelKind,
  req: Request,
  res: Response,
  accountId: string,
): Promise<void> {
  const companyId = companyIdFrom(req);
  if (!companyId) {
    res.status(404).end();
    return;
  }
  const answer = await answerChallenge({ registry: deps.registry, credentials: deps.credentials }, companyId, kind, accountId, queryOf(req));
  if (!answer) {
    res.status(403).end();
    return;
  }
  res.status(200).type(answer.contentType).send(answer.body);
}
