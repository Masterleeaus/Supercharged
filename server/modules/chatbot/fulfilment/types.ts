/**
 * Record shapes for the fulfilment slice. Ported from the Commerce Crew extension models
 * (InventoryLocationStock, InventoryReservation, InventoryAdjustment, Fulfillment, FulfillmentItem).
 *
 * Ids are strings so they match the chatbot module, which uses varchar ids. Every record carries
 * companyId. Storage reads and writes only rows whose companyId matches the caller's scope.
 */

export type Id = string;

export const RESERVATION_STATUS = {
  active: "active",
  committed: "committed",
  released: "released",
  expired: "expired",
} as const;
export type ReservationStatus = (typeof RESERVATION_STATUS)[keyof typeof RESERVATION_STATUS];

export const FULFILMENT_STATUS = {
  pending: "pending",
  processing: "processing",
  shipped: "shipped",
  delivered: "delivered",
  cancelled: "cancelled",
} as const;
export type FulfilmentStatus = (typeof FULFILMENT_STATUS)[keyof typeof FULFILMENT_STATUS];

export const FULFILMENT_METHODS = ["delivery", "pickup", "digital"] as const;
export type FulfilmentMethod = (typeof FULFILMENT_METHODS)[number];

export interface LocationRecord {
  id: Id;
  companyId: Id;
  code: string;
  name: string;
  active: boolean;
  priority: number;
}

/**
 * Stock for one variant at one location. locationId null is the company-wide row, as in the PHP
 * InventoryItem table. allocated counts committed units already drawn by an open fulfilment.
 */
export interface StockRecord {
  companyId: Id;
  variantId: Id;
  locationId: Id | null;
  quantity: number;
  reserved: number;
  committed: number;
  allocated: number;
  damaged: number;
  safetyStock: number;
  incoming: number;
  lowStockThreshold: number;
  allowBackorder: boolean;
  version: number;
}

export interface ReservationRecord {
  id: Id;
  companyId: Id;
  holderId: Id;
  variantId: Id;
  locationId: Id | null;
  quantity: number;
  status: ReservationStatus;
  idempotencyKey: string;
  expiresAt: Date;
  committedAt: Date | null;
  releasedAt: Date | null;
  releaseReason: string | null;
  createdAt: Date;
}

export interface AdjustmentRecord {
  id: Id;
  companyId: Id;
  variantId: Id;
  locationId: Id | null;
  delta: number;
  reason: string;
  balanceAfter: number;
  version: number;
  actorId: Id | null;
  idempotencyKey: string | null;
  createdAt: Date;
}

export interface OrderLine {
  id: Id;
  variantId: Id;
  productId: Id | null;
  sku: string | null;
  name: string;
  quantity: number;
}

/**
 * Snapshot of what was sold. The Commerce Crew extension reads this from checkout sessions and cart
 * lines, which sit outside this slice. The integration writes the snapshot through registerOrder().
 */
export interface OrderRecord {
  id: Id;
  companyId: Id;
  reference: string | null;
  lines: OrderLine[];
  createdAt: Date;
}

export interface FulfilmentItemRecord {
  orderLineId: Id;
  variantId: Id;
  productId: Id | null;
  sku: string | null;
  name: string;
  quantity: number;
}

export interface FulfilmentRecord {
  id: Id;
  companyId: Id;
  orderId: Id;
  status: FulfilmentStatus;
  methodType: FulfilmentMethod;
  locationId: Id | null;
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  customerNote: string | null;
  internalNote: string | null;
  idempotencyKey: string;
  requestHash: string;
  items: FulfilmentItemRecord[];
  processingAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServiceClock {
  now: () => Date;
  newId: () => Id;
}
