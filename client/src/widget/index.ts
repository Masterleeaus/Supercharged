/**
 * Widget entry point. Loaded with a plain script tag:
 *   <script src="https://<host>/widget/titan-chat.js" data-chatbot-id="<public id>" async></script>
 * The script takes its endpoint origin from its own src. It runs no inline script from the server, and it holds no credentials.
 */
import { createWidgetApi } from "./api.ts";
import { mountWidget } from "./widget.ts";
import { getVisitorId, type KeyValueStore } from "./visitor.ts";

const PUBLIC_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SCRIPT_ATTRIBUTE = "data-chatbot-id";

function findScript(doc: Document): HTMLScriptElement | null {
  const current = doc.currentScript;
  if (current instanceof HTMLScriptElement && current.hasAttribute(SCRIPT_ATTRIBUTE)) return current;
  return doc.querySelector<HTMLScriptElement>(`script[${SCRIPT_ATTRIBUTE}]`);
}

/** Starts the widget. Returns false (and does nothing) when the script tag, id or config is missing or refused. */
export async function startWidget(doc: Document = document, fetchImpl?: typeof fetch): Promise<boolean> {
  const script = findScript(doc);
  if (!script) return false;
  const publicId = script.getAttribute(SCRIPT_ATTRIBUTE) ?? "";
  if (!PUBLIC_ID_PATTERN.test(publicId)) return false;
  let baseUrl: string;
  try {
    baseUrl = new URL(script.src).origin;
  } catch {
    return false;
  }

  const api = createWidgetApi({ baseUrl, publicId, fetchImpl });
  const config = await api.loadConfig();
  if (!config) return false;

  let store: KeyValueStore | null = null;
  try {
    store = globalThis.localStorage ?? null;
  } catch {
    store = null;
  }
  mountWidget({ doc, config, api, visitorId: getVisitorId(store) });
  return true;
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  const boot = () => void startWidget(document);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
