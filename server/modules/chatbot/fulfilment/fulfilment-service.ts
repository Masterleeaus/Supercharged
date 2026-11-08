/**
 * Fulfilment service: fulfilment records with item quantities, dispatch status, and the rule that
 * nothing ships without stock. Ported from Services/FulfillmentRuntime.php, with stock coupling added
 * (see DECISIONS.md, decision 3).
 *
 * Stock flow for a physical (non-digital) fulfilment:
 *   create   -> stock.allocated += qty            (qty must fit within committed minus allocated)
 *   ship     -> quantity, committed, allocated -= qty
 *   cancel   -> stock.allocated -= qty
 * Delivered, processing and pending transitions do not touch stock.
 */
import { createHash, randomUUID } from "node:crypto";
import { ChatbotError, requireCompanyId } from "../chatbot-scope.ts";
import type { FulfilmentStorage } from "./fulfilment-storage.ts";
import {
  canTransitionFulfilment,
  aggregateFulfilment,
  holdsOrderQuantity,
  isShipped,
  stableStringify,
  type FulfilmentAggregate,
} from "./state.ts";
import {
  fail,
  lockStock,
  requireId,
  requireIdempotencyKey,
  requireInteger,
  requireLocation,
  requireMethod,
} from "./support.ts";
import {
  FULFILMENT_STATUS,
  type FulfilmentItemRecord,
  type FulfilmentMethod,
  type FulfilmentRecord,
  type FulfilmentStatus,
  type Id,
  type OrderLine,
  type OrderRecord,
  type ServiceClock,
  type StockRecord,
} from "./types.ts";

export const MAX_FULFILMENT_LINE_QUANTITY = 999_999;

export interface RegisterOrderInput {
  id: Id;
  reference?: string | null;
  lines: OrderLine[];
}

export interface FulfilmentItemInput {
  orderLineId: Id;
  quantity: number;
}

export interface CreateFulfilmentInput {
  orderId: Id;
  items: FulfilmentItemInput[];
  idempotencyKey: string;
  methodType?: FulfilmentMethod;
  locationId?: Id | null;
  carrier?: string | null;
  service?: string | null;
  customerNote?: string | null;
  internalNote?: string | null;
}

export interface TrackingInput {
  carrier?: string | null;
  service?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
}

export interface FulfilmentSummary {
  status: FulfilmentAggregate;
  totalQuantity: number;
  fulfilledQuantity: number;
  deliveredQuantity: number;
}

export interface FulfilmentService {
  registerOrder(companyId: Id, input: RegisterOrderInput): Promise<OrderRecord>;
  create(companyId: Id, input: CreateFulfilmentInput): Promise<FulfilmentRecord>;
  get(companyId: Id, fulfilmentId: Id): Promise<FulfilmentRecord>;
  markProcessing(companyId: Id, fulfilmentId: Id): Promise<FulfilmentRecord>;
  markShipped(companyId: Id, fulfilmentId: Id, tracking?: TrackingInput): Promise<FulfilmentRecord>;
  markDelivered(companyId: Id, fulfilmentId: Id): Promise<FulfilmentRecord>;
  cancel(companyId: Id, fulfilmentId: Id, reason?: string | null): Promise<FulfilmentRecord>;
  summaryForOrder(companyId: Id, orderId: Id): Promise<FulfilmentSummary>;
}

export interface FulfilmentServiceDeps {
  storage: FulfilmentStorage;
  clock?: Partial<ServiceClock>;
  /** Port of chatbot-ecommerce.fulfillment.require_tracking_for_delivery. Off by default, as in PHP. */
  requireTrackingForDelivery?: boolean;
}

const trimOr = (value: string | null | undefined, fallback: string | null): string | null => {
  if (value === undefined) return fallback;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

function requestHash(input: CreateFulfilmentInput): string {
  const payload = {
    items: Array.isArray(input.items)
      ? input.items.map((item) => ({ orderLineId: item?.orderLineId, quantity: item?.quantity }))
      : [],
    methodType: input.methodType ?? "delivery",
    locationId: input.locationId ?? null,
    carrier: input.carrier ?? null,
    service: input.service ?? null,
    customerNote: input.customerNote ?? null,
    internalNote: input.internalNote ?? null,
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/** Merges duplicate lines and checks each against the order. Mirrors FulfillmentRuntime::normaliseItems. */
function normaliseItems(items: FulfilmentItemInput[], order: OrderRecord): Map<Id, number> {
  if (!Array.isArray(items) || items.length === 0) {
    throw fail("At least one fulfilment item is required.");
  }
  const merged = new Map<Id, number>();
  for (const [index, item] of items.entries()) {
    const lineId = typeof item?.orderLineId === "string" ? item.orderLineId.trim() : "";
    const quantity = requireInteger(item?.quantity, `items[${index}].quantity`, 1, MAX_FULFILMENT_LINE_QUANTITY);
    if (lineId === "" || !order.lines.some((line) => line.id === lineId)) {
      throw fail(`items[${index}] must reference a line of this order.`);
    }
    merged.set(lineId, (merged.get(lineId) ?? 0) + quantity);
  }
  return merged;
}

export function createFulfilmentService(deps: FulfilmentServiceDeps): FulfilmentService {
  const { storage } = deps;
  const now = deps.clock?.now ?? (() => new Date());
  const newId = deps.clock?.newId ?? (() => randomUUID());
  const requireTracking = deps.requireTrackingForDelivery ?? false;

  async function loadFulfilment(tx: FulfilmentStorage, companyId: Id, fulfilmentId: Id): Promise<FulfilmentRecord> {
    const record = await tx.getFulfilment(companyId, fulfilmentId);
    if (!record) throw fail("Fulfilment was not found.", 404);
    return record;
  }

  function assertTransition(from: FulfilmentStatus, to: FulfilmentStatus): void {
    if (!canTransitionFulfilment(from, to)) {
      throw fail(`Fulfilment cannot transition from ${from} to ${to}.`);
    }
  }

  /** Units per variant across the fulfilment's items, for stock rows. */
  function unitsByVariant(record: FulfilmentRecord): Map<Id, number> {
    const totals = new Map<Id, number>();
    for (const item of record.items) {
      totals.set(item.variantId, (totals.get(item.variantId) ?? 0) + item.quantity);
    }
    return totals;
  }

  async function changeAllocation(
    tx: FulfilmentStorage,
    companyId: Id,
    record: FulfilmentRecord,
    mode: "ship" | "release",
  ): Promise<void> {
    if (record.methodType === "digital" || record.locationId === null) return;
    for (const [variantId, quantity] of unitsByVariant(record)) {
      const stock: StockRecord | null = await tx.getStock(companyId, variantId, record.locationId);
      if (!stock) throw new ChatbotError("Stock row for fulfilment is missing.", 409);

      const next: StockRecord = {
        ...stock,
        allocated: stock.allocated - quantity,
        quantity: mode === "ship" ? stock.quantity - quantity : stock.quantity,
        committed: mode === "ship" ? stock.committed - quantity : stock.committed,
        version: stock.version + 1,
      };
      const invariantBroken =
        next.allocated < 0 ||
        next.committed < 0 ||
        next.quantity < next.reserved + next.committed + next.damaged;
      if (invariantBroken) {
        throw new ChatbotError("Stock would fall below its allocated, committed or damaged quantities.", 409);
      }
      await tx.saveStock(companyId, next);
    }
  }

  return {
    async registerOrder(companyId, input) {
      const scope = requireCompanyId(companyId);
      const id = requireId(input.id, "id");
      if (!Array.isArray(input.lines) || input.lines.length === 0) {
        throw fail("An order needs at least one line.");
      }
      const seen = new Set<Id>();
      const lines: OrderLine[] = input.lines.map((line, index) => {
        const lineId = requireId(line.id, `lines[${index}].id`);
        if (seen.has(lineId)) throw fail(`Order line ${lineId} is duplicated.`);
        seen.add(lineId);
        return {
          id: lineId,
          variantId: requireId(line.variantId, `lines[${index}].variantId`),
          productId: line.productId ?? null,
          sku: line.sku ?? null,
          name: requireId(line.name, `lines[${index}].name`),
          quantity: requireInteger(line.quantity, `lines[${index}].quantity`, 1, MAX_FULFILMENT_LINE_QUANTITY),
        };
      });

      return storage.transaction(scope, async (tx) => {
        if (await tx.getOrder(scope, id)) throw fail("Order is already registered.", 409);
        const order: OrderRecord = {
          id,
          companyId: scope,
          reference: input.reference ?? null,
          lines,
          createdAt: now(),
        };
        await tx.saveOrder(scope, order);
        return order;
      });
    },

    async create(companyId, input) {
      const scope = requireCompanyId(companyId);
      const key = requireIdempotencyKey(input.idempotencyKey);
      const orderId = requireId(input.orderId, "orderId");
      const methodType = requireMethod(input.methodType ?? "delivery");
      const locationId = input.locationId ?? null;
      const hash = requestHash({ ...input, methodType, locationId });

      const checkReplay = (existing: FulfilmentRecord): FulfilmentRecord => {
        if (existing.orderId !== orderId) {
          throw fail("The idempotency key belongs to another order.", 409);
        }
        if (existing.requestHash !== hash) {
          throw fail("The idempotency key was already used for a different fulfilment request.", 409);
        }
        return existing;
      };

      const existing = await storage.findFulfilmentByKey(scope, key);
      if (existing) return checkReplay(existing);

      return storage.transaction(scope, async (tx) => {
        const again = await tx.findFulfilmentByKey(scope, key);
        if (again) return checkReplay(again);

        const order = await tx.getOrder(scope, orderId);
        if (!order) throw fail("Order was not found.", 404);

        const requested = normaliseItems(input.items, order);

        // Quantity already held by live fulfilments, per order line.
        const held = new Map<Id, number>();
        for (const fulfilment of await tx.listFulfilmentsForOrder(scope, orderId)) {
          if (!holdsOrderQuantity(fulfilment.status)) continue;
          for (const item of fulfilment.items) {
            held.set(item.orderLineId, (held.get(item.orderLineId) ?? 0) + item.quantity);
          }
        }

        const items: FulfilmentItemRecord[] = [];
        for (const [lineId, quantity] of requested) {
          const line = order.lines.find((candidate) => candidate.id === lineId);
          if (!line) throw fail("Order line was not found.", 404);
          const remaining = line.quantity - (held.get(lineId) ?? 0);
          if (quantity > remaining) {
            throw fail(`Only ${Math.max(0, remaining)} unit(s) remain unfulfilled for order line ${lineId}.`);
          }
          items.push({
            orderLineId: line.id,
            variantId: line.variantId,
            productId: line.productId,
            sku: line.sku,
            name: line.name,
            quantity,
          });
        }

        if (methodType !== "digital") {
          if (locationId === null) {
            throw fail("A locationId is required to fulfil physical items.");
          }
          await requireLocation(tx, scope, locationId);

          // Physical units must come from committed stock that no open fulfilment has drawn yet.
          const need = new Map<Id, number>();
          for (const item of items) {
            need.set(item.variantId, (need.get(item.variantId) ?? 0) + item.quantity);
          }
          for (const [variantId, quantity] of need) {
            const stock = await lockStock(tx, scope, variantId, locationId);
            const uncovered = stock.committed - stock.allocated;
            if (quantity > uncovered) {
              throw fail(
                `Only ${Math.max(0, uncovered)} committed unit(s) of variant ${variantId} are available to fulfil at this location.`,
              );
            }
            await tx.saveStock(scope, { ...stock, allocated: stock.allocated + quantity, version: stock.version + 1 });
          }
        }

        const at = now();
        const record: FulfilmentRecord = {
          id: newId(),
          companyId: scope,
          orderId,
          status: FULFILMENT_STATUS.pending,
          methodType,
          locationId,
          carrier: trimOr(input.carrier, null),
          service: trimOr(input.service, null),
          trackingNumber: null,
          trackingUrl: null,
          customerNote: trimOr(input.customerNote, null),
          internalNote: trimOr(input.internalNote, null),
          idempotencyKey: key,
          requestHash: hash,
          items,
          processingAt: null,
          shippedAt: null,
          deliveredAt: null,
          cancelledAt: null,
          createdAt: at,
          updatedAt: at,
        };
        await tx.insertFulfilment(scope, record);
        return record;
      });
    },

    async get(companyId, fulfilmentId) {
      const scope = requireCompanyId(companyId);
      const record = await storage.getFulfilment(scope, requireId(fulfilmentId, "fulfilmentId"));
      if (!record) throw fail("Fulfilment was not found.", 404);
      return record;
    },

    async markProcessing(companyId, fulfilmentId) {
      const scope = requireCompanyId(companyId);
      const id = requireId(fulfilmentId, "fulfilmentId");
      return storage.transaction(scope, async (tx) => {
        const record = await loadFulfilment(tx, scope, id);
        if (record.status === FULFILMENT_STATUS.processing) return record;
        assertTransition(record.status, FULFILMENT_STATUS.processing);
        const at = now();
        const next = { ...record, status: FULFILMENT_STATUS.processing, processingAt: at, updatedAt: at };
        await tx.saveFulfilment(scope, next);
        return next;
      });
    },

    async markShipped(companyId, fulfilmentId, tracking = {}) {
      const scope = requireCompanyId(companyId);
      const id = requireId(fulfilmentId, "fulfilmentId");
      return storage.transaction(scope, async (tx) => {
        const record = await loadFulfilment(tx, scope, id);
        if (record.status === FULFILMENT_STATUS.shipped) return record;
        assertTransition(record.status, FULFILMENT_STATUS.shipped);

        const trackingNumber = trimOr(tracking.trackingNumber, record.trackingNumber);
        if (record.methodType === "delivery" && !trackingNumber && requireTracking) {
          throw fail("A tracking number is required for delivery fulfilments.");
        }

        await changeAllocation(tx, scope, record, "ship");

        const at = now();
        const next: FulfilmentRecord = {
          ...record,
          status: FULFILMENT_STATUS.shipped,
          carrier: trimOr(tracking.carrier, record.carrier),
          service: trimOr(tracking.service, record.service),
          trackingNumber,
          trackingUrl: trimOr(tracking.trackingUrl, record.trackingUrl),
          shippedAt: at,
          updatedAt: at,
        };
        await tx.saveFulfilment(scope, next);
        return next;
      });
    },

    async markDelivered(companyId, fulfilmentId) {
      const scope = requireCompanyId(companyId);
      const id = requireId(fulfilmentId, "fulfilmentId");
      return storage.transaction(scope, async (tx) => {
        const record = await loadFulfilment(tx, scope, id);
        if (record.status === FULFILMENT_STATUS.delivered) return record;
        assertTransition(record.status, FULFILMENT_STATUS.delivered);
        const at = now();
        const next = { ...record, status: FULFILMENT_STATUS.delivered, deliveredAt: at, updatedAt: at };
        await tx.saveFulfilment(scope, next);
        return next;
      });
    },

    async cancel(companyId, fulfilmentId, reason = null) {
      const scope = requireCompanyId(companyId);
      const id = requireId(fulfilmentId, "fulfilmentId");
      return storage.transaction(scope, async (tx) => {
        const record = await loadFulfilment(tx, scope, id);
        if (record.status === FULFILMENT_STATUS.cancelled) return record;
        assertTransition(record.status, FULFILMENT_STATUS.cancelled);

        await changeAllocation(tx, scope, record, "release");

        const at = now();
        const next: FulfilmentRecord = {
          ...record,
          status: FULFILMENT_STATUS.cancelled,
          internalNote: trimOr(reason, record.internalNote),
          cancelledAt: at,
          updatedAt: at,
        };
        await tx.saveFulfilment(scope, next);
        return next;
      });
    },

    async summaryForOrder(companyId, orderId) {
      const scope = requireCompanyId(companyId);
      const id = requireId(orderId, "orderId");
      const order = await storage.getOrder(scope, id);
      if (!order) throw fail("Order was not found.", 404);

      const total = order.lines.reduce((sum, line) => sum + line.quantity, 0);
      let fulfilled = 0;
      let delivered = 0;
      for (const fulfilment of await storage.listFulfilmentsForOrder(scope, id)) {
        const quantity = fulfilment.items.reduce((sum, item) => sum + item.quantity, 0);
        if (isShipped(fulfilment.status)) fulfilled += quantity;
        if (fulfilment.status === FULFILMENT_STATUS.delivered) delivered += quantity;
      }

      return {
        status: aggregateFulfilment(total, fulfilled, delivered),
        totalQuantity: total,
        fulfilledQuantity: Math.min(fulfilled, total),
        deliveredQuantity: Math.min(delivered, total),
      };
    },
  };
}
