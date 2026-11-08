/**
 * Record shapes for the native orders domain. Every record carries companyId. Money fields are integer
 * minor units. Ported from the ext_chatbot_commerce_* and ext_chatbot_coupon* tables.
 */
import type { OrderStatus, ReturnStatus } from "./lifecycle.ts";

export type ReturnResolution = "refund" | "exchange" | "store_credit";
export type CouponType = "percentage" | "fixed";
export type CouponAppliesTo = "cart" | "products" | "variants" | "categories";
export type CouponUsageStatus = "reserved" | "redeemed" | "released" | "expired";

export interface OrderRecord {
  id: string;
  companyId: string;
  orderNumber: string;
  chatbotId: string;
  cartId: string | null;
  checkoutId: string;
  paymentIntentId: string | null;
  customerIdentityId: string | null;
  conversationId: string | null;
  sessionId: string | null;
  source: string;
  status: OrderStatus;
  fulfillmentStatus: string;
  currency: string;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  shippingTotal: number;
  total: number;
  refundedTotal: number;
  customerSnapshot: Record<string, unknown>;
  billingAddress: Record<string, unknown>;
  shippingAddress: Record<string, unknown>;
  paymentSnapshot: Record<string, unknown>;
  metadata: Record<string, unknown>;
  placedAt: Date;
  confirmedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderItemRecord {
  id: string;
  companyId: string;
  orderId: string;
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  name: string;
  variantName: string | null;
  quantity: number;
  fulfilledQuantity: number;
  returnedQuantity: number;
  listUnitPrice: number;
  unitPrice: number;
  discountTotal: number;
  taxTotal: number;
  lineTotal: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderEventRecord {
  id: string;
  companyId: string;
  /** Monotonic per company. Used to order the log. */
  sequence: number;
  orderId: string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface ReturnRecord {
  id: string;
  companyId: string;
  rmaNumber: string;
  orderId: string;
  customerIdentityId: string | null;
  status: ReturnStatus;
  reasonCode: string | null;
  reason: string | null;
  requestedResolution: ReturnResolution;
  requestedAmount: number;
  refundedAmount: number;
  currency: string;
  /** True once returned quantities were released by a rejection or cancellation. Prevents double release. */
  quantitiesReleased: boolean;
  paymentRefunds: Record<string, unknown>[];
  metadata: Record<string, unknown>;
  approvedAt: Date | null;
  receivedAt: Date | null;
  resolvedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReturnItemRecord {
  id: string;
  companyId: string;
  returnId: string;
  orderItemId: string;
  quantity: number;
  reasonCode: string | null;
  condition: string | null;
  amount: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CouponRecord {
  id: string;
  companyId: string;
  chatbotId: string;
  /** Stored upper-cased and trimmed. */
  code: string;
  type: CouponType;
  /** Basis points for percentage coupons, minor units for fixed coupons. */
  value: number;
  minimumAmount: number;
  maxDiscountAmount: number | null;
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  currency: string | null;
  channels: string[];
  firstOrderOnly: boolean;
  usageLimit: number | null;
  usageLimitPerCustomer: number | null;
  appliesTo: CouponAppliesTo;
  targetIds: string[];
  stackable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CouponUsageRecord {
  id: string;
  companyId: string;
  couponId: string;
  cartId: string;
  customerIdentityId: string | null;
  status: CouponUsageStatus;
  channel: string | null;
  currency: string | null;
  reservedAt: Date | null;
  redeemedAt: Date | null;
  releasedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields the storage assigns itself. Callers never provide them. */
export type StorageOwned = "id" | "companyId" | "createdAt" | "updatedAt";
export type Insert<T> = Omit<T, StorageOwned>;
