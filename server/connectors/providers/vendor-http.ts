/**
 * Shared HTTP helper for vendor connectors (#355, #356, #358).
 *
 * Wraps an injected fetch so a connector never touches the network directly in tests. Maps the
 * response status onto the SDK error taxonomy and never surfaces a response body: bodies can echo
 * tokens or customer data. The runner owns retries, timeouts and audit; this helper only makes one
 * attempt per call.
 */
import { ConnectorError, errorFromStatus } from '../sdk/contract.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface VendorRequestInit {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers: Record<string, string>;
  body?: string;
}

/** Retry-After in seconds becomes milliseconds. HTTP-date values are ignored (treated as absent). */
export function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export async function callVendor(
  fetchImpl: FetchLike,
  url: string,
  init: VendorRequestInit,
  timeoutMs: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') throw new ConnectorError('timeout', 'Vendor call timed out');
    throw new ConnectorError('upstream', 'Vendor could not be reached');
  }
  if (!response.ok) throw errorFromStatus(response.status, retryAfterMs(response));
  return response;
}

/** Reads a bearer token from oauth2 credentials. Any other credential type is refused. */
export function bearerToken(credentials: { type: string; accessToken?: string }): string {
  if (credentials.type !== 'oauth2' || typeof credentials.accessToken !== 'string' || credentials.accessToken.length === 0) {
    throw new ConnectorError('auth', 'connector needs OAuth credentials');
  }
  return credentials.accessToken;
}

/** Parses a JSON body. A malformed body is an unknown failure, never a crash with raw text. */
export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ConnectorError('unknown', 'Vendor returned an unreadable response');
  }
}

export function requireString(input: unknown, field: string): string {
  const value = input !== null && typeof input === 'object' ? (input as Record<string, unknown>)[field] : undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConnectorError('validation', `${field} is required`);
  }
  return value.trim();
}

export function optionalString(input: unknown, field: string): string | undefined {
  const value = input !== null && typeof input === 'object' ? (input as Record<string, unknown>)[field] : undefined;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ConnectorError('validation', `${field} must be a string`);
  return value;
}
