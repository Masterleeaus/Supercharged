/**
 * Port of GenerativeUiResponseComposer (Chatbot extension, System/GenerativeUI/GenerativeUiResponseComposer.php).
 *
 * Decides when a reply should carry a generated interface, builds the instruction block sent to the
 * model, and turns a model reply into an accepted spec or a plain-text fallback. No model is called
 * here. The caller supplies the raw reply text.
 */
import type { BuilderRegistry } from "./builder-registry.ts";
import { repairSpec, type SpecChange } from "./spec-normaliser.ts";
import { validateSpec } from "./spec-validator.ts";
import { isPhpArray, isPlainObject, orElse, phpTrim, readKey, type Obj } from "./semantics.ts";

export interface ComposerOptions {
  /** Port of chatbot.generative_ui.enabled. */
  enabled: boolean;
  /** Port of chatbot.generative_ui.natural_language_triggers. */
  naturalLanguageTriggers: boolean;
  /** Port of chatbot.generative_ui.preferred_chat_elements. */
  preferredChatElements: number;
}

export const DEFAULT_COMPOSER_OPTIONS: ComposerOptions = {
  enabled: true,
  naturalLanguageTriggers: true,
  preferredChatElements: 50,
};

export interface ComposeResult {
  accepted: boolean;
  fallbackText: string;
  spec: Obj | null;
  changes: SpecChange[];
  issues: Array<{ path: string; message: string }>;
}

export interface DecodedEnvelope {
  fallbackText: string;
  spec: Obj;
  meta: Obj;
}

const FENCE_STRIP = /```titan-ui[\s\S]*?```/gi;
const FENCE_CAPTURE = /```titan-ui\s*([\s\S]*?)```/i;
const EXPLICIT_COMMAND = /^\/(?:ui|interface|canvas)\b/i;
const NATURAL_REQUEST =
  /\b(?:show|build|create|design|render|generate|display|make)\b.{0,80}\b(?:dashboard|form|interface|ui|card|table|calendar|schedule|quote|invoice|portal|kanban|chart|report|workspace|preview)\b/i;

/**
 * Plain-text form of a reply: the titan-ui fence removed and the rest trimmed. When that leaves nothing, the
 * whole trimmed reply is used. Raw UI JSON is never shown as text.
 */
export function plainFallbackText(response: string): string {
  const stripped = phpTrim(response.replace(FENCE_STRIP, ""));
  return orElse(stripped, phpTrim(response));
}

/** True when the user asked for an interface, either with /ui, /interface or /canvas or in plain words. */
export function shouldGenerate(prompt: string, options: ComposerOptions = DEFAULT_COMPOSER_OPTIONS): boolean {
  if (!options.enabled) return false;

  const trimmed = phpTrim(prompt);
  if (EXPLICIT_COMMAND.test(trimmed)) return true;
  if (!options.naturalLanguageTriggers) return false;

  return NATURAL_REQUEST.test(trimmed);
}

/** Wraps the user prompt with the presentation-only instructions sent to the model. */
export function augmentPrompt(
  prompt: string,
  registry: BuilderRegistry,
  surface = "chat",
  options: ComposerOptions = DEFAULT_COMPOSER_OPTIONS,
): string {
  const components = registry.componentIds().join(", ");
  const actions = registry.actionIds().join(", ");
  const max = Math.trunc(options.preferredChatElements);

  // Mirrors the PHP heredoc line for line, including the blank line before "USER REQUEST:".
  return [
    "[SYSTEM: TITAN ZERO PRESENTATION-ONLY UI COMPOSER]",
    "The user explicitly requested a generated interface. Return one concise explanation followed by exactly one fenced `titan-ui` JSON block.",
    `Use this flat structure: {"version":"1.1","authority":"presentation-only","surface":"${surface}","root":"root","state":{},"meta":{"title":"Generated interface"},"persistence":{"scope":"message"},"elements":{"root":{"type":"stack","props":{},"children":[]}}}.`,
    `Allowed components: ${components}.`,
    `Allowed action intents: ${actions}.`,
    `Use fewer than ${max} elements for chat. Every child must reference an existing element. Prefer compact summaries with progressive disclosure and canvas expansion for complex layouts. Use state, read-only data, visibility, repeats and accessible labels where useful. Never output HTML, Blade, JavaScript, SQL, credentials or claims that an action executed. Actions are preview intents only. Use AUD for generic currency examples.`,
    "[END SYSTEM]",
    "",
    "USER REQUEST:",
    prompt,
  ].join("\n");
}

/**
 * Reads a model reply. When it contains one titan-ui fence that repairs and validates, the spec is
 * accepted. Otherwise the reply falls back to its plain text with the fence removed.
 */
export function composeResponse(response: string, registry: BuilderRegistry, surface = "chat"): ComposeResult {
  const fallback = phpTrim(response.replace(FENCE_STRIP, ""));

  const match = FENCE_CAPTURE.exec(response);
  if (!match) {
    return {
      accepted: false,
      fallbackText: plainFallbackText(response),
      spec: null,
      changes: [],
      issues: [{ path: "/", message: "No titan-ui block was returned." }],
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(phpTrim(match[1]));
  } catch {
    decoded = undefined;
  }
  if (!isPhpArray(decoded)) {
    return {
      accepted: false,
      fallbackText: orElse(fallback, "The generated interface could not be decoded."),
      spec: null,
      changes: [],
      issues: [{ path: "/", message: "The titan-ui block is not valid JSON." }],
    };
  }

  const repair = repairSpec(decoded as Obj, registry, surface);
  const validation = validateSpec(repair.spec, registry);
  if (!validation.valid) {
    return {
      accepted: false,
      fallbackText: orElse(fallback, "The generated interface was rejected by the safety validator."),
      spec: null,
      changes: repair.changes,
      issues: validation.issues,
    };
  }

  let text = fallback;
  if (repair.changes.length > 0) {
    text = phpTrim(
      `${orElse(fallback, "Here is the generated interface.")} Minor presentation-schema drift was repaired before rendering.`,
    );
  }

  return {
    accepted: true,
    fallbackText: orElse(text, "Here is the generated interface."),
    spec: validation.spec,
    changes: repair.changes,
    issues: [],
  };
}

/** Wire format for a stored generated interface. Keys match the Chatbot extension's envelope. */
export function encodeEnvelope(fallbackText: string, spec: Obj): string {
  return JSON.stringify({
    type: "titan-ui",
    version: "1.1",
    authority: "presentation-only",
    fallback_text: fallbackText,
    spec,
  });
}

/** Reads a stored envelope. Returns null unless it is well formed and the spec still validates. */
export function decodeEnvelope(payload: string | null | undefined, registry: BuilderRegistry): DecodedEnvelope | null {
  if (typeof payload !== "string" || payload === "") return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isPlainObject(decoded) || readKey(decoded, "type") !== "titan-ui" || !isPhpArray(readKey(decoded, "spec"))) {
    return null;
  }

  const spec = readKey(decoded, "spec") as Obj;
  const validation = validateSpec(spec, registry);
  if (!validation.valid) return null;

  const fallback = readKey(decoded, "fallback_text");
  const meta = readKey(validation.spec, "meta");
  return {
    fallbackText: typeof fallback === "string" ? fallback : "Generated interface",
    spec: validation.spec,
    meta: isPhpArray(meta) ? meta : {},
  };
}
