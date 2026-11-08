/*
 * Realtime over Server-Sent Events. Not imported by chatbot/index.ts yet. The integration agent wires it in.
 *
 * Usage:
 *   const hub = createSseHub();
 *   const events = createSsePublisher(hub);          // pass as the inbox EventPublisher
 *   const streaming = createSseStreamingRuntime({ hub });
 *   const handler = createSseStreamHandler({ hub, resolveAuth });  // mount on a GET route
 */
export { createSseHub } from "./hub.ts";
export type { SseHub, SseSubscriber } from "./hub.ts";
export { createSsePublisher, createSseReplyEventSink, createSseStoreEventSink } from "./sse-publisher.ts";
export { createSseStreamingRuntime, STREAM_FAILED_CODE } from "./streaming.ts";
export type { PersistReplyInput, SseStreamingOptions } from "./streaming.ts";
export { createSseStreamHandler } from "./handler.ts";
export type { SseStreamHandler, SseStreamHandlerOptions } from "./handler.ts";
export {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_RETRY_MS,
  STREAM_FRAME_NAMES,
  SYSTEM_SCHEDULER,
  formatSseFrame,
} from "./types.ts";
export type {
  CustomerScope,
  RealtimeAuth,
  RealtimeRequest,
  RealtimeResponse,
  Scheduler,
  StaffScope,
  StreamFrameName,
  SubscriberScope,
} from "./types.ts";
