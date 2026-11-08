/**
 * Inventory service: stock per variant and location, adjustments, reservations and expiry.
 * Ported from Services/InventoryRuntime.php. Behaviour matches the PHP except where DECISIONS.md
 * says otherwise.
 *
 * Every method takes companyId first. Writes run inside storage.transaction(), so a rejected request
 * leaves no partial change.
 */
import { randomUUID } from "node:crypto";
import { ChatbotError, requireCompanyId } from "../chatbot-scope.ts";
import type { FulfilmentStorage } from "./fulfilment-storage.ts";
import {
  assertReservationTransition,
  expireStaleForStock,
  fail,
  lockStock,
  requireId,
  requireIdempotencyKey,
  requireInteger,
  requireLocation,
  unitsAvailable,
} from "./support.ts";
import { RESERVATION_STATUS, type AdjustmentRecord, type Id, type ReservationRecord, type ReservationStatus, type ServiceClock, type StockRecord } from "./types.ts";

export const DEFAULT_RESERVATION_TTL_MINUTES = 15;
export const MAX_RESERVATION_TTL_MINUTES = 120;
export const MAX_RESERVATION_QUANTITY = 999;

export interface StockView {
  variantId: Id;
  locationId: Id | null;
  quantity: number;
  reserved: number;
  committed: number;
  allocated: number;
  incoming: number;
  damaged: number;
  safetyStock: number;
  available: number;
  lowStock: boolean;
  version: number;
}

export interface AdjustInput {
  variantId: Id;
  delta: number;
  reason: string;
  locationId?: Id | null;
  expectedVersion?: number | null;
  actorId?: Id | null;
  idempotencyKey?: string | null;
}

export interface ReserveInput {
  holderId: Id;
  variantId: Id;
  quantity: number;
  idempotencyKey: string;
  /** Units the holder (a cart) currently has for this variant. Reservations may not exceed it. */
  holderQuantity: number;
  locationId?: Id | null;
  ttlMinutes?: number;
}

export interface InventoryService {
  availability(companyId: Id, variantId: Id, locationId?: Id | null): Promise<StockView>;
  adjust(companyId: Id, input: AdjustInput): Promise<AdjustmentRecord>;
  reserve(companyId: Id, input: ReserveInput): Promise<ReservationRecord>;
  release(companyId: Id, reservationId: Id, reason?: string): Promise<ReservationRecord>;
  releaseForHolder(companyId: Id, holderId: Id, reservationId: Id, reason?: string): Promise<ReservationRecord>;
  commit(companyId: Id, reservationId: Id): Promise<ReservationRecord>;
  expireDue(companyId: Id, limit?: number): Promise<number>;
}

export interface InventoryServiceDeps {
  storage: FulfilmentStorage;
  clock?: Partial<ServiceClock>;
}

export function createInventoryService(deps: InventoryServiceDeps): InventoryService {
  const { storage } = deps;
  const now = deps.clock?.now ?? (() => new Date());
  const newId = deps.clock?.newId ?? (() => randomUUID());

  function view(stock: StockRecord): StockView {
    return {
      variantId: stock.variantId,
      locationId: stock.locationId,
      quantity: stock.quantity,
      reserved: stock.reserved,
      committed: stock.committed,
      allocated: stock.allocated,
      incoming: stock.incoming,
      damaged: stock.damaged,
      safetyStock: stock.safetyStock,
      available: unitsAvailable(stock),
      lowStock: unitsAvailable(stock) <= stock.lowStockThreshold,
      version: stock.version,
    };
  }

  /**
   * Moves a reservation to a new status and updates the stock row to match. Expiry at commit time is
   * recorded as expiry and returned, not thrown, so the caller can persist it and then fail.
   */
  async function transitionReservation(
    tx: FulfilmentStorage,
    companyId: Id,
    reservationId: Id,
    target: ReservationStatus,
    reason: string | null,
    at: Date,
  ): Promise<ReservationRecord> {
    const current = await tx.getReservation(companyId, reservationId);
    if (!current) throw fail("Inventory reservation was not found.", 404);
    if (current.status === target) return current;

    let effective: ReservationStatus = target;
    let effectiveReason = reason;
    if (target === RESERVATION_STATUS.committed && current.status === RESERVATION_STATUS.active && current.expiresAt.getTime() <= at.getTime()) {
      effective = RESERVATION_STATUS.expired;
      effectiveReason = "expired";
    }
    assertReservationTransition(current.status, effective);

    const stock = await tx.getStock(companyId, current.variantId, current.locationId);
    if (!stock) throw new ChatbotError("Stock row for reservation is missing.", 409);

    const updated: StockRecord = {
      ...stock,
      reserved: Math.max(0, stock.reserved - current.quantity),
      version: stock.version + 1,
      committed: effective === RESERVATION_STATUS.committed ? stock.committed + current.quantity : stock.committed,
    };
    await tx.saveStock(companyId, updated);

    const next: ReservationRecord = {
      ...current,
      status: effective,
      committedAt: effective === RESERVATION_STATUS.committed ? at : current.committedAt,
      releasedAt: effective === RESERVATION_STATUS.committed ? current.releasedAt : at,
      releaseReason: effective === RESERVATION_STATUS.committed ? current.releaseReason : effectiveReason,
    };
    await tx.saveReservation(companyId, next);
    return next;
  }

  function assertSameReservation(existing: ReservationRecord, input: ReserveInput): void {
    const locationId = input.locationId ?? null;
    if (
      existing.holderId !== input.holderId ||
      existing.variantId !== input.variantId ||
      existing.quantity !== input.quantity ||
      existing.locationId !== locationId
    ) {
      throw fail("The idempotency key was already used for a different inventory reservation.", 409);
    }
  }

  function assertSameAdjustment(existing: AdjustmentRecord, input: AdjustInput): void {
    if (existing.variantId !== input.variantId || existing.delta !== input.delta || existing.locationId !== (input.locationId ?? null)) {
      throw fail("The idempotency key was already used for a different inventory adjustment.", 409);
    }
  }

  return {
    async availability(companyId, variantId, locationId = null) {
      const scope = requireCompanyId(companyId);
      const id = requireId(variantId, "variantId");
      if (locationId !== null) await requireLocation(storage, scope, locationId);

      const stock = await storage.getStock(scope, id, locationId);
      if (!stock) {
        return {
          variantId: id,
          locationId,
          quantity: 0,
          reserved: 0,
          committed: 0,
          allocated: 0,
          incoming: 0,
          damaged: 0,
          safetyStock: 0,
          available: 0,
          lowStock: true,
          version: 0,
        };
      }
      return view(stock);
    },

    async adjust(companyId, input) {
      const scope = requireCompanyId(companyId);
      const variantId = requireId(input.variantId, "variantId");
      if (!Number.isInteger(input.delta) || input.delta === 0) {
        throw fail("Inventory adjustment delta must be a non-zero integer.");
      }
      const reason = requireId(input.reason, "reason");
      const locationId = input.locationId ?? null;
      const key = input.idempotencyKey ? requireIdempotencyKey(input.idempotencyKey) : null;

      if (key) {
        const existing = await storage.findAdjustmentByKey(scope, key);
        if (existing) {
          assertSameAdjustment(existing, { ...input, variantId, locationId });
          return existing;
        }
      }

      return storage.transaction(scope, async (tx) => {
        const stock = await lockStock(tx, scope, variantId, locationId);
        if (input.expectedVersion !== undefined && input.expectedVersion !== null && stock.version !== input.expectedVersion) {
          throw fail("Inventory changed after it was loaded. Refresh and retry with the current version.");
        }

        const newQuantity = stock.quantity + input.delta;
        const minimum = stock.reserved + stock.committed + stock.damaged;
        if (newQuantity < minimum) {
          throw fail("The adjustment would reduce stock below reserved, committed, or damaged quantities.");
        }

        const updated: StockRecord = { ...stock, quantity: newQuantity, version: stock.version + 1 };
        await tx.saveStock(scope, updated);

        const adjustment: AdjustmentRecord = {
          id: newId(),
          companyId: scope,
          variantId,
          locationId,
          delta: input.delta,
          reason,
          balanceAfter: newQuantity,
          version: updated.version,
          actorId: input.actorId ?? null,
          idempotencyKey: key,
          createdAt: now(),
        };
        await tx.insertAdjustment(scope, adjustment);
        return adjustment;
      });
    },

    async reserve(companyId, input) {
      const scope = requireCompanyId(companyId);
      const quantity = requireInteger(input.quantity, "quantity", 1, MAX_RESERVATION_QUANTITY);
      const key = requireIdempotencyKey(input.idempotencyKey);
      const variantId = requireId(input.variantId, "variantId");
      const holderId = requireId(input.holderId, "holderId");
      const holderQuantity = requireInteger(input.holderQuantity, "holderQuantity", 0, Number.MAX_SAFE_INTEGER);
      const locationId = input.locationId ?? null;
      const ttl = Math.min(Math.max(input.ttlMinutes ?? DEFAULT_RESERVATION_TTL_MINUTES, 1), MAX_RESERVATION_TTL_MINUTES);
      const normalised: ReserveInput = { ...input, variantId, holderId, quantity, idempotencyKey: key, locationId, holderQuantity };

      const existing = await storage.findReservationByKey(scope, key);
      if (existing) {
        assertSameReservation(existing, normalised);
        return existing;
      }

      return storage.transaction(scope, async (tx) => {
        const again = await tx.findReservationByKey(scope, key);
        if (again) {
          assertSameReservation(again, normalised);
          return again;
        }

        const at = now();
        let stock = await lockStock(tx, scope, variantId, locationId);
        if (locationId !== null) {
          const location = await requireLocation(tx, scope, locationId);
          if (!location.active) throw fail("Inventory location is not active.");
        }
        stock = await expireStaleForStock(tx, scope, stock, at);

        const heldForHolder = (await tx.listActiveReservations(scope, variantId, locationId))
          .filter((reservation) => reservation.holderId === holderId)
          .reduce((sum, reservation) => sum + reservation.quantity, 0);
        if (heldForHolder + quantity > holderQuantity) {
          throw fail("The requested reservation exceeds the quantity currently held in the cart.");
        }

        const available = unitsAvailable(stock);
        if (!stock.allowBackorder && available < quantity) {
          throw fail(`Only ${available} unit(s) are currently available.`);
        }

        await tx.saveStock(scope, { ...stock, reserved: stock.reserved + quantity, version: stock.version + 1 });

        const reservation: ReservationRecord = {
          id: newId(),
          companyId: scope,
          holderId,
          variantId,
          locationId,
          quantity,
          status: RESERVATION_STATUS.active,
          idempotencyKey: key,
          expiresAt: new Date(at.getTime() + ttl * 60_000),
          committedAt: null,
          releasedAt: null,
          releaseReason: null,
          createdAt: at,
        };
        await tx.insertReservation(scope, reservation);
        return reservation;
      });
    },

    async release(companyId, reservationId, reason = "released") {
      const scope = requireCompanyId(companyId);
      const id = requireId(reservationId, "reservationId");
      return storage.transaction(scope, (tx) =>
        transitionReservation(tx, scope, id, RESERVATION_STATUS.released, reason, now()),
      );
    },

    async releaseForHolder(companyId, holderId, reservationId, reason = "customer_released") {
      const scope = requireCompanyId(companyId);
      const reservation = await storage.getReservation(scope, requireId(reservationId, "reservationId"));
      if (!reservation) throw fail("Inventory reservation was not found.", 404);
      if (reservation.holderId !== holderId) {
        throw fail("The reservation does not belong to this cart.");
      }
      return storage.transaction(scope, (tx) =>
        transitionReservation(tx, scope, reservation.id, RESERVATION_STATUS.released, reason, now()),
      );
    },

    async commit(companyId, reservationId) {
      const scope = requireCompanyId(companyId);
      const id = requireId(reservationId, "reservationId");
      // The expiry write is kept even though the commit fails, as in the PHP source.
      const result = await storage.transaction(scope, (tx) =>
        transitionReservation(tx, scope, id, RESERVATION_STATUS.committed, null, now()),
      );
      if (result.status !== RESERVATION_STATUS.committed) {
        throw fail("The inventory reservation expired before it could be committed.");
      }
      return result;
    },

    async expireDue(companyId, limit = 500) {
      const scope = requireCompanyId(companyId);
      const bounded = Math.min(Math.max(limit, 1), 5000);
      const due = await storage.listDueReservations(scope, now(), bounded);
      let expired = 0;
      for (const reservation of due) {
        try {
          const result = await storage.transaction(scope, (tx) =>
            transitionReservation(tx, scope, reservation.id, RESERVATION_STATUS.expired, "expired", now()),
          );
          if (result.status === RESERVATION_STATUS.expired) expired++;
        } catch (error) {
          // Another worker moved this reservation first. Skip it, as the PHP sweep does.
          if (!(error instanceof ChatbotError) || error.status !== 422) throw error;
        }
      }
      return expired;
    },
  };
}
