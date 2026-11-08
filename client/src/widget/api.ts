/**
 * HTTP calls the widget makes to the public endpoints. Every call has a timeout and sends no cookies.
 * The fetch implementation is injected so the logic can be tested without a network.
 */
import type { WidgetPublicConfig } from "../../../server/modules/chatbot/contracts/widget.ts";

export const WIDGET_API_PREFIX = "/api/v2/widget";
export const WIDGET_REQUEST_TIMEOUT_MS = 8000;

export interface WidgetApiOptions {
  /** Origin the widget script was loaded from. The endpoints live under it. */
  baseUrl: string;
  publicId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface WidgetSession {
  token: string;
  /** Unix seconds. */
  expiresAt: number;
}

export interface WidgetReply {
  id: string;
  role: "assistant";
  text: string;
}

export class WidgetRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "WidgetRequestError";
    this.status = status;
  }
}

/** A reply delivered by the feed (polling or the stream). Only public fields. */
export interface WidgetFeedMessage {
  id: string;
  role: "assistant" | "staff";
  text: string;
  createdAt: string;
}

export interface WidgetApi {
  loadConfig(): Promise<WidgetPublicConfig | null>;
  createSession(visitorId: string): Promise<WidgetSession>;
  sendMessage(token: string, text: string): Promise<WidgetReply>;
  /** Polling fallback: replies after the cursor, oldest first. */
  listMessages(token: string, afterId: string | null): Promise<WidgetFeedMessage[]>;
  /** Opens the server-sent event stream. The caller reads the body and must abort the signal to close it. */
  openStream(token: string, signal: AbortSignal): Promise<Response>;
}

const FEED_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Checks one feed message. Anything unexpected returns null and is ignored. */
export function parseFeedMessage(value: unknown): WidgetFeedMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  if (typeof m.id !== "string" || !FEED_ID_PATTERN.test(m.id)) return null;
  if (m.role !== "assistant" && m.role !== "staff") return null;
  if (typeof m.text !== "string" || typeof m.createdAt !== "string") return null;
  return { id: m.id, role: m.role, text: m.text, createdAt: m.createdAt };
}

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const LANGUAGE_PATTERN = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/;

/** Checks the shape of a config response. Anything unexpected returns null and the widget stays hidden. */
export function parseWidgetConfig(value: unknown, publicId: string): WidgetPublicConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Record<string, unknown>;
  if (c.publicId !== publicId) return null;
  if (typeof c.title !== "string" || typeof c.welcomeMessage !== "string") return null;
  if (c.launcherText !== null && typeof c.launcherText !== "string") return null;
  if (typeof c.primaryColor !== "string" || !COLOR_PATTERN.test(c.primaryColor)) return null;
  if (c.launcherPosition !== "bottom-left" && c.launcherPosition !== "bottom-right") return null;
  if (typeof c.language !== "string" || !LANGUAGE_PATTERN.test(c.language)) return null;
  if (typeof c.voiceEnabled !== "boolean" || typeof c.generativeUiEnabled !== "boolean") return null;
  if (!Array.isArray(c.allowedOrigins) || !c.allowedOrigins.every((o) => typeof o === "string")) return null;
  if (typeof c.assetBaseUrl !== "string") return null;
  return {
    publicId,
    title: c.title,
    welcomeMessage: c.welcomeMessage,
    launcherText: c.launcherText as string | null,
    primaryColor: c.primaryColor,
    launcherPosition: c.launcherPosition,
    language: c.language,
    voiceEnabled: c.voiceEnabled,
    generativeUiEnabled: c.generativeUiEnabled,
    allowedOrigins: c.allowedOrigins as string[],
    assetBaseUrl: c.assetBaseUrl,
  };
}

export function createWidgetApi(options: WidgetApiOptions): WidgetApi {
  const fetchFn = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? WIDGET_REQUEST_TIMEOUT_MS;
  const root = `${options.baseUrl.replace(/\/+$/, "")}${WIDGET_API_PREFIX}/${encodeURIComponent(options.publicId)}`;

  async function call(path: string, init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: unknown }): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(`${root}${path}`, {
        method: init.method,
        credentials: "omit",
        mode: "cors",
        headers: { Accept: "application/json", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...init.headers },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
      if (!response.ok) throw new WidgetRequestError(response.status, `request failed with status ${response.status}`);
      return await response.json();
    } catch (err) {
      if (err instanceof WidgetRequestError) throw err;
      throw new WidgetRequestError(0, "network request failed");
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async loadConfig() {
      try {
        const body = await call("/config", { method: "GET" });
        return parseWidgetConfig(body, options.publicId);
      } catch {
        return null;
      }
    },

    async createSession(visitorId) {
      const body = (await call("/session", { method: "POST", body: { visitorId } })) as Partial<WidgetSession> | null;
      if (!body || typeof body.token !== "string" || typeof body.expiresAt !== "number") {
        throw new WidgetRequestError(0, "unexpected session response");
      }
      return { token: body.token, expiresAt: body.expiresAt };
    },

    async sendMessage(token, text) {
      const body = (await call("/messages", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: { text },
      })) as { message?: Partial<WidgetReply> } | null;
      const m = body?.message;
      if (!m || typeof m.id !== "string" || typeof m.text !== "string") {
        throw new WidgetRequestError(0, "unexpected message response");
      }
      return { id: m.id, role: "assistant", text: m.text };
    },

    async listMessages(token, afterId) {
      const query = afterId ? `?after=${encodeURIComponent(afterId)}` : "";
      const body = (await call(`/messages${query}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      })) as { messages?: unknown } | null;
      if (!body || !Array.isArray(body.messages)) throw new WidgetRequestError(0, "unexpected feed response");
      const out: WidgetFeedMessage[] = [];
      for (const item of body.messages) {
        const parsed = parseFeedMessage(item);
        if (parsed) out.push(parsed);
      }
      return out;
    },

    async openStream(token, signal) {
      // No timeout here: the stream is long-lived. The caller aborts it when the widget stops or falls back.
      const response = await fetchFn(`${root}/stream`, {
        method: "GET",
        credentials: "omit",
        mode: "cors",
        headers: { Accept: "text/event-stream", Authorization: `Bearer ${token}` },
        signal,
      });
      if (!response.ok) throw new WidgetRequestError(response.status, `stream failed with status ${response.status}`);
      if (!response.body) throw new WidgetRequestError(0, "stream has no body");
      return response;
    },
  };
}
