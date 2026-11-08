/**
 * Port of GenerativeUiSpecNormaliser (Chatbot extension, System/GenerativeUI/GenerativeUiSpecNormaliser.php).
 *
 * Normalises and repairs presentation-only UI specifications. It never runs actions and never
 * resolves business data. All functions are pure; the registry is passed in.
 */
import type { BuilderRegistry } from "./builder-registry.ts";
import {
  defineOwn,
  hasKey,
  isPhpArray,
  isPhpList,
  isPlainObject,
  issetKey,
  phpValues,
  readKey,
  type Obj,
} from "./semantics.ts";

export const SUPPORTED_SURFACES = ["chat", "builder", "page", "canvas", "mobile", "preview"] as const;
export const MAX_ELEMENTS = 250;

export interface SpecChange {
  path: string;
  message: string;
}

export function isSupportedSurface(value: unknown): value is (typeof SUPPORTED_SURFACES)[number] {
  return typeof value === "string" && (SUPPORTED_SURFACES as readonly string[]).includes(value);
}

/** Fills in the top-level defaults. Does not inspect element contents. */
export function normaliseSpec(spec: Obj, defaultSurface = "chat"): Obj {
  const rawElements = readKey(spec, "elements");
  const elements: Obj = isPlainObject(rawElements) && !isPhpList(rawElements) ? rawElements : {};

  const rawRoot = readKey(spec, "root");
  // Port note: JS orders integer-like keys first, PHP keeps insertion order. Such keys are rejected by the
  // validator either way, so the outcome is the same.
  const root: string =
    typeof rawRoot === "string" && rawRoot !== "" ? rawRoot : (Object.keys(elements)[0] ?? "root");

  const rawSurface = readKey(spec, "surface");
  const surface = isSupportedSurface(rawSurface)
    ? rawSurface
    : isSupportedSurface(defaultSurface)
      ? defaultSurface
      : "chat";

  const rawState = readKey(spec, "state");
  const rawMeta = readKey(spec, "meta");
  const rawPersistence = readKey(spec, "persistence");

  return {
    ...spec,
    version: "1.1",
    surface,
    authority: "presentation-only",
    root,
    state: isPhpArray(rawState) ? rawState : {},
    meta: isPhpArray(rawMeta) ? rawMeta : {},
    persistence: rawPersistence === false ? false : isPhpArray(rawPersistence) ? rawPersistence : {},
    elements,
  };
}

const ALERT_FALLBACK_ROOT = "root";

function alertElement(tone: string, title: string, message: string): Obj {
  return { type: "alert", props: { tone, title, message } };
}

/** Binding list as PHP reads it: a list is a list of bindings, anything else is one binding. */
function bindingList(bindings: unknown): unknown[] {
  return isPhpArray(bindings) && isPhpList(bindings) ? phpValues(bindings) : [bindings];
}

/** Identical-array check for `$children !== $original`. */
function sameChildren(original: unknown, repaired: string[]): boolean {
  if (!Array.isArray(original) || original.length !== repaired.length) return false;
  return original.every((value, index) => value === repaired[index]);
}

/**
 * Repairs drift that can be fixed safely: trims oversized specs, swaps unknown components for a
 * warning alert, drops missing children and unsupported action bindings. Returns the repaired spec and
 * a list of what changed.
 */
export function repairSpec(
  input: Obj,
  registry: BuilderRegistry,
  defaultSurface = "chat",
): { spec: Obj; changes: SpecChange[] } {
  const base = normaliseSpec(input, defaultSurface);
  const changes: SpecChange[] = [];
  const componentIds = new Set(registry.componentIds());
  const actionIds = new Set(registry.actionIds());

  let elements: Obj = base.elements;
  let root: string = base.root;

  const entries = Object.entries(elements);
  if (entries.length > MAX_ELEMENTS) {
    elements = Object.fromEntries(entries.slice(0, MAX_ELEMENTS));
    changes.push({ path: "/elements", message: "Trimmed the specification to the maximum element count." });
  }

  if (!issetKey(elements, root)) {
    root = Object.keys(elements)[0] ?? ALERT_FALLBACK_ROOT;
    changes.push({ path: "/root", message: "Selected the first valid element as the root." });
  }

  if (Object.keys(elements).length === 0) {
    elements = {
      [ALERT_FALLBACK_ROOT]: alertElement(
        "warning",
        "Interface repaired",
        "The generated specification did not contain renderable elements.",
      ),
    };
    root = ALERT_FALLBACK_ROOT;
    changes.push({ path: "/elements", message: "Inserted a safe fallback element." });
  }

  const repaired: Obj = {};
  for (const [key, original] of Object.entries(elements)) {
    if (!isPhpArray(original)) {
      defineOwn(repaired, key, alertElement("warning", "Invalid element", `Element ${key} was repaired.`));
      changes.push({ path: `/elements/${key}`, message: "Replaced a malformed element with a safe alert." });
      continue;
    }

    let element: Obj = { ...(original as Obj) };
    const type = readKey(element, "type");

    if (typeof type !== "string" || !componentIds.has(type)) {
      const unsupported = typeof type === "string" ? type : "unknown";
      element = {
        ...element,
        type: "alert",
        props: {
          tone: "warning",
          title: "Unsupported component",
          message: `The ${unsupported} component is not available in this catalogue.`,
        },
      };
      delete element.children;
      delete element.repeat;
      delete element.on;
      delete element.watch;
      changes.push({ path: `/elements/${key}/type`, message: "Replaced an unknown component with a safe alert." });
    }

    const props = readKey(element, "props");
    element.props = isPhpArray(props) ? props : {};

    if (issetKey(element, "children")) {
      const originalChildren = element.children;
      const children = phpValues(isPhpArray(originalChildren) ? originalChildren : []).filter(
        (child): child is string => typeof child === "string" && hasKey(elements, child),
      );
      if (!sameChildren(originalChildren, children)) {
        changes.push({ path: `/elements/${key}/children`, message: "Removed missing child references." });
      }
      element.children = children;
    }

    for (const group of ["on", "watch"] as const) {
      const bindingsByEvent = readKey(element, group);
      if (!isPhpArray(bindingsByEvent)) {
        delete element[group];
        continue;
      }

      const kept: Obj = {};
      for (const [event, bindings] of Object.entries(bindingsByEvent)) {
        const safe = bindingList(bindings).filter(
          (binding): binding is Obj =>
            isPhpArray(binding) &&
            typeof readKey(binding, "action") === "string" &&
            actionIds.has(readKey(binding, "action")),
        );
        if (safe.length === 0) {
          changes.push({
            path: `/elements/${key}/${group}/${event}`,
            message: "Removed unsupported action bindings.",
          });
        } else {
          defineOwn(kept, event, safe.length === 1 ? safe[0] : safe);
        }
      }

      if (Object.keys(kept).length === 0) {
        delete element[group];
      } else {
        element[group] = kept;
      }
    }

    defineOwn(repaired, key, element);
  }

  return { spec: { ...base, root, elements: repaired }, changes };
}
