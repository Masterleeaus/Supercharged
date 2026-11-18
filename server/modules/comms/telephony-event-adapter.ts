/**
 * Provider-neutral signed telephony events (issue #328).
 *
 * A telephony provider (or a hosted voice channel) posts events to us with three headers:
 *   X-Telephony-Timestamp  epoch seconds when the provider sent the event
 *   X-Telephony-Event-Id   the provider's unique id for this event
 *   X-Telephony-Signature  "sha256=" + hex HMAC-SHA256 over "<timestamp>.<raw body>", keyed by the tenant secret
 *
 * Order of checks: headers present, tenant secret known, signature (constant time), then the replay guard
 * (timestamp window and (provider, tenant, event id) idempotency). The signature is checked before the replay
 * guard, so unsigned traffic cannot fill the guard's table. If the handler fails, the event id is forgotten so the
 * provider's retry is accepted. The event is not lost and is not processed twice on success.
 *
 * Pure: no database, no clock except the injected one. Plivo keeps its own V2 verification in
 * server/engines/plivo/plivo-signature.ts; this adapter is for new providers.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ReplayGuard, ReplayRefusalReason } from '../../middleware/webhook-replay';

export const TELEPHONY_TIMESTAMP_HEADER = 'x-telephony-timestamp';
export const TELEPHONY_EVENT_ID_HEADER = 'x-telephony-event-id';
export const TELEPHONY_SIGNATURE_HEADER = 'x-telephony-signature';
const SIGNATURE_PREFIX = 'sha256=';

export type TelephonyRefusal = 'missing_headers' | 'unknown_tenant' | 'bad_signature' | ReplayRefusalReason;

export interface TelephonyEventInput {
  /** Provider name, for example "voice-hosted". Part of the idempotency key. */
  provider: string;
  /** Tenant (company) the event is addressed to, taken from the route, never from the body. */
  tenantId: string;
  /** Request headers. Lower-case names are looked up. */
  headers: Record<string, string | string[] | undefined>;
  /** The exact raw request body the provider signed. */
  rawBody: string;
}

export interface TelephonyAdapterDeps {
  guard: ReplayGuard;
  /** Returns the signing secret for a tenant, or null when the tenant has none. Unknown tenants are refused. */
  secretFor: (tenantId: string) => string | null;
}

export type TelephonyVerdict =
  | { accepted: true; guardKey: { provider: string; eventId: string } }
  | { accepted: false; reason: TelephonyRefusal };

function header(headers: TelephonyEventInput['headers'], name: string): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Signature for a timestamp (epoch seconds) and raw body. Exported so providers and tests share one rule. */
export function signTelephonyEvent(secret: string, timestampSeconds: number, rawBody: string): string {
  return SIGNATURE_PREFIX + createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`, 'utf8').digest('hex');
}

function signatureMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Verifies one event. Accepted events are recorded in the replay guard. */
export function verifyTelephonyEvent(input: TelephonyEventInput, deps: TelephonyAdapterDeps): TelephonyVerdict {
  const timestampRaw = header(input.headers, TELEPHONY_TIMESTAMP_HEADER);
  const eventId = header(input.headers, TELEPHONY_EVENT_ID_HEADER);
  const signature = header(input.headers, TELEPHONY_SIGNATURE_HEADER);
  if (!timestampRaw || !eventId || !signature) {
    return { accepted: false, reason: 'missing_headers' };
  }
  const timestampSeconds = Number(timestampRaw);
  if (!Number.isFinite(timestampSeconds)) {
    return { accepted: false, reason: 'missing_timestamp' };
  }

  const secret = deps.secretFor(input.tenantId);
  if (!secret) {
    return { accepted: false, reason: 'unknown_tenant' };
  }
  const expected = signTelephonyEvent(secret, timestampSeconds, input.rawBody);
  if (!signatureMatches(expected, signature)) {
    return { accepted: false, reason: 'bad_signature' };
  }

  // Idempotency key is scoped to the tenant, so the same provider id in two tenants does not collide.
  const scopedProvider = `${input.provider}:${input.tenantId}`;
  const replay = deps.guard.check({ provider: scopedProvider, eventId, timestampMs: timestampSeconds * 1000 });
  if (!replay.accepted) {
    return { accepted: false, reason: replay.reason };
  }
  return { accepted: true, guardKey: { provider: scopedProvider, eventId } };
}

/**
 * Verifies, then runs the handler once. If the handler throws, the event is forgotten (so a retry is accepted)
 * and the error is rethrown for the caller to answer with a 5xx.
 */
export async function processTelephonyEvent<T>(
  input: TelephonyEventInput,
  deps: TelephonyAdapterDeps,
  handle: () => Promise<T>,
): Promise<{ accepted: true; result: T } | { accepted: false; reason: TelephonyRefusal }> {
  const verdict = verifyTelephonyEvent(input, deps);
  if (verdict.accepted === false) {
    return { accepted: false, reason: verdict.reason };
  }
  try {
    const result = await handle();
    return { accepted: true, result };
  } catch (err) {
    deps.guard.forget(verdict.guardKey);
    throw err;
  }
}
