/**
 * Shared engine types. Every provider implements GatewayAdapter.
 * Amounts are integers in minor units (cents). Currency is ISO 4217 upper case.
 */

export type ProviderStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface CreateRequest {
  idempotencyKey: string;
  userId: string;
  amount: number;
  currency: string;
  metadata?: Record<string, string>;
}

export interface CreateResult {
  ok: boolean;
  providerRef?: string;
  redirectUrl?: string;
  status?: ProviderStatus;
  error?: string;
}

export interface VerifyResult {
  ok: boolean;
  status: ProviderStatus;
  providerRef: string;
  error?: string;
}

export interface WebhookRequest {
  /** Lower-case header names. */
  headers: Record<string, string | undefined>;
  /** Exact bytes received. Signatures are computed over these bytes, never over re-serialised JSON. */
  rawBody: Buffer;
}

export interface WebhookResult {
  accepted: boolean;
  eventType?: string;
  providerRef?: string;
  status?: ProviderStatus;
  /** Machine-readable reason, e.g. invalid_signature, invalid_json, unsupported_event, not_implemented. */
  error?: string;
}

export interface GatewayAdapter {
  readonly id: string;
  create(input: CreateRequest): Promise<CreateResult>;
  verify(providerRef: string): Promise<VerifyResult>;
  handleWebhook(req: WebhookRequest): Promise<WebhookResult>;
}
