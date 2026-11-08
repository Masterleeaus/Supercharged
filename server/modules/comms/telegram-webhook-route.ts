// Telegram webhook route. Factory only: nothing is mounted here. The mode split mounts the
// returned router under comms mode.
//
// Per POST, in order:
//   1. Secret token. The X-Telegram-Bot-Api-Secret-Token header must match the configured secret.
//      Anything else (missing, wrong, or no secret configured) gets 401 with the same body.
//   2. Parse and allowlist. Updates that are unsupported, invalid, or from a chat not on the
//      allowlist get 200 with the same body. The response never says why an update was ignored.
//      An empty allowlist ignores every chat.
//   3. Dedupe. A repeated update_id gets 200 and is not handled again.
//   4. Handle. onMessage runs for the first delivery. A failure releases the update_id and
//      returns 500, so Telegram's retry is handled.
//
// The duplicate guard is in memory and per process (see telegram-update.ts). The company is
// not taken from the request: the caller's onMessage decides where the message goes.

import {
  Router as ExpressRouter,
  type NextFunction as ExpressNext,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
  type RequestHandler as ExpressRequestHandler,
  type Router as ExpressRouterType,
} from 'express';
import {
  TELEGRAM_SECRET_HEADER,
  createUpdateDeduplicator,
  parseTelegramUpdate,
  verifySecretToken,
  type ParsedTelegramMessage,
} from './telegram-update.ts';

export const TELEGRAM_WEBHOOK_DEFAULT_PATH = '/webhooks/telegram';

export interface TelegramWebhookRouteDeps {
  /** Secret set with setWebhook(secret_token). Required; the factory throws when it is empty. */
  secretToken: string;
  /** Chat ids allowed to reach the handler. Empty (or not an array) ignores every chat. */
  allowedChatIds: readonly (string | number)[];
  /** Receives each accepted, non-duplicate message. Keep it quick: Telegram waits for the reply. */
  onMessage: (message: ParsedTelegramMessage) => Promise<void> | void;
  /** Mode guard for comms, e.g. requireModule(...). Required: there is no default. */
  modeGuard: ExpressRequestHandler;
  /** Route path. Defaults to TELEGRAM_WEBHOOK_DEFAULT_PATH. */
  path?: string;
  /** Size of the duplicate guard. Defaults to 10,000 update ids. */
  dedupeMaxEntries?: number;
}

const OK_BODY = { ok: true } as const;

function adaptRoute(
  handler: (req: ExpressRequest, res: ExpressResponse) => Promise<void>,
): ExpressRequestHandler {
  return (req: ExpressRequest, res: ExpressResponse, _next: ExpressNext) => {
    // Any unexpected throw gets a fixed 500 body, not Express's default error page.
    handler(req, res).catch(() => {
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    });
  };
}

/**
 * Builds the Telegram webhook router. Throws at construction when the secret, the handler or
 * the mode guard is missing, so the route cannot be mounted without them.
 */
export function createTelegramWebhookRouter(deps: TelegramWebhookRouteDeps): ExpressRouterType {
  if (!deps || typeof deps !== 'object') throw new Error('telegram webhook: deps are required');
  if (typeof deps.secretToken !== 'string' || deps.secretToken.length === 0) {
    throw new Error('telegram webhook: secret token is required');
  }
  if (typeof deps.onMessage !== 'function') {
    throw new Error('telegram webhook: onMessage is required');
  }
  if (typeof deps.modeGuard !== 'function') {
    throw new Error('telegram webhook: modeGuard is required; this router mounts under comms only');
  }

  const path = deps.path ?? TELEGRAM_WEBHOOK_DEFAULT_PATH;
  // A non-array allowlist becomes an empty one, so a misconfiguration ignores every chat.
  const allowedChatIds = Array.isArray(deps.allowedChatIds) ? [...deps.allowedChatIds] : [];
  const dedupe = createUpdateDeduplicator(deps.dedupeMaxEntries);

  const router = ExpressRouter();
  router.use(deps.modeGuard);

  router.post(
    path,
    adaptRoute(async (req, res) => {
      const secret = verifySecretToken({
        header: req.headers[TELEGRAM_SECRET_HEADER],
        expected: deps.secretToken,
      });
      if (!secret.ok) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }

      const parsed = parseTelegramUpdate(req.body, { allowedChatIds });
      if ('ignored' in parsed) {
        res.status(200).json(OK_BODY);
        return;
      }

      if (!dedupe.accept(parsed.externalId)) {
        res.status(200).json(OK_BODY);
        return;
      }

      try {
        await deps.onMessage(parsed);
      } catch {
        dedupe.release(parsed.externalId);
        res.status(500).json({ error: 'internal_error' });
        return;
      }
      res.status(200).json(OK_BODY);
    }),
  );

  return router;
}
