/**
 * In-memory CallProvider for tests and local runs. It makes no network call: startCall and hangUp only touch a map.
 *
 * Signatures are real. verifyWebhook uses the same HMAC rule as verifySignedWebhook in policy.ts, so a test can prove
 * that a wrong or missing secret is refused. Wire format for parseWebhook (JSON):
 *   { "events": [ { "type": "ringing" | "answered" | "completed" | "failed" | "transcript" | "other",
 *                   "providerCallId": "...", "occurredAt": "<ISO time>", "text": "<transcript, transcript only>" } ] }
 */
import type { CallProvider, CallProviderEvent, CallSession, CallStartRequest, CallWebhookInput, HttpClient, Transcript } from "../contracts/index.ts";
import { signWebhookPayload, verifySignedWebhook } from "./policy.ts";

const EVENT_TYPES: Readonly<Record<string, Exclude<CallProviderEvent["type"], "other">>> = {
  ringing: "call.ringing",
  answered: "call.answered",
  completed: "call.completed",
  failed: "call.failed",
};

export interface MemoryCallProviderOptions {
  key?: string;
}

export class MemoryCallProvider implements CallProvider {
  readonly key: string;
  private readonly calls = new Map<string, { companyId: string; chatbotId: string; hungUp: boolean }>();
  private readonly startRequests: CallStartRequest[] = [];
  private sequence = 0;
  private nextStartError: Error | null = null;

  constructor(options: MemoryCallProviderOptions = {}) {
    this.key = options.key ?? "memory";
  }

  /** Makes the next startCall throw once. Used to test the provider-failure path. */
  failNextStart(error: Error): void {
    this.nextStartError = error;
  }

  /** Requests received by startCall, in order. Carries no credentials. */
  requests(): CallStartRequest[] {
    return this.startRequests.map((r) => ({ ...r }));
  }

  /** Provider call ids this provider has hung up, for one company. */
  hungUpCalls(companyId: string): string[] {
    return [...this.calls.entries()]
      .filter(([k, v]) => k.startsWith(`${companyId}\u0000`) && v.hungUp)
      .map(([k]) => k.slice(companyId.length + 1));
  }

  async startCall(request: CallStartRequest, _credentials: Readonly<Record<string, string>>, _http: HttpClient): Promise<CallSession> {
    if (this.nextStartError) {
      const error = this.nextStartError;
      this.nextStartError = null;
      throw error;
    }
    this.sequence += 1;
    const providerCallId = `mem-call-${this.sequence}`;
    this.calls.set(`${request.companyId}\u0000${providerCallId}`, { companyId: request.companyId, chatbotId: request.chatbotId, hungUp: false });
    this.startRequests.push({ ...request });
    return {
      id: `mem-session-${this.sequence}`,
      companyId: request.companyId,
      chatbotId: request.chatbotId,
      conversationId: null,
      direction: "outbound",
      providerCallId,
      status: "ringing",
      fromNumber: request.fromNumber,
      toNumber: request.toNumber,
      startedAt: null,
      endedAt: null,
      durationSeconds: null,
      transcriptId: null,
    };
  }

  async hangUp(companyId: string, providerCallId: string, _credentials: Readonly<Record<string, string>>, _http: HttpClient): Promise<boolean> {
    const row = this.calls.get(`${companyId}\u0000${providerCallId}`);
    if (!row) return false;
    row.hungUp = true;
    return true;
  }

  async verifyWebhook(_companyId: string, input: CallWebhookInput, credentials: Readonly<Record<string, string>>): Promise<boolean> {
    return verifySignedWebhook({
      secret: credentials.secret ?? null,
      timestamp: input.timestamp,
      rawBody: input.rawBody,
      signature: input.signature,
    });
  }

  parseWebhook(_companyId: string, rawBody: string): CallProviderEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new Error("malformed webhook body");
    }
    const list = (parsed as { events?: unknown })?.events;
    if (!Array.isArray(list)) throw new Error("malformed webhook body");
    return list.map((raw) => this.parseEvent(raw));
  }

  private parseEvent(raw: unknown): CallProviderEvent {
    const item = raw as { type?: unknown; providerCallId?: unknown; occurredAt?: unknown; text?: unknown };
    const occurredAt = typeof item.occurredAt === "string" ? new Date(item.occurredAt) : null;
    if (!occurredAt || Number.isNaN(occurredAt.getTime())) throw new Error("malformed webhook event");
    const providerCallId = typeof item.providerCallId === "string" && item.providerCallId.length > 0 ? item.providerCallId : null;
    if (item.type === "other") return { type: "other", providerCallId, occurredAt };
    if (providerCallId === null) throw new Error("malformed webhook event");
    if (item.type === "transcript") {
      if (typeof item.text !== "string") throw new Error("malformed webhook event");
      const transcript: Transcript = { text: item.text, language: null, confidence: null, segments: [], provider: this.key };
      return { type: "call.transcript", providerCallId, transcript, occurredAt };
    }
    const mapped = typeof item.type === "string" ? EVENT_TYPES[item.type] : undefined;
    if (!mapped) throw new Error("malformed webhook event");
    // mapped is one of the four status events, which carry no transcript. The cast narrows the widened union.
    return { type: mapped, providerCallId, occurredAt } as CallProviderEvent;
  }
}

/** Builds a webhook body and its headers, signed the way verifyWebhook expects. For tests. */
export function signMemoryWebhook(input: { secret: string; timestamp: string; events: unknown[] }): CallWebhookInput & { rawBody: string } {
  const rawBody = JSON.stringify({ events: input.events });
  return {
    rawBody,
    timestamp: input.timestamp,
    signature: signWebhookPayload(input.secret, input.timestamp, rawBody),
  };
}
