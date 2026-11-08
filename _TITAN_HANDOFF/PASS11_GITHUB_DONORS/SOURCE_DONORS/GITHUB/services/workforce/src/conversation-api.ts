import type { ServerResponse } from "node:http";
import type { ZeroWorkforceDispatchInput, ZeroWorkforceDispatchResult, AuthenticatedDispatchIdentity, ZeroRuntimeCancellationInput } from "./zero-runtime-dispatcher.js";

export type ConversationSurface = "zero" | "go" | "hub";
export type AuthenticatedConversationContext = {
  company_id: string;
  actor_id: string;
  device_id: string;
  surface: ConversationSurface;
  session_id: string;
  context_revision: string;
  authenticated_identity?: AuthenticatedDispatchIdentity;
};

export type ConversationRequest = {
  action?: "start" | "continue" | "resume" | "cancel";
  company_id?: string;
  actor_id?: string;
  device_id?: string;
  surface?: ConversationSurface;
  session_id?: string;
  context_revision?: string;
  conversation_id: string;
  interaction_id: string;
  client_message_id: string;
  request_id: string;
  operation_id: string;
  correlation_id: string;
  trace_id: string;
  idempotency_key: string;
  text?: string;
  continuation_token?: string;
};

export type ConversationResponse = {
  accepted: true;
  schema_version: "titan.workforce.conversation.v1";
  company_id: string;
  actor_id: string;
  device_id: string;
  surface: ConversationSurface;
  session_id: string;
  context_revision: string;
  conversation_id: string;
  request_id: string;
  operation_id: string;
  correlation_id: string;
  trace_id: string;
  idempotency_key: string;
  events: ZeroWorkforceDispatchResult["events"];
  continuation_token?: string;
};

export interface ConversationHostRuntime {
  dispatch(input: ZeroWorkforceDispatchInput): Promise<ZeroWorkforceDispatchResult>;
  /** Explicit authenticated recovery observes uncertain execution; never retries its effect. */
  recover?(input: ZeroWorkforceDispatchInput): Promise<ZeroWorkforceDispatchResult>;
  cancel?(input: ZeroRuntimeCancellationInput): Promise<ZeroWorkforceDispatchResult>;
}

export interface ConversationAuth {
  resolve(input: {
    request: ConversationRequest;
    authorization: string | undefined;
  }): Promise<AuthenticatedConversationContext>;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 20 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const schema_version = "titan.workforce.conversation.v1" as const;

function required(value: unknown, code: string): string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(code);
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function bounded(value: unknown, code: string, max: number): string {
  const normalized = required(value, code);
  if (Buffer.byteLength(normalized, "utf8") > max) throw new Error(code.replace("-required", "-too-large"));
  return normalized;
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : "conversation-failed";
}

export function normalizeConversationRequest(input: unknown): ConversationRequest {
  if (!input || typeof input !== "object") throw new Error("conversation-request-invalid");
  const value = input as Record<string, unknown>;
  const action = value.action === undefined ? "start" : value.action;
  if (typeof action !== "string" || !["start", "continue", "resume", "cancel"].includes(action)) throw new Error("conversation-action-invalid");
  if (action === "start" && value.continuation_token !== undefined) throw new Error("conversation-action-invalid");
  if (action !== "start" && (typeof value.continuation_token !== "string" || !value.continuation_token.trim())) throw new Error("conversation-continuation-required");
  return {
    action: action as ConversationRequest["action"],
    company_id: bounded(value.company_id, "conversation-company-id-required", 256),
    actor_id: bounded(value.actor_id, "conversation-actor-id-required", 256),
    device_id: bounded(value.device_id, "conversation-device-id-required", 256),
    surface: value.surface as ConversationSurface,
    session_id: bounded(value.session_id, "conversation-session-id-required", 256),
    context_revision: bounded(value.context_revision, "conversation-context-revision-required", 256),
    conversation_id: bounded(value.conversation_id, "conversation-id-required", 256),
    interaction_id: bounded(value.interaction_id, "conversation-interaction-id-required", 256),
    client_message_id: bounded(value.client_message_id, "conversation-client-message-id-required", 256),
    request_id: bounded(value.request_id, "conversation-request-id-required", 256),
    operation_id: bounded(value.operation_id, "conversation-operation-id-required", 256),
    correlation_id: bounded(value.correlation_id, "conversation-correlation-id-required", 256),
    trace_id: bounded(value.trace_id, "conversation-trace-id-required", 256),
    idempotency_key: bounded(value.idempotency_key, "conversation-idempotency-key-required", 256),
    text: value.text === undefined ? undefined : (typeof value.text === "string" && !value.text.includes("\0") && Buffer.byteLength(value.text, "utf8") <= MAX_TEXT_BYTES ? value.text : (() => { throw new Error("conversation-text-too-large"); })()),
    continuation_token: value.continuation_token === undefined ? undefined : bounded(value.continuation_token, "conversation-continuation-required", 4096),
  };
}

function assertContext(request: ConversationRequest, context: AuthenticatedConversationContext): void {
  if (!['zero', 'go', 'hub'].includes(String(request.surface))) throw new Error("conversation-surface-invalid");
  if (request.company_id !== context.company_id) throw new Error("conversation-company-mismatch");
  if (request.actor_id !== context.actor_id) throw new Error("conversation-actor-mismatch");
  if (request.device_id !== context.device_id) throw new Error("conversation-device-mismatch");
  if (request.surface !== context.surface) throw new Error("conversation-surface-mismatch");
  if (request.session_id !== context.session_id) throw new Error("conversation-session-mismatch");
  if (request.context_revision !== context.context_revision) throw new Error("conversation-context-stale");
  if (request.action !== "cancel" && !request.text && !request.continuation_token) throw new Error("conversation-input-required");
}

function toDispatch(request: ConversationRequest, context: AuthenticatedConversationContext): ZeroWorkforceDispatchInput {
  return {
    company_id: request.company_id!,
    actor_id: request.actor_id!,
    conversation_id: request.conversation_id,
    interaction_id: request.interaction_id,
    client_message_id: request.client_message_id,
    text: request.text ?? "",
    correlation_id: request.correlation_id,
    request_id: request.request_id, operation_id: request.operation_id, trace_id: request.trace_id,
    idempotency_key: request.idempotency_key, session_id: context.session_id,
    context_revision: context.context_revision, authenticated_identity: context.authenticated_identity,
    continuation_token: request.continuation_token,
  };
}

// Runtime events are internal evidence, not a public transport DTO. In particular,
// provider errors and approval wait payloads may contain secrets or tool inputs.
function publicEvent(event: ZeroWorkforceDispatchResult["events"][number]): ZeroWorkforceDispatchResult["events"][number] {
  const kinds = new Set(["run.started", "run.completed", "run.failed", "run.cancelled", "run.state", "agent.waiting", "agent.resumed", "reasoning.status", "message.delta", "tool.requested", "tool.started", "tool.completed", "approval.required", "work.state"]);
  const result: ZeroWorkforceDispatchResult["events"][number] = {
    id: event.id, kind: kinds.has(event.kind) ? event.kind : "run.state", company_id: event.company_id,
    conversation_id: event.conversation_id, surface: event.surface,
  };
  for (const key of ["work_id", "run_id", "agent_id", "actor_id", "interaction_id", "client_message_id", "request_id", "operation_id", "trace_id", "correlation_id", "idempotency_key", "capability", "tool_call_id", "decision_id", "evidence_ref"] as const) {
    if (typeof event[key] === "string" && event[key].length <= 1024 && !/[\u0000-\u001f\u007f]/.test(event[key])) result[key] = event[key];
  }
  if (typeof event.state === "string" && /^(CREATED|READY|CLAIMED|IN_PROGRESS|QUEUED|RUNNING|WAITING|WAITING_TOOL|WAITING_AGENT|WAITING_USER|WAITING_APPROVAL|WAITING_USER_AUTH|WAITING_MFA|WAITING_EXTERNAL|SUSPENDED|COMPLETED|FAILED|CANCELLED)$/.test(event.state)) result.state = event.state;
  if (event.kind === "message.delta" && typeof event.delta === "string") result.delta = event.delta.slice(0, MAX_TEXT_BYTES);
  if (event.status === "working") result.status = "working";
  if (typeof event.verified === "boolean") result.verified = event.verified;
  if (event.kind === "run.failed") result.error = { code: "runtime-failed" };
  return result;
}

export async function handleConversationRequest(
  request: ConversationRequest,
  auth: ConversationAuth,
  runtime: ConversationHostRuntime,
  authorization: string | undefined,
): Promise<ConversationResponse> {
  const context = await auth.resolve({ request, authorization });
  assertContext(request, context);
  const result = request.action === "cancel"
    ? await (runtime.cancel ? runtime.cancel({
        company_id: context.company_id,
        actor_id: context.actor_id,
        conversation_id: request.conversation_id,
        interaction_id: request.interaction_id,
        client_message_id: request.client_message_id,
        request_id: request.request_id,
        operation_id: request.operation_id,
        trace_id: request.trace_id,
        correlation_id: request.correlation_id,
        idempotency_key: request.idempotency_key,
        continuation_token: required(request.continuation_token, "conversation-continuation-required"),
        reason: "cancelled-by-client", session_id: context.session_id, context_revision: context.context_revision,
        authenticated_identity: context.authenticated_identity,
      }) : Promise.reject(new Error("conversation-cancellation-unavailable")))
    : request.action === "resume"
      ? await (runtime.recover ? runtime.recover(toDispatch(request, context)) : Promise.reject(new Error("conversation-recovery-unavailable")))
      : await runtime.dispatch(toDispatch(request, context));
  return {
    accepted: true, schema_version, company_id: context.company_id, actor_id: context.actor_id,
    device_id: context.device_id, session_id: context.session_id, context_revision: context.context_revision, surface: context.surface,
    conversation_id: request.conversation_id, request_id: request.request_id,
    operation_id: request.operation_id, correlation_id: request.correlation_id,
    trace_id: request.trace_id, idempotency_key: request.idempotency_key,
    events: result.events.map(publicEvent), ...(result.continuation_token ? { continuation_token: result.continuation_token } : {}),
  };
}

export async function readConversationBody(request: AsyncIterable<Buffer | string>): Promise<ConversationRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("conversation-body-too-large");
    chunks.push(buffer);
  }
  try { return normalizeConversationRequest(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch (error) { if (error instanceof Error && error.message.startsWith("conversation-")) throw error; throw new Error("conversation-json-invalid"); }
}

export function writeConversationResponse(response: ServerResponse, value: ConversationResponse, stream: boolean, lastEventId?: string): void {
  const resumeIndex = lastEventId ? value.events.findIndex(event => event.id === lastEventId) : -1;
  const events = (lastEventId && resumeIndex >= 0 ? value.events.slice(resumeIndex + 1) : value.events).map(publicEvent);
  const encoded = JSON.stringify({ ...value, events });
  if (Buffer.byteLength(encoded, "utf8") > MAX_RESPONSE_BYTES) { response.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ error: "conversation-response-too-large" })); return; }
  if (!stream) {
    const body = encoded;
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(body); return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  for (const event of events) { response.write(`id: ${event.id}\nevent: workforce\ndata: ${JSON.stringify(event)}\n\n`); }
  response.write(`event: workforce.lifecycle\ndata: ${JSON.stringify({ accepted: true, continuation_token: value.continuation_token ?? null })}\n\n`);
  response.end();
}

export function conversationHttpStatus(code: string): number {
  if (code === "identity-registry-unavailable" || code === "zero-execution-admission-unavailable") return 503;
  if (code.includes("authentication") || code.includes("authorization")) return 401;
  if (code.includes("mismatch") || code.includes("stale") || code.includes("conflict")) return 409;
  if (code.includes("too-large")) return 413;
  if (code.includes("unavailable")) return 501;
  if (code.includes("required") || code.includes("invalid")) return 400;
  return 500;
}
