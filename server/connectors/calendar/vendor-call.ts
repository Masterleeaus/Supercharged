/**
 * Shared vendor-call helper for the calendar connectors (#354). Uses the injected HttpClient port, maps HTTP
 * status to the SDK error taxonomy, and never puts a response body in an error. Tokens go only in the
 * Authorization header.
 */
import { ConnectorError, errorFromStatus, type ConnectorCredentials } from '../sdk/contract.ts';
import type { HttpClient, HttpMethod } from '../../modules/chatbot/contracts/http.ts';

export interface VendorCall {
  http: HttpClient;
  method: HttpMethod;
  url: string;
  credentials: ConnectorCredentials;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs: number;
}

export function accessTokenOf(credentials: ConnectorCredentials): string {
  if (credentials.type === 'oauth2') return credentials.accessToken;
  if (credentials.type === 'api_key') return credentials.apiKey;
  throw new ConnectorError('auth', 'connector needs credentials');
}

/** Returns the parsed JSON body of a 2xx response, or null for an empty body. */
export async function vendorJson(call: VendorCall): Promise<{ status: number; json: unknown }> {
  let res;
  try {
    res = await call.http({
      method: call.method,
      url: call.url,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessTokenOf(call.credentials)}`,
        ...(call.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(call.headers ?? {}),
      },
      body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
      timeoutMs: call.timeoutMs,
    });
  } catch {
    throw new ConnectorError('upstream', 'Vendor request could not be completed');
  }
  if (res.status < 200 || res.status > 299) {
    const retryAfter = Number(res.headers?.['retry-after']);
    throw errorFromStatus(res.status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
  }
  if (res.body === '' || res.body === undefined) return { status: res.status, json: null };
  try {
    return { status: res.status, json: JSON.parse(res.body) };
  } catch {
    throw new ConnectorError('upstream', 'Vendor returned an unreadable response');
  }
}
