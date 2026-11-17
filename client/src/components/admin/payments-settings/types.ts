/**
 * Shape of GET /api/admin/settings as used by the payments settings screens.
 * Credential, id, mode and currency fields are strings. The *_enabled and
 * *_configured flags are read through unknown or boolean checks, so they stay
 * loose. Any other key is read as unknown and must be narrowed before use.
 */
export interface AdminPaymentSettings {
  stripe_configured?: boolean;
  stripe_enabled?: unknown;
  stripe_currency?: string;
  stripe_currency_locked?: unknown;
  stripe_mode?: string;
  stripe_publishable_key?: string;
  stripe_secret_key?: string;
  stripe_webhook_secret?: string;
  razorpay_configured?: boolean;
  razorpay_enabled?: unknown;
  razorpay_key_id?: string;
  razorpay_key_secret?: string;
  razorpay_mode?: string;
  razorpay_webhook_secret?: string;
  paypal_configured?: boolean;
  paypal_enabled?: unknown;
  paypal_client_id?: string;
  paypal_client_secret?: string;
  paypal_currency?: string;
  paypal_mode?: string;
  paypal_webhook_id?: string;
  paystack_configured?: boolean;
  paystack_enabled?: unknown;
  paystack_currency?: string;
  paystack_public_key?: string;
  paystack_secret_key?: string;
  paystack_webhook_secret?: string;
  mercadopago_configured?: boolean;
  mercadopago_enabled?: unknown;
  mercadopago_access_token?: string;
  mercadopago_currency?: string;
  mercadopago_public_key?: string;
  mercadopago_webhook_id?: string;
  mercadopago_webhook_secret?: string;
  yookassa_configured?: boolean;
  yookassa_enabled?: unknown;
  yookassa_currency?: string;
  yookassa_secret_key?: string;
  yookassa_shop_id?: string;
  yookassa_webhook_secret?: string;
  [key: string]: unknown;
}
