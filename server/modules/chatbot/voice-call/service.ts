/**
 * Voice-call session service. Sits on the CallProvider contract and the storage port. No provider is named here.
 *
 * Rules enforced in this file:
 * - The voice flag must be exactly "true" (readFlag). Off means every entry point refuses.
 * - Webhooks fail closed: no credentials, a stale or missing timestamp, or a provider verdict other than true
 *   is a 401 with no state change.
 * - Each call belongs to one company and one chatbot. A row from another company or chatbot is absent.
 * - The per-plan seconds quota is checked at start. The call's cap is stored on the row and enforced by the
 *   server, so a client-reported duration is never trusted.
 * - Phone numbers are masked in every output and in every log line.
 */
import { createHash } from "node:crypto";
import {
  CONTRACT_FLAGS,
  readFlag as defaultReadFlag,
  type CallProvider,
  type CallProviderEvent,
  type CallSession,
  type CallSessionStatus,
  type CallStartRequest,
  type CallWebhookInput,
  type FlagEnv,
  type HttpClient,
  type ReadFlag,
} from "../contracts/index.ts";
import { requireCompanyId } from "../chatbot-scope.ts";
import { capDemoDuration, DEFAULT_DEMO_SECONDS_LIMIT } from "./demo-cap.ts";
import {
  callDurationSeconds,
  evaluateQuota,
  isFreshWebhook,
  isPlausiblePhone,
  limitDeadline,
  LOG_DENY_KEYS,
  maskPhone,
  parseWebhookTimestamp,
  redactPhoneText,
  startOfUtcMonth,
} from "./policy.ts";
import type {
  CallEndReason,
  CallQuotaPort,
  CreditLedger,
  CredentialSource,
  ChatbotGate,
  VoiceCallRecord,
  VoiceCallStorage,
  VoiceLogger,
} from "./ports.ts";

export type VoiceResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export type MaskedCallSession = CallSession & { maxSeconds: number | null; endReason: CallEndReason | null };

export interface VoiceCallDeps {
  storage: VoiceCallStorage;
  provider: CallProvider;
  http: HttpClient;
  quota: CallQuotaPort;
  chatbots: ChatbotGate;
  credentials: CredentialSource;
  /** Owner credit: checked at start, charged per transcript. Required. A missing balance refuses the call. */
  credits: CreditLedger;
  logger: VoiceLogger;
  env: FlagEnv;
  /** Hosts a status callback URL may point at. Empty means no callback is allowed (fail closed). */
  callbackHosts: readonly string[];
  readFlag?: ReadFlag;
  clock?: () => Date;
  /** Webhook timestamps further than this from now are refused. Default 300 seconds. */
  webhookMaxAgeSeconds?: number;
  /**
   * Demo mode. Injected by the mount, default false. When true, each stored call duration is capped to the day's
   * remaining demo seconds. Nothing here reads DEMO_MODE; the mount decides the value.
   */
  demoMode?: boolean;
  /** Daily demo seconds limit (PHP setting voice_call_demo_seconds_limit). Default DEFAULT_DEMO_SECONDS_LIMIT. */
  demoSecondsLimit?: number;
}

export interface StartOutboundInput {
  companyId: string;
  chatbotId: string;
  toNumber: string;
  fromNumber: string;
  /** Built by the caller. Must be https, on an allowed host, and carry the companyId and chatbotId in its path. */
  statusCallbackUrl: string;
  idempotencyKey: string;
  conversationId?: string | null;
}

export interface InboundCallInput {
  providerCallId: string;
  fromNumber: string;
  toNumber: string;
  conversationId?: string | null;
}

export interface WebhookOutcome {
  processed: number;
  ignored: number;
}

const TERMINAL: ReadonlySet<CallSessionStatus> = new Set(["completed", "failed", "no_answer"]);

const ok = <T>(value: T): VoiceResult<T> => ({ ok: true, value });
const fail = <T = never>(status: number, error: string): VoiceResult<T> => ({ ok: false, status, error });

/** Start of the UTC day that holds `now`. The demo window is one UTC day. */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDuplicate(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "duplicate" || code === "23505";
}

function validKey(key: string): boolean {
  return typeof key === "string" && key.length > 0 && key.length <= 128;
}

export function toCallSession(record: VoiceCallRecord): MaskedCallSession {
  return {
    id: record.id,
    companyId: record.companyId,
    chatbotId: record.chatbotId,
    conversationId: record.conversationId,
    direction: record.direction,
    providerCallId: record.providerCallId ?? "",
    status: record.status,
    fromNumber: maskPhone(record.fromNumber),
    toNumber: maskPhone(record.toNumber),
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationSeconds: record.durationSeconds,
    transcriptId: null,
    maxSeconds: record.maxSeconds,
    endReason: record.endReason,
  };
}

/** Drops denied keys and masks phone-like text in every string value before a log line is written. */
function scrubFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (LOG_DENY_KEYS.has(key)) continue;
    out[key] = typeof value === "string" ? redactPhoneText(value) : value;
  }
  return out;
}

export class VoiceCallService {
  private readonly deps: VoiceCallDeps;
  private readonly readFlag: ReadFlag;
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly maxAge: number;

  constructor(deps: VoiceCallDeps) {
    this.deps = deps;
    this.readFlag = deps.readFlag ?? defaultReadFlag;
    this.allowedHosts = new Set(deps.callbackHosts.map((h) => h.toLowerCase()));
    this.maxAge = deps.webhookMaxAgeSeconds ?? 300;
  }

  // ---- public entry points -------------------------------------------------------------------------------

  async startOutbound(input: StartOutboundInput): Promise<VoiceResult<MaskedCallSession>> {
    const companyId = requireCompanyId(input.companyId);
    const off = this.flagOff();
    if (off) return off;
    if (!isPlausiblePhone(input.toNumber) || !isPlausiblePhone(input.fromNumber)) {
      return fail(400, "Invalid phone number");
    }
    if (!validKey(input.idempotencyKey)) return fail(400, "Idempotency key required");
    const callbackProblem = this.checkCallbackUrl(companyId, input.chatbotId, input.statusCallbackUrl);
    if (callbackProblem) return fail(400, callbackProblem);
    if (!(await this.deps.chatbots.exists(companyId, input.chatbotId))) return fail(404, "Chatbot not found");

    // A replayed start with the same key returns the existing call and places no second call.
    const replay = await this.deps.storage.findByIdempotencyKey(companyId, input.chatbotId, input.idempotencyKey);
    if (replay) return ok(toCallSession(replay));

    const quota = await this.checkQuota(companyId, input.chatbotId);
    if (!quota.ok) return quota;

    const credentials = await this.deps.credentials.load(companyId, input.chatbotId);
    if (!credentials) return fail(503, "Voice calling is not configured for this chatbot");

    let record: VoiceCallRecord;
    try {
      record = await this.deps.storage.insert(companyId, {
        companyId,
        chatbotId: input.chatbotId,
        conversationId: input.conversationId ?? null,
        direction: "outbound",
        provider: this.deps.provider.key,
        providerCallId: null,
        idempotencyKey: input.idempotencyKey,
        status: "ringing",
        fromNumber: input.fromNumber,
        toNumber: input.toNumber,
        maxSeconds: quota.value.remainingSeconds,
      });
    } catch (err) {
      if (isDuplicate(err)) {
        const again = await this.deps.storage.findByIdempotencyKey(companyId, input.chatbotId, input.idempotencyKey);
        if (again) return ok(toCallSession(again));
      }
      return fail(409, "Call could not be recorded");
    }

    const request: CallStartRequest = {
      companyId,
      chatbotId: input.chatbotId,
      toNumber: input.toNumber,
      fromNumber: input.fromNumber,
      statusCallbackUrl: input.statusCallbackUrl,
      idempotencyKey: input.idempotencyKey,
    };

    let session: CallSession;
    try {
      session = await this.deps.provider.startCall(request, credentials, this.deps.http);
    } catch (err) {
      await this.deps.storage.update(companyId, record.id, "ringing", {
        status: "failed",
        endReason: "provider_error",
        endedAt: this.now(),
        durationSeconds: 0,
      });
      this.log("warn", "voice call could not be placed", { callId: record.id, companyId, chatbotId: input.chatbotId, error: errorMessage(err) });
      return fail(502, "Call could not be placed");
    }

    // The provider must hand back a session bound to this company and chatbot. Anything else is refused. The
    // provider call is not hung up here: its id may belong to another tenant, so this service does not act on it.
    if (session.companyId !== companyId || session.chatbotId !== input.chatbotId || !session.providerCallId) {
      await this.deps.storage.update(companyId, record.id, "ringing", {
        status: "failed",
        endReason: "provider_error",
        endedAt: this.now(),
        durationSeconds: 0,
      });
      this.log("warn", "provider session not bound to this company or chatbot", { callId: record.id, companyId, chatbotId: input.chatbotId });
      return fail(502, "Call could not be placed");
    }

    const bound = await this.deps.storage.update(companyId, record.id, "ringing", { providerCallId: session.providerCallId });
    const current = bound ?? { ...record, providerCallId: session.providerCallId };
    this.log("info", "voice call placed", { callId: current.id, companyId, chatbotId: input.chatbotId, direction: "outbound" });
    return ok(toCallSession(current));
  }

  /**
   * Records an inbound call. The provider's signed request is verified first, with the same rules as a webhook.
   * A call that does not fit the quota is hung up at once.
   */
  async startInbound(companyId: string, chatbotId: string, webhook: CallWebhookInput, inbound: InboundCallInput): Promise<VoiceResult<MaskedCallSession>> {
    requireCompanyId(companyId);
    const off = this.flagOff();
    if (off) return off;
    if (!(await this.deps.chatbots.exists(companyId, chatbotId))) return fail(404, "Chatbot not found");
    const verified = await this.verifyRequest(companyId, chatbotId, webhook);
    if (!verified.ok) return verified;
    const credentials = verified.value;

    if (!isPlausiblePhone(inbound.fromNumber) || !isPlausiblePhone(inbound.toNumber)) return fail(400, "Invalid phone number");

    const existing = await this.deps.storage.findByProviderCallId(companyId, this.deps.provider.key, inbound.providerCallId);
    if (existing) {
      if (existing.chatbotId !== chatbotId) return fail(409, "Call is bound to another chatbot");
      return ok(toCallSession(existing));
    }

    const quota = await this.checkQuota(companyId, chatbotId);
    if (!quota.ok) {
      await this.hangUpSafely(companyId, inbound.providerCallId, credentials);
      return quota;
    }

    const record = await this.deps.storage.insert(companyId, {
      companyId,
      chatbotId,
      conversationId: inbound.conversationId ?? null,
      direction: "inbound",
      provider: this.deps.provider.key,
      providerCallId: inbound.providerCallId,
      idempotencyKey: null,
      status: "ringing",
      fromNumber: inbound.fromNumber,
      toNumber: inbound.toNumber,
      maxSeconds: quota.value.remainingSeconds,
    });
    this.log("info", "voice call received", { callId: record.id, companyId, chatbotId, direction: "inbound" });
    return ok(toCallSession(record));
  }

  /**
   * Applies a provider webhook to the calls of one company and one chatbot.
   * Order: flag, chatbot, signature and timestamp, parse, resolve every call (any miss refuses the whole request
   * with no writes), then apply the events in order.
   */
  async handleWebhook(companyId: string, chatbotId: string, input: CallWebhookInput): Promise<VoiceResult<WebhookOutcome>> {
    requireCompanyId(companyId);
    const off = this.flagOff();
    if (off) return off;
    if (!(await this.deps.chatbots.exists(companyId, chatbotId))) return fail(404, "Chatbot not found");
    const verified = await this.verifyRequest(companyId, chatbotId, input);
    if (!verified.ok) return verified;

    let events: CallProviderEvent[];
    try {
      events = this.deps.provider.parseWebhook(companyId, input.rawBody);
    } catch {
      return fail(400, "Malformed webhook");
    }

    const now = this.now();
    for (const event of events) {
      if (event.type === "other") continue;
      const call = await this.deps.storage.findByProviderCallId(companyId, this.deps.provider.key, event.providerCallId);
      if (!call || call.chatbotId !== chatbotId) {
        this.log("warn", "voice webhook for unknown call refused", { companyId, chatbotId });
        return fail(404, "Unknown call");
      }
    }

    let processed = 0;
    let ignored = 0;
    for (const [index, event] of events.entries()) {
      if (event.type === "other") {
        ignored += 1;
        continue;
      }
      if (event.type === "call.transcript") {
        const outcome = await this.chargeTranscriptEvent(companyId, chatbotId, event, `${sha256Hex(input.rawBody)}:${index}`);
        if (outcome === "failed") return fail(503, "Credit could not be recorded");
        if (outcome === "charged") processed += 1;
        else ignored += 1;
        continue;
      }
      const changed = await this.applyEvent(companyId, chatbotId, event.providerCallId, event, now, verified.value);
      if (changed) processed += 1;
      else ignored += 1;
    }
    return ok({ processed, ignored });
  }

  /** Ends every active call of this chatbot whose cap has passed. Meant for a scheduler. */
  async enforceLimits(companyId: string, chatbotId: string): Promise<VoiceResult<{ ended: number }>> {
    requireCompanyId(companyId);
    const off = this.flagOff();
    if (off) return off;
    let ended = 0;
    for (const call of await this.deps.storage.listActive(companyId, chatbotId)) {
      const before = call.status;
      const after = await this.enforceLimit(call, this.now());
      if (before !== after.status) ended += 1;
    }
    return ok({ ended });
  }

  /**
   * Ends every in-progress call of one company whose cap has passed. This is the function a worker calls on a
   * schedule, once per company. Only the given company's rows are read or changed.
   */
  async enforceLimitsForCompany(companyId: string, options: { limit: number }): Promise<VoiceResult<{ ended: number; scanned: number }>> {
    // Not gated by the flag: ending a call that is past its cap must still work when voice is off, so no call runs on unpaid.
    requireCompanyId(companyId);
    const now = this.now();
    const calls = await this.deps.storage.listInProgressForCompany(companyId, options.limit);
    let ended = 0;
    for (const call of calls) {
      const after = await this.enforceLimit(call, now);
      if (after.status !== call.status) ended += 1;
    }
    return ok({ ended, scanned: calls.length });
  }

  /** Reads one call. A row from another company or chatbot is absent. */
  async getSession(companyId: string, chatbotId: string, id: string): Promise<VoiceResult<MaskedCallSession>> {
    requireCompanyId(companyId);
    const off = this.flagOff();
    if (off) return off;
    const record = await this.deps.storage.findById(companyId, chatbotId, id);
    return record ? ok(toCallSession(record)) : fail(404, "Call not found");
  }

  // ---- internals -----------------------------------------------------------------------------------------

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Duration to store for a closing call. Outside demo mode it is returned unchanged and storage is not read. In demo
   * mode it is capped to the day's remaining demo seconds, where used seconds are the completed calls of this chatbot
   * that ended today (UTC). The row being closed is not yet ended, so it is not counted twice.
   */
  private async storedDuration(companyId: string, chatbotId: string, requested: number, now: Date): Promise<number> {
    if (this.deps.demoMode !== true) return requested;
    const usage = await this.deps.storage.usage(companyId, chatbotId, startOfUtcDay(now));
    return capDemoDuration({
      isDemo: true,
      requestedSeconds: requested,
      usedTodaySeconds: usage.completedSeconds,
      limitSeconds: this.deps.demoSecondsLimit ?? DEFAULT_DEMO_SECONDS_LIMIT,
    });
  }

  private flagOff<T = never>(): VoiceResult<T> | null {
    return this.readFlag(CONTRACT_FLAGS.VOICE_ENABLED, this.deps.env) ? null : fail<T>(404, "Voice calls are not enabled");
  }

  private log(level: "info" | "warn", message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    const target = level === "warn" ? this.deps.logger.warn : this.deps.logger.info;
    target.call(this.deps.logger, redactPhoneText(message), scrubFields(fields));
  }

  private checkCallbackUrl(companyId: string, chatbotId: string, raw: string): string | null {
    const refused = "Callback URL not allowed";
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return refused;
    }
    if (url.protocol !== "https:" || url.username || url.password) return refused;
    if (!this.allowedHosts.has(url.hostname.toLowerCase())) return refused;
    if (!url.pathname.includes(companyId) || !url.pathname.includes(chatbotId)) return refused;
    return null;
  }

  private async checkQuota(companyId: string, chatbotId: string): Promise<VoiceResult<{ remainingSeconds: number | null }>> {
    const limit = await this.deps.quota.secondsLimitFor(companyId, chatbotId);
    if (limit === null) return fail(404, "Chatbot not found");
    const now = this.now();
    const usage = await this.deps.storage.usage(companyId, chatbotId, startOfUtcMonth(now));
    const decision = evaluateQuota({
      secondsLimit: limit,
      usedSeconds: usage.completedSeconds,
      reservedSeconds: usage.reservedSeconds,
    });
    if (!decision.allowed) {
      return decision.reason === "plan_disabled"
        ? fail(403, "Voice calls are not available in your current plan.")
        : fail(403, "Monthly voice call limit reached.");
    }
    // The owner must be able to pay. A balance check that throws also refuses the call (fail closed).
    let funded = false;
    try {
      funded = (await this.deps.credits.hasBalance(companyId, chatbotId)) === true;
    } catch {
      funded = false;
    }
    if (!funded) return fail(403, "Insufficient credits for voice call.");
    return ok({ remainingSeconds: decision.remainingSeconds });
  }

  /**
   * Charges the owner's credit for one transcript event of a live call. Returns charged, ignored (call already
   * over, or no text), or failed (the charge could not be recorded). Transcript text is never stored or logged.
   */
  private async chargeTranscriptEvent(
    companyId: string,
    chatbotId: string,
    event: Extract<CallProviderEvent, { type: "call.transcript" }>,
    idempotencyKey: string,
  ): Promise<"charged" | "ignored" | "failed"> {
    const call = await this.deps.storage.findByProviderCallId(companyId, this.deps.provider.key, event.providerCallId);
    if (!call || call.chatbotId !== chatbotId) return "ignored";
    if (call.status !== "ringing" && call.status !== "in_progress") return "ignored";
    const text = event.transcript.text.trim();
    if (text.length === 0) return "ignored";
    try {
      await this.deps.credits.chargeTranscript(companyId, chatbotId, { callId: call.id, text, idempotencyKey });
      return "charged";
    } catch {
      this.log("warn", "voice transcript credit could not be recorded", { callId: call.id, companyId, chatbotId });
      return "failed";
    }
  }

  /** Checks the signature with the company's own credentials. Returns those credentials on success. */
  private async verifyRequest(companyId: string, chatbotId: string, input: CallWebhookInput): Promise<VoiceResult<Readonly<Record<string, string>>>> {
    const credentials = await this.deps.credentials.load(companyId, chatbotId);
    if (!credentials) {
      this.log("warn", "voice webhook rejected", { reason: "no_credentials", companyId, chatbotId });
      return fail(401, "Webhook rejected");
    }
    const timestamp = parseWebhookTimestamp(input.timestamp);
    if (!timestamp || !isFreshWebhook(timestamp, this.now(), this.maxAge)) {
      this.log("warn", "voice webhook rejected", { reason: "timestamp", companyId, chatbotId });
      return fail(401, "Webhook rejected");
    }
    let valid = false;
    try {
      valid = (await this.deps.provider.verifyWebhook(companyId, input, credentials)) === true;
    } catch {
      valid = false;
    }
    if (!valid) {
      this.log("warn", "voice webhook rejected", { reason: "signature", companyId, chatbotId });
      return fail(401, "Webhook rejected");
    }
    return ok(credentials);
  }

  private async hangUpSafely(companyId: string, providerCallId: string, credentials: Readonly<Record<string, string>>): Promise<boolean> {
    try {
      return await this.deps.provider.hangUp(companyId, providerCallId, credentials, this.deps.http);
    } catch (err) {
      this.log("warn", "voice hang-up failed", { companyId, error: errorMessage(err) });
      return false;
    }
  }

  /**
   * Ends a call that has reached its cap. The provider is asked to hang up first. The row is then closed with
   * the cap as its duration, whether or not the provider confirmed.
   */
  private async enforceLimit(call: VoiceCallRecord, now: Date, credentials?: Readonly<Record<string, string>>): Promise<VoiceCallRecord> {
    if (call.status !== "in_progress" || call.startedAt === null) return call;
    const deadline = limitDeadline(call.startedAt, call.maxSeconds);
    if (!deadline || now.getTime() < deadline.getTime()) return call;

    const creds = credentials ?? (await this.deps.credentials.load(call.companyId, call.chatbotId));
    if (creds && call.providerCallId) {
      const confirmed = await this.hangUpSafely(call.companyId, call.providerCallId, creds);
      if (!confirmed) this.log("warn", "voice call hang-up not confirmed at limit", { callId: call.id, companyId: call.companyId });
    }

    const durationSeconds = await this.storedDuration(call.companyId, call.chatbotId, call.maxSeconds ?? 0, now);
    const closed = await this.deps.storage.update(call.companyId, call.id, "in_progress", {
      status: "completed",
      endReason: "limit_reached",
      endedAt: deadline,
      durationSeconds,
    });
    if (!closed) return (await this.deps.storage.findById(call.companyId, call.chatbotId, call.id)) ?? call;
    this.log("info", "voice call ended at plan limit", { callId: call.id, companyId: call.companyId, chatbotId: call.chatbotId, durationSeconds: closed.durationSeconds });
    return closed;
  }

  /** Applies one event. Returns true when the stored call changed. */
  private async applyEvent(
    companyId: string,
    chatbotId: string,
    providerCallId: string,
    event: CallProviderEvent,
    now: Date,
    credentials: Readonly<Record<string, string>>,
  ): Promise<boolean> {
    const found = await this.deps.storage.findByProviderCallId(companyId, this.deps.provider.key, providerCallId);
    if (!found || found.chatbotId !== chatbotId) return false;
    const call = await this.enforceLimit(found, now, credentials);
    if (TERMINAL.has(call.status)) return false;

    switch (event.type) {
      case "call.answered": {
        if (call.status !== "ringing") return false;
        const started = await this.deps.storage.update(companyId, call.id, "ringing", {
          status: "in_progress",
          startedAt: event.occurredAt,
        });
        if (!started) return false;
        this.log("info", "voice call answered", { callId: started.id, companyId, chatbotId, maxSeconds: started.maxSeconds });
        await this.enforceLimit(started, now, credentials);
        return true;
      }
      case "call.completed":
        return this.finish(companyId, call, event.occurredAt, "completed");
      case "call.failed":
        return this.finish(companyId, call, event.occurredAt, "failed");
      default:
        return false;
    }
  }

  private async finish(companyId: string, call: VoiceCallRecord, endedAt: Date, reason: "completed" | "failed"): Promise<boolean> {
    const requested = callDurationSeconds(call.startedAt, endedAt, call.maxSeconds);
    const durationSeconds = await this.storedDuration(companyId, call.chatbotId, requested, this.now());
    const closed = await this.deps.storage.update(companyId, call.id, call.status, {
      status: reason,
      endReason: reason,
      endedAt,
      durationSeconds,
    });
    if (!closed) return false;
    this.log("info", "voice call ended", { callId: call.id, companyId, chatbotId: call.chatbotId, status: reason, durationSeconds });
    return true;
  }
}
