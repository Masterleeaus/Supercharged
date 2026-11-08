/**
 * Keeps the widget's message list up to date with replies that arrive after a send.
 *
 * Uses the server-sent event stream when the server offers it. If the stream is not offered (404, 405 or 501),
 * or the browser cannot read a stream, it polls the feed instead. A stream that drops is reopened with a backoff,
 * and the widget catches up with one poll after each drop.
 *
 * The stream is read with fetch, not EventSource, so the Authorization header can be sent. The session token never
 * goes into the URL.
 */
import { WidgetRequestError, parseFeedMessage, type WidgetApi, type WidgetFeedMessage } from "./api.ts";

export const SYNC_POLL_INTERVAL_MS = 4000;
export const SYNC_RECONNECT_MS = 5000;
export const SYNC_MAX_BACKOFF_MS = 60_000;
const SEEN_LIMIT = 500;
const STREAM_UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([404, 405, 501]);

export type SyncMode = "idle" | "stream" | "poll";

export interface MessageSyncOptions {
  api: WidgetApi;
  /** Returns a valid session token. Called again on every reconnect, so a refreshed token is used. */
  getToken(): Promise<string>;
  onMessage(message: WidgetFeedMessage): void;
  pollIntervalMs?: number;
  reconnectMs?: number;
  /** false forces polling only. */
  preferStream?: boolean;
  /** Injected for tests. The default checks for fetch, ReadableStream and TextDecoder. */
  streamSupported?: () => boolean;
}

export interface MessageSync {
  start(): void;
  stop(): void;
  mode(): SyncMode;
  /** Records an id the widget already shows, so the same reply is never shown twice. */
  markSeen(id: string): void;
}

export interface SseFrame {
  event: string;
  data: string;
}

/** Splits complete frames off the buffer. Returns the frames and the unfinished tail. Input must use LF line ends. */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const pieces = buffer.split("\n\n");
  const rest = pieces.pop() ?? "";
  const frames: SseFrame[] = [];
  for (const piece of pieces) {
    let event = "message";
    const data: string[] = [];
    for (const line of piece.split("\n")) {
      if (line.startsWith(":") || line.length === 0) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length > 0) frames.push({ event, data: data.join("\n") });
  }
  return { frames, rest };
}

export function defaultStreamSupported(): boolean {
  return typeof fetch === "function" && typeof ReadableStream !== "undefined" && typeof TextDecoder !== "undefined";
}

export function createMessageSync(options: MessageSyncOptions): MessageSync {
  const pollMs = options.pollIntervalMs ?? SYNC_POLL_INTERVAL_MS;
  const reconnectMs = options.reconnectMs ?? SYNC_RECONNECT_MS;
  const supported = options.streamSupported ?? defaultStreamSupported;

  let running = false;
  let currentMode: SyncMode = "idle";
  let cursor: string | null = null;
  let streamAvailable = options.preferStream !== false && supported();
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wakeup: (() => void) | null = null;
  const seen = new Set<string>();
  const seenOrder: string[] = [];

  /** True the first time an id is seen. */
  function remember(id: string): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    seenOrder.push(id);
    if (seenOrder.length > SEEN_LIMIT) {
      const oldest = seenOrder.shift();
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  }

  function deliver(message: WidgetFeedMessage): void {
    if (!remember(message.id)) return;
    cursor = message.id;
    options.onMessage(message);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      wakeup = resolve;
      timer = setTimeout(() => {
        timer = null;
        wakeup = null;
        resolve();
      }, ms);
    });
  }

  async function pollOnce(): Promise<void> {
    try {
      const token = await options.getToken();
      const list = await options.api.listMessages(token, cursor);
      for (const message of list) deliver(message);
    } catch {
      // Retried on the next round. The widget shows nothing for a failed poll.
    }
  }

  async function readStream(): Promise<void> {
    const token = await options.getToken();
    controller = new AbortController();
    const response = await options.api.openStream(token, controller.signal);
    currentMode = "stream";
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (running) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      const parsed = parseSseFrames(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.event !== "message") continue;
        let json: unknown = null;
        try {
          json = JSON.parse(frame.data);
        } catch {
          continue;
        }
        const message = parseFeedMessage(json);
        if (message) deliver(message);
      }
    }
  }

  async function run(): Promise<void> {
    let failures = 0;
    while (running) {
      if (streamAvailable) {
        try {
          await readStream();
          failures = 0;
        } catch (err) {
          if (!running) break;
          if (err instanceof WidgetRequestError && STREAM_UNAVAILABLE_STATUSES.has(err.status)) streamAvailable = false;
          else failures += 1;
        } finally {
          controller = null;
        }
        if (!running) break;
      }
      currentMode = "poll";
      await pollOnce();
      if (!running) break;
      const wait = streamAvailable
        ? Math.min(reconnectMs * Math.max(1, failures), SYNC_MAX_BACKOFF_MS)
        : pollMs;
      await sleep(wait);
    }
    currentMode = "idle";
  }

  return {
    start() {
      if (running) return;
      running = true;
      void run();
    },
    stop() {
      running = false;
      currentMode = "idle";
      controller?.abort();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const wake = wakeup;
      wakeup = null;
      wake?.();
    },
    mode: () => currentMode,
    markSeen(id: string) {
      remember(id);
    },
  };
}
