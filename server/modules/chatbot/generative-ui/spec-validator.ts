/**
 * Port of GenerativeUiSpecValidator (Chatbot extension, System/GenerativeUI/GenerativeUiSpecValidator.php).
 *
 * Validates presentation-only UI specifications: component types, action allow-list, safe pointers,
 * visibility conditions, tree shape and size limits. Pure function; the registry is passed in.
 */
import type { BuilderRegistry } from "./builder-registry.ts";
import { MAX_ELEMENTS, normaliseSpec } from "./spec-normaliser.ts";
import {
  arrWrap,
  byteLength,
  hasKey,
  isPhpArray,
  isPhpList,
  isPhpStringKey,
  issetKey,
  phpStringCast,
  phpValues,
  readKey,
  type Obj,
} from "./semantics.ts";

export type IssueSeverity = "error" | "warning";

export interface SpecIssue {
  path: string;
  message: string;
  severity: IssueSeverity;
}

export interface SpecValidation {
  valid: boolean;
  issues: SpecIssue[];
  spec: Obj;
}

const MAX_DEPTH = 30;
const MAX_CHILDREN = 60;
const MAX_ACTION_CHAIN = 12;
const MAX_STATE_BYTES = 262144;
const MAX_STRING_BYTES = 20000;
const MAX_POINTER_BYTES = 512;
const SUPPORTED_VERSIONS = ["1.0", "1.1"] as const;
const SUPPORTED_SURFACES = ["chat", "builder", "page", "canvas", "mobile", "preview"] as const;
const UNSAFE_PROP_KEYS = ["html", "rawHtml", "innerHTML", "dangerouslySetInnerHTML", "script", "javascript"] as const;

/** Element keys: letters, digits, underscore and hyphen, 1 to 100 characters. */
export function isSafeKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(key);
}

/** JSON Pointer that is absolute, short, free of "..", and free of control characters. */
export function isSafePointer(path: unknown): boolean {
  return (
    typeof path === "string" &&
    (path === "/" || path.startsWith("/")) &&
    byteLength(path) <= MAX_POINTER_BYTES &&
    !path.includes("..") &&
    !/[\x00-\x1F\x7F]/.test(path)
  );
}

/** RFC 6901 escaping for a single pointer segment. */
export function pointerToken(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

class IssueList {
  readonly items: SpecIssue[] = [];

  error(path: string, message: string): void {
    this.items.push({ path, message, severity: "error" });
  }

  warning(path: string, message: string): void {
    this.items.push({ path, message, severity: "warning" });
  }
}

function validateSafeValues(value: unknown, path: string, issues: IssueList, depth: number): void {
  if (depth > MAX_DEPTH) {
    issues.error(path, "Value is nested too deeply.");
    return;
  }
  if (typeof value === "string" && byteLength(value) > MAX_STRING_BYTES) {
    issues.error(path, "String value exceeds the maximum safe length.");
    return;
  }
  if (!isPhpArray(value)) return;

  for (const [key, child] of Object.entries(value as Obj)) {
    if ((UNSAFE_PROP_KEYS as readonly string[]).includes(key)) {
      issues.error(`${path}/${pointerToken(key)}`, "Raw HTML or script properties are not permitted.");
    }
    validateSafeValues(child, `${path}/${pointerToken(key)}`, issues, depth + 1);
  }
}

function validateVisibility(condition: unknown, path: string, issues: IssueList, depth: number): void {
  if (depth > MAX_DEPTH) {
    issues.error(path, "Visibility condition is nested too deeply.");
    return;
  }
  if (typeof condition === "boolean") return;
  if (!isPhpArray(condition)) {
    issues.error(path, "Visibility must be a boolean, condition or condition array.");
    return;
  }
  if (isPhpList(condition)) {
    phpValues(condition).forEach((child, index) => validateVisibility(child, `${path}/${index}`, issues, depth + 1));
    return;
  }

  for (const operator of ["$and", "$or"] as const) {
    if (hasKey(condition, operator)) {
      const members = readKey(condition, operator);
      if (!isPhpArray(members) || !isPhpList(members)) {
        issues.error(`${path}/${operator}`, `${operator} must contain an array of conditions.`);
        return;
      }
      phpValues(members).forEach((child, index) =>
        validateVisibility(child, `${path}/${operator}/${index}`, issues, depth + 1),
      );
      return;
    }
  }

  const hasSource =
    isSafePointer(readKey(condition, "$state") ?? null) ||
    isSafePointer(readKey(condition, "$data") ?? null) ||
    typeof readKey(condition, "$item") === "string" ||
    readKey(condition, "$index") === true;
  if (!hasSource) {
    issues.error(path, "Visibility condition requires $state, $data, $item or $index.");
  }
}

function validateActionBinding(binding: unknown, path: string, issues: IssueList, allowed: Set<string>): void {
  if (!isPhpArray(binding)) {
    issues.error(path, "Action binding must be an object.");
    return;
  }
  const action = readKey(binding, "action") ?? null;
  if (typeof action !== "string" || !allowed.has(action)) {
    issues.error(`${path}/action`, "Action is not in the builder allow-list.");
  }
  const params = readKey(binding, "params");
  if (issetKey(binding, "params") && !isPhpArray(params)) {
    issues.error(`${path}/params`, "Action parameters must be an object.");
  } else if (issetKey(binding, "params")) {
    validateSafeValues(params, `${path}/params`, issues, 0);
  }
  const confirm = readKey(binding, "confirm");
  if (issetKey(binding, "confirm") && typeof confirm !== "boolean" && typeof confirm !== "string") {
    issues.error(`${path}/confirm`, "Confirm must be a boolean or prompt string.");
  }
}

function validateTreeDepth(
  key: string,
  elements: Obj,
  ancestors: Set<string>,
  depth: number,
  issues: IssueList,
  reachable: Set<string>,
): void {
  reachable.add(key);
  if (depth > MAX_DEPTH) {
    issues.error(`/elements/${pointerToken(key)}`, "Element tree exceeds maximum depth.");
    return;
  }
  if (ancestors.has(key)) {
    issues.error(`/elements/${pointerToken(key)}`, "Element tree contains a cycle.");
    return;
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(key);
  for (const child of arrWrap(readKey(elements[key], "children") ?? [])) {
    if (typeof child === "string" && issetKey(elements, child)) {
      validateTreeDepth(child, elements, nextAncestors, depth + 1, issues, reachable);
    }
  }
}

/** Bindings as PHP reads them: a list is several bindings, anything else is one. */
function bindingsAsList(bindings: unknown): unknown[] {
  return isPhpArray(bindings) && isPhpList(bindings) ? phpValues(bindings) : [bindings];
}

/**
 * Validates a specification against the registry. Mirrors GenerativeUiSpecValidator::validate().
 * The input is normalised first, so the result contains the normalised spec.
 */
export function validateSpec(input: Obj, registry: BuilderRegistry): SpecValidation {
  const surfaceHint = readKey(input, "surface");
  const spec = normaliseSpec(input, typeof surfaceHint === "string" ? surfaceHint : "chat");
  const issues = new IssueList();
  const root = spec.root;
  const elements = spec.elements;

  const authority = readKey(input, "authority") ?? "presentation-only";
  if (authority !== "presentation-only") {
    issues.error("/authority", "Authority must be presentation-only.");
  }
  if (issetKey(input, "version") && !(SUPPORTED_VERSIONS as readonly string[]).includes(phpStringCast(readKey(input, "version")))) {
    issues.error("/version", "Unsupported specification version.");
  }
  if (!(SUPPORTED_SURFACES as readonly string[]).includes(spec.surface)) {
    issues.error("/surface", "Unsupported rendering surface.");
  }
  if (typeof root !== "string" || root === "" || !isSafeKey(root)) {
    issues.error("/root", "Root must be a non-empty safe element key.");
  }
  if (!isPhpArray(elements) || isPhpList(elements)) {
    issues.error("/elements", "Elements must be an object keyed by element ID.");
    return { valid: false, issues: issues.items, spec };
  }

  if (Object.keys(elements).length > MAX_ELEMENTS) {
    issues.error("/elements", `A spec may contain at most ${MAX_ELEMENTS} elements.`);
  }
  if (!hasKey(elements, root)) {
    issues.error("/root", "Root does not reference an existing element.");
  }
  if (byteLength(JSON.stringify(spec.state)) > MAX_STATE_BYTES) {
    issues.error("/state", "Initial state exceeds the maximum safe size.");
  }
  if (issetKey(spec, "data") && !isPhpArray(spec.data)) {
    issues.error("/data", "Read-only data must be an object.");
  }
  if (spec.persistence !== false && !isPhpArray(spec.persistence)) {
    issues.error("/persistence", "Persistence must be false or an object.");
  }

  const componentIds = new Set(registry.componentIds());
  const allowedActions = new Set(registry.actionIds());

  for (const [key, element] of Object.entries(elements)) {
    const path = `/elements/${pointerToken(key)}`;
    if (!isPhpStringKey(key) || !isSafeKey(key)) {
      issues.error(path, "Element keys may contain letters, numbers, underscores and hyphens only.");
      continue;
    }
    if (!isPhpArray(element)) {
      issues.error(path, "Element must be an object.");
      continue;
    }

    const type = readKey(element, "type") ?? null;
    if (typeof type !== "string" || !componentIds.has(type)) {
      issues.error(`${path}/type`, "Unknown or unregistered component type.");
    }

    const props = readKey(element, "props");
    if (!issetKey(element, "props") || !isPhpArray(props)) {
      issues.error(`${path}/props`, "Props must be an object.");
    } else {
      validateSafeValues(props, `${path}/props`, issues, 0);
    }

    if (issetKey(element, "children")) {
      const children = readKey(element, "children");
      if (!isPhpArray(children) || !isPhpList(children)) {
        issues.error(`${path}/children`, "Children must be an array of element keys.");
      } else {
        const childList = phpValues(children);
        if (childList.length > MAX_CHILDREN) {
          issues.error(`${path}/children`, `An element may contain at most ${MAX_CHILDREN} direct children.`);
        }
        childList.forEach((child, index) => {
          if (typeof child !== "string" || !issetKey(elements, child)) {
            issues.error(`${path}/children/${index}`, "Child does not reference an existing element.");
          }
        });
      }
    }

    if (issetKey(element, "visible")) {
      validateVisibility(readKey(element, "visible"), `${path}/visible`, issues, 0);
    }

    if (issetKey(element, "repeat")) {
      const repeat = readKey(element, "repeat");
      if (!isPhpArray(repeat) || !isSafePointer(readKey(repeat, "statePath") ?? null)) {
        issues.error(`${path}/repeat`, "Repeat requires a safe JSON Pointer statePath.");
      }
      if (issetKey(repeat, "key")) {
        const repeatKey = readKey(repeat, "key");
        if (typeof repeatKey !== "string" || repeatKey === "") {
          issues.error(`${path}/repeat/key`, "Repeat key must be a non-empty item field name.");
        }
      }
    }

    for (const group of ["on", "watch"] as const) {
      if (!issetKey(element, group)) continue;
      const bindingGroup = readKey(element, group);
      if (!isPhpArray(bindingGroup)) {
        issues.error(`${path}/${group}`, `${group === "on" ? "On" : "Watch"} must be an object.`);
        continue;
      }
      for (const [event, bindings] of Object.entries(bindingGroup)) {
        if (!isPhpStringKey(event) || event === "") {
          issues.error(`${path}/${group}`, "Binding names must be non-empty strings.");
          continue;
        }
        if (group === "watch" && !isSafePointer(event)) {
          issues.error(`${path}/${group}/${pointerToken(event)}`, "Watch keys must be safe JSON Pointer paths.");
        }
        const normalised = bindingsAsList(bindings);
        if (normalised.length > MAX_ACTION_CHAIN) {
          issues.error(`${path}/${group}/${pointerToken(event)}`, "Action chain exceeds the maximum safe length.");
        }
        normalised.forEach((binding, index) =>
          validateActionBinding(binding, `${path}/${group}/${pointerToken(event)}/${index}`, issues, allowedActions),
        );
      }
    }
  }

  if (issetKey(elements, root)) {
    const reachable = new Set<string>();
    validateTreeDepth(root, elements, new Set<string>(), 0, issues, reachable);
    for (const key of Object.keys(elements)) {
      if (!reachable.has(key)) {
        issues.warning(`/elements/${pointerToken(key)}`, "Element is not reachable from the root.");
      }
    }
  }

  const valid = !issues.items.some((issue) => issue.severity === "error");
  return { valid, issues: issues.items, spec };
}
