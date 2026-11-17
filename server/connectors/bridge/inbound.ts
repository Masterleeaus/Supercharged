/**
 * Inbound bridge handler (#359). Zapier, Make or n8n posts a signed request; this module decides
 * whether it may run and, if so, runs one connector action.
 *
 * Checks, in order. The first failure decides the response:
 *   1. bridge exists (unknown and bad-signature cases share one 401 so ids cannot be probed)
 *   2. HMAC signature and timestamp window (signing.ts)
 *   3. the same signature is not replayed inside the window
 *   4. per-bridge rate limit (fixed one-minute window)
 *   5. body is JSON, names no company (the bridge's own company is the only scope), and the
 *      action is on the bridge's allowlist
 *   6. the connector is registered and enabled for the bridge's company (fails closed)
 * Then the shared runner runs the action with the company's credentials and writes one audit record.
 *
 * Pure apart from the injected ports.
 */
import type { ConnectorCredentials } from '../sdk/contract.ts';
import { ConnectorError } from '../sdk/contract.ts';
import { runAction } from '../sdk/runner.ts';
import type { AuditSink } from '../sdk/audit.ts';
import type { ConnectorRegistry } from '../registry.ts';
import { verifyDelivery, DEFAULT_TOLERANCE_SECONDS } from './signing.ts';

export interface BridgeConfig {
  bridgeId: string;
  companyId: string;
  connectorId: string;
  /** The only actions this bridge may call. Anything else is refused before the connector runs. */
  allowedActions: string[];
  secret: string;
}

export interface BridgeRequest {
  bridgeId: string;
  rawBody: string;
  timestampHeader: string;
  signatureHeader: string;
}

export interface BridgeResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface BridgeHandlerDeps {
  loadBridge(bridgeId: string): Promise<BridgeConfig | null>;
  registry: ConnectorRegistry;
  resolveCredentials(companyId: string, connectorId: string): Promise<ConnectorCredentials>;
  audit: AuditSink;
  /** Current time in unix seconds. */
  nowSeconds(): number;
  now?: () => Date;
  maxPerMinute?: number;
  toleranceSeconds?: number;
  timeoutMs?: number;
}

const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_TOP_KEYS = new Set(['action', 'input', 'requestId']);
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

const deny = (status: number, error: string): BridgeResponse => ({ status, body: { ok: false, error } });

export function createBridgeHandler(deps: BridgeHandlerDeps) {
  const maxPerMinute = deps.maxPerMinute ?? 60;
  const tolerance = deps.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!Number.isInteger(maxPerMinute) || maxPerMinute < 1) throw new RangeError('maxPerMinute must be a positive integer');

  const seenSignatures = new Map<string, number>();
  const windows = new Map<string, { start: number; count: number }>();

  function pruneSeen(nowSeconds: number) {
    for (const [sig, expires] of seenSignatures) if (expires < nowSeconds) seenSignatures.delete(sig);
  }

  function withinRateLimit(bridgeId: string, nowSeconds: number): boolean {
    const start = Math.floor(nowSeconds / 60) * 60;
    const win = windows.get(bridgeId);
    if (!win || win.start !== start) {
      windows.set(bridgeId, { start, count: 1 });
      return true;
    }
    if (win.count >= maxPerMinute) return false;
    win.count += 1;
    return true;
  }

  async function handle(req: BridgeRequest): Promise<BridgeResponse> {
    if (Buffer.byteLength(req.rawBody, 'utf8') > MAX_BODY_BYTES) return deny(413, 'payload_too_large');

    const bridge = await deps.loadBridge(req.bridgeId);
    const nowSeconds = deps.nowSeconds();
    if (!bridge) return deny(401, 'unauthorized');

    const verified = verifyDelivery({
      secret: bridge.secret,
      rawBody: req.rawBody,
      timestampHeader: req.timestampHeader,
      signatureHeader: req.signatureHeader,
      nowSeconds,
      toleranceSeconds: tolerance,
    });
    if (!verified.ok) return deny(401, 'unauthorized');

    pruneSeen(nowSeconds);
    if (seenSignatures.has(req.signatureHeader)) return deny(401, 'unauthorized');
    seenSignatures.set(req.signatureHeader, nowSeconds + tolerance);

    if (!withinRateLimit(bridge.bridgeId, nowSeconds)) return deny(429, 'rate_limited');

    let parsed: unknown;
    try {
      parsed = JSON.parse(req.rawBody);
    } catch {
      return deny(400, 'invalid_json');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return deny(400, 'invalid_body');
    const body = parsed as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      if (!ALLOWED_TOP_KEYS.has(key)) return deny(400, key === 'companyId' ? 'company_scope_not_allowed' : 'unknown_field');
    }
    const action = body.action;
    if (typeof action !== 'string' || action.length === 0) return deny(400, 'action_required');
    if (!bridge.allowedActions.includes(action)) return deny(403, 'action_not_allowed');

    const requestId = body.requestId;
    if (requestId !== undefined && (typeof requestId !== 'string' || !REQUEST_ID.test(requestId))) {
      return deny(400, 'invalid_request_id');
    }

    let registered;
    try {
      registered = await deps.registry.forCompany(bridge.companyId, bridge.connectorId);
    } catch {
      return deny(403, 'connector_unavailable');
    }

    const spec = registered.definition.actions[action];
    if (spec?.kind === 'write' && requestId === undefined) return deny(400, 'request_id_required');

    let credentials: ConnectorCredentials;
    try {
      credentials = await deps.resolveCredentials(bridge.companyId, bridge.connectorId);
    } catch {
      return deny(502, 'credentials_unavailable');
    }

    try {
      const result = await runAction({
        definition: registered.definition,
        companyId: bridge.companyId,
        action,
        input: body.input ?? {},
        credentials,
        stableId: requestId === undefined ? undefined : `${bridge.bridgeId}:${requestId}`,
        timeoutMs: deps.timeoutMs,
        audit: deps.audit,
        now: deps.now,
      });
      return { status: 200, body: { ok: true, result: result.value } };
    } catch (err) {
      const code = err instanceof ConnectorError ? err.code : 'unknown';
      const status: Record<string, number> = { validation: 400, forbidden: 403, not_found: 404, rate_limited: 429, auth: 502, upstream: 502, timeout: 504, conflict: 409 };
      return deny(status[code] ?? 502, code);
    }
  }

  return { handle };
}
