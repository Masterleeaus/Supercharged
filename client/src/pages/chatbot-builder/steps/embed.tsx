/**
 * Test and embed step (core: edit-step-embed.blade.php).
 *
 * - The snippet uses embed.uuid, the public id from the contract (types.ts). It is not the internal chatbot id.
 *   The runtime calls /api/v2/chatbot/<uuid> and /chatbot/<uuid>/frame on the host it loads from.
 * - The script URL is VITE_CHATBOT_WIDGET_BASE_URL plus /vendor/chatbot/js/external-chatbot.js. When the variable
 *   is unset, the current page origin is used. The snippet holds no secret or token.
 * - Trusted domains are part of the embed group and are saved by the shell's Save.
 * - Iframe width and height are local to this step. Core does not save them.
 * - The inactive warning reads the saved flag from GET /api/chatbot/chatbots (EXISTS).
 * - The install check is EXTERNAL. Desk has no route for it, so it shows a pending state and makes no call.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { CHATBOTS_QUERY_KEY, listChatbots } from "../api";
import { BUILDER_LIMITS, type StepProps } from "../types";

const WIDGET_SCRIPT_PATH = "/vendor/chatbot/js/external-chatbot.js";
const FRAME_MIN = 100;
const FRAME_MAX = 1000;
const FRAME_STEP = 50;
const DEFAULT_FRAME_WIDTH = 400;
const DEFAULT_FRAME_HEIGHT = 600;
/** Hostname only, no protocol, path or port. The runtime compares against window.location.hostname. */
const HOSTNAME_PATTERN = /^(localhost|([a-z0-9-]+\.)+[a-z0-9-]{2,})$/;

/** Script URL from configuration. Falls back to the page origin when the variable is not set. */
export function widgetScriptUrl(): string {
  const configured = import.meta.env.VITE_CHATBOT_WIDGET_BASE_URL?.trim() ?? "";
  const base = configured !== "" ? configured : window.location.origin;
  return `${base.replace(/\/+$/, "")}${WIDGET_SCRIPT_PATH}`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Builds the paste-ready snippet. Attribute names match what external-chatbot.js reads. */
export function buildEmbedSnippet(scriptUrl: string, publicId: string, width: number, height: number): string {
  return [
    "<script",
    "  defer",
    `  src="${escapeAttribute(scriptUrl)}"`,
    `  data-chatbot-uuid="${escapeAttribute(publicId)}"`,
    `  data-iframe-width="${width}"`,
    `  data-iframe-height="${height}"`,
    "></script>",
  ].join("\n");
}

function normaliseHost(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .replace(/\.$/, "");
}

/** Splits the textarea into valid hostnames and entries that were rejected. Duplicates are dropped. */
export function parseTrustedDomains(text: string): { domains: string[]; invalid: string[] } {
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const entry = normaliseHost(raw);
    if (entry === "") continue;
    if (!HOSTNAME_PATTERN.test(entry)) {
      invalid.push(raw.trim());
      continue;
    }
    if (!domains.includes(entry)) domains.push(entry);
  }
  return { domains, invalid };
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** Clipboard API first, then a hidden textarea with execCommand for browsers or contexts without it. */
async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or not allowed here. Fall through to the legacy path.
    }
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  field.style.left = "-9999px";
  document.body.appendChild(field);
  field.select();
  field.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(field);
  }
  return ok;
}

export default function EmbedStep({ value, onChange, chatbotId, disabled }: StepProps<"embed">) {
  const { toast } = useToast();
  const [domainText, setDomainText] = useState(() => value.trustedDomains.join(", "));
  const [frameWidth, setFrameWidth] = useState(DEFAULT_FRAME_WIDTH);
  const [frameHeight, setFrameHeight] = useState(DEFAULT_FRAME_HEIGHT);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  // The last list this step sent. A value that differs from it came from outside (for example a discarded draft).
  const lastSent = useRef(value.trustedDomains);
  useEffect(() => {
    if (!sameList(value.trustedDomains, lastSent.current)) {
      lastSent.current = value.trustedDomains;
      setDomainText(value.trustedDomains.join(", "));
    }
  }, [value.trustedDomains]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const chatbotsQuery = useQuery({
    queryKey: CHATBOTS_QUERY_KEY,
    queryFn: () => listChatbots(),
    enabled: chatbotId !== null,
  });
  const savedRecord = chatbotId ? chatbotsQuery.data?.find((c) => c.id === chatbotId) : undefined;
  const isInactive = savedRecord !== undefined && !savedRecord.active;

  const parsed = parseTrustedDomains(domainText);
  const overLimit = parsed.domains.length > BUILDER_LIMITS.trustedDomains;

  function handleDomainsChange(text: string) {
    setDomainText(text);
    const next = parseTrustedDomains(text).domains;
    // Over the limit: keep the last valid list and show the message instead of sending.
    if (next.length > BUILDER_LIMITS.trustedDomains) return;
    lastSent.current = next;
    onChange({ trustedDomains: next });
  }

  const publicId = value.uuid;
  const snippet = publicId
    ? buildEmbedSnippet(widgetScriptUrl(), publicId, frameWidth, frameHeight)
    : null;

  async function copySnippet() {
    if (snippet === null) return;
    const ok = await copyText(snippet);
    setCopyState(ok ? "copied" : "failed");
    if (ok) toast({ title: "Embed code copied" });
  }

  return (
    <div className="space-y-6">
      {isInactive && (
        <Alert>
          <AlertTitle>This chatbot is not active</AlertTitle>
          <AlertDescription>
            The embed will not work on your site until the chatbot is active. Turn it on in the Configure step and
            save.
          </AlertDescription>
        </Alert>
      )}

      <section className="space-y-3">
        <Label className="text-sm font-semibold">Trusted domains</Label>
        <Textarea
          rows={3}
          className="font-mono text-xs"
          placeholder="example.com, shop.example.com"
          value={domainText}
          disabled={disabled}
          onChange={(e) => handleDomainsChange(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Separate hostnames with commas or new lines. When the list is not empty, the chatbot only loads on these
          hostnames. Leave it empty to allow every site. Saved with Save.
        </p>
        {parsed.invalid.length > 0 && (
          <p className="text-xs text-destructive">
            Not valid hostnames, so not saved: {parsed.invalid.join(", ")}
          </p>
        )}
        {overLimit && (
          <p className="text-xs text-destructive">
            Up to {BUILDER_LIMITS.trustedDomains} domains. The last valid list is kept until you remove some.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <Label className="text-sm font-semibold">Embed code</Label>
        {snippet !== null ? (
          <>
            <Textarea
              readOnly
              rows={7}
              className="font-mono text-xs"
              value={snippet}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Embed code"
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" onClick={() => void copySnippet()} disabled={copyState === "copied"}>
                {copyState === "copied" ? (
                  <Check className="mr-1.5 h-4 w-4" />
                ) : (
                  <Copy className="mr-1.5 h-4 w-4" />
                )}
                {copyState === "copied" ? "Copied" : "Copy embed code"}
              </Button>
              {copyState === "failed" && (
                <span className="text-xs text-destructive">
                  Could not copy automatically. Select the code above and copy it by hand.
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Paste this just before the closing body tag of your site, then reload the page to check.
            </p>
          </>
        ) : (
          <Alert>
            <AlertDescription>
              {chatbotId === null
                ? "Save the chatbot to get its embed code."
                : "The embed code is not ready yet. The chatbot has no public id."}
            </AlertDescription>
          </Alert>
        )}
      </section>

      <section className="space-y-4">
        <Label className="text-sm font-semibold">Preview size</Label>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span>Width</span>
            <span className="font-mono">{frameWidth}px</span>
          </div>
          <Slider
            min={FRAME_MIN}
            max={FRAME_MAX}
            step={FRAME_STEP}
            value={[frameWidth]}
            disabled={disabled}
            onValueChange={([v]) => setFrameWidth(v)}
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span>Height</span>
            <span className="font-mono">{frameHeight}px</span>
          </div>
          <Slider
            min={FRAME_MIN}
            max={FRAME_MAX}
            step={FRAME_STEP}
            value={[frameHeight]}
            disabled={disabled}
            onValueChange={([v]) => setFrameHeight(v)}
          />
        </div>
        <p className="text-xs text-muted-foreground">Sets the data-iframe-width and data-iframe-height attributes in the code. Not saved.</p>
      </section>

      <section className="space-y-3">
        <Label className="text-sm font-semibold">Check installation</Label>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" disabled>
            Check installation
          </Button>
          <Badge variant="outline">Pending</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Desk has no route that checks whether the code is on your site yet (EXTERNAL). Nothing is checked, so no
          result is shown.
        </p>
      </section>
    </div>
  );
}
