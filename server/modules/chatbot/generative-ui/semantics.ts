/**
 * Small helpers that reproduce the PHP value semantics the generative UI rules were written against.
 *
 * Port note: PHP arrays cover both JSON lists and JSON objects, and json_decode turns an empty
 * JSON object into []. These helpers keep that behaviour so the port accepts and rejects the same
 * specifications as the Chatbot extension.
 *
 * Every helper here is pure.
 */

export type Obj = Record<string, any>;

const OWN = Object.prototype.hasOwnProperty;
const INTEGER_KEY = /^(0|-?[1-9][0-9]*)$/;
const PHP_TRIM_CHARS = /^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g;

/** A non-array object decoded from JSON. */
export function isPlainObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** PHP is_array(): JSON lists and JSON objects both count. */
export function isPhpArray(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/**
 * PHP array_is_list(). A plain object whose keys are exactly "0".."n-1" in order is a list.
 * An empty object counts as a list, because json_decode turns {} into [].
 */
export function isPhpList(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (!isPlainObject(value)) return false;
  return Object.keys(value).every((key, index) => key === String(index));
}

/** Own-property read. Returns undefined for missing keys and for non-object containers. */
export function readKey(container: unknown, key: string): any {
  return isPlainObject(container) && OWN.call(container, key) ? container[key] : undefined;
}

/** PHP isset() on an array key: the key exists and its value is not null. */
export function issetKey(container: unknown, key: string): boolean {
  return readKey(container, key) != null;
}

/** PHP array_key_exists() on an object: the key exists, even when its value is null. */
export function hasKey(container: unknown, key: string): boolean {
  return isPlainObject(container) && OWN.call(container, key);
}

/** Writes an own data property. Safe for keys such as "__proto__", unlike plain assignment. */
export function defineOwn(target: Obj, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * PHP treats integer-like array keys ("0", "-5", "123") as ints, so is_string() fails for them.
 * The port rejects the same keys so validity matches the PHP behaviour.
 */
export function isPhpStringKey(key: string): boolean {
  return !INTEGER_KEY.test(key);
}

/** PHP trim() with its default character set. */
export function phpTrim(value: string): string {
  return value.replace(PHP_TRIM_CHARS, "");
}

/** PHP `$a ?: $b`: an empty string or "0" is falsy. */
export function orElse<T>(value: string, fallback: T): string | T {
  return value === "" || value === "0" ? fallback : value;
}

/** PHP strlen(): byte length of a UTF-8 string. */
export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** PHP (string) cast for values that can arrive from JSON. */
export function phpStringCast(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "1" : "";
  if (typeof value === "number") return String(value);
  if (value === null || value === undefined) return "";
  return "Array";
}

/** Laravel Arr::wrap(): null becomes [], arrays pass through, anything else is wrapped. */
export function arrWrap(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (isPhpArray(value)) return Array.isArray(value) ? value : Object.values(value as Obj);
  return [value];
}

/** Values of a PHP array in order (list or object). */
export function phpValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value)) return Object.values(value);
  return [];
}

/**
 * Laravel Arr::get() with dot notation. Returns the fallback for missing paths.
 * A direct key match wins over dot traversal, as in Laravel.
 */
export function arrGet(container: unknown, key: string, fallback: unknown): unknown {
  if (!isPhpArray(container)) return fallback;
  if (hasKey(container, key)) return readKey(container, key);
  if (!key.includes(".")) return fallback;

  let current: unknown = container;
  for (const segment of key.split(".")) {
    if (hasKey(current, segment)) {
      current = readKey(current, segment);
    } else {
      return fallback;
    }
  }
  return current;
}

/** PHP truthiness for the values this module compares: null, false, "", "0", 0 and [] are falsy. */
export function phpTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "" || value === "0") {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
