/**
 * Outbound event delivery for the bridge (#359). When a company event happens (booking created,
 * job completed, ...), this module signs it and POSTs it to every active subscription for that
 * company that asked for the event.
 *
 * Rules:
 *   - only events in BRIDGE_EVENTS can be delivered or subscribed to
 *   - subscribers are looked up by the event's company only, so one company never receives another's events
 *   - each delivery is signed with the bridge secret (signing.ts), so the receiver can verify it
 *   - retries only on 429, 5xx and network failures, with a bounded attempt count
 *   - a per-bridge fixed one-minute rate limit caps deliveries; over the limit a delivery is skipped, not queued
 *   - the response body is never recorded: it can echo customer data
 *
 * Queueing and the subscription store are injected ports. This module does no database work itself.
 */
import { signatureFor } from './signing.ts';
import { isBridgeEvent, type BridgeEvent } from './events.ts';
import type { FetchLike } from '../providers/vendor-http.ts';

export interface Subscription {
  bridgeId: string;
  companyId: string;
  /** Destination. Must be https. */
  url: string;
  secret: string;
  events: BridgeEvent[];
  active: boolean;
}

export interface SubscriptionStore {
  /** Active subscriptions for one company that asked for this event. Never another company's. */
  subscribersFor(companyId: string, event: BridgeEvent): Promise<Subscription[]>;
}

export interface OutboundEvent {
  id: string;
  event: BridgeEvent;
  companyId: string;
  occurredAt: string;
  /** Business fields for the event. Must not contain secrets or credentials. */
  data: Record<string, unknown>;
}

export type DeliveryOutcome =
  | { bridgeId: string; status: 'delivered'; attempts: number; httpStatus: number }
  | { bridgeId: string; status: 'failed'; attempts: number; httpStatus?: number; reason: string }
  | { bridgeId: string; status: 'rate_limited' }
  | { bridgeId: string; status: 'invalid_subscription'; reason: string };

export interface OutboundDeps {
  store: SubscriptionStore;
  fetch: FetchLike;
  nowSeconds(): number;
  sleep?(ms: number): Promise<void>;
  maxAttempts?: number;
  maxPerMinute?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_PER_MINUTE = 60;
const DEFAULT_TIMEOUT_MS = 5_000;
const BACKOFF_BASE_MS = 500;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const SECRET_MIN_LENGTH = 32;

/** Subscriptions must target https. Plain http and embedded credentials are refused. */
export function validateSubscriptionUrl(raw: string): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'url is not valid' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'url must be https' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'url must not carry credentials' };
  return { ok: true };
}

/** Checks a subscription before it is stored. Returns the problems; empty means valid. */
export function validateSubscription(sub: Omit<Subscription, 'active'> & { active?: boolean }): string[] {
  const problems: string[] = [];
  const url = validateSubscriptionUrl(sub.url);
  if (url.ok === false) problems.push(url.reason);
  if (typeof sub.secret !== 'string' || sub.secret.length < SECRET_MIN_LENGTH) problems.push('secret is too short');
  if (!Array.isArray(sub.events) || sub.events.length === 0) problems.push('at least one event is required');
  for (const event of sub.events ?? []) {
    if (!isBridgeEvent(event)) problems.push(`unknown event "${String(event)}"`);
  }
  return problems;
}

function retryable(status: number | undefined): boolean {
  return status === undefined || status === 429 || status >= 500;
}

export function createOutboundDispatcher(deps: OutboundDeps) {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxPerMinute = deps.maxPerMinute ?? DEFAULT_MAX_PER_MINUTE;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new RangeError('maxAttempts must be 1 to 5');
  if (!Number.isInteger(maxPerMinute) || maxPerMinute < 1) throw new RangeError('maxPerMinute must be a positive integer');

  const windows = new Map<string, { start: number; count: number }>();

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

  async function deliverOne(sub: Subscription, event: OutboundEvent, body: string): Promise<DeliveryOutcome> {
    const problems = validateSubscription(sub);
    if (problems.length > 0) return { bridgeId: sub.bridgeId, status: 'invalid_subscription', reason: problems.join('; ') };

    const nowSeconds = deps.nowSeconds();
    if (!withinRateLimit(sub.bridgeId, nowSeconds)) return { bridgeId: sub.bridgeId, status: 'rate_limited' };

    const signature = signatureFor(sub.secret, nowSeconds, body);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-titan-event': event.event,
      'x-titan-delivery-id': event.id,
      'x-titan-timestamp': String(nowSeconds),
      'x-titan-signature': signature,
    };

    let lastStatus: number | undefined;
    let lastReason = 'delivery failed';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response | undefined;
      try {
        response = await deps.fetch(sub.url, {
          method: 'POST',
          headers,
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        lastStatus = undefined;
        lastReason = 'network_error';
      }
      if (response) {
        lastStatus = response.status;
        if (response.ok) return { bridgeId: sub.bridgeId, status: 'delivered', attempts: attempt, httpStatus: response.status };
        lastReason = `http_${response.status}`;
      }
      if (!retryable(lastStatus) || attempt === maxAttempts) break;
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
    return { bridgeId: sub.bridgeId, status: 'failed', attempts: maxAttempts, httpStatus: lastStatus, reason: lastReason };
  }

  /** Delivers one company event to its subscribers. Each subscriber gets its own outcome. */
  async function dispatch(event: OutboundEvent): Promise<DeliveryOutcome[]> {
    if (!isBridgeEvent(event.event)) throw new RangeError('event is not in the bridge catalogue');
    if (typeof event.companyId !== 'string' || event.companyId.length === 0) throw new RangeError('companyId is required');
    if (typeof event.id !== 'string' || event.id.length === 0) throw new RangeError('event id is required');

    const body = JSON.stringify({
      id: event.id,
      event: event.event,
      companyId: event.companyId,
      occurredAt: event.occurredAt,
      data: event.data,
    });
    if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) throw new RangeError('event payload is too large');

    const subscribers = await deps.store.subscribersFor(event.companyId, event.event);
    const scoped = subscribers.filter(
      (s) => s.active && s.companyId === event.companyId && s.events.includes(event.event),
    );
    const outcomes: DeliveryOutcome[] = [];
    for (const sub of scoped) outcomes.push(await deliverOne(sub, event, body));
    return outcomes;
  }

  return { dispatch };
}
