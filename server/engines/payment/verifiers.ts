// Webhook signature verifiers, one per gateway. Every path that is not a
// positive match returns { ok: false }. Missing secret, missing header,
// malformed header and mismatch all fail closed.
//
// Ported from the documented algorithms, not copied from the legacy code:
//   stripe      HMAC-SHA256 over "<t>.<body>", v1 header, 300 s tolerance
//   razorpay    HMAC-SHA256 hex over body, X-Razorpay-Signature
//   paystack    HMAC-SHA512 hex over body, X-Paystack-Signature (key = API secret key)
//   mercadopago HMAC-SHA256 over "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
//   paypal      remote only (provider verify-webhook-signature call), injected
//   yookassa    remote only (provider re-fetch), injected. The re-fetch is
//               /home/claude/work/security-fixes/01-yookassa-webhook-verification/fix.diff
//               (not duplicated here); it is not applied and not wired here.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  GATEWAY_IDS,
  type GatewayAdapter,
  type GatewayId,
  type RemoteVerifier,
  type VerifyInput,
  type VerifyOutcome,
} from './contract.ts';

export const STRIPE_TOLERANCE_SECONDS = 300;

type Headers = Record<string, string | string[] | undefined>;

const reject = (reason: string): VerifyOutcome => ({ ok: false, reason });

function toBuffer(raw: string | Uint8Array): Buffer {
  return typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
}

function headerValue(headers: Headers, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const raw = headers[key];
    const first = Array.isArray(raw) ? raw[0] : raw;
    return typeof first === 'string' && first.length > 0 ? first : undefined;
  }
  return undefined;
}

function safeEqualHex(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function hmacHex(alg: 'sha256' | 'sha512', secret: string, data: Buffer | string): string {
  return createHmac(alg, secret).update(data).digest('hex');
}

function parseObject(raw: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function idFrom(obj: Record<string, unknown> | null): string | undefined {
  const id = obj?.id;
  if (typeof id === 'string' && id.length > 0) return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return undefined;
}

const stripe: GatewayAdapter = {
  id: 'stripe',
  async verify({ rawBody, headers, secret, nowMs }: VerifyInput): Promise<VerifyOutcome> {
    if (!secret) return reject('secret_missing');
    const sigHeader = headerValue(headers, 'stripe-signature');
    if (!sigHeader) return reject('signature_missing');

    let timestamp = '';
    const v1: string[] = [];
    for (const part of sigHeader.split(',')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (key === 't') timestamp = value;
      else if (key === 'v1') v1.push(value);
    }
    if (!/^\d+$/.test(timestamp) || v1.length === 0) return reject('signature_malformed');
    if (Math.abs(nowMs / 1000 - Number(timestamp)) > STRIPE_TOLERANCE_SECONDS) {
      return reject('timestamp_outside_tolerance');
    }

    const body = toBuffer(rawBody);
    const expected = hmacHex(
      'sha256',
      secret,
      Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]),
    );
    if (!v1.some((sig) => safeEqualHex(expected, sig))) return reject('signature_mismatch');
    return { ok: true, eventId: idFrom(parseObject(body)) };
  },
};

const razorpay: GatewayAdapter = {
  id: 'razorpay',
  async verify({ rawBody, headers, secret }: VerifyInput): Promise<VerifyOutcome> {
    if (!secret) return reject('secret_missing');
    const sig = headerValue(headers, 'x-razorpay-signature');
    if (!sig) return reject('signature_missing');
    const expected = hmacHex('sha256', secret, toBuffer(rawBody));
    if (!safeEqualHex(expected, sig)) return reject('signature_mismatch');
    return { ok: true, eventId: undefined };
  },
};

const paystack: GatewayAdapter = {
  id: 'paystack',
  async verify({ rawBody, headers, secret }: VerifyInput): Promise<VerifyOutcome> {
    if (!secret) return reject('secret_missing');
    const sig = headerValue(headers, 'x-paystack-signature');
    if (!sig) return reject('signature_missing');
    const expected = hmacHex('sha512', secret, toBuffer(rawBody));
    if (!safeEqualHex(expected, sig)) return reject('signature_mismatch');
    return { ok: true, eventId: undefined };
  },
};

const mercadopago: GatewayAdapter = {
  id: 'mercadopago',
  async verify({ rawBody, headers, query, secret }: VerifyInput): Promise<VerifyOutcome> {
    if (!secret) return reject('secret_missing');
    const xSignature = headerValue(headers, 'x-signature');
    const xRequestId = headerValue(headers, 'x-request-id');
    if (!xSignature || !xRequestId) return reject('signature_missing');

    // MercadoPago signs the data.id from the query string, not the body.
    const dataId = query?.['data.id'];
    if (!dataId) return reject('data_id_missing');

    let ts = '';
    let v1 = '';
    for (const part of xSignature.split(',')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (key === 'ts') ts = value;
      else if (key === 'v1') v1 = value;
    }
    if (!ts || !v1) return reject('signature_malformed');

    const normalisedId = /^[A-Za-z0-9]+$/.test(dataId) ? dataId.toLowerCase() : dataId;
    const manifest = `id:${normalisedId};request-id:${xRequestId};ts:${ts};`;
    const expected = hmacHex('sha256', secret, manifest);
    if (!safeEqualHex(expected, v1)) return reject('signature_mismatch');
    return { ok: true, eventId: idFrom(parseObject(toBuffer(rawBody))) };
  },
};

function remoteOnly(id: GatewayId, remote: RemoteVerifier | undefined): GatewayAdapter {
  return {
    id,
    async verify(input: VerifyInput): Promise<VerifyOutcome> {
      if (!remote) return reject('remote_verifier_not_configured');
      return remote(input);
    },
  };
}

const LOCAL_ADAPTERS: Partial<Record<GatewayId, GatewayAdapter>> = {
  stripe,
  razorpay,
  paystack,
  mercadopago,
};

export function createDefaultAdapters(
  remote: Partial<Record<'paypal' | 'yookassa', RemoteVerifier>> = {},
): Map<GatewayId, GatewayAdapter> {
  const adapters = new Map<GatewayId, GatewayAdapter>();
  for (const id of GATEWAY_IDS) {
    const local = LOCAL_ADAPTERS[id];
    if (local) {
      adapters.set(id, local);
    } else if (id === 'paypal' || id === 'yookassa') {
      adapters.set(id, remoteOnly(id, remote[id]));
    }
  }
  return adapters;
}

// Exposed for hashing an event that has no provider id.
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
