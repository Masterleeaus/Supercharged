// Origin policy for agent embeds.
//
// Pure functions only: no Express, no database. Every decision fails closed:
// a malformed origin, a wildcard, an empty allowlist, or a missing Origin and
// Referer header all result in "not allowed".

export const MAX_ALLOWED_ORIGINS = 50;
const MAX_ORIGIN_LENGTH = 253 + 8 + 6; // hostname + scheme + port, generous bound

export interface NormalizeOptions {
  /**
   * Accept http://localhost, http://127.0.0.1 and http://[::1] origins.
   * Intended for local development only. Off by default.
   */
  allowLoopbackHttp?: boolean;
}

export type OriginValidation =
  | { ok: true; origins: string[] }
  | { ok: false; errors: string[] };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Turns a string into a canonical origin ("https://host[:port]") or returns null.
 * Rejects wildcards, paths, queries, fragments, credentials, opaque origins
 * ("null"), and plain http except for loopback when explicitly allowed.
 */
export function normalizeOrigin(input: unknown, options: NormalizeOptions = {}): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw === '' || raw.length > MAX_ORIGIN_LENGTH) return null;
  if (raw.includes('*')) return null;
  if (/\s/.test(raw)) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.hostname === '' || url.hostname.includes('*')) return null;

  if (url.protocol === 'https:') {
    return `https://${url.host}`;
  }
  if (url.protocol === 'http:' && options.allowLoopbackHttp && LOOPBACK_HOSTS.has(url.hostname)) {
    return `http://${url.host}`;
  }
  return null;
}

/**
 * Validates a configured allowlist. Use at save time and when loading an agent.
 * Returns canonical, de-duplicated origins, or every error found.
 */
export function validateAllowedOrigins(list: unknown, options: NormalizeOptions = {}): OriginValidation {
  if (!Array.isArray(list)) {
    return { ok: false, errors: ['allowedOrigins must be an array'] };
  }
  if (list.length === 0) {
    return { ok: false, errors: ['allowedOrigins is empty: nothing can embed this agent'] };
  }
  if (list.length > MAX_ALLOWED_ORIGINS) {
    return { ok: false, errors: [`allowedOrigins may contain at most ${MAX_ALLOWED_ORIGINS} entries`] };
  }

  const errors: string[] = [];
  const seen = new Set<string>();
  const origins: string[] = [];

  list.forEach((entry, index) => {
    if (typeof entry === 'string' && entry.includes('*')) {
      errors.push(`allowedOrigins[${index}]: wildcards are not allowed`);
      return;
    }
    const normalized = normalizeOrigin(entry, options);
    if (!normalized) {
      errors.push(`allowedOrigins[${index}]: must be an explicit https origin with no path`);
      return;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      origins.push(normalized);
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, origins };
}

/**
 * Derives the requesting origin from request headers.
 * - An Origin header wins. If it is present but invalid (for example "null"), the result is null.
 *   Referer is not used as a fallback in that case.
 * - Without Origin, the origin of Referer is used.
 * - With neither header, the result is null.
 */
export function originFromHeaders(
  headers: { origin?: unknown; referer?: unknown },
  options: NormalizeOptions = {},
): string | null {
  const origin = firstString(headers.origin);
  if (origin !== undefined) {
    return normalizeOrigin(origin, options);
  }
  const referer = firstString(headers.referer);
  if (referer === undefined) return null;
  try {
    return normalizeOrigin(new URL(referer).origin, options);
  } catch {
    return null;
  }
}

/**
 * True only when the candidate's canonical origin appears in the allowlist.
 * An empty allowlist always returns false. Entries that do not normalise never match.
 */
export function isOriginAllowed(
  candidate: unknown,
  allowlist: readonly unknown[] | null | undefined,
  options: NormalizeOptions = {},
): boolean {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  const canonical = typeof candidate === 'string' ? normalizeOrigin(candidate, options) : null;
  if (canonical === null) return false;
  return allowlist.some((entry) => typeof entry === 'string' && normalizeOrigin(entry, options) === canonical);
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}
