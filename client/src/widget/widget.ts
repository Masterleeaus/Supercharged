/**
 * The widget view: launcher bubble, window with a header, welcome banner, message list and input.
 * All text is written with textContent. The session token lives in memory only.
 */
import type { WidgetPublicConfig } from "../../../server/modules/chatbot/contracts/widget.ts";
import { WidgetRequestError, type WidgetApi, type WidgetSession } from "./api.ts";
import { el, iconSvg, ICON_CHAT, ICON_CLOSE, ICON_SEND } from "./dom.ts";
import { createMessageSync } from "./sync.ts";
import { injectWidgetStyles, safePrimary } from "./styles.ts";

export const WIDGET_ROOT_ID = "titan-chat-widget";
export const WIDGET_MAX_INPUT = 2000;
/** Refresh the session this many seconds before it expires. */
const SESSION_REFRESH_MARGIN_SECONDS = 60;

export interface MountOptions {
  doc: Document;
  config: WidgetPublicConfig;
  api: WidgetApi;
  visitorId: string;
  now?: () => number;
}

export interface MountedWidget {
  root: HTMLElement;
  open(): void;
  close(): void;
}

export function mountWidget(options: MountOptions): MountedWidget {
  const { doc, config, api, visitorId } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const launcherText = config.launcherText && config.launcherText.length > 0 ? config.launcherText : null;
  const titleText = config.title || "Chat";
  const panelId = "titan-chat-panel";

  injectWidgetStyles(doc);

  const root = el(doc, "div", {
    id: WIDGET_ROOT_ID,
    class: config.launcherPosition === "bottom-left" ? "tcw-left" : "tcw-right",
    "data-open": "false",
  });
  root.style.setProperty("--tcw-primary", safePrimary(config.primaryColor));

  // Launcher
  const launcher = el(doc, "button", {
    type: "button",
    class: "tcw-launcher",
    "aria-label": launcherText ? undefined : `Open ${titleText}`,
    "aria-expanded": "false",
    "aria-controls": panelId,
  }, [iconSvg(doc, ICON_CHAT), ...(launcherText ? [launcherText] : [])]);

  // Panel
  const closeBtn = el(doc, "button", { type: "button", class: "tcw-close", "aria-label": "Close chat" }, [iconSvg(doc, ICON_CLOSE)]);
  const header = el(doc, "div", { class: "tcw-header" }, [el(doc, "h2", { class: "tcw-title" }, [titleText]), closeBtn]);
  const banner = el(doc, "p", { class: config.welcomeMessage ? "tcw-banner" : "tcw-banner tcw-hidden" }, [config.welcomeMessage]);
  const log = el(doc, "div", { class: "tcw-log", role: "log", "aria-live": "polite" });
  const input = el(doc, "textarea", {
    class: "tcw-input",
    rows: "1",
    maxlength: String(WIDGET_MAX_INPUT),
    placeholder: "Type a message",
    "aria-label": "Message",
  });
  const sendBtn = el(doc, "button", { type: "submit", class: "tcw-send", "aria-label": "Send" }, [iconSvg(doc, ICON_SEND)]);
  const form = el(doc, "form", { class: "tcw-form" }, [input, sendBtn]);
  const panel = el(doc, "section", { id: panelId, class: "tcw-panel", role: "dialog", "aria-label": titleText }, [header, banner, log, form]);

  root.append(launcher, panel);
  doc.body.append(root);

  let session: WidgetSession | null = null;
  let busy = false;

  function setOpen(open: boolean): void {
    root.setAttribute("data-open", open ? "true" : "false");
    launcher.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) input.focus();
    else launcher.focus();
  }

  function addMessage(kind: "user" | "assistant" | "error", text: string): void {
    const cls = kind === "user" ? "tcw-msg tcw-msg-user" : kind === "assistant" ? "tcw-msg tcw-msg-assistant" : "tcw-msg tcw-msg-error";
    log.append(el(doc, "div", { class: cls }, [text]));
    log.scrollTop = log.scrollHeight;
  }

  async function ensureSession(): Promise<string> {
    if (session && session.expiresAt - now() > SESSION_REFRESH_MARGIN_SECONDS) return session.token;
    session = await api.createSession(visitorId);
    return session.token;
  }

  // Replies can arrive from the send response or from the feed (stream or poll). Each id is shown once.
  const shownIds = new Set<string>();
  function showReply(id: string, text: string): void {
    if (shownIds.has(id)) return;
    shownIds.add(id);
    sync.markSeen(id);
    addMessage("assistant", text);
  }

  // Started after the first send, so a page view alone never opens a session or a stream.
  const sync = createMessageSync({
    api,
    getToken: ensureSession,
    onMessage: (message) => showReply(message.id, message.text),
  });

  async function onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const text = input.value.trim();
    if (text.length === 0) return;
    busy = true;
    input.disabled = true;
    sendBtn.disabled = true;
    input.value = "";
    addMessage("user", text);
    try {
      const token = await ensureSession();
      const reply = await api.sendMessage(token, text);
      showReply(reply.id, reply.text);
      sync.start();
    } catch (err) {
      // An expired or refused token is dropped, so the next send asks for a new one.
      if (err instanceof WidgetRequestError && (err.status === 401 || err.status === 403)) session = null;
      addMessage("error", "Something went wrong. Please try again.");
    } finally {
      busy = false;
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  launcher.addEventListener("click", () => setOpen(true));
  closeBtn.addEventListener("click", () => setOpen(false));
  form.addEventListener("submit", (event) => void onSubmit(event));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && root.getAttribute("data-open") === "true") setOpen(false);
  });

  return {
    root,
    open: () => setOpen(true),
    close: () => setOpen(false),
  };
}
