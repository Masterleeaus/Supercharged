// Gateway-neutral contract for the Desk payment webhook engine.
// Sits beside the legacy engine (index.ts, gateways/*), which is not modified.
// No runtime dependencies: node:crypto only.

export const GATEWAY_IDS = ['stripe', 'razorpay', 'paypal', 'paystack', 'mercadopago', 'yookassa'] as const;
export type GatewayId = (typeof GATEWAY_IDS)[number];

// Same shape as server/engines/decision: no separator that could break composite keys.
export const COMPANY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export type PaymentErrorCode =
  | 'company_id_required'
  | 'company_id_invalid'
  | 'unknown_gateway'
  | 'signature_invalid'
  | 'replay_refused'
  | 'engine_misconfigured';

export class PaymentEngineError extends Error {
  readonly code: PaymentErrorCode;
  // Fixed internal reason string (never a secret or a raw provider payload).
  readonly detail: string | undefined;

  constructor(code: PaymentErrorCode, detail?: string) {
    super(code);
    this.name = 'PaymentEngineError';
    this.code = code;
    this.detail = detail;
  }
}

export interface RawWebhook {
  // Exact bytes as received. Must not be re-serialised JSON.
  rawBody: string | Uint8Array;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | undefined>;
}

export interface VerifyInput extends RawWebhook {
  secret: string | null;
  nowMs: number;
}

export type VerifyOutcome =
  | { ok: true; eventId?: string }
  | { ok: false; reason: string };

// A remote verifier calls the provider (for example a re-fetch of the object).
// It is injected by the caller and is never implemented in this module.
export type RemoteVerifier = (input: VerifyInput) => Promise<VerifyOutcome>;

export interface GatewayAdapter {
  readonly id: GatewayId;
  verify(input: VerifyInput): Promise<VerifyOutcome>;
}

export interface VerifiedWebhook {
  companyId: string;
  gateway: GatewayId;
  eventKey: string;
  rawBody: string;
  receivedAtMs: number;
}

export interface WebhookReceipt {
  status: 'accepted';
  companyId: string;
  gateway: GatewayId;
  eventKey: string;
}
