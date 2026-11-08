/**
 * Desk-side client for Titan Zero Field.
 *
 * Every endpoint path in this file is ASSUMED. Field has no matching API today and no
 * service-to-service auth scheme. See docs/FIELD_LINK.md before relying on any path.
 *
 * Safety rules for this file:
 * - base URL must be https, or http to 127.0.0.1 / localhost only. No credentials in the URL.
 * - redirects are refused (fetch redirect:"error", and any 3xx is an error).
 * - every request has a timeout.
 * - requests are signed with HMAC-SHA256 over timestamp, method, path and body hash.
 * - errors carry a code and an HTTP status only. They never include the secret,
 *   the request body, or the response body. Nothing is logged.
 * - the Field account is resolved from the Desk company_id through FieldCompanyMap.
 *   If there is no mapping, no request is sent.
 */
import { createHash, createHmac } from 'node:crypto';
import { DENY_ALL_COMPANY_MAP, type FieldCompanyMap } from './company-map.ts';

export const FIELD_LINK_HEADERS = Object.freeze({
  keyId: 'X-Desk-Key-Id',
  timestamp: 'X-Desk-Timestamp',
  signature: 'X-Desk-Signature',
  idempotencyKey: 'Idempotency-Key',
});

/** Paths are ASSUMED. Field must implement them with the same names or this file changes too. */
export const FIELD_LINK_ENDPOINTS = Object.freeze({
  /** ASSUMED: Field does not expose this route yet. Thin wrapper over the booking-request create logic. */
  createBookingRequest: Object.freeze({ method: 'POST', path: '/api/v1/integrations/desk/booking-requests' }),
  /** ASSUMED: Field does not expose this route yet. Read one booking request created by Desk. */
  getBookingRequest: Object.freeze({ method: 'GET', path: '/api/v1/integrations/desk/booking-requests/:id' }),
});

export type FieldLinkErrorCode =
  | 'field_link_config_invalid'
  | 'field_link_tenant_not_mapped'
  | 'field_link_input_invalid'
  | 'field_link_redirect_refused'
  | 'field_link_timeout'
  | 'field_link_unreachable'
  | 'field_link_auth_rejected'
  | 'field_link_forbidden'
  | 'field_link_not_found'
  | 'field_link_conflict'
  | 'field_link_validation_failed'
  | 'field_link_http_error'
  | 'field_link_bad_response';

/** The message is the code. Status is the HTTP status when there was one. No other detail. */
export class FieldLinkError extends Error {
  readonly code: FieldLinkErrorCode;
  readonly status: number | null;

  constructor(code: FieldLinkErrorCode, status: number | null = null) {
    super(code);
    this.name = 'FieldLinkError';
    this.code = code;
    this.status = status;
  }
}

export interface FieldLinkConfig {
  /** e.g. https://field.example.com or http://127.0.0.1:3010 */
  baseUrl: string;
  /** Identifies the Desk-side key on Field. Not secret. */
  keyId: string;
  /** HMAC secret. Never logged, never included in errors. */
  secret: string;
  timeoutMs?: number;
}

export interface FieldLinkClientOptions extends FieldLinkConfig {
  companyMap?: FieldCompanyMap;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Input the caller supplies. company_id is NOT here: it comes from the server-side record. */
export interface DeskBookingRequestInput {
  idempotency_key: string;
  /** Desk record id of the qualified lead or contact. */
  record_id: string;
  customer: { name: string; phone?: string; email?: string };
  service_address: { line1: string; suburb: string; postcode: string };
  requested_service: string;
  requested_window: { start: string; end: string };
  notes?: string;
  consent: { captured_at: string; basis: string };
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;
const MIN_SECRET_LENGTH = 32;
const MAX_RESPONSE_CHARS = 1_000_000;
const MAX_NOTES_CHARS = 2000;
const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** Returns a normalised base URL, or throws field_link_config_invalid. Never echoes the input. */
export function validateFieldBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(String(raw ?? ''));
  } catch {
    throw new FieldLinkError('field_link_config_invalid');
  }
  if (url.username || url.password) throw new FieldLinkError('field_link_config_invalid');
  if (url.search || url.hash) throw new FieldLinkError('field_link_config_invalid');
  if (url.protocol === 'https:') {
    // allowed for any host
  } else if (url.protocol === 'http:' && ALLOWED_LOOPBACK_HOSTS.has(url.hostname)) {
    // plain http only for loopback
  } else {
    throw new FieldLinkError('field_link_config_invalid');
  }
  return url.href.replace(/\/+$/, '');
}

export function readFieldLinkConfig(env: Record<string, string | undefined>): FieldLinkConfig | null {
  const baseUrl = env.FIELD_LINK_BASE_URL?.trim();
  const keyId = env.FIELD_LINK_KEY_ID?.trim();
  const secret = env.FIELD_LINK_SECRET ?? '';
  if (!baseUrl && !keyId && !secret) return null; // not configured: callers fail closed
  if (!baseUrl || !keyId || !secret) throw new FieldLinkError('field_link_config_invalid');
  const timeoutRaw = env.FIELD_LINK_TIMEOUT_MS;
  const timeoutMs = timeoutRaw === undefined || timeoutRaw === '' ? undefined : Number(timeoutRaw);
  return { baseUrl, keyId, secret, timeoutMs };
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Canonical string that Field must rebuild and verify: timestamp.METHOD.path.sha256hex(body). */
export function canonicalFieldRequest(timestamp: string, method: string, path: string, body: string): string {
  return `${timestamp}.${method.toUpperCase()}.${path}.${sha256Hex(body)}`;
}

export function signFieldRequest(secret: string, timestamp: string, method: string, path: string, body: string): string {
  return createHmac('sha256', secret).update(canonicalFieldRequest(timestamp, method, path, body), 'utf8').digest('base64');
}

export class FieldLinkClient {
  private readonly baseUrl: string;
  private readonly keyId: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly companyMap: FieldCompanyMap;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: FieldLinkClientOptions) {
    // Validation messages never include the secret or the URL.
    this.baseUrl = validateFieldBaseUrl(options?.baseUrl ?? '');
    const keyId = String(options?.keyId ?? '').trim();
    if (!keyId) throw new FieldLinkError('field_link_config_invalid');
    const secret = String(options?.secret ?? '');
    if (secret.length < MIN_SECRET_LENGTH) throw new FieldLinkError('field_link_config_invalid');
    const timeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
      throw new FieldLinkError('field_link_config_invalid');
    }
    this.keyId = keyId;
    this.secret = secret;
    this.timeoutMs = timeout;
    this.companyMap = options.companyMap ?? DENY_ALL_COMPANY_MAP;
    // Wrapped so the global fetch is never called with the client as its receiver.
    const injected = options.fetch;
    this.fetchImpl = injected ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  /** ASSUMED endpoint. See FIELD_LINK_ENDPOINTS.createBookingRequest. */
  async createBookingRequest(deskCompanyId: string, input: DeskBookingRequestInput): Promise<unknown> {
    const accountId = await this.resolveAccount(deskCompanyId);
    validateBookingInput(input);
    const body = {
      external_ref: { source: 'titan-desk', tenant_ref: String(deskCompanyId).trim(), record_id: input.record_id },
      account_id: accountId,
      idempotency_key: input.idempotency_key,
      customer: input.customer,
      service_address: input.service_address,
      requested_service: input.requested_service,
      requested_window: input.requested_window,
      notes: input.notes ?? '',
      consent: input.consent,
    };
    const { method, path } = FIELD_LINK_ENDPOINTS.createBookingRequest;
    return this.send(method, path, body, input.idempotency_key);
  }

  /** ASSUMED endpoint. See FIELD_LINK_ENDPOINTS.getBookingRequest. */
  async getBookingRequest(deskCompanyId: string, fieldBookingRequestId: string): Promise<unknown> {
    await this.resolveAccount(deskCompanyId);
    const id = String(fieldBookingRequestId ?? '').trim();
    if (!id) throw new FieldLinkError('field_link_input_invalid');
    const { method, path } = FIELD_LINK_ENDPOINTS.getBookingRequest;
    return this.send(method, path.replace(':id', encodeURIComponent(id)), undefined, undefined);
  }

  private async resolveAccount(deskCompanyId: string): Promise<string> {
    const key = String(deskCompanyId ?? '').trim();
    if (!key) throw new FieldLinkError('field_link_tenant_not_mapped');
    const accountId = await this.companyMap.lookup(key);
    if (!accountId) throw new FieldLinkError('field_link_tenant_not_mapped');
    return accountId;
  }

  private async send(method: string, path: string, payload: unknown, idempotencyKey: string | undefined): Promise<unknown> {
    const bodyText = payload === undefined ? '' : JSON.stringify(payload);
    const timestamp = String(Math.floor(this.now() / 1000));
    const signature = signFieldRequest(this.secret, timestamp, method, path, bodyText);

    const headers: Record<string, string> = {
      accept: 'application/json',
      [FIELD_LINK_HEADERS.keyId]: this.keyId,
      [FIELD_LINK_HEADERS.timestamp]: timestamp,
      [FIELD_LINK_HEADERS.signature]: signature,
    };
    if (bodyText) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers[FIELD_LINK_HEADERS.idempotencyKey] = idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: bodyText || undefined,
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        // The original error is dropped: it can carry URL or header detail.
        if (controller.signal.aborted) throw new FieldLinkError('field_link_timeout');
        throw new FieldLinkError('field_link_unreachable');
      }

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new FieldLinkError('field_link_redirect_refused', response.status);
      }
      const text = await readLimited(response);
      if (response.status >= 200 && response.status < 300) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (parsed === null || typeof parsed !== 'object') throw new Error('shape');
          return parsed;
        } catch {
          throw new FieldLinkError('field_link_bad_response', response.status);
        }
      }
      throw new FieldLinkError(mapStatusToCode(response.status), response.status);
    } catch (error) {
      if (error instanceof FieldLinkError) throw error;
      if (controller.signal.aborted) throw new FieldLinkError('field_link_timeout');
      throw new FieldLinkError('field_link_bad_response');
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readLimited(response: Response): Promise<string> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) throw new FieldLinkError('field_link_bad_response', response.status);
  return text;
}

function mapStatusToCode(status: number): FieldLinkErrorCode {
  if (status === 401) return 'field_link_auth_rejected';
  if (status === 403) return 'field_link_forbidden';
  if (status === 404) return 'field_link_not_found';
  if (status === 409) return 'field_link_conflict';
  if (status === 422) return 'field_link_validation_failed';
  return 'field_link_http_error';
}

function validateBookingInput(input: DeskBookingRequestInput): void {
  const bad = () => new FieldLinkError('field_link_input_invalid');
  if (!input || typeof input !== 'object') throw bad();
  for (const value of [input.idempotency_key, input.record_id, input.requested_service, input.customer?.name,
    input.service_address?.line1, input.service_address?.suburb, input.service_address?.postcode,
    input.requested_window?.start, input.requested_window?.end, input.consent?.captured_at, input.consent?.basis]) {
    if (typeof value !== 'string' || !value.trim()) throw bad();
  }
  if (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > MAX_NOTES_CHARS)) throw bad();
}
