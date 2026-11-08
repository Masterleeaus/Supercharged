import type { Request, Response } from 'express';
import type { db as DatabaseClient } from '../db';
import { websiteWidgets } from '@shared/schema';

/**
 * Origin allowlist for public, cross-origin read endpoints (/api/init, /api/branding).
 *
 * Source of truth: website_widgets.allowed_domains (shared/schema.ts, websiteWidgets.allowedDomains).
 * An allowed domain also allows its subdomains: "example.com" allows https://example.com,
 * https://shop.example.com and https://deep.shop.example.com. A leading "*." on a stored entry
 * is stripped and the remainder is treated as the base domain. Only https origins match.
 * A leading "www." on a stored entry is stripped, so the base domain covers it.
 *
 * Fails closed: an empty list, or a failed database read, means no cross-origin access.
 * Same-origin and non-browser callers do not depend on these headers and are unaffected.
 */

const ALLOWLIST_TTL_MS = 60_000;

let cached: { hosts: Set<string>; expiresAt: number } | null = null;
let inflight: Promise<Set<string>> | null = null;

/**
 * Reduces one stored entry to its base host (host, plus port if one is given), or null when the
 * entry cannot grant access. Accepts "example.com", "*.example.com", "www.example.com" and
 * "https://example.com". Anything with a non-https scheme, path, query, credentials or a
 * wildcard other than the leading "*." is rejected.
 */
function toBaseHost(entry: unknown): string | null {
  if (typeof entry !== 'string') return null;
  let value = entry.trim().toLowerCase();
  if (value.startsWith('*.')) value = value.slice(2);
  if (value === '' || value.includes('*')) return null;

  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;

  const host = url.host.replace(/^www\./, '');
  return host === '' ? null : host;
}

/**
 * Pure matching rule. Returns true when origin is an https origin whose host equals an entry's
 * base host or ends with "." followed by that base host. The dot boundary is required, so
 * "evilexample.com" does not match "example.com". Unparseable origins, non-https origins and
 * origins with a path, query or hash are rejected.
 */
export function matchOrigin(origin: unknown, entries: Iterable<unknown>): boolean {
  if (typeof origin !== 'string' || origin === '') return false;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return false;

  const host = url.host;
  for (const entry of entries) {
    const base = toBaseHost(entry);
    if (base === null) continue;
    if (host === base || host.endsWith(`.${base}`)) return true;
  }
  return false;
}

async function loadAllowlist(db: typeof DatabaseClient): Promise<Set<string>> {
  const rows = await db
    .select({ allowedDomains: websiteWidgets.allowedDomains })
    .from(websiteWidgets);

  const hosts = new Set<string>();
  for (const row of rows) {
    for (const domain of row.allowedDomains ?? []) {
      const base = toBaseHost(domain);
      if (base !== null) hosts.add(base);
    }
  }
  return hosts;
}

/** Returns the current set of base hosts, reloaded from the database at most once per TTL. */
export async function getEmbedOriginAllowlist(db: typeof DatabaseClient): Promise<Set<string>> {
  if (cached && cached.expiresAt > Date.now()) return cached.hosts;

  if (!inflight) {
    inflight = loadAllowlist(db)
      .then((hosts) => {
        cached = { hosts, expiresAt: Date.now() + ALLOWLIST_TTL_MS };
        return hosts;
      })
      .finally(() => {
        inflight = null;
      });
  }

  try {
    return await inflight;
  } catch {
    // Fail closed. Nothing is cached on error, so the next request retries the read.
    return new Set<string>();
  }
}

/**
 * Sets Access-Control-Allow-Origin only when the request Origin matches the allowlist, echoing
 * that origin. Always sets Vary: Origin so caches key on the Origin header.
 * Returns true when the origin was allowed. Never writes the response body.
 */
export async function applyEmbedCors(
  db: typeof DatabaseClient,
  req: Request,
  res: Response,
): Promise<boolean> {
  res.vary('Origin');

  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return false;

  const hosts = await getEmbedOriginAllowlist(db);
  // Fail closed: an empty or missing allowlist grants no origin. No Access-Control-Allow-Origin
  // is written, so browsers refuse the cross-origin response and any preflight.
  if (hosts.size === 0) return false;
  if (!matchOrigin(origin, hosts)) return false;

  res.setHeader('Access-Control-Allow-Origin', origin);
  return true;
}
