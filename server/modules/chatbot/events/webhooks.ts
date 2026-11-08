/**
 * Outbound webhooks: HMAC-SHA256 signing, subscription management and the dispatcher.
 *
 * - The signing secret is sealed with SecretBox under the company id. Plaintext is decrypted only for the
 *   moment of signing, and is never returned, logged or put in an error or a delivery record.
 * - The signature covers the exact body bytes sent: "sha256=" plus the hex HMAC of the body.
 * - Every request goes through a pinned client (pinned-webhook.ts) unless the caller injects one, with a timeout.
 *   The pinned client connects to the address it checked (audit C5). The feature flag must be "true".
 * - A subscription whose secret cannot be opened is not sent to. Sending unsigned is not allowed.
 * - One delivery per (event, subscription) that succeeded. A later dispatch skips it, so retries do not resend.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  CONTRACT_FLAGS,
  readFlag,
  type FlagEnv,
  type HttpClient,
  type HttpResponse,
  type OutboxEvent,
  type ReadFlag,
  type SecretBox,
  type WebhookDelivery,
  type WebhookDispatcher,
  type WebhookSubscription,
} from "../contracts/index.ts";
import {
  EventsError,
  type EventsDeps,
  type OutboxStore,
  type WebhookDeliveryRecord,
  type WebhookSubscriptionView,
} from "./types.ts";
import {
  WebhookUrlRefusedError,
  assertPublicWebhookUrl,
  systemWebhookResolver,
  type WebhookAddressResolver,
} from "./ssrf.ts";
import { createPinnedWebhookHttp, type PinnedWebhookRequester } from "./pinned-webhook.ts";
import { openStored, sealToString } from "../secrets/sealed-form.ts";

export type PinnedWebhookTransport = { https?: PinnedWebhookRequester };

export const WEBHOOK_HEADERS = {
  event: "X-Chatbot-Event",
  signature: "X-Chatbot-Signature",
  idempotency: "Idempotency-Key",
} as const;

export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_LENGTH = 256;

/** "sha256=" plus the lower-case hex HMAC-SHA256 of the exact body string. */
export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/** Constant-time check. A missing secret or header is a rejection (fails closed). */
export function verifyWebhookSignature(
  secret: string | null | undefined,
  body: string,
  header: string | null | undefined,
): boolean {
  if (!secret || !header) return false;
  const expected = Buffer.from(signWebhookBody(secret, body), "utf8");
  const received = Buffer.from(header, "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

const TOPIC_PATTERN = /^[a-z][a-z0-9_.-]{0,99}$|^\*$/;

export interface WebhookSubscriptionInput {
  url: string;
  topics: string[];
  /** Supplied by the caller. Stored sealed. Never returned. */
  signingSecret: string;
  active?: boolean;
}

export interface WebhookSubscriptionService {
  subscribe(companyId: string, input: WebhookSubscriptionInput): Promise<WebhookSubscriptionView>;
  list(companyId: string): Promise<WebhookSubscriptionView[]>;
}

export function toSubscriptionView(subscription: WebhookSubscription): WebhookSubscriptionView {
  return {
    id: subscription.id,
    companyId: subscription.companyId,
    url: subscription.url,
    topics: [...subscription.topics],
    active: subscription.active,
  };
}

const MAX_URL_LENGTH = 2048;

/** Length, then the SSRF rule set (https only, public addresses only). Refusals become VALIDATION errors. */
async function checkWebhookUrl(raw: string, resolve: WebhookAddressResolver): Promise<string> {
  if (typeof raw !== "string" || raw.length > MAX_URL_LENGTH) {
    throw new EventsError("VALIDATION", "Webhook URL must be https, public and no longer than 2048 characters.");
  }
  try {
    return (await assertPublicWebhookUrl(raw, resolve)).toString();
  } catch (error) {
    if (error instanceof WebhookUrlRefusedError) throw new EventsError("VALIDATION", `Webhook URL refused: ${error.message}`);
    throw error;
  }
}

export function createWebhookSubscriptionService(
  store: OutboxStore,
  secretBox: SecretBox,
  deps: EventsDeps,
  resolve: WebhookAddressResolver = systemWebhookResolver,
): WebhookSubscriptionService {
  return {
    async subscribe(companyId, input) {
      const url = await checkWebhookUrl(input.url, resolve);
      if (!Array.isArray(input.topics) || input.topics.length < 1 || input.topics.length > 50) {
        throw new EventsError("VALIDATION", "A subscription needs 1 to 50 topics.");
      }
      for (const topic of input.topics) {
        if (typeof topic !== "string" || !TOPIC_PATTERN.test(topic)) throw new EventsError("VALIDATION", "A topic name is not valid.");
      }
      const secret = input.signingSecret;
      if (typeof secret !== "string" || secret !== secret.trim() || secret.length < MIN_SECRET_LENGTH || secret.length > MAX_SECRET_LENGTH) {
        throw new EventsError("VALIDATION", `A signing secret must be ${MIN_SECRET_LENGTH} to ${MAX_SECRET_LENGTH} characters with no outer spaces.`);
      }
      const sealed = await sealToString(secretBox, companyId, secret);
      const subscription: WebhookSubscription = {
        id: deps.newId(),
        companyId,
        url,
        topics: [...new Set(input.topics)],
        active: input.active ?? true,
        signingSecret: sealed,
      };
      await store.insertSubscription(companyId, subscription);
      return toSubscriptionView(subscription);
    },

    async list(companyId) {
      const rows = await store.listSubscriptions(companyId);
      return rows.map(toSubscriptionView);
    },
  };
}

export interface WebhookDispatcherDeps {
  /**
   * Optional custom transport. When it is unset, sends go through createPinnedWebhookHttp, which resolves the name
   * once and connects to the checked address (audit C5). When it is set, the dispatcher runs the SSRF check itself
   * before each hop, but the transport may resolve the name again, so the pin does not apply. Production leaves it unset.
   */
  http?: HttpClient;
  /** Test seam for the pinned client's socket layer. Ignored when `http` is set. */
  transport?: PinnedWebhookTransport;
  secretBox: SecretBox;
  store: OutboxStore;
  env: FlagEnv;
  readFlag?: ReadFlag;
  timeoutMs?: number;
  events: EventsDeps;
  /** Address lookup for the SSRF check. Defaults to the system resolver. Tests inject a fake. */
  resolve?: WebhookAddressResolver;
}

/** Redirects are followed only for 307 and 308, which keep the method and body, so the signature still matches. */
export const WEBHOOK_FOLLOWED_REDIRECTS: ReadonlySet<number> = new Set([307, 308]);
export const WEBHOOK_REFUSED_REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303]);
export const WEBHOOK_MAX_REDIRECTS = 3;

/** The body is built once per dispatch so every subscriber gets the same bytes for a given event. */
function buildBody(event: OutboxEvent, occurredAt: Date): string {
  return JSON.stringify({
    event: event.topic,
    extension: "chatbot",
    payload: { ...event.payload, event_uuid: event.id },
    occurred_at: occurredAt.toISOString(),
  });
}

export function createWebhookDispatcher(deps: WebhookDispatcherDeps): WebhookDispatcher {
  const flag = deps.readFlag ?? readFlag;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
  const resolve = deps.resolve ?? systemWebhookResolver;
  // A custom transport is checked here, before each hop. The pinned client checks inside its own request.
  const customTransport = deps.http;
  const transport: HttpClient = customTransport ?? createPinnedWebhookHttp({ resolve, transport: deps.transport });

  return {
    async dispatch(companyId, event): Promise<WebhookDelivery[]> {
      if (!flag(CONTRACT_FLAGS.OUTBOUND_WEBHOOKS_ENABLED, deps.env)) return [];

      const subscriptions = (await deps.store.listSubscriptions(companyId)).filter(
        (s) => s.active && (s.topics.includes("*") || s.topics.includes(event.topic)),
      );
      const previous = await deps.store.listDeliveries(companyId, event.id);
      const now = deps.events.now();
      const body = buildBody(event, now);
      const results: WebhookDelivery[] = [];

      for (const subscription of subscriptions) {
        const earlier = previous.filter((d) => d.subscriptionId === subscription.id);
        if (earlier.some((d) => d.ok)) continue;
        const attempt = earlier.length + 1;

        const outcome = await sendOne(subscription, event, body);
        const record: WebhookDeliveryRecord = {
          companyId,
          eventId: event.id,
          subscriptionId: subscription.id,
          httpStatus: outcome.httpStatus,
          ok: outcome.ok,
          attempt,
          errorMessage: outcome.errorMessage,
          deliveredAt: deps.events.now(),
        };
        await deps.store.recordDelivery(companyId, record);
        results.push(stripCompany(record));
      }
      return results;
    },
  };

  async function sendOne(
    subscription: WebhookSubscription,
    event: OutboxEvent,
    body: string,
  ): Promise<{ ok: boolean; httpStatus: number | null; errorMessage: string | null }> {
    let secret: string;
    try {
      secret = await openStored(deps.secretBox, subscription.companyId, subscription.signingSecret);
    } catch {
      return { ok: false, httpStatus: null, errorMessage: "Signing secret unavailable." };
    }

    // Every hop is checked: the pinned client checks inside each request, and a custom transport is checked here.
    // Nothing is sent to a refused URL.
    const refused = (hop: number) => ({
      ok: false,
      httpStatus: null,
      errorMessage: hop === 0 ? "Address refused." : "Redirect target refused.",
    });
    let url = subscription.url;
    for (let hop = 0; ; hop++) {
      if (customTransport !== undefined) {
        try {
          await assertPublicWebhookUrl(url, resolve);
        } catch {
          return refused(hop);
        }
      }

      let response: HttpResponse;
      try {
        response = await transport({
          method: "POST",
          url,
          headers: {
            "Content-Type": "application/json",
            [WEBHOOK_HEADERS.event]: event.topic,
            [WEBHOOK_HEADERS.signature]: signWebhookBody(secret, body),
            [WEBHOOK_HEADERS.idempotency]: event.id,
          },
          body,
          timeoutMs,
          redirect: "manual",
        });
      } catch (error) {
        // A refusal from the pinned client is an SSRF refusal, not a transport failure.
        if (error instanceof WebhookUrlRefusedError) return refused(hop);
        // Only the transport kind is kept. The raw message can echo the URL or the body.
        const kind = typeof error === "object" && error !== null && (error as { kind?: unknown }).kind === "timeout" ? "timeout" : "network";
        return { ok: false, httpStatus: null, errorMessage: kind === "timeout" ? "Request timed out." : "Network error." };
      }

      if (WEBHOOK_REFUSED_REDIRECTS.has(response.status)) {
        return { ok: false, httpStatus: response.status, errorMessage: "Redirect not followed." };
      }
      if (WEBHOOK_FOLLOWED_REDIRECTS.has(response.status)) {
        if (hop >= WEBHOOK_MAX_REDIRECTS) {
          return { ok: false, httpStatus: response.status, errorMessage: "Too many redirects." };
        }
        const location = response.headers["location"];
        if (!location) return { ok: false, httpStatus: response.status, errorMessage: "Redirect without a location." };
        try {
          url = new URL(location, url).toString();
        } catch {
          return { ok: false, httpStatus: response.status, errorMessage: "Redirect target is not valid." };
        }
        continue;
      }

      const ok = response.status >= 200 && response.status < 300;
      return { ok, httpStatus: response.status, errorMessage: ok ? null : `HTTP ${response.status}` };
    }
  }
}

function stripCompany(record: WebhookDeliveryRecord): WebhookDelivery {
  return {
    subscriptionId: record.subscriptionId,
    eventId: record.eventId,
    httpStatus: record.httpStatus,
    ok: record.ok,
    attempt: record.attempt,
    errorMessage: record.errorMessage,
    deliveredAt: record.deliveredAt,
  };
}
