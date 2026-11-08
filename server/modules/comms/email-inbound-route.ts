// Inbound email webhook route. Factory only: nothing is mounted here.
//
// Company: fixed by configuration (deps.companyId). It is never read from the request body,
// query or params. To serve several companies, build one router per company.
//
// Per POST, in order:
//   1. Raw body. The signature covers the exact bytes sent. Those come from req.rawBody when an
//      earlier parser kept them (the app's express.json sets it through a verify hook), or from
//      this route's own raw parser otherwise. With no bytes available the route refuses (400).
//   2. Signature. deps.verifySignature must return true. Missing, false, a throw, or a non-true
//      value all get 401 with the same body. There is no default verifier and no bypass.
//   3. Parse. Invalid JSON or an unparseable message (missing Message-ID, sender or date) gets 400.
//   4. Dedupe. A Message-ID already stored for this company gets 200 and is not stored again.
//   5. Thread. The References and In-Reply-To ids are matched against stored threads. A match
//      appends the message to that thread. No match creates a new thread. Mail is never dropped.
//   6. Any unexpected failure gets 500 with a fixed body.
//
// Responses never say why a check failed. Errors carry no stack trace and no provider payload.

import {
  Router as ExpressRouter,
  type NextFunction as ExpressNext,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
  type RequestHandler as ExpressRequestHandler,
  type Router as ExpressRouterType,
} from 'express';
import express from 'express';
import {
  inboundReferenceIds,
  parseInboundEmail,
  type InboundEmail,
  type InboundEmailPayload,
} from './email-inbound.ts';
import { matchEmailThread, type ThreadForMatch } from './thread-match.ts';

export const EMAIL_INBOUND_DEFAULT_PATH = '/webhooks/email/inbound';
const DEFAULT_BODY_LIMIT = '1mb';

export interface EmailSignatureInput {
  headers: ExpressRequest['headers'];
  rawBody: Buffer;
}

export interface EmailInboundStore {
  /** Every thread for the company that may take a reply: all channels filtered to email. */
  listEmailThreads(companyId: string): Promise<ThreadForMatch[]>;
  /** True when this Message-ID is already stored for the company. */
  hasMessage(companyId: string, messageId: string): Promise<boolean>;
  /** Appends the message to an existing thread and adds its Message-ID to the thread's messageIds. */
  attachMessage(companyId: string, threadId: string, inbound: InboundEmail): Promise<void>;
  /** Creates a thread holding this message and returns its id. */
  createThread(companyId: string, inbound: InboundEmail): Promise<string>;
}

export interface EmailInboundRouteDeps {
  /** Company that owns this mailbox. Required and non-empty. Set by configuration only. */
  companyId: string;
  /**
   * Verifies the provider's signature over the raw body. Required: the factory throws without it.
   * Return true only when the signature is valid.
   */
  verifySignature: (input: EmailSignatureInput) => boolean | Promise<boolean>;
  store: EmailInboundStore;
  /** Route path. Defaults to EMAIL_INBOUND_DEFAULT_PATH. */
  path?: string;
  /** Raw body size limit. Defaults to 1mb. */
  bodyLimit?: string;
}

export interface EmailInboundRouteGuards {
  /** Mode guard for comms, e.g. requireModule(...). Required: there is no default. */
  modeGuard: ExpressRequestHandler;
}

export type EmailInboundRouteOutcome = 'created' | 'attached' | 'duplicate';

const OK_BODY = { ok: true } as const;

function adaptRoute(
  handler: (req: ExpressRequest, res: ExpressResponse) => Promise<void>,
): ExpressRequestHandler {
  return (req: ExpressRequest, res: ExpressResponse, _next: ExpressNext) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    });
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The exact bytes of the request. A Buffer in req.body means this route's raw parser ran. A
 * Buffer in req.rawBody means an earlier parser kept them. Anything else returns undefined.
 */
function rawBytes(req: ExpressRequest): Buffer | undefined {
  if (Buffer.isBuffer(req.body)) return req.body;
  const kept = (req as ExpressRequest & { rawBody?: unknown }).rawBody;
  return Buffer.isBuffer(kept) ? kept : undefined;
}

/**
 * Builds the inbound email router. Throws at construction when the company, the verifier, the
 * store or the mode guard is missing, so the route cannot be mounted without them.
 */
export function createEmailInboundRouter(
  deps: EmailInboundRouteDeps,
  guards: EmailInboundRouteGuards,
): ExpressRouterType {
  if (!deps || typeof deps !== 'object') throw new Error('email inbound: deps are required');
  if (typeof deps.companyId !== 'string' || deps.companyId.trim() === '') {
    throw new Error('email inbound: companyId is required');
  }
  if (typeof deps.verifySignature !== 'function') {
    throw new Error('email inbound: verifySignature is required');
  }
  const store = deps.store;
  if (
    !store ||
    typeof store.listEmailThreads !== 'function' ||
    typeof store.hasMessage !== 'function' ||
    typeof store.attachMessage !== 'function' ||
    typeof store.createThread !== 'function'
  ) {
    throw new Error('email inbound: store is incomplete');
  }
  if (!guards || typeof guards.modeGuard !== 'function') {
    throw new Error('email inbound: modeGuard is required; this router mounts under comms only');
  }

  const companyId = deps.companyId;
  const verifySignature = deps.verifySignature;
  const path = deps.path ?? EMAIL_INBOUND_DEFAULT_PATH;
  const bodyLimit = deps.bodyLimit ?? DEFAULT_BODY_LIMIT;

  const router = ExpressRouter();
  router.use(guards.modeGuard);

  router.post(
    path,
    express.raw({ type: () => true, limit: bodyLimit }),
    adaptRoute(async (req, res) => {
      const rawBody = rawBytes(req);
      if (!rawBody) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }

      let signed = false;
      try {
        signed = (await verifySignature({ headers: req.headers, rawBody })) === true;
      } catch {
        signed = false;
      }
      if (!signed) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!isPlainObject(payload)) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }

      const parsed = parseInboundEmail(payload as unknown as InboundEmailPayload, { companyId });
      if (!parsed.ok) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const inbound = parsed.inbound;

      const outcome = await storeInbound(store, companyId, inbound, payload as unknown as InboundEmailPayload);
      res.status(200).json({ ...OK_BODY, outcome });
    }),
  );

  return router;
}

/** Dedupe, match, and store. Exported for tests; the route is the only production caller. */
export async function storeInbound(
  store: EmailInboundStore,
  companyId: string,
  inbound: InboundEmail,
  payload: InboundEmailPayload,
): Promise<EmailInboundRouteOutcome> {
  if (await store.hasMessage(companyId, inbound.messageId)) return 'duplicate';

  const threads = await store.listEmailThreads(companyId);
  const match = matchEmailThread({
    companyId,
    inbound: { fromAddress: inbound.fromAddress, receivedAt: new Date(inbound.receivedAt) },
    referenceIds: inboundReferenceIds(payload),
    threads,
  });

  if (match.matched) {
    await store.attachMessage(companyId, match.threadId, inbound);
    return 'attached';
  }
  await store.createThread(companyId, inbound);
  return 'created';
}
