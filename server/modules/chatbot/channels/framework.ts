/**
 * Channel framework. Shared by every channel kind (whatsapp, telegram, messenger, instagram, voice, web).
 *
 * Holds four things:
 * - a registry keyed by ChannelKind, which refuses unknown kinds;
 * - the inbound pipeline, which runs the contract's fixed order: resolveAccount, load credentials,
 *   verifyWebhook, parseInbound. Any step that does not pass rejects the request. Parsing never runs before
 *   verification succeeds;
 * - the outbound send path, which checks the message before any network call and redacts provider text;
 * - small helpers the channel providers share: constant-time compare, form-body parsing, secret redaction.
 *
 * Nothing here writes to storage. The runtime layer stores the parsed results.
 * Nothing here logs. Error values returned to callers carry reason codes and never credential values.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  CHANNEL_KINDS,
  type ChannelCredentialSource,
  type ChannelCredentials,
  type ChannelKind,
  type ChannelProvider,
  type HttpClient,
  type InboundMessage,
  type InboundParseResult,
  type OutboundMessage,
  type RawWebhook,
  type SendResult,
  type WebhookVerification,
} from "../contracts/index.ts";

/** Default hard limit for one outbound provider call, in milliseconds. */
export const CHANNEL_HTTP_TIMEOUT_MS = 10_000;

/** Longest provider error text that is passed back to callers. */
const MAX_PROVIDER_MESSAGE_LENGTH = 300;

// ---------- registry ----------

export type ChannelRegistryErrorCode =
  | "CHANNEL_KIND_UNKNOWN"
  | "CHANNEL_NOT_REGISTERED"
  | "CHANNEL_KIND_DUPLICATE"
  | "CHANNEL_PROVIDER_INVALID";

/** Thrown by the registry. The message names the problem only; it never echoes the kind value a caller passed. */
export class ChannelRegistryError extends Error {
  readonly code: ChannelRegistryErrorCode;

  constructor(code: ChannelRegistryErrorCode, message: string) {
    super(message);
    this.name = "ChannelRegistryError";
    this.code = code;
  }
}

export function isChannelKind(value: unknown): value is ChannelKind {
  return typeof value === "string" && (CHANNEL_KINDS as readonly string[]).includes(value);
}

export interface ChannelRegistry {
  register(provider: ChannelProvider): void;
  /** Throws ChannelRegistryError when the kind is unknown or no provider is registered for it. */
  get(kind: unknown): ChannelProvider;
  has(kind: unknown): boolean;
  kinds(): ChannelKind[];
}

const PROVIDER_METHODS = ["capabilities", "resolveAccount", "verifyWebhook", "parseInbound", "send"] as const;

export function createChannelRegistry(): ChannelRegistry {
  const providers = new Map<ChannelKind, ChannelProvider>();

  return {
    register(provider: ChannelProvider): void {
      if (!provider || typeof provider !== "object") {
        throw new ChannelRegistryError("CHANNEL_PROVIDER_INVALID", "Channel provider is not an object");
      }
      if (!isChannelKind(provider.kind)) {
        throw new ChannelRegistryError("CHANNEL_KIND_UNKNOWN", "Channel provider declares an unknown kind");
      }
      for (const method of PROVIDER_METHODS) {
        if (typeof provider[method] !== "function") {
          throw new ChannelRegistryError("CHANNEL_PROVIDER_INVALID", `Channel provider is missing ${method}()`);
        }
      }
      if (providers.has(provider.kind)) {
        throw new ChannelRegistryError("CHANNEL_KIND_DUPLICATE", "A provider is already registered for this kind");
      }
      providers.set(provider.kind, provider);
    },

    get(kind: unknown): ChannelProvider {
      if (!isChannelKind(kind)) {
        throw new ChannelRegistryError("CHANNEL_KIND_UNKNOWN", "Unknown channel kind");
      }
      const provider = providers.get(kind);
      if (!provider) {
        throw new ChannelRegistryError("CHANNEL_NOT_REGISTERED", "No provider is registered for this channel kind");
      }
      return provider;
    },

    has(kind: unknown): boolean {
      return isChannelKind(kind) && providers.has(kind);
    },

    kinds(): ChannelKind[] {
      return [...providers.keys()];
    },
  };
}

// ---------- verification helpers ----------

/** Reasons a verification may fail with. Matches the contract's WebhookVerification. */
export type VerificationFailure = Extract<WebhookVerification, { ok: false }>;
export type VerificationReason = VerificationFailure["reason"];

/** Reasons the pipeline itself can reject with, in addition to the verification reasons. */
export type WebhookRejectReason = VerificationReason | "kind_unknown" | "parse_failed";

const VERIFICATION_REASONS: readonly VerificationReason[] = [
  "signature_missing",
  "signature_invalid",
  "timestamp_stale",
  "account_unknown",
  "credentials_missing",
];

/**
 * Compares two strings in constant time. Both sides are hashed first, so the comparison time does not depend on
 * where the strings differ or on their lengths.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB) && a.length === b.length;
}

/** Only a verification result of exactly { ok: true } passes. Anything else, including a bare true, rejects. */
export function verificationPassed(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === true;
}

export function verificationFailureReason(result: unknown): VerificationReason {
  if (typeof result === "object" && result !== null) {
    const reason = (result as { reason?: unknown }).reason;
    if (typeof reason === "string" && (VERIFICATION_REASONS as readonly string[]).includes(reason)) {
      return reason as VerificationReason;
    }
  }
  return "signature_invalid";
}

// ---------- form bodies ----------

/**
 * Parses an application/x-www-form-urlencoded body into ordered entries. Keeps duplicate keys, because some
 * signature schemes (Twilio) sign every value.
 */
export function parseFormEntries(rawBody: string): Array<[string, string]> {
  return [...new URLSearchParams(rawBody).entries()];
}

/** First value for each key. Use this for field lookups; use parseFormEntries for signing. */
export function formFields(entries: Array<[string, string]>): Map<string, string> {
  const fields = new Map<string, string>();
  for (const [key, value] of entries) {
    if (!fields.has(key)) fields.set(key, value);
  }
  return fields;
}

// ---------- redaction ----------

/**
 * Replaces every credential value that appears in the text. Values shorter than four characters are skipped, so a
 * one-letter setting cannot blank out ordinary words.
 */
export function redactSecrets(text: string, credentials: ChannelCredentials | readonly string[]): string {
  const values = Array.isArray(credentials) ? credentials : Object.values(credentials);
  let out = text;
  for (const value of values) {
    if (typeof value === "string" && value.length >= 4) {
      out = out.split(value).join("[redacted]");
    }
  }
  return out;
}

export function truncateProviderText(text: string, max = MAX_PROVIDER_MESSAGE_LENGTH): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

// ---------- inbound shape ----------

const CONTENT_KINDS = ["text", "image", "audio", "video", "file", "location", "interactive", "unknown"] as const;
const DELIVERY_STATUSES = ["sent", "delivered", "read", "failed"] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidInboundMessage(message: InboundMessage, kind: ChannelKind, accountId: string): boolean {
  return (
    message !== null &&
    typeof message === "object" &&
    message.channel === kind &&
    message.accountId === accountId &&
    isNonEmptyString(message.externalThreadId) &&
    isNonEmptyString(message.externalMessageId) &&
    isNonEmptyString(message.sender?.externalId) &&
    (CONTENT_KINDS as readonly string[]).includes(message.contentKind) &&
    Array.isArray(message.attachments) &&
    message.sentAt instanceof Date &&
    !Number.isNaN(message.sentAt.getTime())
  );
}

/**
 * Checks that each parse result is well formed and belongs to the provider's kind and the resolved account.
 * A single bad result rejects the whole batch: a provider that mislabels one event cannot be trusted with the rest.
 */
export function checkParseResults(
  results: unknown,
  kind: ChannelKind,
  accountId: string,
): { ok: true; results: InboundParseResult[] } | { ok: false } {
  if (!Array.isArray(results)) return { ok: false };
  for (const result of results as InboundParseResult[]) {
    if (!result || typeof result !== "object") return { ok: false };
    if (result.kind === "message") {
      if (!isValidInboundMessage(result.message, kind, accountId)) return { ok: false };
    } else if (result.kind === "status") {
      const update = result.update;
      const valid =
        update !== null &&
        typeof update === "object" &&
        update.channel === kind &&
        update.accountId === accountId &&
        isNonEmptyString(update.externalMessageId) &&
        (DELIVERY_STATUSES as readonly string[]).includes(update.status) &&
        update.occurredAt instanceof Date;
      if (!valid) return { ok: false };
    } else if (result.kind === "ignored") {
      if (typeof result.reason !== "string") return { ok: false };
    } else {
      return { ok: false };
    }
  }
  return { ok: true, results: results as InboundParseResult[] };
}

// ---------- inbound pipeline ----------

export interface WebhookPipelineDeps {
  registry: ChannelRegistry;
  credentials: ChannelCredentialSource;
}

export type WebhookReceipt =
  | { ok: true; channel: ChannelKind; accountId: string; events: InboundParseResult[] }
  | { ok: false; reason: WebhookRejectReason };

/**
 * Runs one inbound webhook through the contract's fixed order. Returns a receipt; never throws.
 * A rejected receipt carries only a reason code, so it is safe to return to the caller.
 */
export async function receiveWebhook(
  deps: WebhookPipelineDeps,
  companyId: string,
  kind: unknown,
  raw: RawWebhook,
): Promise<WebhookReceipt> {
  const reject = (reason: WebhookRejectReason): WebhookReceipt => ({ ok: false, reason });

  if (!isNonEmptyString(companyId)) return reject("account_unknown");

  let provider: ChannelProvider;
  try {
    provider = deps.registry.get(kind);
  } catch {
    return reject("kind_unknown");
  }

  // 1. Resolve the account from the raw payload. Pure read.
  let accountId: string | null;
  try {
    accountId = provider.resolveAccount(raw);
  } catch {
    return reject("account_unknown");
  }
  if (!isNonEmptyString(accountId)) return reject("account_unknown");

  // 2. Load this account's credentials for this company. A missing or unreadable secret rejects.
  let credentials: ChannelCredentials | null;
  try {
    credentials = await deps.credentials.load(companyId, provider.kind, accountId);
  } catch {
    return reject("credentials_missing");
  }
  if (!credentials) return reject("credentials_missing");

  // 3. Verify the signature. Fails closed: anything other than { ok: true } rejects.
  let verification: unknown;
  try {
    verification = await provider.verifyWebhook(companyId, accountId, raw, credentials);
  } catch {
    return reject("signature_invalid");
  }
  if (!verificationPassed(verification)) {
    return reject(verificationFailureReason(verification));
  }

  // 4. Parse. Only reached after verification has passed.
  let parsed: unknown;
  try {
    parsed = provider.parseInbound(raw, accountId);
  } catch {
    return reject("parse_failed");
  }
  const checked = checkParseResults(parsed, provider.kind, accountId);
  if (!checked.ok) return reject("parse_failed");

  return { ok: true, channel: provider.kind, accountId, events: checked.results };
}

// ---------- verification challenge (GET) ----------

/** The answer to a platform's GET verification request. Only status 200 with a short plain body is ever sent. */
export interface ChallengeResponse {
  status: 200;
  contentType: string;
  body: string;
}

/**
 * Optional extension for providers whose platform checks the callback URL with a GET request before it sends events
 * (Meta's subscription challenge). ChannelProvider has no such method, so the framework checks for it here.
 * answerChallenge must return null unless the request is correct, and must compare secrets in constant time.
 */
export interface ChallengeCapableProvider extends ChannelProvider {
  answerChallenge(
    query: Readonly<Record<string, string | undefined>>,
    credentials: ChannelCredentials,
  ): ChallengeResponse | null;
}

export function isChallengeCapable(provider: ChannelProvider): provider is ChallengeCapableProvider {
  return typeof (provider as Partial<ChallengeCapableProvider>).answerChallenge === "function";
}

/**
 * Answers a GET verification request for one account. Loads that account's credentials for the company, then asks
 * the provider. Returns null for every failure (unknown kind, provider without the hook, missing credentials, bad
 * answer), and the route must then answer 403.
 */
export async function answerChallenge(
  deps: WebhookPipelineDeps,
  companyId: string,
  kind: unknown,
  accountId: string,
  query: Readonly<Record<string, string | undefined>>,
): Promise<ChallengeResponse | null> {
  if (!isNonEmptyString(companyId) || !isNonEmptyString(accountId)) return null;

  let provider: ChannelProvider;
  try {
    provider = deps.registry.get(kind);
  } catch {
    return null;
  }
  if (!isChallengeCapable(provider)) return null;

  let credentials: ChannelCredentials | null;
  try {
    credentials = await deps.credentials.load(companyId, provider.kind, accountId);
  } catch {
    return null;
  }
  if (!credentials) return null;

  let answer: ChallengeResponse | null;
  try {
    answer = provider.answerChallenge(query, credentials);
  } catch {
    return null;
  }
  if (
    !answer ||
    answer.status !== 200 ||
    typeof answer.body !== "string" ||
    answer.body.length === 0 ||
    answer.body.length > 512
  ) {
    return null;
  }
  return answer;
}

// ---------- outbound path ----------

export interface OutboundPipelineDeps {
  registry: ChannelRegistry;
  credentials: ChannelCredentialSource;
  http: HttpClient;
}

function failed(code: string, message: string, retryable: boolean): SendResult {
  return { status: "failed", errorCode: code, retryable, message };
}

/**
 * Checks an outbound message, loads credentials, and calls the provider's send. Refuses before any network call
 * when the message is malformed for the channel. Redacts credential values from any failure text.
 */
export async function sendOutbound(
  deps: OutboundPipelineDeps,
  companyId: string,
  message: OutboundMessage,
): Promise<SendResult> {
  if (!isNonEmptyString(companyId)) return failed("account_unknown", "Channel account not found", false);

  let provider: ChannelProvider;
  try {
    provider = deps.registry.get(message?.channel);
  } catch {
    return failed("kind_unknown", "Unknown channel kind", false);
  }

  if (message.channel !== provider.kind) {
    return failed("channel_mismatch", "Message channel does not match the provider", false);
  }
  if (!isNonEmptyString(message.idempotencyKey)) {
    return failed("idempotency_key_missing", "An idempotency key is required", false);
  }

  const maxText = provider.capabilities().maxTextLength;
  if (message.text !== null && maxText !== null && message.text.length > maxText) {
    return failed("text_too_long", `Text is longer than the channel limit of ${maxText} characters`, false);
  }

  let credentials: ChannelCredentials | null;
  try {
    credentials = await deps.credentials.load(companyId, provider.kind, message.accountId);
  } catch {
    return failed("credentials_missing", "Channel credentials could not be loaded", false);
  }
  if (!credentials) return failed("credentials_missing", "Channel credentials are not configured", false);

  let result: unknown;
  try {
    result = await provider.send(companyId, message, credentials, deps.http);
  } catch {
    // Not retryable: the provider may already have accepted the message, and a retry could send it twice.
    return failed("provider_exception", "Channel send failed", false);
  }

  return sanitiseSendResult(result, credentials);
}

function sanitiseSendResult(result: unknown, credentials: ChannelCredentials): SendResult {
  if (typeof result !== "object" || result === null) {
    return failed("provider_result_invalid", "Channel returned an unreadable result", false);
  }
  const r = result as Record<string, unknown>;
  if (r.status === "sent" && isNonEmptyString(r.externalMessageId)) {
    return { status: "sent", externalMessageId: r.externalMessageId };
  }
  if (r.status === "queued") {
    return { status: "queued", externalMessageId: null };
  }
  if (r.status === "failed" && typeof r.errorCode === "string" && typeof r.retryable === "boolean") {
    const text = typeof r.message === "string" ? r.message : "Channel send failed";
    return {
      status: "failed",
      errorCode: r.errorCode,
      retryable: r.retryable,
      message: truncateProviderText(redactSecrets(text, credentials)),
    };
  }
  return failed("provider_result_invalid", "Channel returned an unreadable result", false);
}
