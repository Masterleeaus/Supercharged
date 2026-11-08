/**
 * Origin and trusted-domain rules for the public widget. Pure functions, no storage.
 *
 * Rules:
 * - The trusted domain check uses the Origin header, never the page's hostname sent in the body.
 * - Origins must be https. http is accepted only for localhost, for local development.
 * - An empty trusted list refuses every origin (fails closed). The legacy PHP widget let an empty list through.
 * - No wildcard entries. Each entry is one hostname, with an optional port.
 */

const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const PORT_PATTERN = /^\d{1,5}$/;

/** Returns "scheme://host[:port]" for an allowed origin, or null. Lower-case, no path, no credentials. */
export function normaliseOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) return null;
  return `${url.protocol}//${url.host}`;
}

/**
 * Normalises a stored trusted-domain entry. Accepts "example.com", "example.com:8443" and "https://example.com/".
 * Returns null for anything else, including wildcards and paths.
 */
export function normaliseTrustedDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (value.length === 0 || value.includes("/") || value.includes("*")) return null;
  const colon = value.lastIndexOf(":");
  const host = colon === -1 ? value : value.slice(0, colon);
  const port = colon === -1 ? null : value.slice(colon + 1);
  if (!HOSTNAME_PATTERN.test(host)) return null;
  if (port !== null && (!PORT_PATTERN.test(port) || Number(port) < 1 || Number(port) > 65535)) return null;
  return port === null ? host : `${host}:${port}`;
}

/** Normalises a list of stored entries and drops invalid ones. Keeps order, removes duplicates. */
export function normaliseTrustedDomains(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const domain = normaliseTrustedDomain(entry);
    if (domain && !out.includes(domain)) out.push(domain);
  }
  return out;
}

/**
 * True only when the request's Origin is a valid origin whose host matches a trusted entry.
 * An entry with a port matches host:port exactly. An entry without a port matches the hostname on the default port.
 */
export function isTrustedOrigin(requestOrigin: unknown, trustedDomains: readonly string[]): boolean {
  const origin = normaliseOrigin(requestOrigin);
  if (origin === null) return false;
  const url = new URL(origin);
  const trusted = normaliseTrustedDomains(trustedDomains);
  if (trusted.length === 0) return false;
  return trusted.some((entry) => {
    if (entry.includes(":")) return entry === url.host;
    return entry === url.hostname && url.port === "";
  });
}
