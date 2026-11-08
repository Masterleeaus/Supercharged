'use strict';
/**
 * YooKassa notification verification.
 *
 * YooKassa HTTP notifications carry no signature, so the request body cannot be
 * trusted. This helper re-fetches the payment from the YooKassa API with the
 * shop credentials and returns only what the API reports (status, paid flag,
 * amount, metadata). It fails closed: missing credentials, a malformed id, a
 * network error, a non-2xx response, an id mismatch or a status other than a
 * paid "succeeded" payment all throw.
 */

export interface VerifiedYookassaPayment {
  id: string;
  status: string;
  paid: boolean;
  amount: { value: string; currency: string };
  metadata: Record<string, any>;
}

export interface VerifyYookassaOptions {
  shopId: string | null | undefined;
  secretKey: string | null | undefined;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
}

export class YookassaVerificationError extends Error {
  /** true when the caller may retry later (YooKassa unreachable), false when the notification is rejected */
  readonly retriable: boolean;
  constructor(message: string, retriable: boolean) {
    super(message);
    this.name = 'YookassaVerificationError';
    this.retriable = retriable;
  }
}

const PAYMENT_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export async function fetchVerifiedYookassaPayment(
  paymentId: unknown,
  opts: VerifyYookassaOptions
): Promise<VerifiedYookassaPayment> {
  if (typeof paymentId !== 'string' || !PAYMENT_ID_PATTERN.test(paymentId)) {
    throw new YookassaVerificationError('Invalid payment id in notification', false);
  }
  if (!opts.shopId || !opts.secretKey) {
    // Fail closed: without credentials the notification cannot be verified.
    throw new YookassaVerificationError('YooKassa credentials not configured; notification not verified', true);
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.apiBase ?? 'https://api.yookassa.ru/v3';
  const auth = Buffer.from(`${opts.shopId}:${opts.secretKey}`).toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10000);

  let res: Response;
  try {
    res = await fetchImpl(`${base}/payments/${encodeURIComponent(paymentId)}`, {
      method: 'GET',
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch {
    throw new YookassaVerificationError('YooKassa payment lookup failed', true);
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 500) {
    throw new YookassaVerificationError(`YooKassa payment lookup returned ${res.status}`, true);
  }
  if (!res.ok) {
    throw new YookassaVerificationError(`YooKassa payment lookup returned ${res.status}`, false);
  }

  const body: any = await res.json().catch(() => null);
  if (!body || body.id !== paymentId) {
    throw new YookassaVerificationError('YooKassa payment id does not match notification', false);
  }
  if (body.status !== 'succeeded' || body.paid !== true) {
    throw new YookassaVerificationError(`YooKassa payment is not a paid success (status: ${String(body.status)})`, false);
  }
  if (!body.amount || typeof body.amount.value !== 'string' || typeof body.amount.currency !== 'string') {
    throw new YookassaVerificationError('YooKassa payment has no amount', false);
  }

  return {
    id: body.id,
    status: body.status,
    paid: body.paid,
    amount: { value: body.amount.value, currency: body.amount.currency },
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
  };
}
