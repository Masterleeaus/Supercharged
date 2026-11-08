/*
 * Types for realtime delivery over Server-Sent Events. Types and constants only.
 *
 * A stream belongs to one company and one scope. Staff streams see every inbox event for their company.
 * Customer streams see only the token and typing frames of their own conversation.
 */

/** Who the stream belongs to. Always taken from the injected auth function, never from the URL. */
export type StaffScope = { kind: "staff"; staffId: string };
export type CustomerScope = { kind: "customer"; conversationId: string; customerId: string | null };
export type SubscriberScope = StaffScope | CustomerScope;

/** Result of the injected auth function. companyId comes from the verified session only. */
export type RealtimeAuth = { companyId: string } & SubscriberScope;

/** Frame names written by the streaming runtime. Inbox frames use the InboxEventType names. */
export const STREAM_FRAME_NAMES = ["token", "typing", "done", "error", "ready"] as const;
export type StreamFrameName = (typeof STREAM_FRAME_NAMES)[number];

/** Upper limit for ids that come from auth (staff id, conversation id). */
export const MAX_SCOPE_ID_LENGTH = 191;

/** Default heartbeat interval. Proxies commonly close idle connections after 30 to 60 seconds. */
export const DEFAULT_HEARTBEAT_MS = 25_000;

/** Default retry hint sent to the browser on connect, in milliseconds. */
export const DEFAULT_RETRY_MS = 3_000;

/** Default cap on bytes waiting in one response before the stream is dropped as a slow consumer. */
export const DEFAULT_MAX_BUFFERED_BYTES = 1_048_576;

/** Timer port, so tests can drive the heartbeat without real time. */
export interface Scheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const SYSTEM_SCHEDULER: Scheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Minimal request shape the handler reads. Express's Request satisfies it. Only the close hook is used, and
 * the URL, query and params are never read.
 */
export interface RealtimeRequest {
  on(event: "close", listener: () => void): unknown;
}

/** Minimal response shape the handler writes to. Express's Response and http.ServerResponse satisfy it. */
export interface RealtimeResponse {
  statusCode: number;
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
  readonly writableLength: number;
  setHeader(name: string, value: string): unknown;
  write(chunk: string): boolean;
  end(chunk?: string): unknown;
  flushHeaders?(): void;
  on(event: "close", listener: () => void): unknown;
}

/** Builds one SSE frame. JSON never contains a raw newline, so the data line cannot be split by input. */
export function formatSseFrame(name: string, data: unknown): string {
  const safeName = name.replace(/[\r\n]/g, "");
  return `event: ${safeName}\ndata: ${JSON.stringify(data)}\n\n`;
}
