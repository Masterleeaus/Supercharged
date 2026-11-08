/**
 * Commerce ports: marketplaces, payments, BNPL, tax, shipping, pricing, rental and hire, credentials, and
 * customer communications. Mirrors extensions/chatbot-ecommerce/System/Contracts/*.php and the models behind
 * the ext_chatbot_* tables.
 *
 * Money rules (decision, see CONVENTIONS.md): every amount is an integer in the currency's minor unit
 * (cents), with an ISO 4217 currency code. No floats for money, anywhere in these types.
 *
 * Tenancy: every method that reads or writes tenant data takes companyId first.
 * Secrets: provider credentials are loaded from CommerceCredentialStore at call time, decrypted in memory,
 * and never stored in these types or returned to a customer.
 */
import type { HttpClient } from "./http.ts";
import type { ChannelKind } from "./channels.ts";

/** ISO 4217 code, for example "AUD". Upper case. */
export type CurrencyCode = string;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** Decrypted credential bag for one provider connection. In-memory for one call. Never logged. */
export type CommerceCredentials = Readonly<Record<string, string>>;

export interface CommerceCredentialStore {
  /** Loads and decrypts. Returns null when the connection is missing or belongs to another company. */
  load(companyId: string, connectionId: string): Promise<CommerceCredentials | null>;
  /** Encrypts with SecretBox before writing. Returns the stored connection id. */
  save(companyId: string, connectionId: string, provider: string, credentials: CommerceCredentials): Promise<void>;
  remove(companyId: string, connectionId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Rate limits (shared by every outbound commerce call)
// ---------------------------------------------------------------------------

export interface RateLimitDecision {
  allowed: boolean;
  /** Milliseconds to wait before the next attempt. Null when allowed. */
  retryAfterMs: number | null;
  remaining: number | null;
}

export interface RateLimitObservation {
  status: number;
  headers: Readonly<Record<string, string>>;
}

/**
 * Hooks the rate limiter exposes to a provider. acquire() runs before each call and observe() runs after,
 * so the limiter can read the provider's own quota headers. The circuit breaker sits behind the same hooks.
 */
export interface RateLimitHooks {
  acquire(companyId: string, provider: string, operation: string): Promise<RateLimitDecision>;
  observe(companyId: string, provider: string, operation: string, response: RateLimitObservation): Promise<void>;
  /** Records a transport failure so the circuit breaker can open. */
  recordFailure(companyId: string, provider: string, operation: string, reason: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Marketplaces
// ---------------------------------------------------------------------------

export const MARKETPLACE_PROVIDER_KEYS = ["ebay", "amazon", "etsy", "generic"] as const;
export type MarketplaceProviderKey = (typeof MARKETPLACE_PROVIDER_KEYS)[number];

export const MARKETPLACE_CAPABILITIES = [
  "read_listings",
  "read_inventory",
  "import_orders",
  "write_listing",
  "write_inventory",
  "write_price",
] as const;
export type MarketplaceCapability = (typeof MARKETPLACE_CAPABILITIES)[number];

/** A reference to one marketplace connection. The credentials are loaded from the store, not carried here. */
export interface MarketplaceConnectionRef {
  companyId: string;
  connectionId: string;
  provider: MarketplaceProviderKey;
}

export interface MarketplaceListing {
  externalListingId: string;
  title: string;
  priceMinor: number;
  currency: CurrencyCode;
  quantity: number | null;
  /** Hash of the listing as the marketplace last reported it. Writes must quote it back. */
  sourceHash: string;
  raw: Record<string, unknown>;
}

export interface MarketplaceListingQuery {
  keywords?: string;
  cursor: string | null;
  limit: number;
}

export interface MarketplaceListingPage {
  rows: MarketplaceListing[];
  nextCursor: string | null;
}

export interface MarketplaceInventoryLevel {
  externalListingId: string;
  quantity: number;
}

export interface MarketplaceOrderImportPage {
  orders: Record<string, unknown>[];
  nextCursor: Record<string, unknown> | null;
}

export interface MarketplaceReadOps {
  searchListings(ref: MarketplaceConnectionRef, query: MarketplaceListingQuery, http: HttpClient): Promise<MarketplaceListingPage>;
  getListing(ref: MarketplaceConnectionRef, externalListingId: string, http: HttpClient): Promise<MarketplaceListing | null>;
  getInventory(ref: MarketplaceConnectionRef, externalListingIds: string[], http: HttpClient): Promise<MarketplaceInventoryLevel[]>;
  importOrders(ref: MarketplaceConnectionRef, cursor: Record<string, unknown> | null, http: HttpClient): Promise<MarketplaceOrderImportPage>;
}

export interface MarketplaceWriteRequest {
  externalListingId: string;
  operation: MarketplaceCapability;
  changes: Record<string, unknown>;
  /** The write is refused when the listing has changed since this hash was read. */
  expectedSourceHash: string;
  /** Same key on a retry must not apply the change twice. */
  idempotencyKey: string;
}

export type MarketplaceWriteResult =
  | { status: "applied"; sourceHash: string; rollbackState: Record<string, unknown> }
  | { status: "conflict"; currentSourceHash: string }
  | { status: "rejected"; errorCode: string; message: string };

export interface MarketplaceWriteOps {
  execute(ref: MarketplaceConnectionRef, request: MarketplaceWriteRequest, http: HttpClient): Promise<MarketplaceWriteResult>;
  /** Restores the state saved by execute(). Uses the same concurrency and idempotency rules. */
  rollback(
    ref: MarketplaceConnectionRef,
    request: MarketplaceWriteRequest & { rollbackState: Record<string, unknown> },
    http: HttpClient,
  ): Promise<MarketplaceWriteResult>;
}

export interface MarketplaceProvider {
  readonly key: MarketplaceProviderKey;
  capabilities(): MarketplaceCapability[];
  read: MarketplaceReadOps;
  /** Null for read-only providers. Writes also need the CHATBOT_MARKETPLACE_WRITE_ENABLED flag. */
  write: MarketplaceWriteOps | null;
  rateLimit: RateLimitHooks;
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export const PAYMENT_STATUSES = [
  "requires_payment_method",
  "requires_capture",
  "succeeded",
  "canceled",
  "failed",
  "refunded",
  "expired",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface PaymentIntentInput {
  companyId: string;
  orderRef: string;
  amountMinor: number;
  currency: CurrencyCode;
  method: string;
  description: string | null;
  /** Same key returns the same intent. */
  idempotencyKey: string;
  customerRef: string | null;
}

export interface PaymentIntent {
  providerIntentId: string;
  status: PaymentStatus;
  amountMinor: number;
  currency: CurrencyCode;
  /** Single-use token for the browser to confirm the payment. Not the secret key. */
  clientToken: string | null;
}

export interface PaymentActionResult {
  providerIntentId: string;
  status: PaymentStatus;
  amountMinor: number;
  currency: CurrencyCode;
  providerRequestId: string | null;
}

export interface PaymentRefundResult extends PaymentActionResult {
  refundId: string;
  refundedMinor: number;
}

export interface PaymentWebhookInput {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
}

export interface PaymentWebhookEvent {
  providerEventId: string;
  type: string;
  providerIntentId: string | null;
  status: PaymentStatus | null;
  amountMinor: number | null;
  currency: CurrencyCode | null;
  occurredAt: Date;
}

export interface PaymentProvider {
  readonly name: string;
  supports(method: string): boolean;
  createIntent(companyId: string, input: PaymentIntentInput, http: HttpClient): Promise<PaymentIntent>;
  authorize(companyId: string, providerIntentId: string, http: HttpClient): Promise<PaymentActionResult>;
  capture(companyId: string, providerIntentId: string, amountMinor: number, http: HttpClient): Promise<PaymentActionResult>;
  cancel(companyId: string, providerIntentId: string, http: HttpClient): Promise<PaymentActionResult>;
  refund(companyId: string, providerIntentId: string, amountMinor: number, reason: string | null, http: HttpClient): Promise<PaymentRefundResult>;
  retrieve(companyId: string, providerIntentId: string, http: HttpClient): Promise<PaymentActionResult>;
  /**
   * Fails closed. Returns false when the signature, timestamp or secret is missing or wrong. Constant-time compare.
   * credentials carries the webhook secret for this company's connection.
   */
  verifyWebhook(companyId: string, input: PaymentWebhookInput, credentials: CommerceCredentials): Promise<boolean>;
  parseWebhook(companyId: string, rawBody: string): PaymentWebhookEvent[];
}

// ---------------------------------------------------------------------------
// BNPL (buy now, pay later)
// ---------------------------------------------------------------------------

export const BNPL_OFFER_STATUSES = ["eligible", "declined", "accepted", "active", "completed", "cancelled"] as const;
export type BnplOfferStatus = (typeof BNPL_OFFER_STATUSES)[number];

export interface BnplEligibilityInput {
  companyId: string;
  amountMinor: number;
  currency: CurrencyCode;
  customerRef: string | null;
  countryCode: string | null;
}

export interface BnplEligibility {
  eligible: boolean;
  maxAmountMinor: number | null;
  installmentCounts: number[];
  reason: string | null;
}

export interface BnplOffer {
  id: string;
  companyId: string;
  orderRef: string;
  providerCode: string;
  status: BnplOfferStatus;
  amountMinor: number;
  currency: CurrencyCode;
  installmentCount: number;
  /** Hosted page the customer opens to accept. Not a secret. */
  hostedCheckoutUrl: string | null;
  createdAt: Date;
}

export interface BnplProvider {
  readonly code: string;
  checkEligibility(input: BnplEligibilityInput, credentials: CommerceCredentials, http: HttpClient): Promise<BnplEligibility>;
  createOffer(companyId: string, orderRef: string, amountMinor: number, currency: CurrencyCode, installmentCount: number, credentials: CommerceCredentials, http: HttpClient): Promise<BnplOffer>;
  cancelOffer(companyId: string, offerId: string, credentials: CommerceCredentials, http: HttpClient): Promise<BnplOffer | null>;
  verifyWebhook(companyId: string, input: PaymentWebhookInput, credentials: CommerceCredentials): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------

export interface TaxAddress {
  countryCode: string;
  region: string | null;
  postcode: string | null;
}

export interface TaxZone {
  id: string;
  name: string;
  countryCode: string;
  region: string | null;
}

export interface TaxRate {
  zoneId: string | null;
  taxClass: string;
  /** Basis points: 1000 means 10.00 percent. Integer only. */
  rateBps: number;
  inclusive: boolean;
  label: string;
  /** Optional. True when this component is charged on top of earlier components. Added by change request 4 (money slice). */
  compound?: boolean;
}

export interface TaxLine {
  lineId: string;
  taxClass: string | null;
  amountMinor: number;
  quantity: number;
}

export interface TaxProvider {
  resolveZone(companyId: string, address: TaxAddress): Promise<TaxZone | null>;
  ratesForLine(companyId: string, line: TaxLine, zone: TaxZone | null): Promise<TaxRate[]>;
  ratesForShipping(companyId: string, zone: TaxZone | null, shippingAmountMinor: number): Promise<TaxRate[]>;
}

// ---------------------------------------------------------------------------
// Shipping
// ---------------------------------------------------------------------------

export interface ShippingCartLine {
  variantId: number;
  quantity: number;
  unitPriceMinor: number;
  weightGrams: number | null;
  taxClass: string | null;
  /** Optional. Digital and service lines do not ship. Added by change request 3 (money slice). */
  productType?: "physical" | "digital" | "service";
}

export interface ShippingCartSnapshot {
  cartId: string;
  currency: CurrencyCode;
  lines: ShippingCartLine[];
}

export interface ShippingAddress {
  name: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postcode: string;
  countryCode: string;
}

export interface ShippingQuote {
  quoteId: string;
  carrier: string;
  service: string;
  priceMinor: number;
  currency: CurrencyCode;
  estimatedDays: number | null;
  /** Quote is only valid until this time. */
  expiresAt: Date;
}

export interface ShippingProvider {
  quotes(
    companyId: string,
    cart: ShippingCartSnapshot,
    address: ShippingAddress,
    http: HttpClient,
  ): Promise<ShippingQuote[]>;
}

// ---------------------------------------------------------------------------
// Pricing rules
// ---------------------------------------------------------------------------

/** Values taken from PricingRuntime.php. Confirm the full list there before the port is implemented. */
export const PRICING_RULE_TYPES = ["percentage_discount", "fixed_discount", "price_override", "free_shipping"] as const;
export type PricingRuleType = (typeof PRICING_RULE_TYPES)[number];

export const PRICING_SCOPES = ["line", "cart", "shipping"] as const;
export type PricingScope = (typeof PRICING_SCOPES)[number];

/** Mirrors the ext_chatbot_pricing_rules row. value is basis points for percentages and minor units otherwise. */
export interface PricingRule {
  id: string;
  companyId: string;
  name: string;
  ruleType: PricingRuleType;
  scope: PricingScope;
  targetType: string;
  value: number;
  priority: number;
  stackable: boolean;
  active: boolean;
  currency: CurrencyCode | null;
  /** Null means the rule applies on every channel. */
  channel: ChannelKind | null;
  startsAt: Date | null;
  endsAt: Date | null;
  conditions: Record<string, unknown> | null;
  /*
   * Optional fields from the PHP ext_chatbot_pricing_rules row. Added by change request 2 (money slice).
   * Absent means "not set". The money slice carries them in PricingRuleRecord.
   */
  targetId?: string | null;
  minQuantity?: number | null;
  minSubtotalMinor?: number | null;
  customerRef?: string | null;
  /** True when a fixed amount applies per unit rather than per line. */
  perUnit?: boolean;
}

export interface PricingContext {
  companyId: string;
  cart: ShippingCartSnapshot;
  channel: ChannelKind;
  customerRef: string | null;
  at: Date;
}

export interface PricingAdjustment {
  ruleId: string;
  scope: PricingScope;
  lineId: string | null;
  amountMinor: number;
}

export interface PricingResult {
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  adjustments: PricingAdjustment[];
  /** Hash of the inputs and rules used. Stored with the quote so a later check can detect drift. */
  snapshotHash: string;
}

export interface PricingProvider {
  evaluate(context: PricingContext, rules: PricingRule[]): PricingResult;
}

// ---------------------------------------------------------------------------
// Rental and hire
// ---------------------------------------------------------------------------

export const RENTAL_AGREEMENT_STATUSES = ["draft", "active", "paused", "ended", "cancelled"] as const;
export type RentalAgreementStatus = (typeof RENTAL_AGREEMENT_STATUSES)[number];

export const RENTAL_CHARGE_STATUSES = ["open", "partially_paid", "paid", "voided"] as const;
export type RentalChargeStatus = (typeof RENTAL_CHARGE_STATUSES)[number];

export interface RentalAccount {
  id: string;
  companyId: string;
  accountNumber: string;
  accountType: string;
  displayName: string;
  currency: CurrencyCode;
  status: "open" | "closed";
  contactEmail: string | null;
  contactPhone: string | null;
}

export interface RentalAgreement {
  id: string;
  companyId: string;
  accountId: string;
  agreementNumber: string;
  agreementType: string;
  subjectType: string;
  subjectReference: string;
  billingFrequency: "weekly" | "fortnightly" | "monthly";
  chargeAmountMinor: number;
  currency: CurrencyCode;
  startsOn: string;
  endsOn: string | null;
  nextChargeDate: string | null;
  status: RentalAgreementStatus;
  allowPartialPayments: boolean;
  autoAllocatePayments: boolean;
}

export interface RentalCharge {
  id: string;
  companyId: string;
  agreementId: string;
  chargeNumber: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  originalMinor: number;
  adjustmentMinor: number;
  paidMinor: number;
  balanceDueMinor: number;
  currency: CurrencyCode;
  status: RentalChargeStatus;
  idempotencyKey: string;
}

export interface RentalLedgerEntry {
  id: string;
  companyId: string;
  accountId: string;
  entryType: string;
  debitMinor: number;
  creditMinor: number;
  currency: CurrencyCode;
  effectiveAt: Date;
  reference: string;
  /** Hash that links the entry to the one before it. Entries are append-only. */
  immutableHash: string;
}

export interface RentalPaymentAllocation {
  id: string;
  companyId: string;
  paymentId: string;
  chargeId: string;
  amountMinor: number;
}

// ---------------------------------------------------------------------------
// Customer communications (order and booking updates sent to the customer)
// ---------------------------------------------------------------------------

export const CUSTOMER_COMMUNICATION_KINDS = [
  "order_confirmed",
  "order_shipped",
  "order_delivered",
  "refund_issued",
  "payment_due",
  "booking_confirmed",
  "booking_reminder",
  "booking_cancelled",
] as const;
export type CustomerCommunicationKind = (typeof CUSTOMER_COMMUNICATION_KINDS)[number];

export interface CustomerCommunication {
  id: string;
  companyId: string;
  customerId: string;
  kind: CustomerCommunicationKind;
  channel: "whatsapp" | "telegram" | "messenger" | "instagram" | "email" | "sms" | "web";
  templateName: string | null;
  /** Idempotency anchor, for example the order id plus the kind. */
  referenceKey: string;
  status: "queued" | "sent" | "delivered" | "failed" | "suppressed";
  suppressedReason: string | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Ports from other slices, promoted to contracts by change requests (order-ops slice)
// ---------------------------------------------------------------------------

/** Finds variant ids by exact SKU. The catalogue owns the lookup. Added by change request (order-ops, SKU lookup). */
export interface CatalogueVariantLookup {
  idsBySku(companyId: string, sku: string): Promise<string[]>;
}

/** One native order, as the orders slice reports it for a chatbot. Added by change request (order-ops, chatbot-wide list). */
export interface ChatbotOrderSummary {
  orderId: string;
  orderNumber: string;
  chatbotId: string;
  conversationId: string | null;
  sessionId: string | null;
  status: string;
  currency: CurrencyCode;
}

/**
 * Chatbot-wide list of native orders. The orders slice has only a per-session list today. Added by change request
 * (order-ops, chatbot-wide list). Optional for the orders slice to implement until the owner decides.
 */
export interface ChatbotOrderLister {
  listForChatbot(companyId: string, chatbotId: string): Promise<ChatbotOrderSummary[]>;
}

/**
 * Records a proposed marketplace stock change for seller approval. It never applies the change. Added by change
 * request (order-ops, write proposals). Kept apart from MarketplaceWriteOps so existing providers still compile.
 */
export interface InventoryWriteProposal {
  companyId: string;
  connection: MarketplaceConnectionRef & { chatbotId: string; ownerUserId: string };
  externalListingId: string;
  quantity: number;
  /** The proposal is refused when the listing has changed since this hash was read. */
  expectedSourceHash: string;
  idempotencyKey: string;
  actorUserId: string;
}

export interface InventoryWriteProposer {
  propose(input: InventoryWriteProposal): Promise<{ proposalId: string }>;
}
